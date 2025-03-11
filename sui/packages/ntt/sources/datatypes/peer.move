module ntt::peer {
    use wormhole::external_address::ExternalAddress;
    use ntt::rate_limit::{Self, RateLimitState};

    public struct Peer has store {
        address: ExternalAddress,
        token_decimals: u8,
        inbound_rate_limit: RateLimitState,
    }

    // NOTE: this is public. There are no assumptions about a `Peer` being created internally.
    // Instead, `Peer`s are always looked up from the state object whenever they
    // are needed, and write access to the state object is protected.
    public fun new(address: ExternalAddress, token_decimals: u8, inbound_limit: u64): Peer {
        Peer {
            address,
            token_decimals,
            inbound_rate_limit: rate_limit::new(inbound_limit),
        }
    }

    public fun set_address(peer: &mut Peer, address: ExternalAddress) {
        peer.address = address;
    }

    public fun set_token_decimals(peer: &mut Peer, token_decimals: u8) {
        peer.token_decimals = token_decimals;
    }

    public fun borrow_address(peer: &Peer): &ExternalAddress {
        &peer.address
    }

    public fun get_token_decimals(peer: &Peer): u8 {
        peer.token_decimals
    }

    public fun borrow_inbound_rate_limit_mut(peer: &mut Peer): &mut RateLimitState {
        &mut peer.inbound_rate_limit
    }
}
