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

    public struct Auth has drop {}

    public fun prefix(): PrefixOf<Auth> {
        transceiver_message::prefix(&Auth {}, ntt_common::bytes4::new(x"9945FF10"))
    }

    public struct State has key, store {
        id: UID,
        peers: Table<u16, ExternalAddress>,
        emitter_cap: EmitterCap,
    }

    public(package) fun new(
        wormhole_state: &wormhole::state::State,
        ctx: &mut TxContext
    ): State {
        State {
            id: object::new(ctx),
            peers: table::new(ctx),
            emitter_cap: wormhole::emitter::new(wormhole_state, ctx), // Creates a new emitter cap for WH core. Acts as the *peer* on the other side.
        }
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
    public fun complete(deployer: DeployerCap, wormhole_state: &wormhole::state::State, ctx: &mut TxContext): AdminCap {
        let DeployerCap { id } = deployer;
        object::delete(id); // Deletion means that nothing can redeploy this again...

        let state = new(wormhole_state, ctx);
        transfer::public_share_object(state);

        AdminCap { id: object::new(ctx) }
    }

    public fun release_outbound(
        state: &mut State,
        message: OutboundMessage<Auth>,
    ): Option<MessageTicket> {

        let (ntt_manager_message, source_ntt_manager, recipient_ntt_manager)
            = message.unwrap_outbound_message(&Auth {});

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
        option::some(message_ticket)
    }

    public fun validate_message(
        state: &State,
        vaa: VAA, 
    ): ValidatedTransceiverMessage<Auth, vector<u8>> {
        let (emitter_chain, emitter_address, payload)
            = vaa::take_emitter_info_and_payload(vaa);

        assert!(state.peers.borrow(emitter_chain) == emitter_address);

        let transceiver_message = ntt_common::transceiver_message::parse(prefix(), payload);

        let (message_data, _) = transceiver_message.destruct();

        validated_transceiver_message::new(
            &Auth {},
            emitter_chain,
            message_data,
        )
    }

    ////// Admin stuff

    public struct AdminCap has key, store {
        id: UID
    }

    // public fun set_peer(
    //     _: &AdminCap,
    //     state: &mut State,
    //     chain: u16,
    //     peer: ExternalAddress
    // ) {
    //     if (state.peers.contains(chain)) {
    //         state.peers.remove(chain);
    //     };
    //     state.peers.add(chain, peer);
    // }

    public fun set_peer(_ : &AdminCap, state: &mut State, chain: u16, peer: ExternalAddress): Option<MessageTicket>{
        
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
    fun broadcast_peer(chain_id: u16, peer_address: ExternalAddress, state: &mut State): Option<MessageTicket>{

        let transceiver_registration_struct = wormhole_transceiver::wormhole_transceiver_registration::new(chain_id, peer_address);
        let message_ticket = wormhole::publish_message::prepare_message(
            &mut state.emitter_cap,
            0,
            transceiver_registration_struct.to_bytes(),
        );
        option::some(message_ticket) 
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
    public fun broadcast_id<CoinType, Auth>(_: &AdminCap, coin_meta: &CoinMetadata<CoinType>, state: &mut State, manager_state: &ManagerState<CoinType>): Option<MessageTicket> {

        let mut manager_address_opt: Option<address> = ntt_common::contract_auth::get_auth_address<Auth>(); 
        let manager_address = option::extract(&mut manager_address_opt);

        let external_address_manager_address = wormhole::external_address::from_address(manager_address);

        let transceiver_info_struct = wormhole_transceiver::wormhole_transceiver_info::new(external_address_manager_address, *manager_state.borrow_mode(),  wormhole::external_address::from_id(object::id(coin_meta)), coin_meta.get_decimals());

        let message_ticket = wormhole::publish_message::prepare_message(
            &mut state.emitter_cap,
            0,
            transceiver_info_struct.to_bytes(),
        );
        option::some(message_ticket)
    }

    #[test]
    public fun test_auth_type() {
        assert!(ntt_common::contract_auth::is_auth_type<wormhole_transceiver::wormhole_transceiver::Auth>(), 0);
    }
}
