// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Immutable registry of signed/committed experience-evidence batches.
 *
 * It stores no user identifier, browsing history, raw receipt, or wallet link.
 * The issuer commits a Merkle root; a later ZK proof demonstrates membership
 * and eligibility without disclosing the leaf.
 */
contract EvidenceRegistry {
    error NotOwner();
    error NotIssuer();
    error InvalidIssuer();
    error EmptyRoot();

    struct Batch {
        bytes32 root;
        bytes32 policyHash;
        uint64 committedAt;
        address issuer;
    }

    address public immutable owner;
    mapping(address => bool) public issuers;
    mapping(uint256 => Batch) public batches;
    uint256 public batchCount;

    event IssuerUpdated(address indexed issuer, bool allowed);
    event EvidenceCommitted(
        uint256 indexed batchId,
        bytes32 indexed root,
        bytes32 indexed policyHash,
        address issuer
    );

    constructor(address initialIssuer) {
        owner = msg.sender;
        _setIssuer(initialIssuer, true);
    }

    function setIssuer(address issuer, bool allowed) external {
        if (msg.sender != owner) revert NotOwner();
        _setIssuer(issuer, allowed);
    }

    function commitEvidence(bytes32 root, bytes32 policyHash) external returns (uint256 batchId) {
        if (!issuers[msg.sender]) revert NotIssuer();
        if (root == bytes32(0) || policyHash == bytes32(0)) revert EmptyRoot();
        batchId = ++batchCount;
        batches[batchId] = Batch(root, policyHash, uint64(block.timestamp), msg.sender);
        emit EvidenceCommitted(batchId, root, policyHash, msg.sender);
    }

    function _setIssuer(address issuer, bool allowed) private {
        if (issuer == address(0)) revert InvalidIssuer();
        issuers[issuer] = allowed;
        emit IssuerUpdated(issuer, allowed);
    }
}
