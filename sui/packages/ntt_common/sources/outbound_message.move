/// Outbound communication between managers and transceivers.
///
/// The manager issues values of type `OutboundMessage<SomeTransceiverAuth>`
/// when it wants a particular transceiver (in this case the one that defines
/// the type `SomeTransceiverAuth`) to send a message.
///
/// The transceiver can unwrap the message using `unwrap_outbound_message`, and
/// indeed it has to, because `OutboundMessage`s cannot be dropped otherwise.
/// The manager implements replay protection, so it will only issue the message once.
/// (TODO: should we relax this? no harm in sending the same message multiple
/// times, the receiving side implements replay protection anyway)
/// Thus, it's crucial that the intended transceiver consumes the message.
///
/// Additionally, the `source_ntt_manager` field encodes the address of the
/// manager that sent the message, which is verified by checking the
/// `ManagerAuth` type in `new`. This way, the transceiver doesn't have to trust
/// the particular manager implementation to ensure it's not lying about its own
/// identity.
/// This is not super relevant in the current setup where transceivers are
/// deployed alongside the managers, but it is an important design decision for
/// the future, if we want to share a single transceiver between multiple managers.
module ntt_common::outbound_message {
    use wormhole::external_address::{Self, ExternalAddress};
    use ntt_common::contract_auth;
    use ntt_common::ntt_manager_message::NttManagerMessage;

    /// Wraps a message to be sent by `Transceiver`.
    /// Only the relevant transceiver can unwrap the message via `unwrap_outbound_message`.
    public struct OutboundMessage<phantom ManagerAuth, phantom TransceiverAuth> {
        message: NttManagerMessage<vector<u8>>,
        source_ntt_manager: ExternalAddress,
        recipient_ntt_manager: ExternalAddress,
    }

    public fun new<ManagerAuth, TransceiverAuth, State: key>(
        auth: &ManagerAuth,
        state: &State,
        message: NttManagerMessage<vector<u8>>,
        recipient_ntt_manager: ExternalAddress,
    ): OutboundMessage<ManagerAuth, TransceiverAuth> {
        let manager_address = contract_auth::auth_as(auth, b"ManagerAuth", state);
        let source_ntt_manager = external_address::from_address(manager_address);
        OutboundMessage { message, source_ntt_manager, recipient_ntt_manager }
    }

    public fun unwrap_outbound_message<ManagerAuth, TransceiverAuth>(
        message: OutboundMessage<ManagerAuth, TransceiverAuth>,
        auth: &TransceiverAuth,
    ): (NttManagerMessage<vector<u8>>, ExternalAddress, ExternalAddress) {
        contract_auth::assert_auth_type(auth, b"TransceiverAuth");
        let OutboundMessage { message, source_ntt_manager, recipient_ntt_manager } = message;
        (message, source_ntt_manager, recipient_ntt_manager)
    }
}
