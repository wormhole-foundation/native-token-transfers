module ntt::transceiver_registry {
    use sui::dynamic_field;
    use ntt_common::bitmap::{Self, Bitmap};

    #[error]
    const EUnregisteredTransceiver: vector<u8> =
        b"Unregistered transceiver";

    // TODO: make the transceivers enumerable. what's the best way to do it? the
    // keys are heterogeneous, so maybe just storing a different data structure
    // that's keyed by id? or even a vector of pairs. we can keep it sorted for
    // logarithmic access if need be (but probably overkill)
    public struct TransceiverRegistry has key, store {
        id: UID,
        next_id: u8,
        enabled_bitmap: Bitmap
    }

    public(package) fun new(ctx: &mut TxContext): TransceiverRegistry {
        TransceiverRegistry {
            id: object::new(ctx),
            next_id: 0,
            enabled_bitmap: bitmap::empty()
        }
    }

    public fun next_id(registry: &mut TransceiverRegistry): u8 {
        let id = registry.next_id;
        registry.next_id = id + 1;
        id
    }

    public fun get_enabled_transceivers(registry: &TransceiverRegistry): Bitmap {
        registry.enabled_bitmap
    }

    public fun get_next_id(registry: &TransceiverRegistry): u8 {
        registry.next_id
    }

    // TODO: do we want to put anything here?
    public struct TransceiverInfo has copy, drop, store {
        id: u8,
        state_object_id: ID,
    }

    public struct Key<phantom T> has copy, drop, store {}

    public fun register_transceiver<Transceiver>(registry: &mut TransceiverRegistry, state_object_id: ID) {
        let id = next_id(registry);
        registry.add<Transceiver>(id, state_object_id);
        registry.enable_transceiver(id);
    }

    public fun enable_transceiver(registry: &mut TransceiverRegistry, id: u8) {
        registry.enabled_bitmap.enable(id)
    }

    public fun disable_transceiver(registry: &mut TransceiverRegistry, id: u8) {
        registry.enabled_bitmap.disable(id)
    }

    public fun transceiver_id<Transceiver>(registry: &TransceiverRegistry): u8 {
        registry.borrow<Transceiver>().id
    }

    // helpers
    fun add<Transceiver>(registry: &mut TransceiverRegistry, id: u8, state_object_id: ID) {
        dynamic_field::add(&mut registry.id, Key<Transceiver> {}, TransceiverInfo { id, state_object_id });
    }

    fun borrow<Transceiver>(registry: &TransceiverRegistry): &TransceiverInfo {
        let key = Key<Transceiver> {};
        assert!(dynamic_field::exists_with_type<_, TransceiverInfo>(&registry.id, key), EUnregisteredTransceiver);
        dynamic_field::borrow(&registry.id, key)
    }
}
