// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EvidenceRegistry} from "./EvidenceRegistry.sol";
import {IPoEVerifier} from "./IPoEVerifier.sol";
import {FundedSponsorshipCampaigns} from "./FundedSponsorshipCampaigns.sol";

/** V2 campaigns reject stale ongoing evidence even if an old proof still exists. */
contract FundedSponsorshipCampaignsV2 is FundedSponsorshipCampaigns {
    error EvidenceTooOld();
    error CampaignIdChanged();
    uint256 public constant MAX_EVIDENCE_AGE_SECONDS = 1 days;

    constructor(EvidenceRegistry evidenceRegistry, IPoEVerifier poeVerifier, address protocolTreasury, address acceptedFundingToken)
        FundedSponsorshipCampaigns(evidenceRegistry, poeVerifier, protocolTreasury, acceptedFundingToken) {}

    /** Useful for retrospective cohorts: prebuild a root for the exact next ID. */
    function fundAndActivateWithExpectedId(
        uint256 expectedCampaignId,
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
    ) external returns (uint256 campaignId) {
        if (campaignCount + 1 != expectedCampaignId) revert CampaignIdChanged();
        return fundAndActivate(acceptedToken, paymentAmount, manifestHash, ruleHash, snapshotRoot,
            mode, startsAt, endsAt, totalTimeMinutes, timePerClaimMinutes, claimPeriodSeconds);
    }

    function claim(
        uint256 campaignId,
        uint256 batchId,
        bytes32 nullifier,
        bytes32 suppliedRuleHash,
        uint256 epoch,
        bytes calldata proof
    ) public override {
        Campaign storage campaign = campaigns[campaignId];
        if (campaign.advertiser != address(0) && campaign.mode == EligibilityMode.ONGOING) {
            (,, uint64 committedAt,) = registry.batches(batchId);
            if (committedAt == 0 || block.timestamp - committedAt > MAX_EVIDENCE_AGE_SECONDS) revert EvidenceTooOld();
        }
        super.claim(campaignId, batchId, nullifier, suppliedRuleHash, epoch, proof);
    }
}
