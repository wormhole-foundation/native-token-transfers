module sui_m::registrar {
    use sui::table::{Self, Table};
    use sui::hash;
    use sui::bcs;
    use sui::event;
    
    // ============ Error Codes ============

    /// Error when the portal address is zero
    const EZeroPortal: u64 = 1;

    // ============ Structs ============

    /// Registrar global state - shared object
    /// A book of record of arbitrary key-value pairs and lists
    public struct RegistrarGlobal has key {
        id: UID,
        /// Portal address that can modify the registrar
        portal: address,
        /// Storage for key-value pairs
        values: Table<vector<u8>, vector<u8>>
    }

    /// Portal capability - allows modifying registrar data
    public struct PortalCap has key, store {
        id: UID
    }

    // ============ Events ============

    /// Emitted when an address is added to a list
    public struct AddressAddedToList has copy, drop {
        list: vector<u8>,
        account: address
    }

    /// Emitted when an address is removed from a list  
    public struct AddressRemovedFromList has copy, drop {
        list: vector<u8>,
        account: address
    }

    /// Emitted when a key-value pair is set
    public struct KeySet has copy, drop {
        key: vector<u8>,
        value: vector<u8>
    }

    // ============ Init Function ============

    /// Initialize the Registrar module with portal address
    /// @param portal_address The address of the portal contract
    fun init(ctx: &mut TxContext) {
        let deployer = tx_context::sender(ctx);

        // Create the global registrar state
        let global = RegistrarGlobal {
            id: object::new(ctx),
            portal: deployer, // Will be updated to actual portal address
            values: table::new(ctx)
        };

        // Create portal capability
        let portal_cap = PortalCap { id: object::new(ctx) };

        // Share the global state
        transfer::share_object(global);

        // Transfer portal capability to deployer (to be transferred to actual portal)
        transfer::transfer(portal_cap, deployer);
    }

    // ============ Portal Functions ============

    /// Add an address to a list (requires Portal capability)
    public fun add_to_list(
        global: &mut RegistrarGlobal,
        _cap: &PortalCap,
        list: vector<u8>,
        account: address
    ) {
        let key = get_is_in_list_key(list, account);
        let value = vector[1u8]; // Represents true/exists
        
        if (table::contains(&global.values, key)) {
            *table::borrow_mut(&mut global.values, key) = value;
        } else {
            table::add(&mut global.values, key, value);
        };

        event::emit(AddressAddedToList { list, account });
    }

    /// Remove an address from a list (requires Portal capability)
    public fun remove_from_list(
        global: &mut RegistrarGlobal,
        _cap: &PortalCap,
        list: vector<u8>,
        account: address
    ) {
        let key = get_is_in_list_key(list, account);
        
        if (table::contains(&global.values, key)) {
            table::remove(&mut global.values, key);
        };

        event::emit(AddressRemovedFromList { list, account });
    }

    /// Set a key-value pair (requires Portal capability)
    public fun set_key(
        global: &mut RegistrarGlobal,
        _cap: &PortalCap,
        key: vector<u8>,
        value: vector<u8>
    ) {
        let storage_key = get_value_key(key);
        
        if (table::contains(&global.values, storage_key)) {
            *table::borrow_mut(&mut global.values, storage_key) = value;
        } else {
            table::add(&mut global.values, storage_key, value);
        };

        event::emit(KeySet { key, value });
    }

    /// Update the portal address (admin function)
    public fun set_portal(
        global: &mut RegistrarGlobal,
        portal_cap: PortalCap,
        new_portal: address
    ) {
        assert!(new_portal != @0x0, EZeroPortal);
        global.portal = new_portal;
        // transfer portal cap to new portal
        transfer::public_transfer(portal_cap, new_portal)
    }

    // ============ View Functions ============

    /// Get a single value by key
    public fun get(global: &RegistrarGlobal, key: vector<u8>): vector<u8> {
        let storage_key = get_value_key(key);
        
        if (table::contains(&global.values, storage_key)) {
            *table::borrow(&global.values, storage_key)
        } else {
            vector::empty() // Return empty vector if key doesn't exist
        }
    }

    /// Get multiple values by keys
    public fun get_multiple(
        global: &RegistrarGlobal, 
        keys: vector<vector<u8>>
    ): vector<vector<u8>> {
        let mut values = vector::empty<vector<u8>>();
        let mut i = 0;
        let len = vector::length(&keys);
        
        while (i < len) {
            let key = *vector::borrow(&keys, i);
            let value = get(global, key);
            vector::push_back(&mut values, value);
            i = i + 1;
        };
        
        values
    }

    /// Check if a list contains an address
    public fun list_contains(
        global: &RegistrarGlobal,
        list: vector<u8>,
        account: address
    ): bool {
        let key = get_is_in_list_key(list, account);
        
        if (table::contains(&global.values, key)) {
            let value = table::borrow(&global.values, key);
            *vector::borrow(value, 0) == 1u8
        } else {
            false
        }
    }

    /// Check if a list contains all addresses in the given vector
    public fun list_contains_all(
        global: &RegistrarGlobal,
        list: vector<u8>,
        accounts: vector<address>
    ): bool {
        let mut i = 0;
        let len = vector::length(&accounts);
        
        while (i < len) {
            let account = *vector::borrow(&accounts, i);
            if (!list_contains(global, list, account)) {
                return false
            };
            i = i + 1;
        };
        
        true
    }

    /// Get portal address
    public fun portal(global: &RegistrarGlobal): address {
        global.portal
    }

    // ============ Internal Helper Functions ============

    /// Returns the storage key for a value key
    /// Equivalent to keccak256(abi.encodePacked("VALUE", key_))
    fun get_value_key(key: vector<u8>): vector<u8> {
        let mut data = b"VALUE";
        vector::append(&mut data, key);
        hash::keccak256(&data)
    }

    /// Returns the storage key for checking if an account is in a list
    /// Equivalent to keccak256(abi.encodePacked("IN_LIST", list_, account_))
    fun get_is_in_list_key(list: vector<u8>, account: address): vector<u8> {
        let mut data = b"IN_LIST";
        vector::append(&mut data, list);
        vector::append(&mut data, bcs::to_bytes(&account));
        hash::keccak256(&data)
    }

    // ============ Test Helper Functions ============

    #[test_only]
    /// Initialize module for testing
    public fun test_init(ctx: &mut TxContext) {
        init(ctx)
    }
}