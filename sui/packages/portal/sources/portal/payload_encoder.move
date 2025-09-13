/// Payload encoding/decoding for M Token custom messages
/// 
/// Mirrors the Solidity PayloadEncoder functionality with identical prefixes:
/// - Index transfers (M0IT)
/// - Key transfers (M0KT) 
/// - List updates (M0LU)
/// - Token transfers (handled by NTT)
module sui_m::portal_payload_encoder {
    use sui::address;
    
    // Error constants
    const E_INVALID_PAYLOAD_LENGTH: u64 = 1;
    const E_INVALID_PAYLOAD_PREFIX: u64 = 2;
    // const E_UNKNOWN_PAYLOAD_TYPE: u64 = 3; // Currently unused
    
    // Payload prefixes (matching Solidity implementation)
    const INDEX_TRANSFER_PREFIX: vector<u8> = b"M0IT"; // M0 Index Transfer
    const KEY_TRANSFER_PREFIX: vector<u8> = b"M0KT";   // M0 Key Transfer  
    const LIST_UPDATE_PREFIX: vector<u8> = b"M0LU";   // M0 List Update
    const NTT_PREFIX: vector<u8> = b"NTT\x00";        // Standard NTT prefix
    
    const PAYLOAD_PREFIX_LENGTH: u64 = 4;
    
    /// Payload type enumeration
    public struct PayloadType has store, copy, drop {
        value: u8
    }
    
    // Payload type constants
    const TOKEN_TYPE: u8 = 0;
    const INDEX_TYPE: u8 = 1;
    const KEY_TYPE: u8 = 2;
    const LIST_TYPE: u8 = 3;
    
    // ================ Payload Type Functions ================
    
    public fun token_payload_type(): PayloadType {
        PayloadType { value: TOKEN_TYPE }
    }
    
    public fun index_payload_type(): PayloadType {
        PayloadType { value: INDEX_TYPE }
    }
    
    public fun key_payload_type(): PayloadType {
        PayloadType { value: KEY_TYPE }
    }
    
    public fun list_payload_type(): PayloadType {
        PayloadType { value: LIST_TYPE }
    }
    
    public fun is_token_payload(payload_type: &PayloadType): bool {
        payload_type.value == TOKEN_TYPE
    }
    
    public fun is_index_payload(payload_type: &PayloadType): bool {
        payload_type.value == INDEX_TYPE
    }
    
    public fun is_key_payload(payload_type: &PayloadType): bool {
        payload_type.value == KEY_TYPE
    }
    
    public fun is_list_payload(payload_type: &PayloadType): bool {
        payload_type.value == LIST_TYPE
    }
    
    // ================ Payload Type Detection ================
    
    /// Determine payload type from payload bytes
    public fun get_payload_type(payload: &vector<u8>): PayloadType {
        assert!(vector::length(payload) >= PAYLOAD_PREFIX_LENGTH, E_INVALID_PAYLOAD_LENGTH);
        
        let prefix = extract_prefix(payload);
        
        if (prefix == NTT_PREFIX) {
            token_payload_type()
        } else if (prefix == INDEX_TRANSFER_PREFIX) {
            index_payload_type()
        } else if (prefix == KEY_TRANSFER_PREFIX) {
            key_payload_type()
        } else if (prefix == LIST_UPDATE_PREFIX) {
            list_payload_type()
        } else {
            abort E_INVALID_PAYLOAD_PREFIX
        }
    }
    
    fun extract_prefix(payload: &vector<u8>): vector<u8> {
        let mut prefix = vector::empty<u8>();
        let mut i = 0;
        while (i < PAYLOAD_PREFIX_LENGTH) {
            vector::push_back(&mut prefix, *vector::borrow(payload, i));
            i = i + 1;
        };
        prefix
    }
    
    // ================ M Token Additional Payload ================
    
    /// Encode additional payload for M Token transfers (index + destination token)
    public fun encode_m_additional_payload(
        index: u128,
        destination_token: vector<u8>, // 32-byte address
    ): vector<u8> {
        let mut payload = vector::empty<u8>();
        
        // Encode index as u64 (truncated from u128)
        let index_u64 = (index as u64);
        append_u64(&mut payload, index_u64);
        
        // Append 32-byte destination token
        assert!(vector::length(&destination_token) == 32, E_INVALID_PAYLOAD_LENGTH);
        vector::append(&mut payload, destination_token);
        
        payload
    }
    
