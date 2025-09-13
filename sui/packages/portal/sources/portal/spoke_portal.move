/// Spoke Portal - Sui implementation for M Token cross-chain transfers
///
/// Sui is a Spoke chain in the M^0 multichain model where Ethereum is the exclusive Hub.
/// This Portal handles:
/// - Receiving M Token transfers from Ethereum Hub (with index updates)
/// - Processing custom messages from Hub Portal (index/key/list updates)
/// - Outbound: Burns tokens, sends to Ethereum Hub
/// - Inbound: Mints tokens from Ethereum Hub transfers
module sui_m::spoke_portal {
    use sui::coin::{Self, Coin, CoinMetadata};
    use sui::balance::{Self, Balance};
    use sui::clock::Clock;
    use sui::event;
    use wormhole::external_address::{Self as external_address, ExternalAddress};

    // NTT dependencies
    use ntt::ntt::{Self, TransferTicket};
    use ntt::state::{Self as ntt_state, State as NttState};
    use ntt::outbox::{Self as outbox, OutboxKey};
    use ntt::upgrades::{Self as upgrades, VersionGated};
    use ntt::auth; // For ManagerAuth type
    use ntt_common::validated_transceiver_message::{Self as validated_transceiver_message, ValidatedTransceiverMessage};
    use ntt_common::outbound_message::{OutboundMessage};
    use ntt_common::ntt_manager_message::{Self as ntt_manager_message, NttManagerMessage};
    use ntt_common::native_token_transfer::{Self as native_token_transfer, NativeTokenTransfer};
    use ntt_common::trimmed_amount::{Self as trimmed_amount, TrimmedAmount};
    use wormhole::bytes32::{Bytes32};
    use wormhole::publish_message::{MessageTicket};

    // Wormhole Transceiver dependencies
    use wormhole_transceiver::wormhole_transceiver::{Self, State as TransceiverState, TransceiverAuth};

    // M Token dependencies
    use sui_m::m_token::{Self, M_TOKEN, MTokenGlobal, PortalCap as MTokenPortalCap};
    use sui_m::registrar::{Self, RegistrarGlobal, PortalCap as RegistrarPortalCap};
    use sui_m::portal_payload_encoder::{Self as payload_encoder, PayloadType};

    // Error constants
    const E_INVALID_DESTINATION_CHAIN: u64 = 1;

    /// Spoke Portal state - wraps NTT state with M-specific functionality
    public struct SpokePortal has key {
        id: UID,
        ntt_state: NttState<M_TOKEN>,
        m_token_global_id: ID, // M Token global object ID
        registrar_global_id: ID, // Registrar global object ID
        m_token_cap: MTokenPortalCap, // Portal capability for M Token
        registrar_cap: RegistrarPortalCap, // Portal capability for registrar
    }

    /// Admin capability for Spoke Portal
    public struct SpokePortalAdminCap has key, store {
        id: UID,
    }

    // ================ Events ================

    public struct MTokenIndexReceived has copy, drop {
        message_id: vector<u8>,
        index: u128,
    }

    public struct RegistrarKeyReceived has copy, drop {
        message_id: vector<u8>,
        key: vector<u8>,
        value: vector<u8>,
    }

    public struct RegistrarListStatusReceived has copy, drop {
        message_id: vector<u8>,
        list_name: vector<u8>,
        account: address,
        add: bool,
    }

    public struct MTokenReceived has copy, drop {
        source_chain_id: u16,
        destination_token: address,
        sender: ExternalAddress,
        recipient: address,
        amount: u64,
        index: u128,
        message_id: vector<u8>,
    }

    // ================ Initialization ================

