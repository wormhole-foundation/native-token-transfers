module wormhole_transceiver::wormhole_transceiver {
    use sui::table::Table;
    use wormhole::vaa::{Self, VAA};
    use wormhole::emitter::EmitterCap;
    use wormhole::external_address::ExternalAddress;
    use wormhole::publish_message::MessageTicket;
    use ntt_common::outbound_message::OutboundMessage;
    use ntt_common::validated_transceiver_message::{Self, ValidatedTransceiverMessage};
    use ntt_common::transceiver_message::{Self, PrefixOf};
    use ntt_common::transceiver_message_data;

    public struct WormholeTransceiverAuth has drop {}

    public fun prefix(): PrefixOf<WormholeTransceiverAuth> {
        transceiver_message::prefix(&WormholeTransceiverAuth {}, ntt_common::bytes4::new(x"9945FF10"))
    }

    public struct State {
        peers: Table<u16, ExternalAddress>,
        emitter_cap: EmitterCap,
    }

    public fun release_outbound(
        state: &mut State,
        message: OutboundMessage<WormholeTransceiverAuth>,
    ): Option<MessageTicket> {
        let (ntt_manager_message, source_ntt_manager, recipient_ntt_manager)
            = message.unwrap_outbound_message(&WormholeTransceiverAuth {});

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
    ): ValidatedTransceiverMessage<WormholeTransceiverAuth, vector<u8>> {
        let (emitter_chain, emitter_address, payload)
            = vaa::take_emitter_info_and_payload(vaa);

        assert!(state.peers.borrow(emitter_chain) == emitter_address);

        let transceiver_message = ntt_common::transceiver_message::parse(prefix(), payload);

        let (message_data, _) = transceiver_message.destruct();

        validated_transceiver_message::new(
            &WormholeTransceiverAuth {},
            emitter_chain,
            message_data,
        )
    }

    ////// Admin stuff

    public struct AdminCap has key {
        id: UID
    }

    public fun set_peer(
        _: &AdminCap,
        state: &mut State,
        chain: u16,
        peer: ExternalAddress
    ) {
        state.peers.add(chain, peer)
    }

}