    /// Encode additional payload with earners merkle root (for Solana)
    public fun encode_m_additional_payload_with_merkle_root(
        index: u128,
        destination_token: vector<u8>,
        earners_merkle_root: vector<u8>,
    ): vector<u8> {
        let mut payload = encode_m_additional_payload(index, destination_token);
        
        // Append 32-byte merkle root
        assert!(vector::length(&earners_merkle_root) == 32, E_INVALID_PAYLOAD_LENGTH);
        vector::append(&mut payload, earners_merkle_root);
        
        payload
    }
    
    /// Decode M Token additional payload
    public fun decode_m_additional_payload(payload: &vector<u8>): (u128, vector<u8>) {
        assert!(vector::length(payload) >= 8 + 32, E_INVALID_PAYLOAD_LENGTH);
        
        let mut offset = 0;
        let (index_u64, new_offset) = read_u64(payload, offset);
        offset = new_offset;
        
        let destination_token = read_bytes(payload, offset, 32);
        
        ((index_u64 as u128), destination_token)
    }
    
    // ================ Index Payload ================
    
    /// Encode M Token index payload
    public fun encode_index_payload(index: u128, destination_chain_id: u16): vector<u8> {
        let mut payload = INDEX_TRANSFER_PREFIX;
        
        let index_u64 = (index as u64);
        append_u64(&mut payload, index_u64);
        append_u16(&mut payload, destination_chain_id);
        
        payload
    }
    
    /// Decode M Token index payload
    public fun decode_index_payload(payload: vector<u8>): (u128, u16) {
        assert!(vector::length(&payload) >= PAYLOAD_PREFIX_LENGTH + 8 + 2, E_INVALID_PAYLOAD_LENGTH);

        let mut offset = PAYLOAD_PREFIX_LENGTH;
        let (index_u64, new_offset) = read_u64(&payload, offset);
        offset = new_offset;
        
        let (destination_chain_id, _) = read_u16(&payload, offset);
        
        ((index_u64 as u128), destination_chain_id)
    }
    
    // ================ Key Payload ================
    
    /// Encode Registrar key payload  
    public fun encode_key_payload(
        key: vector<u8>,
        value: vector<u8>,
        destination_chain_id: u16
    ): vector<u8> {
        let mut payload = KEY_TRANSFER_PREFIX;
        
        // Pad key and value to 32 bytes if needed
        let key_32 = pad_to_32_bytes(key);
        let value_32 = pad_to_32_bytes(value);
        
        vector::append(&mut payload, key_32);
        vector::append(&mut payload, value_32);
        append_u16(&mut payload, destination_chain_id);
        
        payload
    }
    
    /// Decode Registrar key payload
    public fun decode_key_payload(payload: vector<u8>): (vector<u8>, vector<u8>, u16) {
        assert!(vector::length(&payload) >= PAYLOAD_PREFIX_LENGTH + 32 + 32 + 2, E_INVALID_PAYLOAD_LENGTH);

        let mut offset = PAYLOAD_PREFIX_LENGTH;
        
        let key = read_bytes(&payload, offset, 32);
        offset = offset + 32;
        
        let value = read_bytes(&payload, offset, 32);
        offset = offset + 32;
        
        let (destination_chain_id, _) = read_u16(&payload, offset);
        
        (key, value, destination_chain_id)
    }
    
    // ================ List Update Payload ================
    
    /// Encode Registrar list update payload
    public fun encode_list_update_payload(
        list_name: vector<u8>,
        account: address,
        add: bool,
        destination_chain_id: u16
    ): vector<u8> {
        let mut payload = LIST_UPDATE_PREFIX;
        
        // Pad list name to 32 bytes
        let list_name_32 = pad_to_32_bytes(list_name);
        vector::append(&mut payload, list_name_32);
        
        // Append address (20 bytes, pad to 32)
        let account_bytes = address_to_bytes(account);
        vector::append(&mut payload, account_bytes);
        
        // Append boolean (1 byte)
        vector::push_back(&mut payload, if (add) 1 else 0);
        
        // Append chain ID (2 bytes)  
        append_u16(&mut payload, destination_chain_id);
        
        payload
    }
    