    /// Initialize Spoke Portal with wrapped NTT state and capabilities
    public fun new(
        ntt_state: NttState<M_TOKEN>,
        m_token_global_id: ID,
        registrar_global_id: ID,
        m_token_cap: MTokenPortalCap,
        registrar_cap: RegistrarPortalCap,
        ctx: &mut TxContext
    ): (SpokePortal, SpokePortalAdminCap) {
        let portal = SpokePortal {
            id: object::new(ctx),
            ntt_state,
            m_token_global_id,
            registrar_global_id,
            m_token_cap,
            registrar_cap,
        };

        let admin_cap = SpokePortalAdminCap {
            id: object::new(ctx),
        };

        (portal, admin_cap)
    }

    // ================ Core Transfer Functions ================

    /// Transfer M Token to Ethereum Hub (main entry point for outbound transfers)
    /// This mirrors the EVM Portal's transfer function
    public fun transfer_m_token(
        portal: &mut SpokePortal,
        m_token_global: &mut MTokenGlobal,
        version_gated: VersionGated,
        coins: Coin<M_TOKEN>,
        coin_meta: &CoinMetadata<M_TOKEN>,
        recipient_chain: u16,
        recipient: vector<u8>,
        destination_token_address: vector<u8>,
        should_queue: bool,
        clock: &Clock,
        ctx: &mut TxContext
    ): u64 {
        // Get current M index for additional payload
        let current_index = m_token::current_index(m_token_global);
        let additional_payload = payload_encoder::encode_m_additional_payload(
            current_index,
            destination_token_address
        );

        // Get the amount being transferred (currently unused but may be needed for events)
        let _amount = coin::value(&coins);

        // Prepare the transfer ticket
        let (ticket, dust) = ntt::prepare_transfer(
            &portal.ntt_state,
            coins,
            coin_meta,
            recipient_chain,
            recipient,
            option::some(additional_payload),
            should_queue,
        );

        // Execute the transfer through NTT (this handles burning)
        let outbox_key = ntt::transfer_tx_sender(
            &mut portal.ntt_state,
            version_gated,
            coin_meta,
            ticket,
            clock,
            ctx
        );

        // Return any dust to the sender
        if (balance::value(&dust) > 0) {
            transfer::public_transfer(
                coin::from_balance(dust, ctx),
                ctx.sender()
            );
        } else {
            balance::destroy_zero(dust);
        };

        // Get the actual sequence from outbox key
        let sequence_bytes = get_sequence_from_outbox_key(&outbox_key);
        // Convert Bytes32 to u64 for return (simplified)
        // TODO: Consider if we need the full Bytes32 sequence or just a simple counter
        0 // Placeholder - sequence is available in sequence_bytes
    }

    /// Transfer M-like token (wrapped M) to destination chain
    /// This mirrors the EVM Portal's transferMLikeToken function
    public fun transfer_m_like_token(
        portal: &mut SpokePortal,
        m_token_global: &mut MTokenGlobal,
        version_gated: VersionGated,
        wrapped_coins: Coin<M_TOKEN>, // TODO: This would be a wrapped type
        coin_meta: &CoinMetadata<M_TOKEN>,
        recipient_chain: u16,
        destination_token: vector<u8>,
        recipient: vector<u8>,
        should_queue: bool,
        clock: &Clock,
        ctx: &mut TxContext
    ): u64 {
        // TODO: Implement unwrapping logic when wrapper contracts are available
        // For now, just forward to regular M Token transfer
        transfer_m_token(
            portal,
            m_token_global,
            version_gated,
            wrapped_coins,
            coin_meta,
            recipient_chain,
            recipient,
            destination_token,
            should_queue,
            clock,
            ctx
        )
    }

    // ================ PTB-Compatible Functions ================

