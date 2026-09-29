// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IPoEVerifier} from "./IPoEVerifier.sol";

/** TEST ONLY: accepts the fixture proof "poe-demo-proof". */
contract MockPoEVerifier is IPoEVerifier {
    function verify(bytes calldata proof, bytes32, bytes32, bytes32, uint256, uint256) external pure returns (bool) {
        return keccak256(proof) == keccak256("poe-demo-proof");
    }
}
