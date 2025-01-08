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
        ntt_common::contract_auth::assert_auth_type(auth);
        ValidatedTransceiverMessage {
            from_chain,
            message
        }
    }

    public fun destruct_recipient_only<TransceiverAuth, ManagerAuth, A>(
        message: ValidatedTransceiverMessage<TransceiverAuth, A>,
        auth: &ManagerAuth, // only the recipient mangaer can destruct
    ): (u16, ExternalAddress, NttManagerMessage<A>) {
        let ValidatedTransceiverMessage { from_chain, message } = message;
        let (source_ntt_manager, recipient_ntt_manager, ntt_manager_message) = message.destruct();
        let caller_manager = ntt_common::contract_auth::assert_auth_type(auth);
        assert!(external_address::from_address(caller_manager) == recipient_ntt_manager, EInvalidRecipientManager);
        (from_chain, source_ntt_manager, ntt_manager_message)
    }
}