    /// Prepare M Token transfer for PTB (returns ticket + dust for PTB consumption)
    /// This follows the NTT pattern: prepare in one step, execute in another
    public fun prepare_m_token_transfer_ptb(
        portal: &SpokePortal,
        m_token_global: &MTokenGlobal,
        coins: Coin<M_TOKEN>,
        coin_meta: &CoinMetadata<M_TOKEN>,
        recipient_chain: u16,
        recipient: vector<u8>,
        destination_token_address: vector<u8>,
        should_queue: bool,
    ): (TransferTicket<M_TOKEN>, Balance<M_TOKEN>) {
        // Get current M index for additional payload
        let current_index = m_token::current_index(m_token_global);
        let additional_payload = payload_encoder::encode_m_additional_payload(
            current_index,
            destination_token_address
        );

        // Use NTT's prepare_transfer - this returns (ticket, dust) without side effects
        ntt::prepare_transfer(
            &portal.ntt_state,
            coins,
            coin_meta,
            recipient_chain,
            recipient,
            option::some(additional_payload),
            should_queue,
        )
    }

    /// Execute M Token transfer (consumes ticket, performs burn, returns outbox key)
    /// This will be called by PTB after prepare_m_token_transfer_ptb
    public fun transfer_m_token_ptb(
        portal: &mut SpokePortal,
        version_gated: VersionGated,
        coin_meta: &CoinMetadata<M_TOKEN>,
        ticket: TransferTicket<M_TOKEN>,
        clock: &Clock,
        ctx: &mut TxContext
    ): OutboxKey {
        // Execute the transfer through NTT (this handles burning)
        ntt::transfer_tx_sender(
            &mut portal.ntt_state,
            version_gated,
            coin_meta,
            ticket,
            clock,
            ctx
        )
    }

    /// Get next sequence number for tracking transfers (called by PTB before transfer)
    /// This mirrors the pattern from NTT Sui implementation
    public fun get_next_sequence(portal: &SpokePortal): Bytes32 {
        ntt_state::get_next_sequence(&portal.ntt_state)
    }

    /// Get sequence from outbox key (called by PTB after transfer for tracking)
    public fun get_sequence_from_outbox_key(key: &OutboxKey): Bytes32 {
        outbox::get_id(key)
    }

    /// Get chain ID from portal state
    public fun get_chain_id(portal: &SpokePortal): u16 {
        // Get the chain ID from the NTT state
        ntt_state::get_chain_id(&portal.ntt_state)
    }

    /// Create transceiver message from outbox (PTB compatible)
    /// This should be called after transfer to create the message for transceivers
    public fun create_transceiver_message(
        portal: &mut SpokePortal,
        message_id: Bytes32,
        clock: &Clock
    ): OutboundMessage<auth::ManagerAuth, TransceiverAuth> {
        // Create the outbound message from the NTT state outbox
        // This extracts the message that was added during transfer
        ntt_state::create_transceiver_message<TransceiverAuth, M_TOKEN>(
            &mut portal.ntt_state,
            message_id,
            clock
        )
    }

    /// Release outbound message through Wormhole transceiver (PTB compatible)
    /// This publishes the message to Wormhole Core Bridge
    public fun release_outbound_message(
        transceiver_state: &mut TransceiverState<auth::ManagerAuth>,
        outbound_message: OutboundMessage<auth::ManagerAuth, TransceiverAuth>,
    ): MessageTicket {
        // Release the outbound message through the Wormhole transceiver
        // This creates a MessageTicket that can be published to Wormhole Core
        wormhole_transceiver::release_outbound(
            transceiver_state,
            outbound_message
        )
    }

    /// Validate incoming VAA and create ValidatedTransceiverMessage
    /// This handles the inbound message flow from Wormhole
    public fun validate_wormhole_message(
        transceiver_state: &TransceiverState<auth::ManagerAuth>,
        vaa: wormhole::vaa::VAA,
    ): ValidatedTransceiverMessage<TransceiverAuth, vector<u8>> {
        // Validate the VAA through the Wormhole transceiver
        // This ensures the message comes from a trusted peer
        wormhole_transceiver::validate_message(
            transceiver_state,
            vaa
        )
    }

