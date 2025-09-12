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
        m_token::start_earning(&mut global, ctx);
        
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
        
        m_token::start_earning(&mut global, ctx);
        
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
        
        m_token::start_earning(&mut global, ctx);
        
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
        
        // Alice starts earning
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        m_token::start_earning(&mut global, ctx);
        
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
        let ctx = ctx(&mut scenario);
        m_token::start_earning(&mut global, ctx);
        
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
        let ctx = ctx(&mut scenario);
        m_token::start_earning(&mut global, ctx);
        
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
        let ctx = ctx(&mut scenario);
        m_token::start_earning(&mut global, ctx);
        
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
        let ctx = ctx(&mut scenario);
        m_token::start_earning(&mut global, ctx);
        
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
        let ctx = ctx(&mut scenario);
        m_token::start_earning(&mut global, ctx);
        
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
        m_token::start_earning(&mut global, ctx);
        
        next_tx(&mut scenario, carol);
        let ctx = ctx(&mut scenario);
        m_token::start_earning(&mut global, ctx);
        
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
        
        // Convert Alice to earner
        m_token::approve_earner(&mut global, &registrar_cap, ALICE);
        next_tx(&mut scenario, ALICE);
        let ctx = ctx(&mut scenario);
        m_token::start_earning(&mut global, ctx);
        
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
        let ctx = ctx(&mut scenario);
        m_token::start_earning(&mut global, ctx);
        
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
        let ctx = ctx(&mut scenario);
        m_token::start_earning(&mut global, ctx);
        
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
}