module wormhole_transceiver::wormhole_transceiver {
    use sui::table::{Self, Table};
    use wormhole::vaa::{Self, VAA};
    use wormhole::emitter::EmitterCap;
    use wormhole::external_address::ExternalAddress;
    use wormhole::publish_message::MessageTicket;
    use ntt_common::outbound_message::OutboundMessage;
    use ntt_common::validated_transceiver_message::{Self, ValidatedTransceiverMessage};
    use ntt_common::transceiver_message::{Self, PrefixOf};
    use ntt_common::transceiver_message_data;
    use ntt::state::{State as ManagerState};
    use sui::coin::{CoinMetadata};

    public struct TransceiverAuth has drop {}

    public fun prefix(): PrefixOf<TransceiverAuth> {
        transceiver_message::prefix(&TransceiverAuth {}, ntt_common::bytes4::new(x"9945FF10"))
    }

    public struct State<phantom ManagerAuth> has key, store {
        id: UID,
        peers: Table<u16, ExternalAddress>,
        emitter_cap: EmitterCap,
        admin_cap_id: ID,
    }

    public(package) fun new<ManagerAuth>(
        wormhole_state: &wormhole::state::State,
        ctx: &mut TxContext
    ): (State<ManagerAuth>, AdminCap) {
        assert!(ntt_common::contract_auth::is_auth_type<ManagerAuth>(b"ManagerAuth"));
        let admin_cap = AdminCap {
            id: object::new(ctx)
        };
        let state = State {
            id: object::new(ctx),
            peers: table::new(ctx),
            emitter_cap: wormhole::emitter::new(wormhole_state, ctx), // Creates a new emitter cap for WH core. Acts as the *peer* on the other side.
            admin_cap_id: admin_cap.id.to_inner(),
        };
        (state, admin_cap)
    }

    public struct DeployerCap has key, store {
        id: UID
    }

    // Only callable by the 'creator' of the module.
    fun init(ctx: &mut TxContext) { // Made on creation of module
        let deployer = DeployerCap { id: object::new(ctx) };
        transfer::transfer(deployer, tx_context::sender(ctx));
    }

    #[allow(lint(share_owned))]
    public fun complete<ManagerAuth>(deployer: DeployerCap, wormhole_state: &wormhole::state::State, ctx: &mut TxContext): AdminCap {
        let DeployerCap { id } = deployer;
        object::delete(id); // Deletion means that nothing can redeploy this again...

        let (state, admin_cap) = new<ManagerAuth>(wormhole_state, ctx);
        transfer::public_share_object(state);

        admin_cap
    }

    public fun release_outbound<ManagerAuth>(
        state: &mut State<ManagerAuth>,
        message: OutboundMessage<ManagerAuth, TransceiverAuth>,
    ): MessageTicket {

        let (ntt_manager_message, source_ntt_manager, recipient_ntt_manager)
            = message.unwrap_outbound_message(&TransceiverAuth {});

        let transceiver_message = transceiver_message::new(
            transceiver_message_data::new(
                source_ntt_manager,
                recipient_ntt_manager,
                ntt_manager_message
            ),
            vector[]
        );
        let transceiver_message_encoded = transceiver_message.to_bytes(prefix());

        let message_ticket = wormhole::publish_message::prepare_message(
            &mut state.emitter_cap,
            0,
            transceiver_message_encoded,
        );
        message_ticket
    }

    public fun validate_message<ManagerAuth>(
        state: &State<ManagerAuth>,
        vaa: VAA,
    ): ValidatedTransceiverMessage<TransceiverAuth, vector<u8>> {
        let (emitter_chain, emitter_address, payload)
            = vaa::take_emitter_info_and_payload(vaa);

        assert!(state.peers.borrow(emitter_chain) == emitter_address);

        let transceiver_message = ntt_common::transceiver_message::parse(prefix(), payload);

        let (message_data, _) = transceiver_message.destruct();

        validated_transceiver_message::new(
            &TransceiverAuth {},
            emitter_chain,
            message_data,
        )
    }

    ////// Admin stuff

    public struct AdminCap has key, store {
        id: UID
    }

    public fun set_peer<ManagerAuth>(_ : &AdminCap, state: &mut State<ManagerAuth>, chain: u16, peer: ExternalAddress): MessageTicket{

        // Cannot replace WH peers because of complexities with the accountant, according to EVM implementation.
        assert!(!state.peers.contains(chain));
        state.peers.add(chain, peer);

        broadcast_peer(chain, peer, state)
    }

    /*
    Broadcast Peer in Solana
    Transceiver Registration in EVM

    NTT Accountant must know which transceivers registered each other as peers.
    */
    fun broadcast_peer<ManagerAuth>(chain_id: u16, peer_address: ExternalAddress, state: &mut State<ManagerAuth>): MessageTicket{

        let transceiver_registration_struct = wormhole_transceiver::wormhole_transceiver_registration::new(chain_id, peer_address);
        let message_ticket = wormhole::publish_message::prepare_message(
            &mut state.emitter_cap,
            0,
            transceiver_registration_struct.to_bytes(),
        );
        message_ticket
    }

    /*
    TransceiverInit on EVM
    BroadCastId on Solana

    Deployment of a new transceiver and notice to the NTT accountant.
    Added as a separate function instead of in `init/complete` because
    we want to keep these functions simple and dependency free. Additionally, the deployer of NTT may not want
    the NTT accountant to begin with but does want it in the future.
    If wanted in the future, an admin would call this function to allow the NTT accountant to work.
    */
    public fun broadcast_id<CoinType, ManagerAuth>(_: &AdminCap, coin_meta: &CoinMetadata<CoinType>, state: &mut State<ManagerAuth>, manager_state: &ManagerState<CoinType>): MessageTicket {

        let mut manager_address_opt: Option<address> = ntt_common::contract_auth::get_auth_address<ManagerAuth>(b"ManagerAuth");
        let manager_address = option::extract(&mut manager_address_opt);

        let external_address_manager_address = wormhole::external_address::from_address(manager_address);

        let transceiver_info_struct = wormhole_transceiver::wormhole_transceiver_info::new(external_address_manager_address, *manager_state.borrow_mode(),  wormhole::external_address::from_id(object::id(coin_meta)), coin_meta.get_decimals());

        let message_ticket = wormhole::publish_message::prepare_message(
            &mut state.emitter_cap,
            0,
            transceiver_info_struct.to_bytes(),
        );
        message_ticket
    }

    #[test]
    public fun test_auth_type() {
        assert!(ntt_common::contract_auth::is_auth_type<wormhole_transceiver::wormhole_transceiver::TransceiverAuth>(b"TransceiverAuth"), 0);
    }
}