    /// Send custom M Token index update using zero-amount transfer pattern (PTB-compatible)
    /// This creates a transfer ticket with custom M Token index payload
    public fun prepare_index_update_ptb(
        portal: &SpokePortal,
        m_token_global: &MTokenGlobal,
        zero_coin: Coin<M_TOKEN>, // Must be zero-value coin for custom messages
        coin_meta: &CoinMetadata<M_TOKEN>,
        destination_chain_id: u16,
        recipient: vector<u8>, // Usually the destination portal address
    ): (TransferTicket<M_TOKEN>, Balance<M_TOKEN>) {
        // Verify this is a zero-amount transfer (custom message pattern)
        assert!(coin::value(&zero_coin) == 0, 999); // Custom message must have zero value

        // Get current index for the custom payload
        let current_index = m_token::current_index(m_token_global);

        // Create M Token index update payload (M0IT type)
        let custom_payload = payload_encoder::encode_index_payload(
            current_index,
            destination_chain_id
        );

        // Use NTT's prepare_transfer with custom payload
        // This follows the same pattern as regular transfers but with zero amount
        ntt::prepare_transfer(
            &portal.ntt_state,
            zero_coin,
            coin_meta,
            destination_chain_id,
            recipient,
            option::some(custom_payload), // This is where the M0IT payload goes
            false, // Don't queue custom messages
        )
    }

    /// Execute the index update transfer (PTB-compatible)
    /// This sends the zero-amount transfer with custom payload through transceivers
    public fun send_index_update_ptb(
        portal: &mut SpokePortal,
        version_gated: VersionGated,
        coin_meta: &CoinMetadata<M_TOKEN>,
        ticket: TransferTicket<M_TOKEN>,
        clock: &Clock,
        ctx: &mut TxContext
    ): OutboxKey {
        // Execute the custom message transfer through NTT
        // This will route through the same transceiver flow as regular transfers
        ntt::transfer_tx_sender(
            &mut portal.ntt_state,
            version_gated,
            coin_meta,
            ticket,
            clock,
            ctx
        )
    }

    /// Convert balance to coin for PTB dust handling
    /// This mirrors the pattern from NTT Sui implementation
    public fun balance_to_coin(balance: Balance<M_TOKEN>, ctx: &mut TxContext): Coin<M_TOKEN> {
        coin::from_balance(balance, ctx)
    }

    /// Destroy zero balance (PTB helper)
    public fun destroy_zero_balance(balance: Balance<M_TOKEN>) {
        balance::destroy_zero(balance);
    }

    /// Check if balance is zero (PTB helper)
    public fun is_balance_zero(balance: &Balance<M_TOKEN>): bool {
        balance::value(balance) == 0
    }

    /// Create version gated object (PTB helper)
    /// This is required for most NTT operations
    public fun new_version_gated(): VersionGated {
        upgrades::new_version_gated()
    }

    /// Create zero-value coin for custom messages (PTB helper)
    /// This is needed for zero-amount transfers that carry custom payloads
    public fun zero_coin(ctx: &mut TxContext): Coin<M_TOKEN> {
        coin::zero<M_TOKEN>(ctx)
    }

    // ================ Message Reception Functions ================

