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
    use sui::balance::Balance;
    use sui::clock::Clock;
    use sui::event;
    use wormhole::external_address::{Self as external_address, ExternalAddress};
    use wormhole::bytes32::{Self as bytes32};
    
    // NTT dependencies
    use ntt::ntt::{Self, TransferTicket};
    use ntt::state::{Self as ntt_state, State as NttState};
    use ntt::upgrades::VersionGated;
    use ntt_common::validated_transceiver_message::ValidatedTransceiverMessage;
    use ntt_common::ntt_manager_message::NttManagerMessage;
    use ntt_common::native_token_transfer::NativeTokenTransfer;

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
    
    /// Prepare M Token transfer (wraps NTT functionality)
    public fun prepare_m_token_transfer(
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
    
    /// Execute M Token transfer
    public fun transfer_m_token(
        portal: &mut SpokePortal,
        version_gated: VersionGated,
        coin_meta: &CoinMetadata<M_TOKEN>,
        ticket: TransferTicket<M_TOKEN>,
        clock: &Clock,
        ctx: &TxContext
    ) {
        ntt::transfer_tx_sender(
            &mut portal.ntt_state,
            version_gated,
            coin_meta,
            ticket,
            clock,
            ctx
        );
    }
    
    // ================ Message Reception Functions ================
    
    // /// Attest incoming message from transceiver
    // /// TODO: Re-enable when we implement proper NTT integration
    // public fun attest_message<Transceiver>(
    //     portal: &mut SpokePortal,
    //     version_gated: VersionGated,
    //     source_chain_id: u16,
    //     validated_message: ValidatedTransceiverMessage<Transceiver, vector<u8>>,
    //     coin_meta: &CoinMetadata<M_TOKEN>,
    //     clock: &Clock,
    // ) {
    //     // TODO: Implement NTT attestation logic
    // }
    
    // /// Release incoming token transfer
    // /// TODO: Re-enable when we implement proper NTT integration
    // public fun release_transfer(
    //     _portal: &mut SpokePortal,
    //     _version_gated: VersionGated,
    //     _from_chain_id: u16,
    //     _message: NttManagerMessage<NativeTokenTransfer>,
    //     _coin_meta: &CoinMetadata<M_TOKEN>,
    //     _clock: &Clock,
    //     ctx: &mut TxContext
    // ): Coin<M_TOKEN> {
    //     // TODO: Implement actual release logic
    //     sui::coin::zero<M_TOKEN>(ctx)
    // }
    
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
    
    // ================ Helper Functions ================
    
    fun get_current_m_index(m_token_global: &MTokenGlobal): u128 {
        m_token::current_index(m_token_global)
    }
    
    fun verify_destination_chain(destination_chain_id: u16, ntt_state: &NttState<M_TOKEN>) {
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

    // ================ TODO: NTT Integration Functions ================
    //
    // The following functions will be implemented when we integrate with NTT:
    // - attest_message: For handling incoming attestations from transceivers
    // - release_transfer: For releasing tokens from cross-chain transfers
    //
    // These are currently commented out because they require non-droppable
    // structs from the NTT framework that need proper consumption.
}