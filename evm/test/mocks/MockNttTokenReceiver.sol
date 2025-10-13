// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "../../src/interfaces/INttTokenReceiver.sol";

/// @title MockNttTokenReceiver
/// @notice Mock implementation of INttTokenReceiver for testing
contract MockNttTokenReceiver is INttTokenReceiver {
    // Events for testing
    event TokenReceived(
        address indexed token,
        uint256 amount,
        bytes payload,
        uint16 indexed sourceChain,
        bytes32 indexed sourceAddress
    );

    // Configuration for testing different behaviors
    bool public shouldRevert = false;
    bool public checkCaller = true; // By default, check caller
    address public trustedMultiTokenNtt;

    // Store last received payload for testing
    bytes public lastReceivedPayload;
    address public lastReceivedToken;
    uint256 public lastReceivedAmount;
    uint16 public lastReceivedSourceChain;
    bytes32 public lastReceivedSourceAddress;

    /// @notice Constructor to set the trusted MultiTokenNtt contract
    constructor(
        address _trustedMultiTokenNtt
    ) {
        trustedMultiTokenNtt = _trustedMultiTokenNtt;
    }

    /// @notice Configure whether to check the caller
    function setCheckCaller(
        bool _checkCaller
    ) external {
        checkCaller = _checkCaller;
    }

    /// @notice Update the trusted MultiTokenNtt contract address
    function setTrustedMultiTokenNtt(
        address _trustedMultiTokenNtt
    ) external {
        trustedMultiTokenNtt = _trustedMultiTokenNtt;
    }

    /// @notice Configure the mock to revert
    function setShouldRevert(
        bool _revert
    ) external {
        shouldRevert = _revert;
    }

    /// @inheritdoc INttTokenReceiver
    function onNttTokenReceived(
        address token,
        uint256 amount,
        bytes calldata payload,
        uint16 sourceChain,
        bytes32 sourceAddress
    ) external {
        // SECURITY CRITICAL: Verify caller is trusted MultiTokenNtt contract
        if (checkCaller) {
            require(msg.sender == trustedMultiTokenNtt, "MockNttTokenReceiver: unauthorized caller");
        }

        if (shouldRevert) {
            revert("MockNttTokenReceiver: intentional revert");
        }

        // Store the received data for testing verification
        lastReceivedPayload = payload;
        lastReceivedToken = token;
        lastReceivedAmount = amount;
        lastReceivedSourceChain = sourceChain;
        lastReceivedSourceAddress = sourceAddress;

        emit TokenReceived(token, amount, payload, sourceChain, sourceAddress);
    }
}

/// @title MockNonReceiver
/// @notice Contract that doesn't implement INttTokenReceiver (for testing)
contract MockNonReceiver {
    event TokenReceived(address token, uint256 amount);

    // This contract doesn't implement INttTokenReceiver
    // It will receive tokens but won't get callbacks

    function receiveTokens(address token, uint256 amount) external {
        emit TokenReceived(token, amount);
    }
}

/// @title MockRevertingReceiver
/// @notice Contract that implements INttTokenReceiver but always reverts
contract MockRevertingReceiver is INttTokenReceiver {
    address public trustedMultiTokenNtt;

    constructor(
        address _trustedMultiTokenNtt
    ) {
        trustedMultiTokenNtt = _trustedMultiTokenNtt;
    }

    /// @inheritdoc INttTokenReceiver
    function onNttTokenReceived(address, uint256, bytes calldata, uint16, bytes32) external view {
        // SECURITY CRITICAL: Verify caller is trusted MultiTokenNtt contract
        require(msg.sender == trustedMultiTokenNtt, "MockRevertingReceiver: unauthorized caller");

        revert("MockRevertingReceiver: always reverts");
    }
}