    /// Custom release function for M Token with additional payload processing
    /// This handles the final token minting with custom M Token logic
    public fun release_m_token(
        portal: &mut SpokePortal,
        m_token_global: &mut MTokenGlobal,
        registrar_global: &mut RegistrarGlobal,
        version_gated: VersionGated,
        from_chain_id: u16,
        message: NttManagerMessage<NativeTokenTransfer>,
        coin_meta: &CoinMetadata<M_TOKEN>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Extract the NTT message data and additional payload
        let (message_id, _sender, ntt_transfer) = ntt_manager_message::destruct(message);
        let (trimmed_amount, _source_token, recipient_external, _to_chain, additional_payload) =
            native_token_transfer::destruct(ntt_transfer);

        // Convert to local types
        let recipient = external_address::to_address(recipient_external);
        let amount = trimmed_amount.untrim(coin_meta.get_decimals());

        // Process additional payload if present
        if (option::is_some(&additional_payload)) {
            let payload_bytes = option::destroy_some(additional_payload);

            // Check if this is a custom M Token payload (M0IT/M0KT/M0LU)
            if (vector::length(&payload_bytes) >= 4) {
                let payload_type = payload_encoder::get_payload_type(&payload_bytes);

                if (payload_encoder::is_index_payload(&payload_type) ||
                    payload_encoder::is_key_payload(&payload_type) ||
                    payload_encoder::is_list_payload(&payload_type)) {

                    // Process custom message (M0IT/M0KT/M0LU)
                    process_custom_message(
                        portal,
                        m_token_global,
                        registrar_global,
                        payload_bytes,
                        ctx
                    );

                    // For custom messages, mint the amount to recipient (usually zero for pure custom messages)
                    if (amount > 0) {
                        mint_or_unlock(portal, m_token_global, recipient, amount, 0, ctx); // Index will be updated by custom logic
                    };
                    return
                }
            };

            // Regular M Token transfer with index in additional payload
            let (index, _destination_token) = payload_encoder::decode_m_additional_payload(&payload_bytes);
            mint_or_unlock(portal, m_token_global, recipient, amount, index, ctx);

            // Emit event for tracking
            event::emit(MTokenReceived {
                source_chain_id: from_chain_id,
                destination_token: @0x0, // TODO: extract from destination_token
                sender: external_address::from_address(@0x0), // TODO: extract from sender
                recipient,
                amount,
                index,
                message_id: wormhole::bytes32::to_bytes(message_id), // Convert Bytes32 to vector<u8>
            });
        } else {
            // Standard token transfer without additional payload
            mint_or_unlock(portal, m_token_global, recipient, amount, 0, ctx);
        }
    }

    /// Handle incoming message from Hub Portal
    /// This processes all messages through NTT redeem and then handles custom payloads
    public fun handle_message<Transceiver>(
        portal: &mut SpokePortal,
        m_token_global: &mut MTokenGlobal,
        registrar_global: &mut RegistrarGlobal,
        version_gated: VersionGated,
        validated_message: ValidatedTransceiverMessage<Transceiver, vector<u8>>,
        coin_meta: &CoinMetadata<M_TOKEN>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // All messages go through standard NTT redeem for validation and rate limiting
        // This handles the core cross-chain message validation and token operations
        ntt::redeem<M_TOKEN, Transceiver>(
            &mut portal.ntt_state,
            version_gated,
            coin_meta,
            validated_message,
            clock
        );

        // Note: Custom payload processing would need to be integrated into the NTT release flow
        // The current NTT implementation doesn't expose the additional payload after redeem.
        // Custom payloads (M0IT/M0KT/M0LU) would be processed during the release phase
        // when the token transfer is actually executed.
        //
        // For full implementation, we would need to:
        // 1. Override the NTT release function in our portal
        // 2. Extract the additional payload during release
        // 3. Process M0IT/M0KT/M0LU payloads before final token minting
        //
        // This maintains the security and validation benefits of NTT while adding
        // custom M Token functionality.
    }

    /// Inspect message to determine if it contains custom M Token payloads
    /// This examines the additional_payload field without consuming the message
    fun inspect_message_for_custom_payload<Transceiver>(
        validated_message: &ValidatedTransceiverMessage<Transceiver, vector<u8>>
    ): bool {
        // Note: The ValidatedTransceiverMessage contains a TransceiverMessageData<vector<u8>>
        // but we need to parse this as an NTT message. Since we can't peek into the structure
        // non-destructively with the current NTT API, we'll need to handle this during
        // the redeem process itself.

        // For now, we'll return false to route all messages through standard NTT redeem.
        // The custom payload handling will happen in the handle_message flow after redeem.
        // This is actually the correct pattern since we need to validate the message
        // through NTT first before processing custom logic.

        false
    }

