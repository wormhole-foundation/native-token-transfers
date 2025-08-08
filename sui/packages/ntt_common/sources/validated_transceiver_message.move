/// Inbound communication between transceivers and managers.
///
/// The transceiver validates the message, and constructs
/// a `ValidatedTransceiverMessage` value.
///
/// The `new` function requires authenticates the transceiver, and stores its
/// identity in a phantom type parameter.
/// Thus, when the manager receives a value of type
/// `ValidatedTransceiverMessage<SomeTransceiverAuth, A>`, it knows it was
/// created by the transceiver that defines the `SomeTransceiverAuth` type.
///
/// The manager will then consume this message using the `destruct_recipient_only`.
/// As the function's name suggests, only the intended manager can consume the message.
/// This guarantees that once the transceiver has validated the message, it will be seen by
/// the appropriate manager.
/// This is not a strict security requirement, as long as the transceiver
/// doesn't implement its internal replay protection, because then no denial of
/// service is possible by a malicious client "hijacking" a validation.
/// Nevertheless, we restrict the consumption in this way to provide a static
/// guarantee that the message will be sent to the right place.
module ntt_common::validated_transceiver_message {
    use wormhole::external_address::{Self, ExternalAddress};
    use ntt_common::transceiver_message_data::TransceiverMessageData;
    use ntt_common::ntt_manager_message::NttManagerMessage;

    #[error]
    const EInvalidRecipientManager: vector<u8> =
        b"Invalid recipient manager.";

    public struct ValidatedTransceiverMessage<phantom Transceiver, A> {
        from_chain: u16,
        message: TransceiverMessageData<A>
    }

    public fun new<TransceiverAuth, A>(
        auth: &TransceiverAuth, // only the transceiver can create it
        from_chain: u16,
        message: TransceiverMessageData<A>
    ): ValidatedTransceiverMessage<TransceiverAuth, A> {
        ntt_common::contract_auth::assert_auth_type(auth, b"TransceiverAuth");
        ValidatedTransceiverMessage {
            from_chain,
            message
        }
    }

    public fun destruct_recipient_only<TransceiverAuth, ManagerAuth, State: key, A>(
        message: ValidatedTransceiverMessage<TransceiverAuth, A>,
        auth: &ManagerAuth, // only the recipient manager can destruct
        state: &State
    ): (u16, ExternalAddress, NttManagerMessage<A>) {
        let ValidatedTransceiverMessage { from_chain, message } = message;
        let (source_ntt_manager, recipient_ntt_manager, ntt_manager_message) = message.destruct();
        let caller_manager = ntt_common::contract_auth::auth_as(auth, b"ManagerAuth", state);
        assert!(external_address::from_address(caller_manager) == recipient_ntt_manager, EInvalidRecipientManager);
        (from_chain, source_ntt_manager, ntt_manager_message)
    }
}
