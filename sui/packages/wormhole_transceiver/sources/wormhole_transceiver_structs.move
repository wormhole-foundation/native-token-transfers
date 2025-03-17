
module wormhole_transceiver::transceiver_structs {
    use wormhole::external_address::ExternalAddress;
    use ntt::mode::Mode;
    use wormhole::bytes;

    const INFO_PREFIX: vector<u8> = x"9C23BD3B";
    const REGISTRATION_PREFIX: vector<u8> = x"18fc67c2";

    // https://github.com/wormhole-foundation/native-token-transfers/blob/b6b681a77e8289869f35862b261b8048e3f5d398/evm/src/libraries/TransceiverStructs.sol#L409C12-L409C27
    public struct WormholeTransceiverInfo has drop{
        manager_address: ExternalAddress,
        manager_mode: Mode, 
        token_address: ExternalAddress,
        token_decimals: u8
    }

    // https://github.com/wormhole-foundation/native-token-transfers/blob/b6b681a77e8289869f35862b261b8048e3f5d398/evm/src/libraries/TransceiverStructs.sol#L441
    public struct WormholeTransceiverRegistration has drop {
        transceiver_chain_id: u16,
        transceiver_address: ExternalAddress
    }

    public(package) fun new_transceiver_info(manager_address: ExternalAddress, mode: Mode, token_address: ExternalAddress, decimals: u8): WormholeTransceiverInfo{
        WormholeTransceiverInfo {
            manager_address: manager_address, 
            manager_mode: mode, 
            token_address: token_address, 
            token_decimals: decimals
        }
    }

    public fun transceiver_info_to_bytes(self: &WormholeTransceiverInfo): vector<u8> {
        let mut buf = vector::empty<u8>();

        buf.append(INFO_PREFIX);
        buf.append(self.manager_address.to_bytes()); // decimals and amount
        buf.append(self.manager_mode.serialize()); // 32 bytes
        buf.append(self.token_address.to_bytes()); // 32 bytes 
        bytes::push_u8(&mut buf, self.token_decimals); // 2 bytes
        buf
    }

    public(package) fun new_transceiver_registration(transceiver_chain_id: u16, transceiver_address: ExternalAddress): WormholeTransceiverRegistration{
        WormholeTransceiverRegistration {
            transceiver_chain_id: transceiver_chain_id,
            transceiver_address: transceiver_address
        }
    }

    public fun transceiver_registration_to_bytes(self: &WormholeTransceiverRegistration): vector<u8> {
        let mut buf = vector::empty<u8>();

        buf.append(REGISTRATION_PREFIX);
        bytes::push_u16_be(&mut buf, self.transceiver_chain_id);
        buf.append(self.transceiver_address.to_bytes()); 
        buf
    }

}