    /// Handle custom messages (M0IT/M0KT/M0LU) separately from regular transfers
    fun handle_custom_message<Transceiver>(
        portal: &mut SpokePortal,
        m_token_global: &mut MTokenGlobal,
        registrar_global: &mut RegistrarGlobal,
        version_gated: VersionGated,
        validated_message: ValidatedTransceiverMessage<Transceiver, vector<u8>>,
        coin_meta: &CoinMetadata<M_TOKEN>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // For custom messages, we still need to go through NTT redeem for validation
        // but we extract and process the custom payloads afterward
        ntt::redeem<M_TOKEN, Transceiver>(
            &mut portal.ntt_state,
            version_gated,
            coin_meta,
            validated_message,
            clock
        );

        // TODO: After redeem, extract the additional_payload and process custom logic
        // This would involve:
        // 1. Getting the additional_payload from the redeemed message
        // 2. Determining payload type (M0IT/M0KT/M0LU)
        // 3. Calling appropriate handler functions

        // For now, this is a placeholder that maintains current behavior
        // The infrastructure is in place for when we implement full custom payload extraction
    }

    /// Process incoming token transfer with M Token index (called after NTT redeem)
    /// This handles the M Token-specific logic for regular transfers that include index updates
    public fun process_m_token_transfer(
        portal: &mut SpokePortal,
        m_token_global: &mut MTokenGlobal,
        recipient: address,
        amount: u64,
        additional_payload: vector<u8>,
        ctx: &mut TxContext
    ) {
        // Decode the M Token additional payload to extract index and destination token
        let (index, _destination_token) = payload_encoder::decode_m_additional_payload(&additional_payload);

        // Mint M Tokens to recipient with potential index update
        mint_or_unlock(
            portal,
            m_token_global,
            recipient,
            amount,
            index,
            ctx
        );

        // Emit event for tracking
        event::emit(MTokenReceived {
            source_chain_id: 1, // Ethereum chain ID - TODO: get from message
            destination_token: @0x0, // TODO: extract from payload
            sender: external_address::from_address(@0x0), // TODO: extract from message
            recipient,
            amount,
            index,
            message_id: vector::empty<u8>(), // TODO: extract message ID
        });
    }

    /// Process pure custom payload messages (after zero-amount NTT redemption)
    /// This handles M0IT/M0KT/M0LU messages that don't involve token transfers
    public fun process_custom_message(
        portal: &mut SpokePortal,
        m_token_global: &mut MTokenGlobal,
        registrar_global: &mut RegistrarGlobal,
        additional_payload: vector<u8>,
        ctx: &mut TxContext
    ) {
        // Determine payload type and route accordingly
        let payload_type = payload_encoder::get_payload_type(&additional_payload);

        if (payload_encoder::is_index_payload(&payload_type)) {
            let (index, destination_chain_id) = payload_encoder::decode_index_payload(additional_payload);
            let message_id = vector::empty<u8>(); // TODO: extract real message ID
            update_m_token_index(portal, m_token_global, message_id, index, destination_chain_id, ctx);
        } else if (payload_encoder::is_key_payload(&payload_type)) {
            let (key, value, destination_chain_id) = payload_encoder::decode_key_payload(additional_payload);
            let message_id = vector::empty<u8>(); // TODO: extract real message ID
            set_registrar_key(portal, registrar_global, message_id, key, value, destination_chain_id, ctx);
        } else if (payload_encoder::is_list_payload(&payload_type)) {
            let (list_name, account, add, destination_chain_id) = payload_encoder::decode_list_update_payload(additional_payload);
            let message_id = vector::empty<u8>(); // TODO: extract real message ID
            update_registrar_list(portal, registrar_global, message_id, list_name, account, add, destination_chain_id, ctx);
        }
        // If none of the above, it's likely a regular token transfer handled elsewhere
    }

