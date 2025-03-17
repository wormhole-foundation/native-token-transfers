
module wormhole_transceiver::wormhole_transceiver_registration {
    use wormhole::external_address::{Self,ExternalAddress};
    use wormhole::bytes;
    use wormhole::cursor::{Self, Cursor};
    use ntt_common::bytes4::{Self};
    const REGISTRATION_PREFIX: vector<u8> = x"18fc67c2";

    #[error]
    const EIncorrectPrefix: vector<u8>
        = b"incorrect prefix";

    // https://github.com/wormhole-foundation/native-token-transfers/blob/b6b681a77e8289869f35862b261b8048e3f5d398/evm/src/libraries/TransceiverStructs.sol#L441
    public struct WormholeTransceiverRegistration has drop {
        transceiver_chain_id: u16,
        transceiver_address: ExternalAddress
    }

    public(package) fun new(transceiver_chain_id: u16, transceiver_address: ExternalAddress): WormholeTransceiverRegistration{
        WormholeTransceiverRegistration {
            transceiver_chain_id: transceiver_chain_id,
            transceiver_address: transceiver_address
        }
    }

    public fun to_bytes(self: &WormholeTransceiverRegistration): vector<u8> {
        let mut buf = vector::empty<u8>();

        buf.append(REGISTRATION_PREFIX);
        bytes::push_u16_be(&mut buf, self.transceiver_chain_id);
        buf.append(self.transceiver_address.to_bytes()); 
        buf
    }

    public fun take_bytes(cur: &mut Cursor<u8>): WormholeTransceiverRegistration {
        let ntt_prefix = bytes4::take(cur);
        assert!(ntt_prefix.to_bytes() == REGISTRATION_PREFIX, EIncorrectPrefix);
        let chain_id = bytes::take_u16_be(cur);
        let transceiver_address = external_address::take_bytes(cur);

        WormholeTransceiverRegistration {
            transceiver_chain_id: chain_id, 
            transceiver_address: transceiver_address
        }
    }

    public fun parse(buf: vector<u8>): WormholeTransceiverRegistration   {
        let mut cur = cursor::new(buf);
        let reg  = take_bytes(&mut cur);
        cur.destroy_empty();
        reg
    }

    #[test]
    public fun test_round_trip() {
        let reg = new(1,external_address::from_address(@102));

        let reg_bytes = reg.to_bytes();

        let reg_round_trip = parse(reg_bytes);

        assert!(reg.transceiver_address == reg_round_trip.transceiver_address);
        assert!(reg.transceiver_chain_id == reg_round_trip.transceiver_chain_id);
    }

    #[test]
    public fun test_raw_to_bytes() {
        let mut raw_bytes = vector::empty<u8>();

        let prefix = vector<u8>[0x18, 0xfc, 0x67, 0xc2];
        let transceiver_address = vector<u8>[0x1, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x2];
        let chain_id = vector<u8>[0x4, 0x56]; 
        vector::append(&mut raw_bytes, prefix);
        vector::append(&mut raw_bytes, chain_id);
        vector::append(&mut raw_bytes, transceiver_address);

        let reg = parse(raw_bytes); 

        assert!(reg.transceiver_address.to_bytes() == transceiver_address);
        assert!(reg.transceiver_chain_id == 0x456);
    }

    #[test]
    public fun test_reg_to_raw_bytes(){
        let mut raw_bytes = vector::empty<u8>();

        // Test bytes
        let prefix = vector<u8>[0x18, 0xfc, 0x67, 0xc2];
        let transceiver_address = vector<u8>[0x1, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x2];
        let chain_id = vector<u8>[0x4, 0x56];
        vector::append(&mut raw_bytes, prefix);
        vector::append(&mut raw_bytes, chain_id);
        vector::append(&mut raw_bytes, transceiver_address); 

        // Create value
        let reg = new(0x456,external_address::from_address(@0x0100000000000000000000000000000000000000000000000000000000000002));
        assert!(reg.transceiver_address.to_bytes() == transceiver_address);
        assert!(reg.transceiver_chain_id == 0x456);

        let derived = to_bytes(&reg);
        assert!(derived == raw_bytes);
    }
}