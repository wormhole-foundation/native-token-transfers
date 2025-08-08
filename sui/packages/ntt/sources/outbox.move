module ntt::outbox {
    use sui::table::{Self, Table};
    use sui::clock::Clock;
    use wormhole::bytes32::Bytes32;
    use wormhole::external_address::ExternalAddress;
    use ntt_common::bitmap::{Self, Bitmap};
    use ntt::rate_limit::{Self, RateLimitState};
    use ntt_common::ntt_manager_message::NttManagerMessage;

    #[error]
    const EMessageAlreadySent: vector<u8>
        = b"Message has already been sent by this transceiver";

    public struct Outbox<T: store> has store {
        entries: Table<OutboxKey, OutboxItem<T>>,
        rate_limit: RateLimitState,
    }

    public(package) fun new<T: store>(outbound_limit: u64, ctx: &mut TxContext): Outbox<T> {
        Outbox {
            entries: table::new(ctx),
            rate_limit: rate_limit::new(outbound_limit),
        }
    }

    public fun borrow_rate_limit_mut<T: store>(outbox: &mut Outbox<T>): &mut RateLimitState {
        &mut outbox.rate_limit
    }

    public struct OutboxKey has copy, drop, store {
        id: Bytes32,
    }

    public fun get_id(key: &OutboxKey): Bytes32 {
        key.id
    }

    public fun new_outbox_key(id: Bytes32): OutboxKey {
        OutboxKey { id }
    }

    public struct OutboxItem<T> has store {
        release_timestamp: u64,
        released: Bitmap,
        recipient_ntt_manager: ExternalAddress,
        data: NttManagerMessage<T>,
    }

    public fun new_outbox_item<T>(
        release_timestamp: u64,
        recipient_ntt_manager: ExternalAddress,
        data: NttManagerMessage<T>
    ): OutboxItem<T> {
        OutboxItem {
            release_timestamp,
            released: bitmap::empty(),
            recipient_ntt_manager,
            data: data,
        }
    }

    public fun add<T: store>(outbox: &mut Outbox<T>, item: OutboxItem<T>): OutboxKey {
        let key = OutboxKey { id: item.data.get_id() };
        outbox.entries.add(key, item);
        key
    }

    public fun borrow<T: store>(outbox: &Outbox<T>, key: OutboxKey): &OutboxItem<T> {
        outbox.entries.borrow(key)
    }

    public fun borrow_data<T: store>(outbox: &OutboxItem<T>): &NttManagerMessage<T> {
        &outbox.data
    }

    public fun borrow_recipient_ntt_manager_address<T: store>(
        outbox_item: &OutboxItem<T>,
    ): &ExternalAddress {
        &outbox_item.recipient_ntt_manager
    }

    public(package) fun try_release<T: store>(
        outbox: &mut Outbox<T>,
        key: OutboxKey,
        transceiver_index: u8,
        clock: &Clock
    ): bool {
        let outbox_item = outbox.entries.borrow_mut(key);
        let now = clock.timestamp_ms();

        if (outbox_item.release_timestamp > now) {
            return false
        };

        if (outbox_item.released.get(transceiver_index)) {
            abort EMessageAlreadySent
        };

        outbox_item.released.enable(transceiver_index);

        true
    }
}
