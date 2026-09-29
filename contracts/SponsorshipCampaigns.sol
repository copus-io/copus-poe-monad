// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EvidenceRegistry} from "./EvidenceRegistry.sol";
import {IPoEVerifier} from "./IPoEVerifier.sol";

/**
 * Enforces campaign-scoped PoE eligibility and one claim per nullifier, where the
 * nullifier is scoped to (campaign, epoch) so a campaign may allow one claim per period.
 *
 * This contract approves a sponsorship claim; it deliberately does not mint,
 * transfer, price, or custody TIME. A Copus service can settle the approved
 * claim in its existing in-product ledger using the emitted event as a receipt.
 */
contract SponsorshipCampaigns {
    error NotOwner();
    error CampaignMissing();
    error CampaignClosed();
    error CampaignNotStarted();
    error CampaignFull();
    error RuleMismatch();
    error InvalidProof();
    error AlreadyClaimed();
    error EpochMismatch();
    error InvalidCampaign();

    struct Campaign {
        address advertiser;
        uint64 startsAt;
        uint64 endsAt;
        uint32 claimLimit;
        uint32 approvedClaims;
        uint32 claimPeriodSeconds; // zero means one claim per subject, ever
        bytes32 ruleHash;
        bool active;
    }

    EvidenceRegistry public immutable registry;
    IPoEVerifier public immutable verifier;
    address public immutable owner;
    uint256 public campaignCount;
    mapping(uint256 => Campaign) public campaigns;
    mapping(uint256 => mapping(bytes32 => bool)) public usedNullifiers;

    event CampaignCreated(
        uint256 indexed campaignId,
        address indexed advertiser,
        bytes32 indexed ruleHash,
        uint64 startsAt,
        uint64 endsAt,
        uint32 claimLimit,
        uint32 claimPeriodSeconds
    );
    event CampaignStatusUpdated(uint256 indexed campaignId, bool active);
    event SponsorshipApproved(
        uint256 indexed campaignId,
        uint256 indexed batchId,
        bytes32 indexed nullifier,
        bytes32 ruleHash,
        uint256 epoch
    );

    constructor(EvidenceRegistry evidenceRegistry, IPoEVerifier poeVerifier) {
        registry = evidenceRegistry;
        verifier = poeVerifier;
        owner = msg.sender;
    }

    function createCampaign(
        address advertiser,
        bytes32 ruleHash,
        uint64 startsAt,
        uint64 endsAt,
        uint32 claimLimit,
        uint32 claimPeriodSeconds
    ) external returns (uint256 campaignId) {
        if (msg.sender != owner) revert NotOwner();
        if (advertiser == address(0) || ruleHash == bytes32(0) || startsAt >= endsAt || claimLimit == 0
            || (claimPeriodSeconds != 0 && claimPeriodSeconds < 60)) {
            revert InvalidCampaign();
        }
        campaignId = ++campaignCount;
        campaigns[campaignId] = Campaign(advertiser, startsAt, endsAt, claimLimit, 0, claimPeriodSeconds, ruleHash, true);
        emit CampaignCreated(campaignId, advertiser, ruleHash, startsAt, endsAt, claimLimit, claimPeriodSeconds);
    }

    function setCampaignActive(uint256 campaignId, bool active) external {
        if (msg.sender != owner) revert NotOwner();
        if (campaigns[campaignId].advertiser == address(0)) revert CampaignMissing();
        campaigns[campaignId].active = active;
        emit CampaignStatusUpdated(campaignId, active);
    }

    function claim(
        uint256 campaignId,
        uint256 batchId,
        bytes32 nullifier,
        bytes32 suppliedRuleHash,
        uint256 epoch,
        bytes calldata proof
    ) external {
        Campaign storage campaign = campaigns[campaignId];
        if (campaign.advertiser == address(0)) revert CampaignMissing();
        if (!campaign.active) revert CampaignClosed();
        if (block.timestamp < campaign.startsAt) revert CampaignNotStarted();
        if (block.timestamp >= campaign.endsAt) revert CampaignClosed();
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

        // Public mappings of structs expose tuple getters across contract boundaries.
        // Only the committed root is a verifier public input here.
        (bytes32 evidenceRoot, bytes32 batchPolicyHash,, ) = registry.batches(batchId);
        if (evidenceRoot == bytes32(0)) revert InvalidProof();
        if (batchPolicyHash != campaign.ruleHash) revert RuleMismatch();
        if (!verifier.verify(proof, evidenceRoot, campaign.ruleHash, nullifier, campaignId, epoch)) revert InvalidProof();

        usedNullifiers[campaignId][nullifier] = true;
        unchecked { campaign.approvedClaims++; }
        emit SponsorshipApproved(campaignId, batchId, nullifier, campaign.ruleHash, epoch);
    }
}
