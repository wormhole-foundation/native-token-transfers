module ntt::inbox {
    use sui::clock::Clock;
    use sui::table::{Self, Table};
    use ntt_common::bitmap::{Self, Bitmap};
    use ntt_common::ntt_manager_message::NttManagerMessage;

    #[error]
    const ETransferCannotBeRedeemed: vector<u8>
        = b"Transfer cannot be redeemed yet";

    #[error]
    const ETransferAlreadyRedeemed: vector<u8>
        = b"Transfer already redeemed";

    // === Inbox ===

    /// The inbox.
    /// It's a key-value store where the key is a message containing some
    /// payload 'K', and the value is the value 'K' along with information about
    /// how many transceivers have voted for it, and whether it has been processed yet.
    ///
    /// For security reasons, a mutable reference to an inbox should never be exposed publicly.
    /// This is because priviliged functions are gated by a mutable reference to the inbox.
    ///
    /// In practice, 'K' is instantiated with NativeTokenTransfer, but is written generically
    /// here to make reasoning about the code easier (as the inbox doesn't care
    /// about the things it stores)
    public struct Inbox<K: store + copy + drop> has store {
        entries: Table<InboxKey<K>, InboxItem<K>>
    }

    public fun new<K: store + copy + drop>(ctx: &mut TxContext): Inbox<K> {
        Inbox {
            entries: table::new(ctx),
        }
    }

    // === Inbox key ===

    /// The inbox key is a message from a chain. We include the entire ntt
    /// manager message here, not just the payload 'K', because there might be
    /// multiple messages with the same content, so the manager message metadata
    /// (message id in particular) helps disambiguate. Similarly, manager
    /// message ids are only locally unique (per chain), so we also include the
    /// origin chain in the key.
    ///
    /// By having transceivers `vote` on messages keyed by the message content,
    /// we guarantee that when a particular message receives two votes, both of
    /// those votes are actually for the exact same message.
    public struct InboxKey<K> has store, copy, drop {
        chain_id: u16,
        message: NttManagerMessage<K>
    }

    /// A public constructor for inbox key.
    /// No action is privileged by holding an `InboxKey`, so it's safe to make
    /// its constructor public.
    public fun new_inbox_key<K>(
        chain_id: u16,
        message: NttManagerMessage<K>
    ): InboxKey<K> {
        InboxKey {
            chain_id,
            message
        }
    }

    // === Inbox item ===

    public struct InboxItem<K> has store {
        votes: Bitmap,
        release_status: ReleaseStatus,
        data: K,
    }

    public enum ReleaseStatus has copy, drop, store {
        NotApproved,
        ReleaseAfter(u64),
        Released,
    }

    public fun count_enabled_votes<K>(self: &InboxItem<K>, enabled: &Bitmap): u8 {
        let both = self.votes.and(enabled);
        both.count_ones()
    }


    public fun try_release<K>(inbox_item: &mut InboxItem<K>, clock: &Clock): bool {
        match (inbox_item.release_status) {
            ReleaseStatus::NotApproved => false,
            ReleaseStatus::ReleaseAfter(release_timestamp) => {
                if (release_timestamp <= clock.timestamp_ms()) {
                    inbox_item.release_status = ReleaseStatus::Released;
                    true
                } else {
                    false
                }
            },
            ReleaseStatus::Released => abort ETransferAlreadyRedeemed
        }
    }

    public fun release_after<K>(inbox_item: &mut InboxItem<K>, release_timestamp: u64) {
        if (inbox_item.release_status != ReleaseStatus::NotApproved) {
            abort ETransferCannotBeRedeemed
        };
        inbox_item.release_status = ReleaseStatus::ReleaseAfter(release_timestamp);
    }

    public fun vote<K: store + copy + drop>(inbox: &mut Inbox<K>, transceiver_index: u8, entry: InboxKey<K>) {
        let (_, _, data) = entry.message.destruct();
        if (!inbox.entries.contains(entry)) {
            inbox.entries.add(entry, InboxItem {
                votes: bitmap::empty(),
                release_status: ReleaseStatus::NotApproved,
                data
            })
        };
        inbox.entries.borrow_mut(entry).votes.enable(transceiver_index);
    }

    public fun borrow_inbox_item_mut<K: store + copy + drop>(inbox: &mut Inbox<K>, key: InboxKey<K>): &mut InboxItem<K> {
        inbox.entries.borrow_mut(key)
    }

    public fun borrow_inbox_item<K: store + copy + drop>(inbox: &Inbox<K>, key: InboxKey<K>): &InboxItem<K> {
        inbox.entries.borrow(key)
    }
}
