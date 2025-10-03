// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "../libraries/TransceiverStructs.sol";

interface IWormholeTransceiverState {
    /// @notice Emitted when a message is sent from the transceiver.
    /// @dev Topic0
    ///      0xc3192e083c87c556db539f071d8a298869f487e951327b5616a6f85ae3da958e.
    /// @param relayingType The type of relaying.
    /// @param deliveryPayment The amount of ether sent along with the tx to cover the delivery fee.
    event RelayingInfo(uint8 relayingType, bytes32 refundAddress, uint256 deliveryPayment);

    /// @notice Emitted when a peer transceiver is set.
    /// @dev Topic0
    ///      0xa559263ee060c7a2560843b3a064ff0376c9753ae3e2449b595a3b615d326466.
    /// @param chainId The chain ID of the peer.
    /// @param peerContract The address of the peer contract.
    event SetWormholePeer(uint16 chainId, bytes32 peerContract);

    /// @notice Additonal messages are not allowed.
    /// @dev Selector: 0xc504ea29.
    error UnexpectedAdditionalMessages();

    /// @notice Error if the VAA is invalid.
    /// @dev Selector: 0x8ee2e336.
    /// @param reason The reason the VAA is invalid.
    error InvalidVaa(string reason);

    /// @notice Error if the peer has already been set.
    /// @dev Selector: 0xb55eeae9.
    /// @param chainId The chain ID of the peer.
    /// @param peerAddress The address of the peer.
    error PeerAlreadySet(uint16 chainId, bytes32 peerAddress);

    /// @notice Error the peer contract cannot be the zero address.
    /// @dev Selector: 0x26e0c7de.
    error InvalidWormholePeerZeroAddress();

    /// @notice The chain ID cannot be zero.
    /// @dev Selector: 0x3dd98b24.
    error InvalidWormholeChainIdZero();

    /// @notice The caller is not the relayer.
    /// @dev Selector: 0x1c269589.
    /// @param caller The caller.
    error CallerNotRelayer(address caller);

    /// @notice Get the corresponding Transceiver contract on other chains that have been registered
    /// via governance. This design should be extendable to other chains, so each Transceiver would
    /// be potentially concerned with Transceivers on multiple other chains.
    /// @dev that peers are registered under Wormhole chain ID values.
    /// @param chainId The Wormhole chain ID of the peer to get.
    /// @return peerContract The address of the peer contract on the given chain.
    function getWormholePeer(
        uint16 chainId
    ) external view returns (bytes32);

    /// @notice Returns a boolean indicating whether the given VAA hash has been consumed.
    /// @param hash The VAA hash to check.
    function isVAAConsumed(
        bytes32 hash
    ) external view returns (bool);

    /// @notice Set the Wormhole peer contract for the given chain.
    /// @dev This function is only callable by the `owner`.
    /// @param chainId The Wormhole chain ID of the peer to set.
    /// @param peerContract The address of the peer contract on the given chain.
    function setWormholePeer(uint16 chainId, bytes32 peerContract) external payable;
}
