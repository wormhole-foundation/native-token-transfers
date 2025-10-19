// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "../GmpManager/GmpManager.sol";
import "../GmpManager/GmpIntegration.sol";
import "../libraries/MultiTokenRateLimiter.sol";
import "../libraries/TokenId.sol";
import "../libraries/TokenMeta.sol";
import "../libraries/TokenInfo.sol";
import "../libraries/NativeTokenTransferCodec.sol";
import "./Peers.sol";
import "../interfaces/IERC20Burnable2.sol";
import "../interfaces/INttTokenReceiver.sol";

import "../interfaces/IWETH.sol";
import "../libraries/TokenDeployment.sol";

import {Token} from "./Token.sol";
import "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import "openzeppelin-contracts/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "wormhole-solidity-sdk/Utils.sol";
import "wormhole-solidity-sdk/libraries/BytesParsing.sol";

import "../libraries/Implementation.sol";
import "../libraries/PausableOwnable.sol";
import "../libraries/external/ReentrancyGuardUpgradeable.sol";

import "../interfaces/INttToken.sol";

contract MultiTokenNtt is
    MultiTokenRateLimiter,
    GmpIntegration,
    Peers,
    PausableOwnable,
    ReentrancyGuardUpgradeable,
    Implementation
{
    using SafeERC20 for IERC20;
    using TrimmedAmountLib for uint256;
    using TrimmedAmountLib for TrimmedAmount;

    address immutable deployer;
    address public immutable tokenImplementation; // TODO: maybe beacon proxy? (and make it mutable)
    uint16 immutable chainId;
    IWETH public immutable WETH;

    enum Mode {
        LOCKING,
        BURNING
    }

    error ZeroAmount();
    error StaticcallFailed();
    error InvalidRefundAddress();
    error InvalidRecipient();
    error BurnAmountDifferentThanBalanceDiff(uint256 balanceBefore, uint256 balanceAfter);
    error TransferAmountHasDust(uint256 amount, uint256 dust);
    error RefundFailed(uint256 refundAmount);
    error InvalidSender();
    error UnexpectedDeployer(address expectedOwner, address owner);
    error UnexpectedMsgValue();
    error InvalidTargetChain(uint16 targetChain, uint16 chainId);
    error CancellerNotSender(address sender, address canceller);
    error FailedToDeployToken();
    error NttTokenReceiverCallFailed(address recipient);
    error PayloadTooLong(uint256 length);
    error TransferFailed();
    error QueuedTransferWithPayload();
    error InvalidTokenId();
    error CannotOverrideNativeToken();
    error LocalTokenAlreadyRepresentsDifferentAsset();
    error TokenNotRegistered(uint16 chainId, bytes32 tokenAddress);

    event TransferSent(
        uint64 sequence,
        uint16 indexed tokenChain,
        bytes32 indexed token,
        bytes32 recipient,
        bytes32 refundAddress,
        uint256 amount,
        uint16 indexed toChain,
        address sender
    );

    event OutboundTransferCancelled(uint256 sequence, address recipient, uint256 amount);
    event TransferRedeemed(bytes32 indexed digest);

    string public constant NTT_MANAGER_VERSION = "1.1.0"; // TODO: change this

    // =============== Setup =================================================================

    constructor(
        IGmpManager _gmpManager,
        uint64 _rateLimitDuration,
        bool _skipRateLimiting,
        address _tokenImplementation,
        address _weth
    ) MultiTokenRateLimiter(_rateLimitDuration, _skipRateLimiting) GmpIntegration(_gmpManager) {
        deployer = msg.sender;
        chainId = GmpManager(address(_gmpManager)).chainId();
        tokenImplementation = _tokenImplementation;
        WETH = IWETH(_weth);
    }

    function _migrate() internal virtual override {
        // no-op
    }

    function __NttManager_init() internal onlyInitializing {
        // check if the owner is the deployer of this contract
        if (msg.sender != deployer) {
            revert UnexpectedDeployer(deployer, msg.sender);
        }
        if (msg.value != 0) {
            revert UnexpectedMsgValue();
        }
        __PausedOwnable_init(msg.sender, msg.sender);
        __ReentrancyGuard_init();
    }

    function _initialize() internal virtual override {
        super._initialize();
        __NttManager_init();
    }

    // =============== Admin ==============================================================

    function setOutboundLimit(TokenId calldata token, uint256 limit) external onlyOwner {
        uint8 toDecimals = _tokenDecimals(token);
        _setOutboundLimit(token, limit.trim(toDecimals, toDecimals));
    }

    function setInboundLimit(
        TokenId calldata token,
        uint256 limit,
        uint16 chainId_
    ) external onlyOwner {
        uint8 toDecimals = _tokenDecimals(token);
        _setInboundLimit(token, limit.trim(toDecimals, toDecimals), chainId_);
    }

    function setPeer(uint16 _chainId, bytes32 peerAddress) external onlyOwner {
        _setPeer(_chainId, peerAddress);
    }

    function upgrade(
        address newImplementation
    ) external onlyOwner {
        _upgrade(newImplementation);
    }

    /// @notice Override a representation token for a foreign token.
    /// WARNING: if the representation token already exists, this will overwrite it.
    function overrideLocalAsset(TokenId calldata token, address localToken) external onlyOwner {
        if (token.chainId == 0 || token.tokenAddress == bytes32(0)) {
            revert InvalidTokenId();
        }
        if (token.chainId == chainId) {
            revert CannotOverrideNativeToken();
        }
        TokenId memory existing = _getForeignTokenStorage()[localToken];
        if (existing.tokenAddress != bytes32(0)) {
            if (existing.chainId != token.chainId || existing.tokenAddress != token.tokenAddress) {
                revert LocalTokenAlreadyRepresentsDifferentAsset();
            }
        }
        // TODO: should we check if the token exists, and if so, that the metadata didn't change?
        TokenMeta memory meta = _queryTokenMetaFromTokenContract(localToken);

        // clean up existing entry if there is one
        address oldToken = _getLocalTokenStorage()[token.chainId][token.tokenAddress].token;
        if (oldToken != address(0)) {
            delete _getForeignTokenStorage()[oldToken];
        }

        _getLocalTokenStorage()[token.chainId][token.tokenAddress] =
            LocalTokenInfo({token: localToken, meta: meta});
        _getForeignTokenStorage()[localToken] = token;
    }

    /// ============== Invariants =============================================

    /// @dev When we add new immutables, this function should be updated
    function _checkImmutables() internal view override {
        super._checkImmutables();
        assert(this.gmpManager() == gmpManager);
        assert(this.rateLimitDuration() == rateLimitDuration);
    }

    // ==================== External Interface ===============================================

    enum WrapETH {
        Wrap,
        NoWrap
    }

    /// @notice Transfer tokens to another chain with comprehensive parameter support
    struct TransferArgs {
        address token;
        uint256 amount;
        uint16 recipientChain;
        bytes32 recipient;
        bytes32 refundAddress;
        bool shouldQueue;
        bytes transceiverInstructions;
        bytes additionalPayload;
    }

    function transfer(
        TransferArgs memory args
    ) external payable nonReentrant whenNotPaused returns (uint64) {
        return _executeTransferWithArgs(args, WrapETH.NoWrap);
    }

    /// @notice Transfer gas token (ETH) to another chain with comprehensive parameter support
    struct GasTokenTransferArgs {
        uint256 amount;
        uint16 recipientChain;
        bytes32 recipient;
        bytes32 refundAddress;
        bool shouldQueue;
        bytes transceiverInstructions;
        bytes additionalPayload;
    }

    function wrapAndTransferGasToken(
        GasTokenTransferArgs memory args
    ) external payable nonReentrant whenNotPaused returns (uint64) {
        TransferArgs memory transferArgs = TransferArgs({
            token: address(WETH),
            amount: args.amount,
            recipientChain: args.recipientChain,
            recipient: args.recipient,
            refundAddress: args.refundAddress,
            shouldQueue: args.shouldQueue,
            transceiverInstructions: args.transceiverInstructions,
            additionalPayload: args.additionalPayload
        });

        return _executeTransferWithArgs(transferArgs, WrapETH.Wrap);
    }

    // ========== Internal Helper Functions ==========

    function _executeTransferWithArgs(
        TransferArgs memory args,
        WrapETH wrapMode
    ) internal returns (uint64) {
        // Set default values for optional parameters
        bytes32 finalRefundAddress =
            args.refundAddress == bytes32(0) ? args.recipient : args.refundAddress;
        bytes memory finalInstructions =
            args.transceiverInstructions.length == 0 ? new bytes(1) : args.transceiverInstructions;

        TransferArgs memory finalArgs = args;
        finalArgs.refundAddress = finalRefundAddress;
        finalArgs.transceiverInstructions = finalInstructions;

        return _transferEntryPoint(
            TransferParams({msgValue: msg.value, wrapWETH: wrapMode, args: finalArgs})
        );
    }

    function _receiveMessage(
        bytes32 digest,
        uint16 sourceChainId,
        bytes32 sender,
        bytes calldata data
    ) internal override {
        _verifyPeer(sourceChainId, sender);
        // parse the data into a NativeTokenTransfer
        NativeTokenTransferCodec.NativeTokenTransfer memory message =
            NativeTokenTransferCodec.parseNativeTokenTransfer(data);
        _executeMsg(digest, sourceChainId, message);
    }

    /// @dev Get the creation code for the ERC1967Proxy contract
    /// used to deploy new tokens. This might be useful for client code that
    /// wants to compute the CREATE2 address.
    /// Exposing this as a view function makes the client side code easier to
    /// manage, as the generated bytecode changes depending on compiler flags.
    function tokenProxyCreationCode() external pure returns (bytes memory) {
        return TokenDeployment.getTokenProxyCreationCode();
    }

    function _executeMsg(
        bytes32 digest,
        uint16 sourceChainId,
        NativeTokenTransferCodec.NativeTokenTransfer memory nativeTokenTransfer
    ) internal whenNotPaused nonReentrant {
        bytes20 transferDigest = bytes20(
            keccak256(NativeTokenTransferCodec.encodeNativeTokenTransfer(nativeTokenTransfer))
        );

        TokenInfo memory info = nativeTokenTransfer.token;

        address token = _getOrCreateToken(info);

        uint8 toDecimals = _tokenDecimals(info.token);
        TrimmedAmount nativeTransferAmount =
            (nativeTokenTransfer.amount.untrim(toDecimals)).trim(toDecimals, toDecimals);

        address transferRecipient = fromWormholeFormat(nativeTokenTransfer.to);

        if (!_getInboundLimitParamsStorage(info.token)[sourceChainId].limit.isNull()) {
            // Check inbound rate limits
            bool isRateLimited =
                _isInboundAmountRateLimited(info.token, nativeTransferAmount, sourceChainId);
            if (isRateLimited) {
                // queue up the transfer
                _enqueueInboundTransfer(digest, sourceChainId, transferDigest);

                // end execution early
                return;
            }

            // consume the amount for the inbound rate limit
            _consumeInboundAmount(info.token, nativeTransferAmount, sourceChainId);
        }

        // When receiving a transfer, we refill the outbound rate limit
        // by the same amount (we call this "backflow")
        if (!_getOutboundLimitParamsStorage(info.token).limit.isNull()) {
            // if the outbound limit is not set, we don't backfill
            // this is to avoid backfilling for tokens that don't have an outbound limit set
            _backfillOutboundAmount(info.token, nativeTransferAmount);
        }

        _mintOrUnlockToRecipient(
            digest,
            token,
            transferRecipient,
            nativeTransferAmount,
            false,
            nativeTokenTransfer.additionalPayload,
            sourceChainId,
            nativeTokenTransfer.sender
        );
    }

    function completeInboundQueuedTransfer(
        bytes32 digest,
        NativeTokenTransferCodec.NativeTokenTransfer memory nativeTokenTransfer
    ) external nonReentrant whenNotPaused {
        // compute the digest from the provided transfer
        bytes20 transferDigest = bytes20(
            keccak256(NativeTokenTransferCodec.encodeNativeTokenTransfer(nativeTokenTransfer))
        );

        // find the message in the queue
        InboundQueuedTransfer memory queuedTransfer = getInboundQueuedTransfer(digest);
        if (queuedTransfer.txTimestamp == 0) {
            revert InboundQueuedTransferNotFound(digest);
        }

        if (queuedTransfer.transferDigest != transferDigest) {
            revert InboundQueuedTransferDigestMismatch(
                transferDigest, queuedTransfer.transferDigest
            );
        }

        // check that > RATE_LIMIT_DURATION has elapsed
        if (block.timestamp - queuedTransfer.txTimestamp < rateLimitDuration) {
            revert InboundQueuedTransferStillQueued(digest, queuedTransfer.txTimestamp);
        }

        // remove transfer from the queue
        delete _getInboundQueueStorage()[digest];

        // get token and recipient from the provided transfer struct
        address token = _getOrCreateToken(nativeTokenTransfer.token);
        address transferRecipient = fromWormholeFormat(nativeTokenTransfer.to);

        uint8 toDecimals = _tokenDecimals(nativeTokenTransfer.token.token);
        TrimmedAmount nativeTransferAmount =
            (nativeTokenTransfer.amount.untrim(toDecimals)).trim(toDecimals, toDecimals);

        // run it through the mint/unlock logic
        _mintOrUnlockToRecipient(
            digest,
            token,
            transferRecipient,
            nativeTransferAmount,
            false,
            nativeTokenTransfer.additionalPayload,
            queuedTransfer.sourceChainId,
            nativeTokenTransfer.sender
        );
    }

    function completeOutboundQueuedTransfer(
        uint64 messageSequence
    ) external payable nonReentrant whenNotPaused returns (uint64) {
        // find the message in the queue
        OutboundQueuedTransfer memory queuedTransfer = _getOutboundQueueStorage()[messageSequence];
        if (queuedTransfer.txTimestamp == 0) {
            revert OutboundQueuedTransferNotFound(messageSequence);
        }

        // check that > RATE_LIMIT_DURATION has elapsed
        if (block.timestamp - queuedTransfer.txTimestamp < rateLimitDuration) {
            revert OutboundQueuedTransferStillQueued(messageSequence, queuedTransfer.txTimestamp);
        }

        // remove transfer from the queue
        delete _getOutboundQueueStorage()[messageSequence];

        // run it through the transfer logic and skip the rate limit
        return _transfer(
            msg.value,
            messageSequence,
            queuedTransfer.token,
            queuedTransfer.amount,
            queuedTransfer.recipientChain,
            queuedTransfer.recipient,
            queuedTransfer.refundAddress,
            queuedTransfer.sender,
            queuedTransfer.transceiverInstructions,
            "" // Queued transfers don't support additional payload
        );
    }

    function cancelOutboundQueuedTransfer(
        uint64 messageSequence
    ) external nonReentrant whenNotPaused {
        // find the message in the queue
        OutboundQueuedTransfer memory queuedTransfer = _getOutboundQueueStorage()[messageSequence];
        if (queuedTransfer.txTimestamp == 0) {
            revert OutboundQueuedTransferNotFound(messageSequence);
        }

        // check msg.sender initiated the transfer
        if (queuedTransfer.sender != msg.sender) {
            revert CancellerNotSender(msg.sender, queuedTransfer.sender);
        }

        // remove transfer from the queue
        delete _getOutboundQueueStorage()[messageSequence];

        // return the queued funds to the sender
        _mintOrUnlockToRecipient(
            bytes32(uint256(messageSequence)),
            queuedTransfer.token,
            msg.sender,
            queuedTransfer.amount,
            true,
            "", // No additional payload for cancelled transfers
            0, // No source chain info for cancelled transfers
            bytes32(0) // No source address for cancelled transfers
        );
    }

    /// @dev This function is called when the contract receives ETH
    ///     It is required for unwrapping WETH
    receive() external payable {}

    // ==================== Internal Business Logic =========================================

    // TODO: move to utils?
    function _refundToSender(
        uint256 refundAmount
    ) internal {
        // refund the price quote back to sender
        (bool refundSuccessful,) = payable(msg.sender).call{value: refundAmount}("");

        // check success
        if (!refundSuccessful) {
            revert RefundFailed(refundAmount);
        }
    }

    // TODO: maybe store information about every token, not just foreign ones?
    // specifically, it might make sense to store whether the token is rate
    // limited (since we're already hitting this storage slot, it would be more
    // efficient than hitting another one... although that's not as nice from an
    // encapsulation perspective, so who knows.)
    bytes32 private constant FOREIGN_TOKEN_SLOT =
        bytes32(uint256(keccak256("ntt.multitoken.foreignTokenInfo")) - 1);

    function _getForeignTokenStorage()
        internal
        pure
        returns (mapping(address => TokenId) storage $)
    {
        bytes32 slot = FOREIGN_TOKEN_SLOT;
        assembly {
            $.slot := slot
        }
    }

    function getTokenId(
        address token
    ) public view returns (TokenId memory, Mode) {
        TokenId memory result = _getForeignTokenStorage()[token];
        if (result.chainId != 0) {
            // NOTE: chainId == 0 means the entry is not populated, which means
            // that the token is a local token. This is guaranteed because the
            // entry populated at the time of token creation
            return (result, Mode.BURNING);
        }
        result.chainId = chainId;
        result.tokenAddress = toWormholeFormat(token);
        return (result, Mode.LOCKING);
    }

    bytes32 private constant LOCAL_TOKEN_SLOT =
        bytes32(uint256(keccak256("ntt.multitoken.localTokenInfo")) - 1);

    struct LocalTokenInfo {
        address token;
        TokenMeta meta;
    }

    function _getLocalTokenStorage()
        internal
        pure
        returns (mapping(uint16 => mapping(bytes32 => LocalTokenInfo)) storage $)
    {
        bytes32 slot = LOCAL_TOKEN_SLOT;
        assembly {
            $.slot := slot
        }
    }

    struct TransferParams {
        uint256 msgValue;
        WrapETH wrapWETH;
        TransferArgs args;
    }

    // NOTE: protect every caller with nonReentrant, as this function makes external calls
    function _transferEntryPoint(
        TransferParams memory params
    ) internal returns (uint64) {
        (TokenId memory tokenId, Mode mode) = getTokenId(params.args.token);

        if (params.args.amount == 0) {
            revert ZeroAmount();
        }

        if (params.args.recipient == bytes32(0)) {
            revert InvalidRecipient();
        }

        if (params.args.refundAddress == bytes32(0)) {
            revert InvalidRefundAddress();
        }

        {
            // Lock/burn tokens before checking rate limits
            // use transferFrom to pull tokens from the user and lock them
            // query own token balance before transfer
            uint256 balanceBefore = _getTokenBalanceOf(params.args.token, address(this));

            if (params.wrapWETH == WrapETH.Wrap && params.args.token == address(WETH)) {
                // transfer WETH
                IWETH(WETH).deposit{value: params.args.amount}();
                params.msgValue -= params.args.amount;
            } else {
                IERC20(params.args.token).safeTransferFrom(
                    msg.sender, address(this), params.args.amount
                );
            }

            // query own token balance after transfer
            uint256 balanceAfter = _getTokenBalanceOf(params.args.token, address(this));

            // correct amount for potential transfer fees
            params.args.amount = balanceAfter - balanceBefore;
            if (mode == Mode.BURNING) {
                {
                    // NOTE: We don't account for burn fees in this code path.
                    // We verify that the user's change in balance is equal to the amount that's burned.
                    // Accounting for burn fees can be non-trivial, since there
                    // is no standard way to account for the fee if the fee amount
                    // is taken out of the burn amount.
                    // For example, if there's a fee of 1 which is taken out of the
                    // amount, then burning 20 tokens would result in a transfer of only 19 tokens.
                    // However, the difference in the user's balance would only show 20.
                    // Since there is no standard way to query for burn fee amounts with burnable tokens,
                    // and NTT would be used on a per-token basis, implementing this functionality
                    // is left to integrating projects who may need to account for burn fees on their tokens.
                    try ERC20Burnable(params.args.token).burn(params.args.amount) {}
                    catch {
                        IERC20Burnable2(params.args.token).burn(address(this), params.args.amount);
                    }

                    // tokens held by the contract after the operation should be the same as before
                    uint256 balanceAfterBurn = _getTokenBalanceOf(params.args.token, address(this));
                    if (balanceBefore != balanceAfterBurn) {
                        revert BurnAmountDifferentThanBalanceDiff(balanceBefore, balanceAfterBurn);
                    }
                }
            }
        }

        // trim amount after burning to ensure transfer amount matches (amount - fee)
        TrimmedAmount trimmedAmount;
        // get the sequence for this transfer
        {
            TrimmedAmount internalAmount;
            {
                uint8 decimals = _tokenDecimals(tokenId);
                trimmedAmount = _trimTransferAmount(decimals, params.args.amount);
                internalAmount = trimmedAmount.shift(decimals);
            }

            if (!_getOutboundLimitParamsStorage(tokenId).limit.isNull()) {
                // now check rate limits
                if (_isOutboundAmountRateLimited(tokenId, internalAmount)) {
                    if (!params.args.shouldQueue) {
                        revert NotEnoughCapacity(
                            tokenId, getCurrentOutboundCapacity(tokenId), params.args.amount
                        );
                    }

                    if (params.args.additionalPayload.length != 0) {
                        revert QueuedTransferWithPayload();
                    }

                    uint64 sequence = gmpManager.reserveMessageSequence();

                    emit OutboundTransferRateLimited(
                        msg.sender,
                        sequence,
                        params.args.amount,
                        getCurrentOutboundCapacity(tokenId)
                    );

                    _enqueueOutboundTransfer(
                        sequence,
                        params.args.token,
                        trimmedAmount,
                        params.args.recipientChain,
                        params.args.recipient,
                        params.args.refundAddress,
                        msg.sender,
                        params.args.transceiverInstructions
                    );

                    // refund price quote back to sender
                    _refundToSender(params.msgValue);

                    // return the sequence in the queue
                    return sequence;
                }

                // otherwise, consume the outbound amount
                _consumeOutboundAmount(tokenId, internalAmount);
            }

            // When sending a transfer, we refill the inbound rate limit for
            // that chain by the same amount (we call this "backflow")
            // if the inbound limit is not set, we don't backfill
            // this is to avoid backfilling for chains that don't have an inbound limit set
            if (!_getInboundLimitParamsStorage(tokenId)[params.args.recipientChain].limit.isNull())
            {
                _backfillInboundAmount(tokenId, internalAmount, params.args.recipientChain);
            }
        }

        bytes memory transceiverInstructions = params.args.transceiverInstructions;
        bytes memory additionalPayload = params.args.additionalPayload;

        return _transfer(
            params.msgValue,
            0,
            params.args.token,
            trimmedAmount,
            params.args.recipientChain,
            params.args.recipient,
            params.args.refundAddress,
            msg.sender,
            transceiverInstructions,
            additionalPayload
        );
    }

    function _transfer(
        uint256 msgValue,
        uint64 reservedSequence,
        address token,
        TrimmedAmount amount,
        uint16 recipientChain,
        bytes32 recipient,
        bytes32 refundAddress,
        address sender,
        bytes memory transceiverInstructions,
        bytes memory additionalPayload
    ) internal returns (uint64 msgSequence) {
        // the flow of this code looks interesting here. it's laid out the way
        // it is to avoid stack too deep errors.
        bytes memory message;
        TokenId memory tokenId;
        {
            (tokenId,) = getTokenId(token);
            TokenInfo memory tokenInfo = TokenInfo({meta: _getTokenMeta(tokenId), token: tokenId});

            message = NativeTokenTransferCodec.encodeNativeTokenTransfer(
                NativeTokenTransferCodec.NativeTokenTransfer({
                    amount: amount,
                    token: tokenInfo,
                    sender: toWormholeFormat(sender),
                    to: recipient,
                    additionalPayload: additionalPayload
                })
            );
        }

        msgSequence = _sendMessageWithSequence(
            msgValue,
            recipientChain,
            refundAddress,
            reservedSequence,
            message,
            transceiverInstructions
        );

        uint256 untrimmedAmount = amount.untrim(_tokenDecimals(tokenId));
        emit TransferSent(
            msgSequence,
            tokenId.chainId,
            tokenId.tokenAddress,
            recipient,
            refundAddress,
            untrimmedAmount,
            recipientChain,
            sender
        );
    }

    function _sendMessageWithSequence(
        uint256 msgValue,
        uint16 recipientChain,
        bytes32 refundAddress,
        uint64 reservedSequence,
        bytes memory message,
        bytes memory transceiverInstructions
    ) internal returns (uint64 messageSequence) {
        bytes32 peerAddress = _getPeersStorage()[recipientChain].peerAddress;
        if (peerAddress == bytes32(0)) {
            revert InvalidPeerZeroAddress();
        }
        // _sendMessage invokes the GmpManager contract which takes the payment
        // for sending the message (including paying the transceivers).
        // It then refunds any excess back to this contract, which we refund to
        // the sender of this transaction.
        uint256 balanceBefore = address(this).balance;
        messageSequence = _sendMessage(
            msgValue,
            recipientChain,
            peerAddress,
            refundAddress,
            reservedSequence,
            message,
            transceiverInstructions
        );
        uint256 paid = balanceBefore - address(this).balance;
        if (paid < msgValue) {
            _refundToSender(msgValue - paid);
        }
    }

    // Returns 0 if the token is not yet created
    function getToken(
        TokenId memory tokenId
    ) public view returns (address) {
        if (tokenId.chainId == chainId) {
            return fromWormholeFormat(tokenId.tokenAddress);
        }

        return _getLocalTokenStorage()[tokenId.chainId][tokenId.tokenAddress].token;
    }

    // This function resolves a TokenInfo into a local token address.
    // If the token is actually native to this chain, it will return the address.
    // If the token is foreign, then it will return the local representation of
    // the token, creating it if necessary.
    function _getOrCreateToken(
        TokenInfo memory tokenInfo
    ) internal returns (address) {
        address localToken = getToken(tokenInfo.token);

        if (localToken == address(0)) {
            // create the local token
            localToken = _createLocalToken(tokenInfo);
            _getLocalTokenStorage()[tokenInfo.token.chainId][tokenInfo.token.tokenAddress] =
                LocalTokenInfo({token: localToken, meta: tokenInfo.meta});
            _getForeignTokenStorage()[localToken] = tokenInfo.token;
        }

        return localToken;
    }

    // TODO: decide the exact layout of the tokens. should it be a beacon proxy?
    // regular proxy? non-upgradeable?
    function _createLocalToken(
        TokenInfo memory tokenInfo
    ) internal returns (address) {
        return TokenDeployment.createToken(tokenInfo, tokenImplementation);
    }

    function _mintOrUnlockToRecipient(
        bytes32 digest,
        address token,
        address recipient,
        TrimmedAmount amount,
        bool cancelled,
        bytes memory additionalPayload,
        uint16 sourceChainId,
        bytes32 sourceAddress
    ) internal {
        // calculate proper amount of tokens to unlock/mint to recipient
        // untrim the amount
        (TokenId memory tokenId, Mode mode) = getTokenId(token);

        uint256 untrimmedAmount = amount.untrim(_tokenDecimals(tokenId));

        if (cancelled) {
            emit OutboundTransferCancelled(uint256(digest), recipient, untrimmedAmount);
        } else {
            emit TransferRedeemed(digest);
        }

        if (mode == Mode.LOCKING) {
            if (token == address(WETH)) {
                IWETH(token).withdraw(untrimmedAmount);
                (bool success,) = address(recipient).call{value: untrimmedAmount}("");
                if (!success) revert TransferFailed();
            } else {
                // unlock tokens to the specified recipient
                IERC20(token).safeTransfer(recipient, untrimmedAmount);
            }
        } else if (mode == Mode.BURNING) {
            // mint tokens to the specified recipient
            INttToken(token).mint(recipient, untrimmedAmount);
        } else {
            revert(); // impossible
        }

        // If there's additional payload, call the callback
        if (additionalPayload.length > 0) {
            try INttTokenReceiver(recipient).onNttTokenReceived(
                token, untrimmedAmount, additionalPayload, sourceChainId, sourceAddress
            ) {
                // Callback succeeded
            } catch {
                revert NttTokenReceiverCallFailed(recipient);
            }
        }
    }

    function _queryTokenMetaFromTokenContract(
        address token
    ) internal view returns (TokenMeta memory meta) {
        bytes memory queryResult;

        queryResult = _staticQuery(token, "symbol()");

        string memory symbol = abi.decode(queryResult, (string));
        bytes32 symbol32;
        assembly {
            symbol32 := mload(add(symbol, 32))
        }

        queryResult = _staticQuery(token, "name()");

        string memory name = abi.decode(queryResult, (string));
        bytes32 name32;
        assembly {
            name32 := mload(add(name, 32))
        }

        queryResult = _staticQuery(token, "decimals()");

        uint8 decimals = abi.decode(queryResult, (uint8));

        meta.name = name32;
        meta.symbol = symbol32;
        meta.decimals = decimals;
    }

    function _getTokenMeta(
        TokenId memory tokenId
    ) internal view returns (TokenMeta memory meta) {
        if (tokenId.chainId == chainId) {
            return _queryTokenMetaFromTokenContract(fromWormholeFormat(tokenId.tokenAddress));
        } else {
            // TODO: is there a point in caching this at all? we could just query it every time
            LocalTokenInfo storage localTokenInfo =
                _getLocalTokenStorage()[tokenId.chainId][tokenId.tokenAddress];
            if (localTokenInfo.token == address(0)) {
                revert TokenNotRegistered(tokenId.chainId, tokenId.tokenAddress);
            }
            return localTokenInfo.meta;
        }
    }

    function _tokenDecimals(
        TokenId memory tokenId
    ) internal view override(MultiTokenRateLimiter) returns (uint8) {
        if (tokenId.chainId == chainId) {
            address token = fromWormholeFormat(tokenId.tokenAddress);
            bytes memory queriedDecimals = _staticQuery(token, "decimals()");
            return abi.decode(queriedDecimals, (uint8));
        } else {
            LocalTokenInfo storage localTokenInfo =
                _getLocalTokenStorage()[tokenId.chainId][tokenId.tokenAddress];
            if (localTokenInfo.token == address(0)) {
                revert TokenNotRegistered(tokenId.chainId, tokenId.tokenAddress);
            }
            return localTokenInfo.meta.decimals;
        }
    }

    function _staticQuery(address token, string memory sig) internal view returns (bytes memory) {
        (bool success, bytes memory result) = token.staticcall(abi.encodeWithSignature(sig));
        if (!success) {
            revert StaticcallFailed();
        }
        return result;
    }

    // ==================== Internal Helpers ===============================================

    function _trimTransferAmount(
        uint8 toDecimals,
        uint256 amount
    ) internal pure returns (TrimmedAmount) {
        if (toDecimals == 0) {
            // TODO: can this happen? if so, better error message
            revert();
        }

        TrimmedAmount trimmedAmount;
        {
            trimmedAmount = amount.trim(toDecimals, toDecimals); // TODO: we could improve the readability of this.
            // don't deposit dust that can not be bridged due to the decimal shift
            uint256 newAmount = trimmedAmount.untrim(toDecimals);
            if (amount != newAmount) {
                revert TransferAmountHasDust(amount, amount - newAmount);
            }
        }

        return trimmedAmount;
    }

    function _getTokenBalanceOf(
        address tokenAddr,
        address accountAddr
    ) internal view returns (uint256) {
        (bool success, bytes memory queriedBalance) =
            tokenAddr.staticcall(abi.encodeWithSelector(IERC20.balanceOf.selector, accountAddr));

        if (!success) {
            revert StaticcallFailed();
        }

        return abi.decode(queriedBalance, (uint256));
    }

    // =============== Pause Management ==============================================================

    /// @notice Pauses the contract, blocking all transfer and execution functions
    /// @dev Can be called by owner or pauser
    function pause() public onlyOwnerOrPauser {
        _pause();
    }

    /// @notice Unpauses the contract, re-enabling all functions
    /// @dev Can only be called by owner (not pauser)
    function unpause() public onlyOwner {
        _unpause();
    }
}
