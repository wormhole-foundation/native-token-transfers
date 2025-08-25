// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "../interfaces/IManagerBase.sol";

/// @title TransceiverRegistry
/// @author Wormhole Project Contributors.
/// @notice This contract is responsible for handling the registration of Transceivers.
/// @dev This contract checks that a few critical invariants hold when transceivers are added or removed,
///      including:
///         1. If a transceiver is not registered, it should be enabled.
///         2. The value set in the bitmap of trannsceivers
///            should directly correspond to the whether the transceiver is enabled
abstract contract TransceiverRegistry {
    constructor() {
        // Per-chain configuration is now required, so no global invariants to check
    }

    /// @dev Information about registered transceivers.
    struct TransceiverInfo {
        // whether this transceiver is registered
        bool registered;
        // whether this transceiver is enabled
        bool enabled;
        uint8 index;
    }

    /// @dev Struct representing a transceiver address with its index
    struct TransceiverWithIndex {
        address transceiver;
        uint8 index;
    }

    /// @dev Bitmap encoding the enabled transceivers.
    /// invariant: forall (i: uint8), enabledTransceiverBitmap & i == 1 <=> transceiverInfos[i].enabled
    struct _EnabledTransceiverBitmap {
        uint64 bitmap;
    }

    /// @dev Total number of registered transceivers. This number can only increase.
    /// invariant: numRegisteredTransceivers <= MAX_TRANSCEIVERS
    /// invariant: forall (i: uint8),
    ///   i < numRegisteredTransceivers <=> exists (a: address), transceiverInfos[a].index == i
    struct _NumTransceivers {
        uint8 registered;
        uint8 enabled;
    }

    /// @dev Common fields shared by both send and receive transceiver configs
    struct TransceiverConfig {
        uint64 bitmap; // Bitmap of enabled transceivers
        address[] transceivers; // Array of enabled transceivers
    }

    /// @dev Per-chain configuration for sending transceivers
    struct PerChainSendTransceiverConfig {
        TransceiverConfig config; // Common transceiver configuration
    }

    /// @dev Per-chain configuration for receiving transceivers
    struct PerChainReceiveTransceiverConfig {
        TransceiverConfig config; // Common transceiver configuration
        uint8 threshold; // Threshold for receiving from this chain
    }

    uint8 constant MAX_TRANSCEIVERS = 64;

    /// @notice Error when the caller is not the transceiver.
    /// @dev Selector 0xa0ae911d.
    /// @param caller The address of the caller.
    error CallerNotTransceiver(address caller);

    /// @notice Error when the transceiver is the zero address.
    /// @dev Selector 0x2f44bd77.
    error InvalidTransceiverZeroAddress();

    /// @notice Error when the transceiver is disabled.
    /// @dev Selector 0x1f61ba44.
    error DisabledTransceiver(address transceiver);

    /// @notice Error when the number of registered transceivers
    ///         exceeeds (MAX_TRANSCEIVERS = 64).
    /// @dev Selector 0x891684c3.
    error TooManyTransceivers();

    /// @notice Error when attempting to remove a transceiver
    ///         that is not registered.
    /// @dev Selector 0xd583f470.
    /// @param transceiver The address of the transceiver.
    error NonRegisteredTransceiver(address transceiver);

    /// @notice Error when attempting to enable a transceiver that is already enabled.
    /// @dev Selector 0x8d68f84d.
    /// @param transceiver The address of the transceiver.
    error TransceiverAlreadyEnabled(address transceiver);
    error NoTransceiversConfiguredForChain(uint16 chainId);
    error NoThresholdConfiguredForChain(uint16 chainId);
    error InvalidChainId();

    modifier onlyTransceiver() {
        // TODO: change this to take chain id as argument (and accordingly look up whether it's enabled for that chain)
        if (!_getTransceiverInfosStorage()[msg.sender].enabled) {
            revert CallerNotTransceiver(msg.sender);
        }
        _;
    }

    // =============== Storage ===============================================

    bytes32 private constant TRANSCEIVER_INFOS_SLOT =
        bytes32(uint256(keccak256("ntt.transceiverInfos")) - 1);

    bytes32 private constant TRANSCEIVER_BITMAP_SLOT =
        bytes32(uint256(keccak256("ntt.transceiverBitmap")) - 1);

    bytes32 private constant ENABLED_TRANSCEIVERS_SLOT =
        bytes32(uint256(keccak256("ntt.enabledTransceivers")) - 1);

    bytes32 private constant REGISTERED_TRANSCEIVERS_SLOT =
        bytes32(uint256(keccak256("ntt.registeredTransceivers")) - 1);

    bytes32 private constant NUM_REGISTERED_TRANSCEIVERS_SLOT =
        bytes32(uint256(keccak256("ntt.numRegisteredTransceivers")) - 1);

    bytes32 private constant PER_CHAIN_SEND_TRANSCEIVERS_SLOT =
        bytes32(uint256(keccak256("ntt.perChainSendTransceivers")) - 1);

    bytes32 private constant PER_CHAIN_RECEIVE_TRANSCEIVERS_SLOT =
        bytes32(uint256(keccak256("ntt.perChainReceiveTransceivers")) - 1);

    function _getTransceiverInfosStorage()
        internal
        pure
        returns (mapping(address => TransceiverInfo) storage $)
    {
        uint256 slot = uint256(TRANSCEIVER_INFOS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getEnabledTransceiversStorage() internal pure returns (address[] storage $) {
        uint256 slot = uint256(ENABLED_TRANSCEIVERS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getTransceiverBitmapStorage()
        private
        pure
        returns (_EnabledTransceiverBitmap storage $)
    {
        uint256 slot = uint256(TRANSCEIVER_BITMAP_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getRegisteredTransceiversStorage() internal pure returns (address[] storage $) {
        uint256 slot = uint256(REGISTERED_TRANSCEIVERS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getNumTransceiversStorage() internal pure returns (_NumTransceivers storage $) {
        uint256 slot = uint256(NUM_REGISTERED_TRANSCEIVERS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getPerChainSendTransceiversStorage()
        internal
        pure
        returns (mapping(uint16 => PerChainSendTransceiverConfig) storage $)
    {
        uint256 slot = uint256(PER_CHAIN_SEND_TRANSCEIVERS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    function _getPerChainReceiveTransceiversStorage()
        internal
        pure
        returns (mapping(uint16 => PerChainReceiveTransceiverConfig) storage $)
    {
        uint256 slot = uint256(PER_CHAIN_RECEIVE_TRANSCEIVERS_SLOT);
        assembly ("memory-safe") {
            $.slot := slot
        }
    }

    // =============== Storage Getters/Setters ========================================

    function _setTransceiver(
        address transceiver
    ) internal returns (uint8 index) {
        mapping(address => TransceiverInfo) storage transceiverInfos = _getTransceiverInfosStorage();
        _EnabledTransceiverBitmap storage _enabledTransceiverBitmap = _getTransceiverBitmapStorage();
        address[] storage _enabledTransceivers = _getEnabledTransceiversStorage();

        _NumTransceivers storage _numTransceivers = _getNumTransceiversStorage();

        if (transceiver == address(0)) {
            revert InvalidTransceiverZeroAddress();
        }

        if (transceiverInfos[transceiver].registered) {
            transceiverInfos[transceiver].enabled = true;
        } else {
            if (_numTransceivers.registered >= MAX_TRANSCEIVERS) {
                revert TooManyTransceivers();
            }

            transceiverInfos[transceiver] = TransceiverInfo({
                registered: true,
                enabled: true,
                index: _numTransceivers.registered
            });
            _numTransceivers.registered++;
            _getRegisteredTransceiversStorage().push(transceiver);
        }

        _enabledTransceivers.push(transceiver);
        _numTransceivers.enabled++;

        uint64 updatedEnabledTransceiverBitmap =
            _enabledTransceiverBitmap.bitmap | uint64(1 << transceiverInfos[transceiver].index);
        // ensure that this actually changed the bitmap
        if (updatedEnabledTransceiverBitmap == _enabledTransceiverBitmap.bitmap) {
            revert TransceiverAlreadyEnabled(transceiver);
        }
        _enabledTransceiverBitmap.bitmap = updatedEnabledTransceiverBitmap;

        _checkTransceiversInvariants();

        return transceiverInfos[transceiver].index;
    }

    function _removeTransceiver(
        address transceiver
    ) internal {
        mapping(address => TransceiverInfo) storage transceiverInfos = _getTransceiverInfosStorage();
        _EnabledTransceiverBitmap storage _enabledTransceiverBitmap = _getTransceiverBitmapStorage();
        address[] storage _enabledTransceivers = _getEnabledTransceiversStorage();

        if (transceiver == address(0)) {
            revert InvalidTransceiverZeroAddress();
        }

        if (!transceiverInfos[transceiver].registered) {
            revert NonRegisteredTransceiver(transceiver);
        }

        if (!transceiverInfos[transceiver].enabled) {
            revert DisabledTransceiver(transceiver);
        }

        transceiverInfos[transceiver].enabled = false;
        _getNumTransceiversStorage().enabled--;

        uint64 updatedEnabledTransceiverBitmap =
            _enabledTransceiverBitmap.bitmap & uint64(~(1 << transceiverInfos[transceiver].index));
        // ensure that this actually changed the bitmap
        assert(updatedEnabledTransceiverBitmap < _enabledTransceiverBitmap.bitmap);
        _enabledTransceiverBitmap.bitmap = updatedEnabledTransceiverBitmap;

        bool removed = false;

        uint256 numEnabledTransceivers = _enabledTransceivers.length;
        for (uint256 i = 0; i < numEnabledTransceivers; i++) {
            if (_enabledTransceivers[i] == transceiver) {
                _enabledTransceivers[i] = _enabledTransceivers[numEnabledTransceivers - 1];
                _enabledTransceivers.pop();
                removed = true;
                break;
            }
        }
        assert(removed);

        _checkTransceiversInvariants();
        // we call the invariant check on the transceiver here as well, since
        // the above check only iterates through the enabled transceivers.
        _checkTransceiverInvariants(transceiver);
    }

    function _getEnabledTransceiversBitmap() internal view virtual returns (uint64 bitmap) {
        return _getTransceiverBitmapStorage().bitmap;
    }

    /// @notice Returns the Transceiver contracts that have been enabled via governance.
    function getTransceivers() external pure returns (address[] memory result) {
        result = _getEnabledTransceiversStorage();
    }

    /// @notice Returns the info for all enabled transceivers
    function getTransceiverInfo() external view returns (TransceiverInfo[] memory) {
        address[] memory enabledTransceivers = _getEnabledTransceiversStorage();
        uint256 numEnabledTransceivers = enabledTransceivers.length;
        TransceiverInfo[] memory result = new TransceiverInfo[](numEnabledTransceivers);

        for (uint256 i = 0; i < numEnabledTransceivers; ++i) {
            result[i] = _getTransceiverInfosStorage()[enabledTransceivers[i]];
        }

        return result;
    }

    // =============== Generic Helper Functions =========================================

    /// @dev Generic function to add transceiver to any config
    /// @param chainId The chain ID for validation
    /// @param transceiver The transceiver address to add
    /// @param config The transceiver config to modify
    function _addTransceiverToConfig(
        uint16 chainId,
        address transceiver,
        TransceiverConfig storage config
    ) internal {
        mapping(address => TransceiverInfo) storage transceiverInfos = _getTransceiverInfosStorage();

        if (transceiver == address(0)) {
            revert InvalidTransceiverZeroAddress();
        }

        if (chainId == 0) {
            revert InvalidChainId();
        }

        // Transceiver must be registered
        if (!transceiverInfos[transceiver].registered) {
            revert NonRegisteredTransceiver(transceiver);
        }

        uint8 index = transceiverInfos[transceiver].index;
        uint64 transceiverBit = uint64(1 << index);

        // Check if already enabled for this chain
        if ((config.bitmap & transceiverBit) != 0) {
            revert TransceiverAlreadyEnabled(transceiver);
        }

        // Add to configuration
        config.bitmap |= transceiverBit;
        config.transceivers.push(transceiver);
    }

    /// @dev Generic function to remove transceiver from any config
    /// @param transceiver The transceiver address to remove
    /// @param config The transceiver config to modify
    /// @return remainingCount The number of transceivers remaining after removal
    function _removeTransceiverFromConfig(
        address transceiver,
        TransceiverConfig storage config
    ) internal returns (uint8 remainingCount) {
        mapping(address => TransceiverInfo) storage transceiverInfos = _getTransceiverInfosStorage();

        if (transceiver == address(0)) {
            revert InvalidTransceiverZeroAddress();
        }

        if (!transceiverInfos[transceiver].registered) {
            revert NonRegisteredTransceiver(transceiver);
        }

        uint8 index = transceiverInfos[transceiver].index;
        uint64 transceiverBit = uint64(1 << index);

        // Check if enabled for this chain
        if ((config.bitmap & transceiverBit) == 0) {
            revert DisabledTransceiver(transceiver);
        }

        // Remove from configuration
        config.bitmap &= ~transceiverBit;

        // Remove from array
        bool removed = false;
        uint256 numEnabled = config.transceivers.length;
        for (uint256 i = 0; i < numEnabled; i++) {
            if (config.transceivers[i] == transceiver) {
                config.transceivers[i] = config.transceivers[numEnabled - 1];
                config.transceivers.pop();
                removed = true;
                break;
            }
        }
        assert(removed);

        return uint8(config.transceivers.length);
    }

    // =============== Per-Chain Configuration Functions ===============================

    /// @notice Add a transceiver for sending to a specific chain
    /// @param targetChain The chain ID to send to
    /// @param transceiver The transceiver to enable for sending to this chain
    function _setSendTransceiverForChain(uint16 targetChain, address transceiver) internal {
        PerChainSendTransceiverConfig storage sendConfig =
            _getPerChainSendTransceiversStorage()[targetChain];
        _addTransceiverToConfig(targetChain, transceiver, sendConfig.config);
    }

    /// @notice Remove a transceiver for sending to a specific chain
    /// @param targetChain The chain ID
    /// @param transceiver The transceiver to disable for sending to this chain
    function _removeSendTransceiverForChain(uint16 targetChain, address transceiver) internal {
        PerChainSendTransceiverConfig storage sendConfig =
            _getPerChainSendTransceiversStorage()[targetChain];
        _removeTransceiverFromConfig(transceiver, sendConfig.config);
    }

    /// @notice Add a transceiver for receiving from a specific chain
    /// @param sourceChain The chain ID to receive from
    /// @param transceiver The transceiver to enable for receiving from this chain
    function _setReceiveTransceiverForChain(uint16 sourceChain, address transceiver) internal {
        PerChainReceiveTransceiverConfig storage receiveConfig =
            _getPerChainReceiveTransceiversStorage()[sourceChain];

        _addTransceiverToConfig(sourceChain, transceiver, receiveConfig.config);

        // Set default threshold to 1 if not set
        if (receiveConfig.threshold == 0) {
            receiveConfig.threshold = 1;
        }
    }

    /// @notice Remove a transceiver for receiving from a specific chain
    /// @param sourceChain The chain ID
    /// @param transceiver The transceiver to disable for receiving from this chain
    function _removeReceiveTransceiverForChain(uint16 sourceChain, address transceiver) internal {
        PerChainReceiveTransceiverConfig storage receiveConfig =
            _getPerChainReceiveTransceiversStorage()[sourceChain];

        uint8 remainingCount = _removeTransceiverFromConfig(transceiver, receiveConfig.config);

        // Adjust threshold if necessary
        if (receiveConfig.threshold > remainingCount) {
            receiveConfig.threshold = remainingCount;
        }
    }

    /// @notice Set the threshold for receiving from a specific chain
    /// @param sourceChain The chain ID
    /// @param threshold The threshold for receiving from this chain
    function _setThresholdForChain(uint16 sourceChain, uint8 threshold) internal {
        if (sourceChain == 0) {
            revert InvalidChainId();
        }

        if (threshold == 0) {
            revert IManagerBase.ZeroThreshold();
        }

        PerChainReceiveTransceiverConfig storage receiveConfig =
            _getPerChainReceiveTransceiversStorage()[sourceChain];
        uint8 numEnabled = uint8(receiveConfig.config.transceivers.length);

        if (threshold > numEnabled) {
            revert IManagerBase.ThresholdTooHigh(uint256(threshold), uint256(numEnabled));
        }

        receiveConfig.threshold = threshold;
    }

    /// @notice Get the transceivers enabled for sending to a specific chain
    /// @param targetChain The chain ID
    /// @return transceivers The list of enabled transceivers for sending
    function getSendTransceiversForChain(
        uint16 targetChain
    ) public view returns (address[] memory transceivers) {
        PerChainSendTransceiverConfig storage sendConfig =
            _getPerChainSendTransceiversStorage()[targetChain];
        if (sendConfig.config.transceivers.length == 0) {
            revert NoTransceiversConfiguredForChain(targetChain);
        }
        return sendConfig.config.transceivers;
    }

    /// @notice Get the transceivers enabled for receiving from a specific chain
    /// @param sourceChain The chain ID
    /// @return transceivers The list of enabled transceivers for receiving
    /// @return threshold The threshold for this chain
    function getReceiveTransceiversForChain(
        uint16 sourceChain
    ) public view returns (address[] memory transceivers, uint8 threshold) {
        PerChainReceiveTransceiverConfig storage receiveConfig =
            _getPerChainReceiveTransceiversStorage()[sourceChain];
        if (receiveConfig.config.transceivers.length == 0 || receiveConfig.threshold == 0) {
            revert NoTransceiversConfiguredForChain(sourceChain);
        }
        return (receiveConfig.config.transceivers, receiveConfig.threshold);
    }

    /// @notice Get the bitmap of transceivers enabled for sending to a specific chain
    /// @param targetChain The chain ID
    /// @return bitmap The bitmap of enabled transceivers
    function _getSendTransceiversBitmapForChain(
        uint16 targetChain
    ) internal view returns (uint64 bitmap) {
        PerChainSendTransceiverConfig storage sendConfig =
            _getPerChainSendTransceiversStorage()[targetChain];
        if (sendConfig.config.transceivers.length == 0) {
            revert NoTransceiversConfiguredForChain(targetChain);
        }
        return sendConfig.config.bitmap;
    }

    /// @notice Get the bitmap of transceivers enabled for receiving from a specific chain
    /// @param sourceChain The chain ID
    /// @return bitmap The bitmap of enabled transceivers
    function _getReceiveTransceiversBitmapForChain(
        uint16 sourceChain
    ) internal view returns (uint64 bitmap) {
        PerChainReceiveTransceiverConfig storage receiveConfig =
            _getPerChainReceiveTransceiversStorage()[sourceChain];
        if (receiveConfig.config.transceivers.length == 0 || receiveConfig.threshold == 0) {
            revert NoTransceiversConfiguredForChain(sourceChain);
        }
        return receiveConfig.config.bitmap;
    }

    /// @notice Get the threshold for receiving from a specific chain
    /// @param sourceChain The chain ID
    /// @return threshold The threshold for this chain
    function _getThresholdForChain(
        uint16 sourceChain
    ) internal view returns (uint8 threshold) {
        PerChainReceiveTransceiverConfig storage receiveConfig =
            _getPerChainReceiveTransceiversStorage()[sourceChain];
        if (receiveConfig.threshold == 0) {
            revert NoThresholdConfiguredForChain(sourceChain);
        }
        return receiveConfig.threshold;
    }

    /// @dev Internal helper to get transceivers with indices from a TransceiverConfig
    /// @param config The transceiver config storage pointer
    /// @return transceivers Array of (address, index) pairs for enabled transceivers
    function _getTransceiversWithIndicesFromConfig(
        TransceiverConfig storage config
    ) internal view returns (TransceiverWithIndex[] memory transceivers) {
        address[] memory transceiverAddresses = config.transceivers;
        transceivers = new TransceiverWithIndex[](transceiverAddresses.length);

        mapping(address => TransceiverInfo) storage transceiverInfos = _getTransceiverInfosStorage();

        for (uint256 i = 0; i < transceiverAddresses.length; i++) {
            transceivers[i] = TransceiverWithIndex({
                transceiver: transceiverAddresses[i],
                index: transceiverInfos[transceiverAddresses[i]].index
            });
        }

        return transceivers;
    }

    /// @notice Get the transceivers with their indices enabled for sending to a specific chain
    /// @param targetChain The chain ID
    /// @return transceivers Array of (address, index) pairs for enabled send transceivers
    function getSendTransceiversWithIndicesForChain(
        uint16 targetChain
    ) public view returns (TransceiverWithIndex[] memory transceivers) {
        PerChainSendTransceiverConfig storage sendConfig =
            _getPerChainSendTransceiversStorage()[targetChain];
        return _getTransceiversWithIndicesFromConfig(sendConfig.config);
    }

    /// @notice Get the transceivers with their indices enabled for receiving from a specific chain
    /// @param sourceChain The chain ID
    /// @return transceivers Array of (address, index) pairs for enabled receive transceivers
    function getReceiveTransceiversWithIndicesForChain(
        uint16 sourceChain
    ) public view returns (TransceiverWithIndex[] memory transceivers) {
        PerChainReceiveTransceiverConfig storage receiveConfig =
            _getPerChainReceiveTransceiversStorage()[sourceChain];
        return _getTransceiversWithIndicesFromConfig(receiveConfig.config);
    }

    // ============== Invariants =============================================

    /// @dev Check that the transceiver nttManager is in a valid state.
    /// Checking these invariants is somewhat costly, but we only need to do it
    /// when modifying the transceivers, which happens infrequently.
    function _checkTransceiversInvariants() internal view {
        _NumTransceivers storage _numTransceivers = _getNumTransceiversStorage();
        address[] storage _enabledTransceivers = _getEnabledTransceiversStorage();

        uint256 numTransceiversEnabled = _numTransceivers.enabled;
        assert(numTransceiversEnabled == _enabledTransceivers.length);

        for (uint256 i = 0; i < numTransceiversEnabled; i++) {
            _checkTransceiverInvariants(_enabledTransceivers[i]);
        }

        // invariant: each transceiver is only enabled once
        for (uint256 i = 0; i < numTransceiversEnabled; i++) {
            for (uint256 j = i + 1; j < numTransceiversEnabled; j++) {
                assert(_enabledTransceivers[i] != _enabledTransceivers[j]);
            }
        }

        // invariant: numRegisteredTransceivers <= MAX_TRANSCEIVERS
        assert(_numTransceivers.registered <= MAX_TRANSCEIVERS);
    }

    // @dev Check that the transceiver is in a valid state.
    function _checkTransceiverInvariants(
        address transceiver
    ) private view {
        mapping(address => TransceiverInfo) storage transceiverInfos = _getTransceiverInfosStorage();
        _EnabledTransceiverBitmap storage _enabledTransceiverBitmap = _getTransceiverBitmapStorage();
        _NumTransceivers storage _numTransceivers = _getNumTransceiversStorage();
        address[] storage _enabledTransceivers = _getEnabledTransceiversStorage();

        TransceiverInfo memory transceiverInfo = transceiverInfos[transceiver];

        // if an transceiver is not registered, it should not be enabled
        assert(
            transceiverInfo.registered || (!transceiverInfo.enabled && transceiverInfo.index == 0)
        );

        bool transceiverInEnabledBitmap =
            (_enabledTransceiverBitmap.bitmap & uint64(1 << transceiverInfo.index)) != 0;
        bool transceiverEnabled = transceiverInfo.enabled;

        bool transceiverInEnabledTransceivers = false;

        for (uint256 i = 0; i < _numTransceivers.enabled; i++) {
            if (_enabledTransceivers[i] == transceiver) {
                transceiverInEnabledTransceivers = true;
                break;
            }
        }

        // invariant: transceiverInfos[transceiver].enabled
        //            <=> enabledTransceiverBitmap & (1 << transceiverInfos[transceiver].index) != 0
        assert(transceiverInEnabledBitmap == transceiverEnabled);

        // invariant: transceiverInfos[transceiver].enabled <=> transceiver in _enabledTransceivers
        assert(transceiverInEnabledTransceivers == transceiverEnabled);

        assert(transceiverInfo.index < _numTransceivers.registered);
    }
}
