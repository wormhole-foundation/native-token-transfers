// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "./IManagerBase.sol";

interface IGmpManager is IManagerBase {
    /// @notice The caller is not the deployer.
    error UnexpectedDeployer(address expectedOwner, address owner);

    /// @notice An unexpected msg.value was passed with the call
    /// @dev Selector 0xbd28e889.
    error UnexpectedMsgValue();

    error InvalidTargetChain(uint16 targetChain, uint16 chainId);
    error CallFailed(bytes returnData);
    error InvalidCallee();
    error InvalidEvmAddress();
    error SequenceNotReserved(uint64 sequence);
    error SequenceNotReservedBySender(uint64 sequence, address sender);

    /// @notice Emitted when a message is sent to another chain
    /// @param sequence The sequence number of the message
    /// @param sender The address of the message sender
    /// @param targetChain The chain ID of the target chain
    /// @param callee The address of the contract to call on the target chain
    /// @param data The calldata to be executed on the target chain
    /// @param fee The total fee paid for sending the message
    event MessageSent(
        uint64 indexed sequence,
        address indexed sender,
        uint16 targetChain,
        bytes32 callee,
        bytes data,
        uint256 fee
    );

    /// @notice Emitted when a message is executed on this chain
    /// @param messageHash The hash of the executed message
    /// @param sourceChain The chain ID of the source chain
    /// @param sender The address of the message sender on the source chain
    /// @param callee The address of the contract called on this chain
    /// @param data The calldata executed on this chain
    event MessageExecuted(
        bytes32 indexed messageHash,
        uint16 indexed sourceChain,
        bytes32 indexed sender,
        address callee,
        bytes data
    );

    /// @notice Emitted when a peer is updated
    /// @param chainId The chain ID of the updated peer
    /// @param oldPeerAddress The previous address of the peer
    /// @param newPeerAddress The new address of the peer
    event PeerUpdated(uint16 indexed chainId, bytes32 oldPeerAddress, bytes32 newPeerAddress);

    /**
     * @notice Reserve a message sequence number for later use
     * @dev Sequence numbers start at 1 to allow 0 as sentinel value for "no reserved sequence"
     * @dev Reserved sequences are per-sender and single-use
     * @return sequence The reserved sequence number
     */
    function reserveMessageSequence() external returns (uint64 sequence);

    /**
     * @notice Send a cross-chain message with optional sequence reservation
     * @dev Pass reservedSequence = 0 for immediate allocation, or a pre-reserved sequence number
     * @param targetChain The Wormhole chain ID of the target chain
     * @param callee The target contract address (32-byte format)
     * @param refundAddress The refund address (32-byte format)
     * @param reservedSequence Pre-reserved sequence (0 for immediate allocation)
     * @param data The calldata to execute on target chain
     * @param transceiverInstructions Instructions for transceivers
     * @return sequence The sequence number assigned to this message
     */
    function sendMessage(
        uint16 targetChain,
        bytes32 callee,
        bytes32 refundAddress,
        uint64 reservedSequence,
        bytes calldata data,
        bytes calldata transceiverInstructions
    ) external payable returns (uint64 sequence);
}