    /// Receive M Token transfer with proper NTT message parsing
    /// This handles incoming token transfers from the Hub Portal
    fun receive_m_token_simplified(
        portal: &mut SpokePortal,
        m_token_global: &mut MTokenGlobal,
        source_chain_id: u16,
        source_ntt_manager: ExternalAddress,
        payload: vector<u8>,
        coin_meta: &CoinMetadata<M_TOKEN>,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // TODO: Parse the NTT token transfer payload
        // For now, we'll implement a simplified version that:
        // 1. Extracts basic transfer info from payload
        // 2. Mints tokens to a default recipient
        // 3. Updates index if needed

        // Placeholder implementation - in reality we'd parse the payload
        let _recipient = ctx.sender(); // Use sender as recipient for now
        let _amount = 1000u64; // Placeholder amount
        let _index = 0u128; // Placeholder index

        // TODO: Actually parse payload to extract:
        // - recipient address
        // - transfer amount
        // - M Token index from additional payload
        // - destination token address

        // For now, just emit a placeholder event
        event::emit(MTokenReceived {
            source_chain_id,
            destination_token: @0x0, // Placeholder
            sender: external_address::from_address(@0x0), // Placeholder
            recipient: ctx.sender(),
            amount: 0,
            index: 0,
            message_id: vector::empty<u8>(),
        });

        // TODO: Actually mint tokens with proper index update
        // mint_or_unlock(portal, m_token_global, recipient, amount, index, ctx);
    }

    /// Process custom payload messages (Index/Key/List updates) - Legacy function
    /// This is kept for compatibility but new code should use process_custom_message
    #[allow(unused_function)]
    fun receive_custom_payload(
        portal: &mut SpokePortal,
        m_token_global: &mut MTokenGlobal,
        registrar_global: &mut RegistrarGlobal,
        message_id: vector<u8>,
        payload_type: PayloadType,
        payload: vector<u8>,
        ctx: &mut TxContext
    ) {
        if (payload_encoder::is_index_payload(&payload_type)) {
            let (index, destination_chain_id) = payload_encoder::decode_index_payload(payload);
            update_m_token_index(portal, m_token_global, message_id, index, destination_chain_id, ctx);
        } else if (payload_encoder::is_key_payload(&payload_type)) {
            let (key, value, destination_chain_id) = payload_encoder::decode_key_payload(payload);
            set_registrar_key(portal, registrar_global, message_id, key, value, destination_chain_id, ctx);
        } else if (payload_encoder::is_list_payload(&payload_type)) {
            let (list_name, account, add, destination_chain_id) = payload_encoder::decode_list_update_payload(payload);
            update_registrar_list(portal, registrar_global, message_id, list_name, account, add, destination_chain_id, ctx);
        }
        // Token payloads are handled by standard NTT flow
    }

    // ================ Custom Message Handlers ================

    /// Update M Token index from Hub Portal (enhanced version)
    fun update_m_token_index(
        portal: &mut SpokePortal,
        m_token_global: &mut MTokenGlobal,
        message_id: vector<u8>,
        index: u128,
        destination_chain_id: u16,
        ctx: &mut TxContext
    ) {
        verify_destination_chain(destination_chain_id, &portal.ntt_state);

        event::emit(MTokenIndexReceived {
            message_id,
            index,
        });

        let current_index = get_current_m_index(m_token_global);
        if (index > current_index) {
            // Update M Token index using portal capability
            m_token::update_index(m_token_global, &portal.m_token_cap, index, ctx);
        }
    }

