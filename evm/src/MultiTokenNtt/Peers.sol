// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

abstract contract Peers {
    error InvalidPeerChainIdZero();
    error InvalidPeerZeroAddress();
    error InvalidPeer(uint16 chainId, bytes32 peerAddress);

    event PeerUpdated(uint16 chainId, bytes32 oldPeerAddress, bytes32 newPeerAddress);

    bytes32 private constant PEERS_SLOT = bytes32(uint256(keccak256("ntt.peers")) - 1);

    struct Peer {
        bytes32 peerAddress;
    }

    function _getPeersStorage() internal pure returns (mapping(uint16 => Peer) storage $) {
        uint256 slot = uint256(PEERS_SLOT);
        assembly {
            $.slot := slot
        }
    }

    function getPeer(
        uint16 chainId_
    ) external view returns (Peer memory) {
        return _getPeersStorage()[chainId_];
    }

    /// @dev Verify that the peer address saved for `sourceChainId` matches the `peerAddress`.
    function _verifyPeer(uint16 sourceChainId, bytes32 peerAddress) internal view {
        if (sourceChainId == 0) {
            revert InvalidPeerChainIdZero();
        }
        if (peerAddress == bytes32(0)) {
            revert InvalidPeerZeroAddress();
        }
        if (_getPeersStorage()[sourceChainId].peerAddress != peerAddress) {
            revert InvalidPeer(sourceChainId, peerAddress);
        }
    }

    function _setPeer(uint16 chainId, bytes32 peerAddress) internal {
        if (chainId == 0) {
            revert InvalidPeerChainIdZero();
        }
        if (peerAddress == bytes32(0)) {
            revert InvalidPeerZeroAddress();
        }

        Peer memory oldPeer = _getPeersStorage()[chainId];

        _getPeersStorage()[chainId].peerAddress = peerAddress;

        emit PeerUpdated(chainId, oldPeer.peerAddress, peerAddress);
    }
}
