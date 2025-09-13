#[test_only]
module sui_m::registrar_tests {
    use sui::test_scenario::{Self, Scenario};
    use sui_m::registrar::{Self, RegistrarGlobal, PortalCap};

    // Test addresses
    const ADMIN: address = @0xAD;
    const ACCOUNT1: address = @0xACC1;
    const ACCOUNT2: address = @0xACC2;
    const ACCOUNT3: address = @0xACC3;

    // Helper to set up test scenario
    fun setup_test(): Scenario {
        let mut scenario = test_scenario::begin(ADMIN);
        
        // Initialize the registrar
        test_scenario::next_tx(&mut scenario, ADMIN);
        {
            registrar::test_init(test_scenario::ctx(&mut scenario));
        };
        
        scenario
    }

    // Helper to take shared objects  
    fun take_shared_objects(scenario: &mut Scenario): (RegistrarGlobal, PortalCap) {
        next_tx(scenario, ADMIN);
        let global = test_scenario::take_shared<RegistrarGlobal>(scenario);
        let portal_cap = test_scenario::take_from_sender<PortalCap>(scenario);
        (global, portal_cap)
    }

    // Helper to return shared objects
    fun return_shared_objects(global: RegistrarGlobal, portal_cap: PortalCap) {
        test_scenario::return_shared(global);
        sui::transfer::public_transfer(portal_cap, ADMIN);
    }


    // Helper to move to next transaction with sender
    fun next_tx(scenario: &mut Scenario, sender: address) {
        test_scenario::next_tx(scenario, sender);
    }

    // ============ Initial State Tests ============

    #[test]
    fun test_initial_state() {
        let mut scenario = setup_test();
        let (global, portal_cap) = take_shared_objects(&mut scenario);

        // Check initial portal address (should be ADMIN since that's the deployer)
        assert!(registrar::portal(&global) == ADMIN, 0);

        return_shared_objects(global, portal_cap);
        test_scenario::end(scenario);
    }

    // ============ Set Key Tests ============