    /// Set Registrar key from Hub Portal (enhanced version)
    fun set_registrar_key(
        portal: &SpokePortal,
        registrar_global: &mut RegistrarGlobal,
        message_id: vector<u8>,
        key: vector<u8>,
        value: vector<u8>,
        destination_chain_id: u16,
        _ctx: &mut TxContext
    ) {
        verify_destination_chain(destination_chain_id, &portal.ntt_state);

        event::emit(RegistrarKeyReceived {
            message_id,
            key,
            value,
        });

        // Set the key using portal capability
        registrar::set_key(registrar_global, &portal.registrar_cap, key, value);
    }

    /// Update Registrar list from Hub Portal (enhanced version)
    fun update_registrar_list(
        portal: &SpokePortal,
        registrar_global: &mut RegistrarGlobal,
        message_id: vector<u8>,
        list_name: vector<u8>,
        account: address,
        add: bool,
        destination_chain_id: u16,
        _ctx: &mut TxContext
    ) {
        verify_destination_chain(destination_chain_id, &portal.ntt_state);

        event::emit(RegistrarListStatusReceived {
            message_id,
            list_name,
            account,
            add,
        });

        if (add) {
            // Add account to list using portal capability
            registrar::add_to_list(registrar_global, &portal.registrar_cap, list_name, account);
        } else {
            // Remove account from list using portal capability
            registrar::remove_from_list(registrar_global, &portal.registrar_cap, list_name, account);
        }
    }

    // ================ Token Operations ================

    /// Mint M Tokens to recipient (Spoke mode - BURNING)
    /// This mirrors the EVM SpokePortal's _mintOrUnlock function
    fun mint_or_unlock(
        portal: &SpokePortal,
        m_token_global: &mut MTokenGlobal,
        recipient: address,
        amount: u64,
        index: u128,
        ctx: &mut TxContext
    ) {
        // Update M Token index if newer
        let current_index = m_token::current_index(m_token_global);
        let amount_u256 = (amount as u256);

        if (index > current_index) {
            // Mint with new index (this updates index internally)
            m_token::mint(
                m_token_global,
                &portal.m_token_cap,
                recipient,
                amount_u256,
                index,
                ctx
            );
        } else {
            // Mint without updating index
            m_token::mint_no_index(
                m_token_global,
                &portal.m_token_cap,
                recipient,
                amount_u256,
                ctx
            );
        }
    }

    /// Burn M Tokens (Spoke mode - BURNING)
    /// This mirrors the EVM SpokePortal's _burnOrLock function
    fun burn_or_lock(
        portal: &SpokePortal,
        m_token_global: &mut MTokenGlobal,
        coins: Coin<M_TOKEN>,
        ctx: &mut TxContext
    ) {
        // In BURNING mode, burn the tokens
        m_token::burn(
            m_token_global,
            &portal.m_token_cap,
            coins,
            ctx
        );
    }

    // ================ Helper Functions ================

    fun get_current_m_index(m_token_global: &MTokenGlobal): u128 {
        m_token::current_index(m_token_global)
    }

    fun verify_destination_chain(destination_chain_id: u16, ntt_state: &NttState<M_TOKEN>) {
        // Get chain ID from NTT state
        let current_chain_id = ntt_state::get_chain_id(ntt_state);
        assert!(destination_chain_id == current_chain_id, E_INVALID_DESTINATION_CHAIN);
    }

    // ================ Access Functions ================

    public fun borrow_ntt_state(portal: &SpokePortal): &NttState<M_TOKEN> {
        &portal.ntt_state
    }

    public fun borrow_ntt_state_mut(portal: &mut SpokePortal): &mut NttState<M_TOKEN> {
        &mut portal.ntt_state
    }

    public fun m_token_global_id(portal: &SpokePortal): ID {
        portal.m_token_global_id
    }

    public fun registrar_global_id(portal: &SpokePortal): ID {
        portal.registrar_global_id
    }

    public fun borrow_m_token_cap(portal: &SpokePortal): &MTokenPortalCap {
        &portal.m_token_cap
    }

    public fun borrow_registrar_cap(portal: &SpokePortal): &RegistrarPortalCap {
        &portal.registrar_cap
    }
}