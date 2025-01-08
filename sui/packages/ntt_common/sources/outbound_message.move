module ntt_common::outbound_message {
    use wormhole::external_address::{Self, ExternalAddress};
    use ntt_common::contract_auth;
    use ntt_common::ntt_manager_message::NttManagerMessage;

    /// Wraps a message to be sent by `Transceiver`.
    /// Only the relevant transceiver can unwrap the message via `unwrap_outbound_message`.
    public struct OutboundMessage<phantom TransceiverAuth> {
        message: NttManagerMessage<vector<u8>>,
        source_ntt_manager: ExternalAddress,
        recipient_ntt_manager: ExternalAddress,
    }

    public fun new<ManagerAuth, TransceiverAuth>(
        auth: &ManagerAuth,
        message: NttManagerMessage<vector<u8>>,
        recipient_ntt_manager: ExternalAddress,
    ): OutboundMessage<TransceiverAuth> {
        let manager_address = contract_auth::assert_auth_type(auth);
        let source_ntt_manager = external_address::from_address(manager_address);
        OutboundMessage { message, source_ntt_manager, recipient_ntt_manager }
    }

    public fun unwrap_outbound_message<TransceiverAuth>(
        message: OutboundMessage<TransceiverAuth>,
        auth: &TransceiverAuth,
    ): (NttManagerMessage<vector<u8>>, ExternalAddress, ExternalAddress) {
        contract_auth::assert_auth_type(auth);
        let OutboundMessage { message, source_ntt_manager, recipient_ntt_manager } = message;
        (message, source_ntt_manager, recipient_ntt_manager)
    }
}