    /// Decode Registrar list update payload
    public fun decode_list_update_payload(payload: vector<u8>): (vector<u8>, address, bool, u16) {
        assert!(vector::length(&payload) >= PAYLOAD_PREFIX_LENGTH + 32 + 32 + 1 + 2, E_INVALID_PAYLOAD_LENGTH);

        let mut offset = PAYLOAD_PREFIX_LENGTH;
        
        let list_name = read_bytes(&payload, offset, 32);
        offset = offset + 32;
        
        let account_bytes = read_bytes(&payload, offset, 32);
        let account = bytes_to_address(account_bytes);
        offset = offset + 32;
        
        let add = *vector::borrow(&payload, offset) == 1;
        offset = offset + 1;
        
        let (destination_chain_id, _) = read_u16(&payload, offset);
        
        (list_name, account, add, destination_chain_id)
    }
    
    // ================ Helper Functions ================
    
    fun append_u64(payload: &mut vector<u8>, value: u64) {
        let bytes = u64_to_bytes(value);
        vector::append(payload, bytes);
    }
    
    fun append_u16(payload: &mut vector<u8>, value: u16) {
        let bytes = u16_to_bytes(value);
        vector::append(payload, bytes);
    }
    
    fun read_u64(payload: &vector<u8>, offset: u64): (u64, u64) {
        let bytes = read_bytes(payload, offset, 8);
        (bytes_to_u64(bytes), offset + 8)
    }
    
    fun read_u16(payload: &vector<u8>, offset: u64): (u16, u64) {
        let bytes = read_bytes(payload, offset, 2);
        (bytes_to_u16(bytes), offset + 2)
    }
    
    fun read_bytes(payload: &vector<u8>, offset: u64, length: u64): vector<u8> {
        let mut result = vector::empty<u8>();
        let mut i = 0;
        while (i < length) {
            vector::push_back(&mut result, *vector::borrow(payload, offset + i));
            i = i + 1;
        };
        result
    }
    
    fun pad_to_32_bytes(data: vector<u8>): vector<u8> {
        let len = vector::length(&data);
        if (len >= 32) {
            // Truncate to 32 bytes if longer
            let mut result = vector::empty<u8>();
            let mut i = 0;
            while (i < 32) {
                vector::push_back(&mut result, *vector::borrow(&data, i));
                i = i + 1;
            };
            result
        } else {
            // Pad with zeros on the right
            let mut result = data;
            while (vector::length(&result) < 32) {
                vector::push_back(&mut result, 0);
            };
            result
        }
    }
    
    // Conversion functions (simplified implementations - may need platform-specific versions)
    fun u64_to_bytes(value: u64): vector<u8> {
        // Big-endian encoding
        let mut bytes = vector::empty<u8>();
        vector::push_back(&mut bytes, ((value >> 56) as u8));
        vector::push_back(&mut bytes, ((value >> 48) as u8));
        vector::push_back(&mut bytes, ((value >> 40) as u8));
        vector::push_back(&mut bytes, ((value >> 32) as u8));
        vector::push_back(&mut bytes, ((value >> 24) as u8));
        vector::push_back(&mut bytes, ((value >> 16) as u8));
        vector::push_back(&mut bytes, ((value >> 8) as u8));
        vector::push_back(&mut bytes, (value as u8));
        bytes
    }
    
    fun bytes_to_u64(bytes: vector<u8>): u64 {
        assert!(vector::length(&bytes) == 8, E_INVALID_PAYLOAD_LENGTH);

        let mut result = 0u64;
        let mut i = 0;
        while (i < 8) {
            let byte_val = (*vector::borrow(&bytes, i) as u64);
            result = (result << 8) | byte_val;
            i = i + 1;
        };
        result
    }
    
    fun u16_to_bytes(value: u16): vector<u8> {
        let mut bytes = vector::empty<u8>();
        vector::push_back(&mut bytes, ((value >> 8) as u8));
        vector::push_back(&mut bytes, (value as u8));
        bytes
    }
    
    fun bytes_to_u16(bytes: vector<u8>): u16 {
        assert!(vector::length(&bytes) == 2, E_INVALID_PAYLOAD_LENGTH);
        
        let high = (*vector::borrow(&bytes, 0) as u16);
        let low = (*vector::borrow(&bytes, 1) as u16);
        (high << 8) | low
    }
    
    fun address_to_bytes(addr: address): vector<u8> {
        // Convert address to 32-byte representation (pad with zeros on left)
        let addr_bytes = std::bcs::to_bytes(&addr);
        pad_to_32_bytes(addr_bytes)
    }
    
    fun bytes_to_address(bytes: vector<u8>): address {
        assert!(vector::length(&bytes) == 32, E_INVALID_PAYLOAD_LENGTH);

        // Convert bytes to address using Sui's address module
        address::from_bytes(bytes)
    }
}