
module wormhole_transceiver::wormhole_transceiver_info {
    use wormhole::external_address::{Self,ExternalAddress};
    use wormhole::bytes;
    use wormhole::cursor::{Self, Cursor};
    use ntt_common::bytes4::{Self};
    use ntt::mode::{Self, Mode};

    const INFO_PREFIX: vector<u8> = x"9C23BD3B";

    #[error]
    const EIncorrectPrefix: vector<u8>
        = b"incorrect prefix";

    // https://github.com/wormhole-foundation/native-token-transfers/blob/b6b681a77e8289869f35862b261b8048e3f5d398/evm/src/libraries/TransceiverStructs.sol#L409C12-L409C27
    public struct WormholeTransceiverInfo has drop{
        manager_address: ExternalAddress,
        manager_mode: Mode, 
        token_address: ExternalAddress,
        token_decimals: u8
    }

    public(package) fun new(manager_address: ExternalAddress, mode: Mode, token_address: ExternalAddress, decimals: u8): WormholeTransceiverInfo{
        WormholeTransceiverInfo {
            manager_address: manager_address, 
            manager_mode: mode, 
            token_address: token_address, 
            token_decimals: decimals
        }
    }

    public fun to_bytes(self: &WormholeTransceiverInfo): vector<u8> {
        let mut buf = vector::empty<u8>();

        buf.append(INFO_PREFIX);
        buf.append(self.manager_address.to_bytes()); // decimals and amount
        buf.append(self.manager_mode.serialize()); // 32 bytes
        buf.append(self.token_address.to_bytes()); // 32 bytes 
        bytes::push_u8(&mut buf, self.token_decimals); // 2 bytes
        buf
    }

    public fun take_bytes(cur: &mut Cursor<u8>): WormholeTransceiverInfo {
        let ntt_prefix = bytes4::take(cur);
        assert!(ntt_prefix.to_bytes() == INFO_PREFIX, EIncorrectPrefix);
        let manager_address = external_address::take_bytes(cur);
        let mode = mode::parse(bytes::take_bytes(cur, 1));
        let token_address = external_address::take_bytes(cur);
        let token_decimals = bytes::take_u8(cur);

        WormholeTransceiverInfo {
            manager_address: manager_address, 
            manager_mode: mode, 
            token_address: token_address, 
            token_decimals: token_decimals
        }
    }

    public fun parse(buf: vector<u8>): WormholeTransceiverInfo   {
        let mut cur = cursor::new(buf);
        let info  = take_bytes(&mut cur);
        cur.destroy_empty();
        info
    }

    #[test]
    public fun test_round_trip() {
        let reg = new(external_address::from_address(@102), mode::burning(), external_address::from_address(@304), 9);

        let reg_bytes = reg.to_bytes();

        let reg_round_trip = parse(reg_bytes);

        assert!(reg.manager_address == reg_round_trip.manager_address);
        assert!(reg.manager_mode == reg_round_trip.manager_mode);
        assert!(reg.token_address == reg_round_trip.token_address);
        assert!(reg.token_decimals == reg_round_trip.token_decimals);
    }

    #[test]
    public fun test_raw_to_bytes() {
        let mut raw_bytes = vector::empty<u8>();

        let prefix = vector<u8>[0x9c, 0x23, 0xbd, 0x3b];
        let manager_address = vector<u8>[0x1, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x2];
        let mode = vector<u8>[0x1]; 

        let token_address = vector<u8>[0x4, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x5];
        let token_decimals = vector<u8>[0x3]; 

        vector::append(&mut raw_bytes, prefix);
        vector::append(&mut raw_bytes, manager_address);
        vector::append(&mut raw_bytes, mode);
        vector::append(&mut raw_bytes, token_address);
        vector::append(&mut raw_bytes, token_decimals);


        let reg = parse(raw_bytes); 

        assert!(reg.manager_address.to_bytes() == manager_address);
        assert!(reg.manager_mode == mode::burning());
        assert!(reg.token_address.to_bytes() == token_address);
        assert!(reg.token_decimals == 3);
    }

    #[test]
    public fun test_reg_to_raw_bytes(){
        let mut raw_bytes = vector::empty<u8>();


        let prefix = vector<u8>[0x9c, 0x23, 0xbd, 0x3b];
        let manager_address = vector<u8>[0x1, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x2];
        let mode = vector<u8>[0x0]; 

        let token_address = vector<u8>[0x4, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x5];
        let token_decimals = vector<u8>[0x9]; 

        vector::append(&mut raw_bytes, prefix);
        vector::append(&mut raw_bytes, manager_address);
        vector::append(&mut raw_bytes, mode);
        vector::append(&mut raw_bytes, token_address);
        vector::append(&mut raw_bytes, token_decimals);

        // Create value
        let reg = new(external_address::from_address(@0x0100000000000000000000000000000000000000000000000000000000000002), mode::locking(), external_address::from_address(@0x0400000000000000000000000000000000000000000000000000000000000005), 9);

        assert!(reg.manager_address.to_bytes() == manager_address);
        assert!(reg.manager_mode == mode::locking());
        assert!(reg.token_address.to_bytes() == token_address);
        assert!(reg.token_decimals == 9);

        let derived = to_bytes(&reg);
        assert!(derived == raw_bytes);
    }

}