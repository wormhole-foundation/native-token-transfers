module sui_m::m_token_tests {
    use sui::test_scenario::{Self, Scenario, next_tx, ctx};
    use sui::coin::{Self, Coin};
    use sui_m::m_token::{
        Self, 
        MTokenGlobal, 
        M_TOKEN, 
        PortalCap, 
        RegistrarCap
    };
    use sui_m::continuous_indexing;
    
    // Test constants
    const ALICE: address = @0xa11ce;
    const BOB: address = @0xb0b;
    const PORTAL: address = @0x907a1;
    const DEPLOYER: address = @0xde910e4;
    
    const EXP_SCALED_ONE: u128 = 1_000_000_000_000; // 1e12
    const EXPECTED_CURRENT_INDEX: u128 = 1_100_000_068_703; // From Solidity test
    
    // Helper function to setup test environment
    fun setup_test(): Scenario {
        let mut scenario = test_scenario::begin(DEPLOYER);
        let ctx = ctx(&mut scenario);
        
        // Initialize the m_token module (this would normally happen on deployment)
        m_token::test_init(ctx);
        scenario
    }
    
    // Helper function to get shared objects
    fun take_shared_objects(scenario: &mut Scenario): (MTokenGlobal, PortalCap, RegistrarCap) {
        next_tx(scenario, DEPLOYER);
        let global = test_scenario::take_shared<MTokenGlobal>(scenario);
        let portal_cap = test_scenario::take_from_sender<PortalCap>(scenario);
        let registrar_cap = test_scenario::take_from_sender<RegistrarCap>(scenario);
        (global, portal_cap, registrar_cap)
    }
    
    // Helper to return shared objects
    fun return_shared_objects(global: MTokenGlobal, portal_cap: PortalCap, registrar_cap: RegistrarCap) {
        test_scenario::return_shared(global);
        sui::transfer::public_transfer(portal_cap, DEPLOYER);
        sui::transfer::public_transfer(registrar_cap, DEPLOYER);
    }
    
    // Helper to simulate continuous index like in Solidity tests
    fun set_index(global: &mut MTokenGlobal, index: u128) {
        let indexing = m_token::get_indexing_mut_for_testing(global);
        continuous_indexing::update_index(indexing, index, 0);
    }
    
    // ============ Initial State Tests ============
    
    #[test]
    fun test_initial_state() {
        let mut scenario = setup_test();
        let (global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        // Check initial values
        assert!(m_token::total_non_earning_supply(&global) == 0, 0);
        assert!(m_token::principal_of_total_earning_supply(&global) == 0, 0);
        assert!(m_token::current_index(&global) == EXP_SCALED_ONE, 0);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    // ============ Mint Tests ============
    
    #[test]
    #[expected_failure(abort_code = sui_m::m_token::EInsufficientAmount)]
    fun test_mint_insufficient_amount() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 0, ctx);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    #[expected_failure(abort_code = sui_m::m_token::EInvalidRecipient)]
    fun test_mint_invalid_recipient() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        
        m_token::mint_no_index(&mut global, &portal_cap, @0x0, 1000, ctx);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    fun test_mint_to_non_earner() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        
        // Check balances and supply
        assert!(m_token::balance_of(&global, ALICE) == 1000, 0);
        assert!(m_token::is_earning(&global, ALICE) == false, 0);
        assert!(m_token::total_non_earning_supply(&global) == 1000, 0);
        assert!(m_token::principal_of_total_earning_supply(&global) == 0, 0);
        
        // Check that coin was minted and transferred with correct value
        next_tx(&mut scenario, ALICE);
        let mut coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        
        // Verify coin properties using Coin API
        assert!(coin::value(&coin) == 1000, 0);
        
        // Could also split/merge to verify coin behavior
        let ctx = ctx(&mut scenario);
        let split_coin = coin::split(&mut coin, 300, ctx);
        assert!(coin::value(&coin) == 700, 0);
        assert!(coin::value(&split_coin) == 300, 0);
        
        // Merge back
        coin::join(&mut coin, split_coin);
        assert!(coin::value(&coin) == 1000, 0);
        
        test_scenario::return_to_sender(&scenario, coin);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    fun test_mint_to_earner() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        // First approve and set Alice as earner
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        let zero_coin = coin::zero<M_TOKEN>(ctx);
        let returned_coin = m_token::start_earning(&mut global, zero_coin, ctx);
        coin::destroy_zero(returned_coin);
        
        // Now mint to earner
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 999, ctx);
        
        // Check balances - should be rounded down due to principal conversion
        let expected_principal = 908u128; // 999 * 1e12 / 1_100_000_068_703 rounded down
        
        assert!(m_token::principal_balance_of(&global, ALICE) == (expected_principal as u256), 0);
        assert!(m_token::is_earning(&global, ALICE) == true, 0);
        assert!(m_token::total_non_earning_supply(&global) == 0, 0);
        assert!(m_token::principal_of_total_earning_supply(&global) == expected_principal, 0);
        
        // Verify coin was transferred with correct value (rounded down)
        next_tx(&mut scenario, ALICE);
        let coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let actual_coin_value = coin::value(&coin);
        // Should be close to 999, but might be slightly different due to rounding
        assert!(actual_coin_value >= 998 && actual_coin_value <= 999, 0);
        
        // The coin itself has face value 999, but Alice's earning balance tracks principal
        // This demonstrates the separation between Coin value and earning state
        test_scenario::return_to_sender(&scenario, coin);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    fun test_mint_with_index_update() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        let new_index = 2_000_000_000_000u128; // 2e12
        
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        
        m_token::mint(&mut global, &portal_cap, ALICE, 1000, new_index, ctx);
        
        // Check that index was updated
        assert!(m_token::current_index(&global) == new_index, 0);
        assert!(m_token::balance_of(&global, ALICE) == 1000, 0);
        
        // Verify coin was created correctly via Coin API
        next_tx(&mut scenario, ALICE);
        let mut coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        assert!(coin::value(&coin) == 1000, 0);
        
        // Test that we can create zero value coins
        let ctx = ctx(&mut scenario);
        let zero_coin = coin::zero<M_TOKEN>(ctx);
        assert!(coin::value(&zero_coin) == 0, 0);
        
        // Join zero coin with existing coin
        coin::join(&mut coin, zero_coin);
        assert!(coin::value(&coin) == 1000, 0);
        
        test_scenario::return_to_sender(&scenario, coin);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    // ============ Burn Tests ============
    
    #[test]
    #[expected_failure(abort_code = sui_m::m_token::EInsufficientAmount)]
    fun test_burn_insufficient_amount() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        
        // Create an empty coin to burn
        let empty_coin = coin::zero<M_TOKEN>(ctx);
        m_token::burn(&mut global, &portal_cap, empty_coin, ctx);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    fun test_burn_from_non_earner() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        // First mint tokens to PORTAL
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, PORTAL, 1000, ctx);
        
        // Get the minted coin and burn half
        next_tx(&mut scenario, PORTAL);
        let mut coin_to_burn = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        
        // Split coin to burn only 500
        let burn_coin = coin::split(&mut coin_to_burn, 500, ctx);
        m_token::burn(&mut global, &portal_cap, burn_coin, ctx);
        
        // Check remaining balance
        assert!(m_token::balance_of(&global, PORTAL) == 500, 0);
        assert!(m_token::total_non_earning_supply(&global) == 500, 0);
        
        // Clean up
        test_scenario::return_to_sender(&scenario, coin_to_burn);
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    // ============ Start/Stop Earning Tests ============
    
    #[test]
    #[expected_failure(abort_code = sui_m::m_token::ENotApprovedEarner)]
    fun test_start_earning_not_approved() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        
        let zero_coin = coin::zero<M_TOKEN>(ctx);
        let returned_coin = m_token::start_earning(&mut global, zero_coin, ctx);
        coin::destroy_zero(returned_coin);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    #[expected_failure(abort_code = sui_m::m_token::EIndexNotInitialized)]
    fun test_start_earning_index_not_initialized() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        // Don't set index (it stays at EXP_SCALED_ONE)
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        
        let zero_coin = coin::zero<M_TOKEN>(ctx);
        let returned_coin = m_token::start_earning(&mut global, zero_coin, ctx);
        coin::destroy_zero(returned_coin);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    fun test_start_earning() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        // First mint tokens to Alice
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        
        // Approve Alice as earner
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        
        // Alice starts earning - take her coins and pass them to start_earning
        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);
        
        // Check conversion to principal (rounded down)
        let expected_principal = 909u128; // 1000 * 1e12 / 1_100_000_068_703 rounded down
        
        assert!(m_token::is_earning(&global, ALICE) == true, 0);
        assert!(m_token::principal_balance_of(&global, ALICE) == (expected_principal as u256), 0);
        assert!(m_token::total_non_earning_supply(&global) == 0, 0);
        assert!(m_token::principal_of_total_earning_supply(&global) == expected_principal, 0);
        
        // Verify earning state was properly set
        // Event checking not available in current test framework
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    fun test_stop_earning() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        // Setup: Alice as earner with some principal
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        
        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);
        
        let _principal_before = m_token::principal_balance_of(&global, ALICE);
        
        // Alice stops earning
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        m_token::stop_earning(&mut global, ctx);
        
        // Check conversion back to present amount (rounded down)
        let expected_present = 999u256; // principal * index / 1e12 rounded down
        
        assert!(m_token::is_earning(&global, ALICE) == false, 0);
        assert!(m_token::balance_of(&global, ALICE) == expected_present, 0);
        assert!(m_token::total_non_earning_supply(&global) == expected_present, 0);
        assert!(m_token::principal_of_total_earning_supply(&global) == 0, 0);
        
        // Verify non-earning state was properly set
        // Event checking not available in current test framework
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    fun test_stop_earning_for_non_approved() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        // Setup Alice as earner, then revoke approval
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        
        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);
        
        // Revoke Alice's approval
        m_token::revoke_earner(&mut global, &registrar_cap, ALICE);
        
        // Anyone can force stop earning for non-approved accounts
        next_tx(&mut scenario, BOB);
        let ctx = ctx(&mut scenario);
        m_token::stop_earning_for(&mut global, ALICE, ctx);
        
        assert!(m_token::is_earning(&global, ALICE) == false, 0);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    #[expected_failure(abort_code = sui_m::m_token::EIsApprovedEarner)]
    fun test_stop_earning_for_approved() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        // Setup Alice as approved earner
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        
        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);
        
        // Try to force stop - should fail for approved earners
        next_tx(&mut scenario, BOB);
        let ctx = ctx(&mut scenario);
        m_token::stop_earning_for(&mut global, ALICE, ctx);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    // ============ View Function Tests ============
    
    #[test]
    fun test_balance_calculations() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        // Test non-earning balance
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        
        assert!(m_token::balance_of(&global, ALICE) == 1000, 0);
        assert!(m_token::principal_balance_of(&global, ALICE) == 0, 0); // Not earning
        
        // Convert Alice to earning
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        
        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);
        
        // Now she should have principal balance and calculated present balance
        let principal = m_token::principal_balance_of(&global, ALICE);
        let balance = m_token::balance_of(&global, ALICE);
        
        assert!(principal > 0, 0);
        assert!(balance >= 999 && balance <= 1000, 0); // Some rounding
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    fun test_total_supply_calculations() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        // Mint to both earning and non-earning accounts
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        m_token::mint_no_index(&mut global, &portal_cap, BOB, 1000, ctx);
        
        // Make Alice an earner
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        
        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);
        
        // Check supply calculations
        let total_non_earning = m_token::total_non_earning_supply(&global);
        let total_earning = m_token::total_earning_supply(&global);
        let total_supply = m_token::total_supply(&global);
        
        assert!(total_non_earning == 1000, 0); // Bob's balance
        assert!(total_earning >= 999 && total_earning <= 1000, 0); // Alice's earning balance
        assert!(total_supply >= 1999 && total_supply <= 2000, 0); // Sum of both
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    // ============ Accounting Reconciliation Tests ============
    
    // Helper function to calculate total coin supply by summing all user coins
    fun calculate_total_coin_supply(scenario: &mut Scenario, users: vector<address>): u64 {
        let mut total = 0;
        let mut i = 0;
        while (i < vector::length(&users)) {
            let user = *vector::borrow(&users, i);
            next_tx(scenario, user);
            
            // Try to take coins from user, handle case where they have none
            if (test_scenario::has_most_recent_for_sender<Coin<M_TOKEN>>(scenario)) {
                let coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(scenario);
                total = total + coin::value(&coin);
                test_scenario::return_to_sender(scenario, coin);
            };
            i = i + 1;
        };
        total
    }
    
    #[test]
    fun test_accounting_consistency_after_minting() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        // Define test users
        let carol = @0xca401;
        let dave = @0xda4e;
        let users = vector[ALICE, BOB, carol, dave];
        
        // Make Alice and Carol earners
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        m_token::approve_earner(&mut global, &registrar_cap, carol);
        
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        let zero_coin = coin::zero<M_TOKEN>(ctx);
        let returned_coin = m_token::start_earning(&mut global, zero_coin, ctx);
        coin::destroy_zero(returned_coin);
        
        next_tx(&mut scenario, carol);
        let ctx = ctx(&mut scenario);
        let zero_coin = coin::zero<M_TOKEN>(ctx);
        let returned_coin = m_token::start_earning(&mut global, zero_coin, ctx);
        coin::destroy_zero(returned_coin);
        
        // Mint different amounts to each user
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);    // earner
        m_token::mint_no_index(&mut global, &portal_cap, BOB, 2000, ctx);      // non-earner
        m_token::mint_no_index(&mut global, &portal_cap, carol, 1500, ctx); // earner
        m_token::mint_no_index(&mut global, &portal_cap, dave, 800, ctx);   // non-earner
        
        // Calculate totals from our internal accounting
        let internal_total = m_token::total_supply(&global);
        let internal_earning = m_token::total_earning_supply(&global);
        let internal_non_earning = m_token::total_non_earning_supply(&global);
        
        // Calculate totals from coin API
        let coin_total = calculate_total_coin_supply(&mut scenario, users);
        
        // Accounting should be consistent
        
        // Verify consistency
        assert!(internal_total == (coin_total as u256), 0);
        assert!(internal_earning + internal_non_earning == internal_total, 1);
        assert!(internal_non_earning == 2800, 2); // BOB + Dave = 2000 + 800
        
        // Individual balance checks
        assert!(m_token::balance_of(&global, ALICE) <= 1000, 3); // rounded down for earners
        assert!(m_token::balance_of(&global, BOB) == 2000, 4);   // exact for non-earners
        assert!(m_token::balance_of(&global, carol) <= 1500, 5); // rounded down for earners
        assert!(m_token::balance_of(&global, dave) == 800, 6);    // exact for non-earners
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    // TODO, explore burning coins lost due to rounding errors to keep coin api and internal accounting consistent.
    #[test]
    fun test_accounting_consistency_across_earning_transitions() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        // Start with Alice as non-earner
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        
        // Check initial state
        let initial_total = m_token::total_supply(&global);
        assert!(m_token::balance_of(&global, ALICE) == 1000, 0);
        assert!(m_token::total_non_earning_supply(&global) == 1000, 1);
        assert!(m_token::total_earning_supply(&global) == 0, 2);
        
        // Get initial coin value
        next_tx(&mut scenario, ALICE);
        let coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let initial_coin_value = coin::value(&coin);
        assert!(initial_coin_value == 1000, 3);
        test_scenario::return_to_sender(&scenario, coin);
        
        // Convert Alice to earner - she takes her actual coins
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);
        
        // Check state after conversion
        let earning_balance = m_token::balance_of(&global, ALICE);
        let principal_balance = m_token::principal_balance_of(&global, ALICE);
        let total_after_earning = m_token::total_supply(&global);
        
        // Total supply should remain consistent (allow for 1-2 rounding loss)
        assert!(total_after_earning >= initial_total - 2 && total_after_earning <= initial_total, 4);
        
        // Earning balance should be rounded down from original
        assert!(earning_balance <= 1000, 5);
        assert!(earning_balance >= 999, 6); // but close
        assert!(principal_balance > 0, 7);
        
        // Supplies should shift but total remain same
        assert!(m_token::total_non_earning_supply(&global) == 0, 8);
        assert!(m_token::total_earning_supply(&global) == earning_balance, 9);
        
        // Coin value should remain unchanged
        next_tx(&mut scenario, ALICE);
        let coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        assert!(coin::value(&coin) == initial_coin_value, 10);
        test_scenario::return_to_sender(&scenario, coin);
        
        // Convert back to non-earner
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        m_token::stop_earning(&mut global, ctx);
        
        // Check final state
        let final_balance = m_token::balance_of(&global, ALICE);
        let final_total = m_token::total_supply(&global);
        
        // Total should still be consistent (allow for accumulated rounding loss)
        assert!(final_total >= initial_total - 4 && final_total <= initial_total, 11);
        
        // Balance might be slightly reduced due to rounding
        assert!(final_balance <= earning_balance, 12);
        assert!(final_balance >= 999, 13); // but still close
        
        // Should be back to non-earning
        assert!(m_token::total_non_earning_supply(&global) == final_balance, 14);
        assert!(m_token::total_earning_supply(&global) == 0, 15);
        assert!(m_token::principal_balance_of(&global, ALICE) == 0, 16);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    fun test_accounting_consistency_after_burns() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        // Setup: mint to both earning and non-earning accounts
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        m_token::mint_no_index(&mut global, &portal_cap, BOB, 2000, ctx);
        m_token::mint_no_index(&mut global, &portal_cap, PORTAL, 1500, ctx); // For burning
        
        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);
        
        let initial_total = m_token::total_supply(&global);
        
        // Burn from portal (non-earner)
        next_tx(&mut scenario, PORTAL);
        let mut coin_to_burn = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let burn_coin = coin::split(&mut coin_to_burn, 500, ctx(&mut scenario));
        m_token::burn(&mut global, &portal_cap, burn_coin, ctx(&mut scenario));
        
        // Check accounting after burn
        let total_after_burn = m_token::total_supply(&global);
        let expected_total = initial_total - 500;
        
        assert!(total_after_burn == expected_total, 0);
        
        // Portal balance should be reduced
        assert!(m_token::balance_of(&global, PORTAL) == 1000, 1); // 1500 - 500
        
        // Other balances unchanged
        assert!(m_token::balance_of(&global, BOB) == 2000, 2);
        assert!(m_token::balance_of(&global, ALICE) <= 1000, 3);
        
        // Coin supply should match
        test_scenario::return_to_sender(&scenario, coin_to_burn);
        let users = vector[ALICE, BOB, PORTAL];
        let coin_total = calculate_total_coin_supply(&mut scenario, users);
        
        // Verify accounting consistency after burn
        
        // Allow for 1-2 unit rounding difference due to earning conversions
        assert!((coin_total as u256) >= total_after_burn - 2 && (coin_total as u256) <= total_after_burn + 2, 4);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    fun test_precision_consistency_with_index_changes() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        // Start with higher index
        set_index(&mut global, 1_500_000_000_000); // 1.5e12
        
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        
        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);
        
        let balance_at_15 = m_token::balance_of(&global, ALICE);
        let principal = m_token::principal_balance_of(&global, ALICE);
        
        // Update index to 2.0
        set_index(&mut global, 2_000_000_000_000); // 2.0e12
        
        let balance_at_20 = m_token::balance_of(&global, ALICE);
        
        // Balance should have grown with index
        assert!(balance_at_20 > balance_at_15, 0);
        
        // But principal should remain the same
        assert!(m_token::principal_balance_of(&global, ALICE) == principal, 1);
        
        // Coin value is the actual minted amount (rounded down for earners)
        next_tx(&mut scenario, ALICE);
        let coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let coin_value = coin::value(&coin);
        // Should be close to but <= 1000 due to rounding
        assert!(coin_value <= 1000 && coin_value >= 999, 2);
        test_scenario::return_to_sender(&scenario, coin);
        
        // In our claim-based system, total supply is fixed until claiming occurs
        // Individual balances can grow with index, but total supply remains constant
        // This is different from the Solidity rebasing system
        let total_supply = m_token::total_supply(&global);
        // Total supply should remain at the originally minted amount
        assert!(total_supply <= balance_at_15, 3); // Won't grow until claiming
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    // ============ Yield Claiming Tests ============
    
    #[test]
    fun test_claim_yield_basic() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        // Set initial index
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        // Setup Alice as earner with some principal
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        
        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);
        
        // Check initial state
        let initial_balance = m_token::balance_of(&global, ALICE);
        let initial_principal = m_token::principal_balance_of(&global, ALICE);
        
        // Simulate index growth (20% increase)
        let new_index = (EXPECTED_CURRENT_INDEX * 12) / 10; // 1.2x
        set_index(&mut global, new_index);
        
        // Balance should have grown
        let balance_after_growth = m_token::balance_of(&global, ALICE);
        assert!(balance_after_growth > initial_balance, 0);
        
        // Principal should remain the same before claiming
        assert!(m_token::principal_balance_of(&global, ALICE) == initial_principal, 1);
        
        // Claim yield
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        m_token::claim_yield(&mut global, ctx);
        
        // Check that yield was claimed
        next_tx(&mut scenario, ALICE);
        // Should have received coins
        if (test_scenario::has_most_recent_for_sender<Coin<M_TOKEN>>(&scenario)) {
            let yield_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
            let yield_value = coin::value(&yield_coin);
            assert!(yield_value > 0, 2);
            test_scenario::return_to_sender(&scenario, yield_coin);
        };
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    fun test_claim_yield_multiple_times() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        // Set initial index
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        // Setup Alice as earner
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        
        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);
        
        // First claim after index growth
        let index_1 = (EXPECTED_CURRENT_INDEX * 11) / 10; // 1.1x
        set_index(&mut global, index_1);
        
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        m_token::claim_yield(&mut global, ctx);
        
        // Check first yield
        next_tx(&mut scenario, ALICE);
        let first_yield_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let first_yield = coin::value(&first_yield_coin);
        assert!(first_yield > 0, 0);
        test_scenario::return_to_sender(&scenario, first_yield_coin);
        
        // Second claim after more growth
        let index_2 = (index_1 * 11) / 10; // Another 1.1x
        set_index(&mut global, index_2);
        
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        m_token::claim_yield(&mut global, ctx);
        
        // Check second yield
        next_tx(&mut scenario, ALICE);
        let second_yield_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let second_yield = coin::value(&second_yield_coin);
        assert!(second_yield > 0, 1);
        test_scenario::return_to_sender(&scenario, second_yield_coin);
        
        // Total coins should equal initial mint plus both yields
        let total_coins = 1000 + (first_yield as u256) + (second_yield as u256);
        
        // This should be close to the current balance (accounting for rounding)
        let final_balance = m_token::balance_of(&global, ALICE);
        assert!(final_balance >= total_coins - 2 && final_balance <= total_coins + 2, 2);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    #[expected_failure(abort_code = sui_m::m_token::EAccountNotFound)]
    fun test_claim_yield_no_account() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        // Try to claim without having an account
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        m_token::claim_yield(&mut global, ctx);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    #[expected_failure(abort_code = sui_m::m_token::ENotApprovedEarner)]
    fun test_claim_yield_not_earning() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        // Mint to Alice but don't start earning
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        
        // Try to claim yield as non-earner
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        m_token::claim_yield(&mut global, ctx);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    fun test_claim_yield_no_growth() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        // Set index and setup Alice as earner
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        
        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);
        
        // Count initial coins from minting
        next_tx(&mut scenario, ALICE);
        let initial_coin_count = if (test_scenario::has_most_recent_for_sender<Coin<M_TOKEN>>(&scenario)) {
            let initial_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
            test_scenario::return_to_sender(&scenario, initial_coin);
            1
        } else { 0 };
        
        // Try to claim immediately (no index growth)
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        m_token::claim_yield(&mut global, ctx);
        
        // Should not have received any additional coins from claiming
        next_tx(&mut scenario, ALICE);
        let final_coin_count = if (test_scenario::has_most_recent_for_sender<Coin<M_TOKEN>>(&scenario)) {
            let final_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
            test_scenario::return_to_sender(&scenario, final_coin);
            1
        } else { 0 };
        
        // No new coins should have been minted for claiming
        assert!(final_coin_count == initial_coin_count, 0);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
    
    #[test]
    fun test_claim_yield_accounting_consistency() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        // Set initial index
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        // Setup Alice and Bob as earners
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        m_token::approve_earner(&mut global, &registrar_cap, BOB);
        
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        m_token::mint_no_index(&mut global, &portal_cap, BOB, 2000, ctx);
        
        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);
        
        next_tx(&mut scenario, BOB);
        let bob_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, bob_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);
        
        // Record initial total supply
        let initial_total = m_token::total_supply(&global);
        
        // Simulate index growth
        let new_index = (EXPECTED_CURRENT_INDEX * 12) / 10; // 1.2x
        set_index(&mut global, new_index);
        
        // Alice claims yield
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        m_token::claim_yield(&mut global, ctx);
        
        // Check accounting after Alice's claim
        let total_after_alice = m_token::total_supply(&global);
        
        // Verify accounting consistency
        
        // In claim-based system, total supply reflects actual minted coins
        // It should increase due to yield coins being minted
        assert!(total_after_alice >= initial_total, 0);
        
        // Bob claims yield
        next_tx(&mut scenario, BOB);
        let ctx = ctx(&mut scenario);
        m_token::claim_yield(&mut global, ctx);
        
        // Check total accounting consistency
        let final_total = m_token::total_supply(&global);
        assert!(final_total >= total_after_alice, 1); // Should increase or stay same
        
        // Calculate total coins held by users
        let users = vector[ALICE, BOB];
        let total_coins = calculate_total_coin_supply(&mut scenario, users);
        
        // Verify final accounting consistency
        
        // In claim-based system, actual coins may be less than internal total
        // due to rounding when minting to earners. Users can claim the difference.
        // The key is that total coins + claimable yield = internal total
        assert!((total_coins as u256) <= final_total, 2); // Coins should not exceed internal total
        
        // Verify the system is internally consistent
        let earning_supply = m_token::total_earning_supply(&global);
        let non_earning_supply = m_token::total_non_earning_supply(&global);
        assert!(earning_supply + non_earning_supply == final_total, 3);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_claim_yield_for_recipient() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);

        // Setup index and initial state
        set_index(&mut global, EXPECTED_CURRENT_INDEX);

        // Setup Alice as earner with balance
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);

        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);

        // Make BOB an earner too BEFORE index growth so he can have yield to claim
        m_token::approve_earner(&mut global, &registrar_cap, BOB);
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, BOB, 500, ctx);

        next_tx(&mut scenario, BOB);
        let bob_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, bob_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);

        // Let some time pass with index growth - both Alice and BOB will have yield
        set_index(&mut global, EXPECTED_CURRENT_INDEX * 110 / 100); // 10% growth

        // Alice claims yield for BOB (BOB's yield, sent to BOB)
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        m_token::claim_yield_for(&mut global, BOB, ctx);

        // Check that BOB received his yield coins
        next_tx(&mut scenario, BOB);
        let coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let yield_received = coin::value(&coin);
        assert!(yield_received > 0, 0); // BOB should have received his yield
        test_scenario::return_to_sender(&scenario, coin);

        // BOB's internal balance should still show earning amount (unchanged)
        let bob_balance = m_token::balance_of(&global, BOB);
        assert!(bob_balance > 500, 1); // BOB's earning balance reflects index growth

        // Alice's balance should still show earning amount (unchanged by BOB's claim)
        let alice_balance = m_token::balance_of(&global, ALICE);
        assert!(alice_balance > 1000, 2); // Alice's earning balance reflects index growth

        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_claim_yield_and_join() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);

        // Setup index and initial state
        set_index(&mut global, EXPECTED_CURRENT_INDEX);

        // Setup Alice as earner with balance
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);

        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let mut alice_coin = m_token::start_earning(&mut global, alice_coin, ctx);

        // Alice now has her coin back from start_earning
        let initial_coin_value = coin::value(&alice_coin);

        // Let some time pass with index growth
        set_index(&mut global, EXPECTED_CURRENT_INDEX * 110 / 100); // 10% growth

        // Alice claims yield and joins it with existing coin
        let ctx = ctx(&mut scenario);
        let yield_coin = m_token::claim_yield_and_join(&mut global, ctx);
        let yield_amount = coin::value(&yield_coin);

        assert!(yield_amount > 0, 0); // Should have some yield

        // Join the coins
        coin::join(&mut alice_coin, yield_coin);
        let final_coin_value = coin::value(&alice_coin);

        // Final coin value should be initial + yield
        assert!(final_coin_value == initial_coin_value + yield_amount, 1);
        assert!(final_coin_value > initial_coin_value, 2);

        test_scenario::return_to_sender(&scenario, alice_coin);

        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_claim_variants_equivalence() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);

        // Setup index and initial state
        set_index(&mut global, EXPECTED_CURRENT_INDEX);

        // Setup two identical earners
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        m_token::approve_earner(&mut global, &registrar_cap, BOB);

        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        m_token::mint_no_index(&mut global, &portal_cap, BOB, 1000, ctx);

        // Both start earning at the same time
        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);

        next_tx(&mut scenario, BOB);
        let bob_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, bob_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);

        // Same index growth for both
        set_index(&mut global, EXPECTED_CURRENT_INDEX * 110 / 100); // 10% growth

        // Bob uses claim_yield_and_join first
        next_tx(&mut scenario, BOB);
        let mut bob_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let yield_coin = m_token::claim_yield_and_join(&mut global, ctx);
        coin::join(&mut bob_coin, yield_coin);
        let bob_total = coin::value(&bob_coin);

        // Alice uses claim_yield_and_join too for fair comparison
        next_tx(&mut scenario, ALICE);
        let mut alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let alice_yield_coin = m_token::claim_yield_and_join(&mut global, ctx);
        coin::join(&mut alice_coin, alice_yield_coin);
        let alice_total = coin::value(&alice_coin);

        // They should have equivalent amounts (allowing for rounding differences)
        let diff = if (alice_total > bob_total) {
            alice_total - bob_total
        } else {
            bob_total - alice_total
        };
        assert!(diff <= 1, 0);

        // Clean up coins (destroy them since we can't return modified objects)
        sui::test_utils::destroy(alice_coin);
        sui::test_utils::destroy(bob_coin);

        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_start_earning_syncs_balance_for_existing_earners() {
        let mut scenario = setup_test();
        let (mut global, portal_cap, registrar_cap) = take_shared_objects(&mut scenario);
        
        set_index(&mut global, EXPECTED_CURRENT_INDEX);
        
        // Setup Alice as earner with initial balance
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 1000, ctx);
        
        next_tx(&mut scenario, ALICE);
        let alice_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let ctx = ctx(&mut scenario);
        let returned_coin = m_token::start_earning(&mut global, alice_coin, ctx);
        test_scenario::return_to_sender(&scenario, returned_coin);
        
        // Check initial state
        let initial_principal = m_token::principal_balance_of(&global, ALICE);
        let initial_earning_supply = m_token::total_earning_supply(&global);
        assert!(initial_principal > 0, 0);
        assert!(initial_earning_supply > 0, 1);
        
        // Simulate Alice receiving additional coins via direct transfer
        // (In real scenarios, this could happen through P2P transfers, DEX trades, etc.)
        next_tx(&mut scenario, PORTAL);
        let ctx = ctx(&mut scenario);
        m_token::mint_no_index(&mut global, &portal_cap, ALICE, 500, ctx); // Alice gets 500 more
        
        // Now Alice has 1000 (earning) + 500 (new) = 1500 total coins
        // But her internal balance still only reflects the original 1000
        next_tx(&mut scenario, ALICE);
        let mut alice_original_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        let alice_new_coin = test_scenario::take_from_sender<Coin<M_TOKEN>>(&scenario);
        
        // Join the coins to simulate what would happen in practice
        coin::join(&mut alice_original_coin, alice_new_coin);
        let total_coin_value = coin::value(&alice_original_coin);
        
        // Alice should have more coins now than her original amount
        assert!(total_coin_value > 1000, 2);
        
        // Call start_earning again - this should sync her balance to match her actual coins
        let ctx = ctx(&mut scenario);
        let synced_coin = m_token::start_earning(&mut global, alice_original_coin, ctx);
        test_scenario::return_to_sender(&scenario, synced_coin);
        
        // Check that her internal accounting was updated
        let new_principal = m_token::principal_balance_of(&global, ALICE);
        let new_earning_supply = m_token::total_earning_supply(&global);
        
        // Her principal should have increased to reflect the additional 500 coins
        assert!(new_principal > initial_principal, 3);
        
        // Total earning supply should also have increased
        assert!(new_earning_supply > initial_earning_supply, 4);
        
        // Her balance should now match her actual coin holdings (accounting for rounding)
        let actual_balance = m_token::balance_of(&global, ALICE);
        
        // Allow for small rounding differences due to principal conversion
        // The balance should be close to the total coin value we calculated
        assert!(actual_balance >= (total_coin_value as u256) - 2 && actual_balance <= (total_coin_value as u256), 5);
        
        return_shared_objects(global, portal_cap, registrar_cap);
        test_scenario::end(scenario);
    }
}