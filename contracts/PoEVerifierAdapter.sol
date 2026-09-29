// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoEVerifier} from "./IPoEVerifier.sol";

interface IPoEGroth16Verifier {
    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[5] calldata publicSignals
    ) external view returns (bool);
}

/** Decodes a standard snarkjs Groth16 proof and fixes the public-input order. */
contract PoEVerifierAdapter is IPoEVerifier {
    IPoEGroth16Verifier public immutable groth16Verifier;

    constructor(IPoEGroth16Verifier verifier) {
        require(address(verifier) != address(0), "verifier required");
        groth16Verifier = verifier;
    }

    function verify(
        bytes calldata proof,
        bytes32 evidenceRoot,
        bytes32 ruleHash,
        bytes32 nullifier,
        uint256 campaignId,
        uint256 epoch
    ) external view returns (bool) {
        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) =
            abi.decode(proof, (uint256[2], uint256[2][2], uint256[2]));
        uint256[5] memory publicSignals = [
            uint256(evidenceRoot), uint256(ruleHash), uint256(nullifier), campaignId, epoch
        ];
        return groth16Verifier.verifyProof(a, b, c, publicSignals);
    }
}
