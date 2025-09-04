// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

/// @dev This contract manages a registry of known blockchain networks (chains).
abstract contract ChainRegistry {
    bytes32 private constant KNOWN_CHAINS_SLOT = bytes32(uint256(keccak256("ntt.knownChains")) - 1);

    function _getKnownChainsStorage() internal pure returns (uint16[] storage $) {
        uint256 slot = uint256(KNOWN_CHAINS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    /// @notice Add a chain to the known chains list if not already present
    function _addToKnownChains(
        uint16 chainId
    ) internal {
        uint16[] storage knownChains = _getKnownChainsStorage();

        for (uint256 i = 0; i < knownChains.length; i++) {
            if (knownChains[i] == chainId) return;
        }

        knownChains.push(chainId);
    }

    /// @notice Get all known chains
    /// @return The array of known chain IDs
    function getKnownChains() public pure returns (uint16[] memory) {
        return _getKnownChainsStorage();
    }
}
