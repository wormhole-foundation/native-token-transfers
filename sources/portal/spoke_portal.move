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
    use wormhole::external_address::{ExternalAddress};

    // NTT dependencies
    use ntt::ntt::{Self, TransferTicket};
    use ntt::state::{Self as ntt_state, State as NttState};
    use ntt::outbox::{Self as outbox, OutboxKey};
    use ntt::upgrades::{Self as upgrades, VersionGated};
    use ntt_common::validated_transceiver_message::{ValidatedTransceiverMessage};
    use wormhole::bytes32::{Bytes32};

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
        let _outbox_key = ntt::transfer_tx_sender(
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

        // Return a placeholder sequence for now
        // TODO: Get actual sequence from outbox_key when available
        0
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
        // Using a placeholder for now since we simplified the chain ID access
        21 // Sui chain ID placeholder - TODO: get from NTT state when accessor is available
    }

    /// Create transceiver message for PTB (following NTT pattern)
    /// This should be called after transfer to create the message for transceivers
    /// For now, simplified version - will be enhanced with proper transceiver integration
    public fun create_transceiver_message<TransceiverAuth>(
        _portal: &mut SpokePortal,
        _sequence: Bytes32,
        _clock: &Clock,
    ) {
        // TODO: Implement proper transceiver message creation
        // This will be enhanced in Step 4 with actual transceiver integration
    }

    /// Send custom M Token index update (PTB-compatible)
    /// Returns a value that PTB can use for tracking
    public fun send_index_update_ptb(
        portal: &SpokePortal,
        m_token_global: &MTokenGlobal,
        destination_chain_id: u16,
    ): u128 {
        // Get current index for sending
        let current_index = m_token::current_index(m_token_global);

        // For now, just return the index - actual message sending will be in Step 4
        // TODO: Implement actual custom message sending through transceivers
        current_index
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

    // ================ Message Reception Functions ================

    /// Handle incoming message from Hub Portal (entry point for all messages)
    /// This mirrors the EVM Portal's _handleMsg function
    public fun handle_message<Transceiver>(
        _portal: &mut SpokePortal,
        _m_token_global: &mut MTokenGlobal,
        _registrar_global: &mut RegistrarGlobal,
        _version_gated: VersionGated,
        _source_chain_id: u16,
        _validated_message: ValidatedTransceiverMessage<Transceiver, vector<u8>>,
        _coin_meta: &CoinMetadata<M_TOKEN>,
        _clock: &Clock,
        _ctx: &mut TxContext
    ) {
        // Note: For now we'll simplify the message extraction
        // The actual implementation needs proper destructuring based on NTT's API
        abort 0 // TODO: Implement proper message handling
    }

    /// Process custom payload messages (Index/Key/List updates)
    public fun receive_custom_payload(
        portal: &mut SpokePortal,
        m_token_global: &mut MTokenGlobal,
        registrar_global: &mut RegistrarGlobal,
        message_id: vector<u8>,
        payload_type: PayloadType,
        payload: vector<u8>,
        ctx: &mut TxContext
    ) {
        if (payload_encoder::is_index_payload(&payload_type)) {
            update_m_token_index(portal, m_token_global, message_id, payload, ctx);
        } else if (payload_encoder::is_key_payload(&payload_type)) {
            set_registrar_key(portal, registrar_global, message_id, payload, ctx);
        } else if (payload_encoder::is_list_payload(&payload_type)) {
            update_registrar_list(portal, registrar_global, message_id, payload, ctx);
        }
        // Token payloads are handled by standard NTT flow
    }

    // ================ Custom Message Handlers ================

    /// Update M Token index from Hub Portal
    fun update_m_token_index(
        portal: &mut SpokePortal,
        m_token_global: &mut MTokenGlobal,
        message_id: vector<u8>,
        payload: vector<u8>,
        ctx: &mut TxContext
    ) {
        let (index, destination_chain_id) = payload_encoder::decode_index_payload(payload);
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

    /// Set Registrar key from Hub Portal
    fun set_registrar_key(
        portal: &SpokePortal,
        registrar_global: &mut RegistrarGlobal,
        message_id: vector<u8>,
        payload: vector<u8>,
        _ctx: &mut TxContext
    ) {
        let (key, value, destination_chain_id) = payload_encoder::decode_key_payload(payload);
        verify_destination_chain(destination_chain_id, &portal.ntt_state);

        event::emit(RegistrarKeyReceived {
            message_id,
            key,
            value,
        });

        // Set the key using portal capability
        registrar::set_key(registrar_global, &portal.registrar_cap, key, value);
    }

    /// Update Registrar list from Hub Portal
    fun update_registrar_list(
        portal: &SpokePortal,
        registrar_global: &mut RegistrarGlobal,
        message_id: vector<u8>,
        payload: vector<u8>,
        _ctx: &mut TxContext
    ) {
        let (list_name, account, add, destination_chain_id) = payload_encoder::decode_list_update_payload(payload);
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
        // TODO: Use proper accessor when available
        let current_chain_id = 21; // Sui chain ID placeholder
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