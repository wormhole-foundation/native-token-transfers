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

    /// @notice Emitted when relaying is enabled for the given chain.
    /// @dev Topic0
    ///      0x528b18a533e892b5401d1fb63597275df9d2bb45b13e7695c3147cd07b9746c3.
    /// @param chainId The chain ID to set.
    /// @param isRelayingEnabled A boolean indicating whether relaying is enabled.
    event SetIsWormholeRelayingEnabled(uint16 chainId, bool isRelayingEnabled);

    /// @notice Emitted when special relaying is enabled for the given chain.
    /// @dev Topic0
    ///      0x0fe301480713b2c2072ee91b3bcfcbf2c0014f0447c89046f020f0f80727003c.
    /// @param chainId The chain ID to set.
    event SetIsSpecialRelayingEnabled(uint16 chainId, bool isRelayingEnabled);

    /// @notice Emitted when the chain is EVM compatible.
    /// @dev Topic0
    ///      0x4add57d97a7bf5035340ea1212aeeb3d4d3887eb1faf3821a8224c3a6956a10c.
    /// @param chainId The chain ID to set.
    /// @param isEvm A boolean indicating whether relaying is enabled.
    event SetIsWormholeEvmChain(uint16 chainId, bool isEvm);

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

    /// @notice Returns a boolean indicating whether Wormhole relaying is enabled for the given chain.
    /// @param chainId The Wormhole chain ID to check.
    function isWormholeRelayingEnabled(
        uint16 chainId
    ) external view returns (bool);

    /// @notice Returns a boolean indicating whether special relaying is enabled for the given chain.
    /// @param chainId The Wormhole chain ID to check.
    function isSpecialRelayingEnabled(
        uint16 chainId
    ) external view returns (bool);

    /// @notice Returns a boolean indicating whether the given chain is EVM compatible.
    /// @param chainId The Wormhole chain ID to check.
    function isWormholeEvmChain(
        uint16 chainId
    ) external view returns (bool);

    /// @notice Set the Wormhole peer contract for the given chain.
    /// @dev This function is only callable by the `owner`.
    /// @param chainId The Wormhole chain ID of the peer to set.
    /// @param peerContract The address of the peer contract on the given chain.
    function setWormholePeer(
        uint16 chainId,
        bytes32 peerContract
    ) external payable;

    /// @notice Set whether the chain is EVM compatible.
    /// @dev This function is only callable by the `owner`.
    /// @param chainId The Wormhole chain ID to set.
    /// @param isEvm A boolean indicating whether the chain is an EVM chain.
    function setIsWormholeEvmChain(
        uint16 chainId,
        bool isEvm
    ) external;

    /// @notice Set whether Wormhole relaying is enabled for the given chain.
    /// @dev This function is only callable by the `owner`.
    /// @param chainId The Wormhole chain ID to set.
    /// @param isRelayingEnabled A boolean indicating whether relaying is enabled.
    function setIsWormholeRelayingEnabled(
        uint16 chainId,
        bool isRelayingEnabled
    ) external;

    /// @notice Set whether special relaying is enabled for the given chain.
    /// @dev This function is only callable by the `owner`.
    /// @param chainId The Wormhole chain ID to set.
    /// @param isRelayingEnabled A boolean indicating whether special relaying is enabled.
    function setIsSpecialRelayingEnabled(
        uint16 chainId,
        bool isRelayingEnabled
    ) external;
}
