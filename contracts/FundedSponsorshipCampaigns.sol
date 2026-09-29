// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EvidenceRegistry} from "./EvidenceRegistry.sol";
import {IPoEVerifier} from "./IPoEVerifier.sol";

interface IERC20FundingToken {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/**
 * Testnet funding + PoE claim receipt for a TIME sponsorship.
 *
 * fundAndActivate moves the advertiser's test ERC-20 token directly to the protocol
 * treasury and immutably binds the funding to a campaign manifest. It never
 * holds USDC and it never mints, transfers, or makes TIME tradable.
 *
 * The off-chain Copus ledger credits claimed TIME only after it indexes the
 * SponsorshipApproved event. Any unclaimed TIME is an internal sponsor-balance
 * policy, not an on-chain token refund.
 */
contract FundedSponsorshipCampaigns {
    error InvalidCampaign();
    error PaymentFailed();
    error CampaignMissing();
    error CampaignClosed();
    error CampaignNotStarted();
    error CampaignFull();
    error RuleMismatch();
    error InvalidProof();
    error AlreadyClaimed();
    error EpochMismatch();
    error ReentrantCall();

    enum EligibilityMode { ONGOING, RETROSPECTIVE }

    struct Campaign {
        address advertiser;
        address fundingToken;
        uint64 startsAt;
        uint64 endsAt; // zero means no end date
        uint32 claimLimit;
        uint32 approvedClaims;
        uint32 totalTimeMinutes;
        uint32 timePerClaimMinutes;
        uint32 claimPeriodSeconds; // zero means one claim per subject, ever
        EligibilityMode mode;
        bool active;
        bytes32 ruleHash;
        bytes32 manifestHash;
        bytes32 snapshotRoot; // required only for retrospective campaigns
    }

    EvidenceRegistry public immutable registry;
    IPoEVerifier public immutable verifier;
    address public immutable treasury;
    address public immutable fundingToken;
    uint256 public campaignCount;
    bool private entered;
    mapping(uint256 => Campaign) public campaigns;
    mapping(uint256 => mapping(bytes32 => bool)) public usedNullifiers;

    event CampaignFundedAndActivated(
        uint256 indexed campaignId,
        address indexed advertiser,
        address indexed fundingToken,
        uint256 paymentAmount,
        bytes32 manifestHash,
        bytes32 ruleHash,
        bytes32 snapshotRoot,
        EligibilityMode mode,
        uint64 startsAt,
        uint64 endsAt,
        uint32 totalTimeMinutes,
        uint32 timePerClaimMinutes,
        uint32 claimPeriodSeconds
    );
    event SponsorshipApproved(
        uint256 indexed campaignId,
        uint256 indexed batchId,
        bytes32 indexed nullifier,
        bytes32 ruleHash,
        uint256 epoch
    );

    constructor(EvidenceRegistry evidenceRegistry, IPoEVerifier poeVerifier, address protocolTreasury, address acceptedFundingToken) {
        if (address(evidenceRegistry) == address(0) || address(poeVerifier) == address(0)
            || protocolTreasury == address(0) || acceptedFundingToken == address(0)) {
            revert InvalidCampaign();
        }
        registry = evidenceRegistry;
        verifier = poeVerifier;
        treasury = protocolTreasury;
        fundingToken = acceptedFundingToken;
    }

    function fundAndActivate(
        address acceptedToken,
        uint256 paymentAmount,
        bytes32 manifestHash,
        bytes32 ruleHash,
        bytes32 snapshotRoot,
        EligibilityMode mode,
        uint64 startsAt,
        uint64 endsAt,
        uint32 totalTimeMinutes,
        uint32 timePerClaimMinutes,
        uint32 claimPeriodSeconds
    ) public virtual returns (uint256 campaignId) {
        if (acceptedToken != fundingToken || paymentAmount == 0 || manifestHash == bytes32(0) || ruleHash == bytes32(0)
            || startsAt < block.timestamp || (endsAt != 0 && endsAt <= startsAt)
            || totalTimeMinutes < 30 || timePerClaimMinutes < 30 || timePerClaimMinutes > totalTimeMinutes
            || totalTimeMinutes % timePerClaimMinutes != 0
            || (claimPeriodSeconds != 0 && claimPeriodSeconds < 60)
            || (mode == EligibilityMode.RETROSPECTIVE && snapshotRoot == bytes32(0))) revert InvalidCampaign();

        if (entered) revert ReentrantCall();
        entered = true;

        // A low-level compatible ERC-20 check: accepts canonical tokens that
        // return true and tokens that return no data, rejects a false return.
        (bool ok, bytes memory result) = acceptedToken.call(
            abi.encodeWithSelector(IERC20FundingToken.transferFrom.selector, msg.sender, treasury, paymentAmount)
        );
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert PaymentFailed();
        entered = false;

        campaignId = ++campaignCount;
        uint32 claimLimit = totalTimeMinutes / timePerClaimMinutes;
        campaigns[campaignId] = Campaign({
            advertiser: msg.sender,
            fundingToken: acceptedToken,
            startsAt: startsAt,
            endsAt: endsAt,
            claimLimit: claimLimit,
            approvedClaims: 0,
            totalTimeMinutes: totalTimeMinutes,
            timePerClaimMinutes: timePerClaimMinutes,
            claimPeriodSeconds: claimPeriodSeconds,
            mode: mode,
            active: true,
            ruleHash: ruleHash,
            manifestHash: manifestHash,
            snapshotRoot: snapshotRoot
        });
        emit CampaignFundedAndActivated(campaignId, msg.sender, acceptedToken, paymentAmount, manifestHash, ruleHash,
            snapshotRoot, mode, startsAt, endsAt, totalTimeMinutes, timePerClaimMinutes, claimPeriodSeconds);
    }

    /** Anyone may relay this call; eligibility is bound to the proof/nullifier, not msg.sender. */
    function claim(
        uint256 campaignId,
        uint256 batchId,
        bytes32 nullifier,
        bytes32 suppliedRuleHash,
        uint256 epoch,
        bytes calldata proof
    ) public virtual {
        Campaign storage campaign = campaigns[campaignId];
        if (campaign.advertiser == address(0)) revert CampaignMissing();
        if (!campaign.active || (campaign.endsAt != 0 && block.timestamp >= campaign.endsAt)) revert CampaignClosed();
        if (block.timestamp < campaign.startsAt) revert CampaignNotStarted();
        if (campaign.approvedClaims >= campaign.claimLimit) revert CampaignFull();
        if (campaign.ruleHash != suppliedRuleHash) revert RuleMismatch();
        if (usedNullifiers[campaignId][nullifier]) revert AlreadyClaimed();
        // Which epochs are claimable is decided here, by chain time, never by the prover.
        // Period 0 = one claim per subject for the campaign's lifetime (epoch is always 0).
        // Otherwise one claim per subject per period. The previous epoch stays valid so a
        // proof made just before a boundary is not wasted; it still yields at most one
        // claim per epoch, and never one for an epoch before the campaign started.
        if (campaign.claimPeriodSeconds == 0) {
            if (epoch != 0) revert EpochMismatch();
        } else {
            uint256 current = block.timestamp / campaign.claimPeriodSeconds;
            uint256 first = campaign.startsAt / campaign.claimPeriodSeconds;
            if (epoch > current || epoch + 1 < current || epoch < first) revert EpochMismatch();
        }

        bytes32 evidenceRoot;
        if (campaign.mode == EligibilityMode.RETROSPECTIVE) {
            evidenceRoot = campaign.snapshotRoot;
        } else {
            bytes32 batchPolicyHash;
            (evidenceRoot, batchPolicyHash,, ) = registry.batches(batchId);
            if (evidenceRoot == bytes32(0)) revert InvalidProof();
            if (batchPolicyHash != campaign.ruleHash) revert RuleMismatch();
        }
        if (!verifier.verify(proof, evidenceRoot, campaign.ruleHash, nullifier, campaignId, epoch)) revert InvalidProof();
        usedNullifiers[campaignId][nullifier] = true;
        unchecked { campaign.approvedClaims++; }
        emit SponsorshipApproved(campaignId, batchId, nullifier, campaign.ruleHash, epoch);
    }
}