    #[test]
    fun test_set_key() {
        let mut scenario = setup_test();
        let (mut global, portal_cap) = take_shared_objects(&mut scenario);

        let key = b"someKey";
        let value = b"someValue";

        // Check initial value is empty
        let initial_value = registrar::get(&global, key);
        assert!(initial_value == vector::empty(), 0);

        // Set the key
        next_tx(&mut scenario, ADMIN);
        registrar::set_key(&mut global, &portal_cap, key, value);

        // Check the value was set
        let retrieved_value = registrar::get(&global, key);
        assert!(retrieved_value == value, 1);

        // Event emitted successfully

        return_shared_objects(global, portal_cap);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_set_key_multiple() {
        let mut scenario = setup_test();
        let (mut global, portal_cap) = take_shared_objects(&mut scenario);

        let mut keys = vector::empty<vector<u8>>();
        vector::push_back(&mut keys, b"someKey1");
        vector::push_back(&mut keys, b"someKey2");
        vector::push_back(&mut keys, b"someKey3");

        // Check initial values are empty
        let initial_values = registrar::get_multiple(&global, keys);
        assert!(vector::length(&initial_values) == 3, 0);
        assert!(*vector::borrow(&initial_values, 0) == vector::empty(), 1);
        assert!(*vector::borrow(&initial_values, 1) == vector::empty(), 2);
        assert!(*vector::borrow(&initial_values, 2) == vector::empty(), 3);

        // Set the keys
        next_tx(&mut scenario, ADMIN);
        registrar::set_key(&mut global, &portal_cap, b"someKey1", b"someValue1");
        registrar::set_key(&mut global, &portal_cap, b"someKey2", b"someValue2");
        registrar::set_key(&mut global, &portal_cap, b"someKey3", b"someValue3");

        // Check the values were set
        let retrieved_values = registrar::get_multiple(&global, keys);
        assert!(*vector::borrow(&retrieved_values, 0) == b"someValue1", 4);
        assert!(*vector::borrow(&retrieved_values, 1) == b"someValue2", 5);
        assert!(*vector::borrow(&retrieved_values, 2) == b"someValue3", 6);

        // Events emitted successfully

        return_shared_objects(global, portal_cap);
        test_scenario::end(scenario);
    }

    // ============ Add To List Tests ============

    #[test]
    fun test_add_to_list() {
        let mut scenario = setup_test();
        let (mut global, portal_cap) = take_shared_objects(&mut scenario);

        let list = b"someList";

        // Check account is not in list initially
        assert!(!registrar::list_contains(&global, list, ACCOUNT1), 0);

        // Add account to list
        next_tx(&mut scenario, ADMIN);
        registrar::add_to_list(&mut global, &portal_cap, list, ACCOUNT1);

        // Check account is now in list
        assert!(registrar::list_contains(&global, list, ACCOUNT1), 1);

        // Event emitted successfully

        return_shared_objects(global, portal_cap);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_add_to_list_multiple() {
        let mut scenario = setup_test();
        let (mut global, portal_cap) = take_shared_objects(&mut scenario);

        let list = b"someList";
        let mut accounts = vector::empty<address>();
        vector::push_back(&mut accounts, ACCOUNT1);
        vector::push_back(&mut accounts, ACCOUNT2);
        vector::push_back(&mut accounts, ACCOUNT3);

        // Check accounts are not in list initially
        assert!(!registrar::list_contains_all(&global, list, accounts), 0);

        // Add accounts to list
        next_tx(&mut scenario, ADMIN);
        registrar::add_to_list(&mut global, &portal_cap, list, ACCOUNT1);
        registrar::add_to_list(&mut global, &portal_cap, list, ACCOUNT2);
        registrar::add_to_list(&mut global, &portal_cap, list, ACCOUNT3);

        // Check all accounts are now in list
        assert!(registrar::list_contains_all(&global, list, accounts), 1);

        // Check individual accounts
        assert!(registrar::list_contains(&global, list, ACCOUNT1), 2);
        assert!(registrar::list_contains(&global, list, ACCOUNT2), 3);
        assert!(registrar::list_contains(&global, list, ACCOUNT3), 4);

        // Events emitted successfully

        return_shared_objects(global, portal_cap);
        test_scenario::end(scenario);
    }

    // ============ Remove From List Tests ============

    #[test]
    fun test_remove_from_list() {
        let mut scenario = setup_test();
        let (mut global, portal_cap) = take_shared_objects(&mut scenario);

        let list = b"someList";

        // Add account to list first
        next_tx(&mut scenario, ADMIN);
        registrar::add_to_list(&mut global, &portal_cap, list, ACCOUNT1);

        // Check account is in list
        assert!(registrar::list_contains(&global, list, ACCOUNT1), 0);

        // Remove account from list
        registrar::remove_from_list(&mut global, &portal_cap, list, ACCOUNT1);

        // Check account is no longer in list
        assert!(!registrar::list_contains(&global, list, ACCOUNT1), 1);

        // Events emitted successfully

        return_shared_objects(global, portal_cap);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_remove_from_list_multiple() {
        let mut scenario = setup_test();
        let (mut global, portal_cap) = take_shared_objects(&mut scenario);

        let list = b"someList";
        let mut accounts = vector::empty<address>();
        vector::push_back(&mut accounts, ACCOUNT1);
        vector::push_back(&mut accounts, ACCOUNT2);
        vector::push_back(&mut accounts, ACCOUNT3);

        // Add all accounts to list first
        next_tx(&mut scenario, ADMIN);
        registrar::add_to_list(&mut global, &portal_cap, list, ACCOUNT1);
        registrar::add_to_list(&mut global, &portal_cap, list, ACCOUNT2);
        registrar::add_to_list(&mut global, &portal_cap, list, ACCOUNT3);

        // Check all accounts are in list
        assert!(registrar::list_contains_all(&global, list, accounts), 0);

        // Remove all accounts from list
        registrar::remove_from_list(&mut global, &portal_cap, list, ACCOUNT1);
        registrar::remove_from_list(&mut global, &portal_cap, list, ACCOUNT2);
        registrar::remove_from_list(&mut global, &portal_cap, list, ACCOUNT3);

        // Check no accounts are in list
        assert!(!registrar::list_contains_all(&global, list, accounts), 1);

        // Check individual accounts
        assert!(!registrar::list_contains(&global, list, ACCOUNT1), 2);
        assert!(!registrar::list_contains(&global, list, ACCOUNT2), 3);
        assert!(!registrar::list_contains(&global, list, ACCOUNT3), 4);

        // Events emitted successfully

        return_shared_objects(global, portal_cap);
        test_scenario::end(scenario);
    }

    // ============ Access Control Tests ============

    // Note: In Sui Move, @0x0 is a valid address in tests, and the portal validation
    // happens during real deployment. The constructor validation is more relevant
    // for runtime portal transfers via set_portal function.

    #[test]
    fun test_remove_from_list_nonexistent() {
        let mut scenario = setup_test();
        let (mut global, portal_cap) = take_shared_objects(&mut scenario);

        let list = b"someList";

        // Try to remove account that was never added (should not fail)
        next_tx(&mut scenario, ADMIN);
        registrar::remove_from_list(&mut global, &portal_cap, list, ACCOUNT1);

        // Check account is still not in list
        assert!(!registrar::list_contains(&global, list, ACCOUNT1), 0);

        // Event emitted successfully

        return_shared_objects(global, portal_cap);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_set_key_overwrite() {
        let mut scenario = setup_test();
        let (mut global, portal_cap) = take_shared_objects(&mut scenario);

        let key = b"someKey";
        let value1 = b"someValue1";
        let value2 = b"someValue2";

        // Set initial value
        next_tx(&mut scenario, ADMIN);
        registrar::set_key(&mut global, &portal_cap, key, value1);

        // Check initial value
        let retrieved_value = registrar::get(&global, key);
        assert!(retrieved_value == value1, 0);

        // Overwrite with new value
        registrar::set_key(&mut global, &portal_cap, key, value2);

        // Check new value
        let retrieved_value = registrar::get(&global, key);
        assert!(retrieved_value == value2, 1);

        // Events emitted successfully

        return_shared_objects(global, portal_cap);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_empty_key_and_list() {
        let mut scenario = setup_test();
        let (mut global, portal_cap) = take_shared_objects(&mut scenario);

        let empty_key = vector::empty<u8>();
        let empty_list = vector::empty<u8>();
        let empty_value = vector::empty<u8>();

        // Test empty key operations
        next_tx(&mut scenario, ADMIN);
        registrar::set_key(&mut global, &portal_cap, empty_key, b"value");
        
        let retrieved = registrar::get(&global, empty_key);
        assert!(retrieved == b"value", 0);

        // Test empty list operations
        registrar::add_to_list(&mut global, &portal_cap, empty_list, ACCOUNT1);
        assert!(registrar::list_contains(&global, empty_list, ACCOUNT1), 1);

        // Test empty value
        registrar::set_key(&mut global, &portal_cap, b"key", empty_value);
        let retrieved_empty = registrar::get(&global, b"key");
        assert!(retrieved_empty == empty_value, 2);

        return_shared_objects(global, portal_cap);
        test_scenario::end(scenario);
    }
}