// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Adapter boundary for a generated ZK verifier.
 *
 * A production verifier must validate a proof over these public inputs. The
 * demo verifier is deliberately separate and must never be used on mainnet.
 */
interface IPoEVerifier {
    function verify(
        bytes calldata proof,
        bytes32 evidenceRoot,
        bytes32 ruleHash,
        bytes32 nullifier,
        uint256 campaignId,
        uint256 epoch
    ) external view returns (bool);
}
