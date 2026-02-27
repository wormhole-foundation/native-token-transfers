#[test_only]
module ntt_governance::governance_tests {
    use sui::test_scenario;
    use std::type_name;
    use wormhole::bytes;
    use wormhole::bytes32;
    use ntt::state::{Self, AdminCap};
    use ntt::upgrades;
    use ntt_governance::governance::{Self, GovernanceState};
    use ntt_governance::governance_scenario::{Self as gs};
    use ntt_governance::test_transceiver_a;
    use ntt_governance::test_transceiver_b;

    // ─── Deployment Tests ───

    #[test]
    fun test_init() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        // Verify GovernanceState exists as shared object
        let gov = gs::take_gov(&scenario);
        gs::return_gov(gov);

        // Verify NTT State exists as shared object
        let ntt_state = gs::take_ntt_state(&scenario);
        gs::return_ntt_state(ntt_state);

        scenario.end();
    }

    // ─── Decree-Based Action Tests ───

    #[test]
    fun test_set_peer_via_governance() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);
        let mut ntt_state = gs::take_ntt_state(&scenario);
        let clock = gs::take_clock(&mut scenario);

        // Build set_peer payload: chain_id (u16) | peer_address (32) | decimals (u8) | limit (u64)
        let mut payload = vector[];
        bytes::push_u16_be(&mut payload, gs::peer_chain_id());
        payload.append(x"0000000000000000000000000000000000000000000000000000000000000001");
        bytes::push_u8(&mut payload, gs::decimals());
        bytes::push_u64_be(&mut payload, gs::rate_limit());

        // ACTION_SET_PEER = 1
        let decree = governance::new_decree(1, payload);
        governance::execute_set_peer(&mut gov, &mut ntt_state, decree, &clock);

        // Verify peer was set
        let peer = state::borrow_peer(&ntt_state, gs::peer_chain_id());
        assert!(*ntt::peer::borrow_address(peer) == gs::peer_address());
        assert!(ntt::peer::get_token_decimals(peer) == gs::decimals());

        gs::return_gov(gov);
        gs::return_ntt_state(ntt_state);
        gs::return_clock(clock);
        scenario.end();
    }

    #[test]
    fun test_set_threshold_via_governance() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);
        let mut ntt_state = gs::take_ntt_state(&scenario);

        // Register transceiver A (ACTION_REGISTER_TRANSCEIVER = 7)
        let type_a = type_name::with_defining_ids<test_transceiver_a::TransceiverAuth>()
            .into_string().into_bytes();
        let mut reg_a = vector[];
        reg_a.append(x"0000000000000000000000000000000000000000000000000000000000000100");
        bytes::push_u16_be(&mut reg_a, type_a.length() as u16);
        reg_a.append(type_a);
        governance::execute_register_transceiver<test_transceiver_a::TransceiverAuth, gs::GOVERNANCE_SCENARIO>(
            &mut gov, &mut ntt_state, governance::new_decree(7, reg_a),
        );
        assert!(state::threshold(&ntt_state) == 1);

        // Register transceiver B
        let type_b = type_name::with_defining_ids<test_transceiver_b::TransceiverAuth>()
            .into_string().into_bytes();
        let mut reg_b = vector[];
        reg_b.append(x"0000000000000000000000000000000000000000000000000000000000000101");
        bytes::push_u16_be(&mut reg_b, type_b.length() as u16);
        reg_b.append(type_b);
        governance::execute_register_transceiver<test_transceiver_b::TransceiverAuth, gs::GOVERNANCE_SCENARIO>(
            &mut gov, &mut ntt_state, governance::new_decree(7, reg_b),
        );

        // Set threshold to 2 (ACTION_SET_THRESHOLD = 2)
        let mut threshold_payload = vector[];
        bytes::push_u8(&mut threshold_payload, 2);
        governance::execute_set_threshold(
            &mut gov, &mut ntt_state, governance::new_decree(2, threshold_payload),
        );
        assert!(state::threshold(&ntt_state) == 2);

        gs::return_gov(gov);
        gs::return_ntt_state(ntt_state);
        scenario.end();
    }

    #[test]
    fun test_pause_unpause_via_governance() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);
        let mut ntt_state = gs::take_ntt_state(&scenario);

        // Initially not paused
        assert!(!state::is_paused(&ntt_state));

        // Pause (ACTION_PAUSE = 5)
        governance::execute_pause(
            &mut gov, &mut ntt_state, governance::new_decree(5, vector[]),
        );
        assert!(state::is_paused(&ntt_state));

        // Unpause (ACTION_UNPAUSE = 6)
        governance::execute_unpause(
            &mut gov, &mut ntt_state, governance::new_decree(6, vector[]),
        );
        assert!(!state::is_paused(&ntt_state));

        gs::return_gov(gov);
        gs::return_ntt_state(ntt_state);
        scenario.end();
    }

    #[test]
    fun test_set_outbound_limit_via_governance() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);
        let mut ntt_state = gs::take_ntt_state(&scenario);
        let clock = gs::take_clock(&mut scenario);

        // ACTION_SET_OUTBOUND_LIMIT = 3
        let new_limit: u64 = 1_000_000_000;
        let mut payload = vector[];
        bytes::push_u64_be(&mut payload, new_limit);
        governance::execute_set_outbound_limit(
            &mut gov, &mut ntt_state, governance::new_decree(3, payload), &clock,
        );

        gs::return_gov(gov);
        gs::return_ntt_state(ntt_state);
        gs::return_clock(clock);
        scenario.end();
    }

    #[test]
    fun test_set_inbound_limit_via_governance() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);
        let mut ntt_state = gs::take_ntt_state(&scenario);
        let clock = gs::take_clock(&mut scenario);

        // Set up a peer first (ACTION_SET_PEER = 1)
        let mut peer_payload = vector[];
        bytes::push_u16_be(&mut peer_payload, gs::peer_chain_id());
        peer_payload.append(x"0000000000000000000000000000000000000000000000000000000000000001");
        bytes::push_u8(&mut peer_payload, gs::decimals());
        bytes::push_u64_be(&mut peer_payload, gs::rate_limit());
        governance::execute_set_peer(
            &mut gov, &mut ntt_state, governance::new_decree(1, peer_payload), &clock,
        );

        // Now update only the inbound limit (ACTION_SET_INBOUND_LIMIT = 4)
        let new_limit: u64 = 2_000_000_000;
        let mut limit_payload = vector[];
        bytes::push_u16_be(&mut limit_payload, gs::peer_chain_id());
        bytes::push_u64_be(&mut limit_payload, new_limit);
        governance::execute_set_inbound_limit(
            &mut gov, &mut ntt_state, governance::new_decree(4, limit_payload), &clock,
        );

        gs::return_gov(gov);
        gs::return_ntt_state(ntt_state);
        gs::return_clock(clock);
        scenario.end();
    }

    #[test]
    fun test_register_transceiver_via_governance() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);
        let mut ntt_state = gs::take_ntt_state(&scenario);

        // No transceivers initially
        assert!(state::get_enabled_transceivers(&ntt_state).count_ones() == 0);

        // Register transceiver A (ACTION_REGISTER_TRANSCEIVER = 7)
        let type_a = type_name::with_defining_ids<test_transceiver_a::TransceiverAuth>()
            .into_string().into_bytes();
        let mut reg_a = vector[];
        reg_a.append(x"0000000000000000000000000000000000000000000000000000000000000100");
        bytes::push_u16_be(&mut reg_a, type_a.length() as u16);
        reg_a.append(type_a);
        governance::execute_register_transceiver<test_transceiver_a::TransceiverAuth, gs::GOVERNANCE_SCENARIO>(
            &mut gov, &mut ntt_state, governance::new_decree(7, reg_a),
        );
        assert!(state::get_enabled_transceivers(&ntt_state).count_ones() == 1);
        assert!(state::threshold(&ntt_state) == 1);

        // Register transceiver B
        let type_b = type_name::with_defining_ids<test_transceiver_b::TransceiverAuth>()
            .into_string().into_bytes();
        let mut reg_b = vector[];
        reg_b.append(x"0000000000000000000000000000000000000000000000000000000000000101");
        bytes::push_u16_be(&mut reg_b, type_b.length() as u16);
        reg_b.append(type_b);
        governance::execute_register_transceiver<test_transceiver_b::TransceiverAuth, gs::GOVERNANCE_SCENARIO>(
            &mut gov, &mut ntt_state, governance::new_decree(7, reg_b),
        );
        assert!(state::get_enabled_transceivers(&ntt_state).count_ones() == 2);

        gs::return_gov(gov);
        gs::return_ntt_state(ntt_state);
        scenario.end();
    }

    #[test]
    fun test_enable_disable_transceiver_via_governance() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);
        let mut ntt_state = gs::take_ntt_state(&scenario);

        // Register two transceivers (ACTION_REGISTER_TRANSCEIVER = 7)
        let type_a = type_name::with_defining_ids<test_transceiver_a::TransceiverAuth>()
            .into_string().into_bytes();
        let mut reg_a = vector[];
        reg_a.append(x"0000000000000000000000000000000000000000000000000000000000000100");
        bytes::push_u16_be(&mut reg_a, type_a.length() as u16);
        reg_a.append(type_a);
        governance::execute_register_transceiver<test_transceiver_a::TransceiverAuth, gs::GOVERNANCE_SCENARIO>(
            &mut gov, &mut ntt_state, governance::new_decree(7, reg_a),
        );

        let type_b = type_name::with_defining_ids<test_transceiver_b::TransceiverAuth>()
            .into_string().into_bytes();
        let mut reg_b = vector[];
        reg_b.append(x"0000000000000000000000000000000000000000000000000000000000000101");
        bytes::push_u16_be(&mut reg_b, type_b.length() as u16);
        reg_b.append(type_b);
        governance::execute_register_transceiver<test_transceiver_b::TransceiverAuth, gs::GOVERNANCE_SCENARIO>(
            &mut gov, &mut ntt_state, governance::new_decree(7, reg_b),
        );
        assert!(state::get_enabled_transceivers(&ntt_state).count_ones() == 2);

        // Set threshold to 2 (ACTION_SET_THRESHOLD = 2)
        let mut threshold_payload = vector[];
        bytes::push_u8(&mut threshold_payload, 2);
        governance::execute_set_threshold(
            &mut gov, &mut ntt_state, governance::new_decree(2, threshold_payload),
        );

        // Disable transceiver B (id=1) — threshold auto-reduces to 1
        // ACTION_DISABLE_TRANSCEIVER = 9
        let mut disable_payload = vector[];
        bytes::push_u8(&mut disable_payload, 1);
        governance::execute_disable_transceiver(
            &mut gov, &mut ntt_state, governance::new_decree(9, disable_payload),
        );
        assert!(state::get_enabled_transceivers(&ntt_state).count_ones() == 1);
        assert!(state::threshold(&ntt_state) == 1);

        // Re-enable transceiver B (ACTION_ENABLE_TRANSCEIVER = 8)
        let mut enable_payload = vector[];
        bytes::push_u8(&mut enable_payload, 1);
        governance::execute_enable_transceiver(
            &mut gov, &mut ntt_state, governance::new_decree(8, enable_payload),
        );
        assert!(state::get_enabled_transceivers(&ntt_state).count_ones() == 2);

        gs::return_gov(gov);
        gs::return_ntt_state(ntt_state);
        scenario.end();
    }

    #[test]
    fun test_authorize_upgrade_via_governance() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);
        let mut ntt_state = gs::take_ntt_state(&scenario);

        // ACTION_AUTHORIZE_UPGRADE = 10
        let digest = x"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        let decree = governance::new_decree(10, digest);
        let ticket = governance::execute_authorize_upgrade(&mut gov, decree);
        let receipt = sui::package::test_upgrade(ticket);
        governance::execute_commit_upgrade(&mut gov, &mut ntt_state, receipt);

        gs::return_gov(gov);
        gs::return_ntt_state(ntt_state);
        scenario.end();
    }

    // ─── Governance ID Validation Tests ───

    #[test]
    fun test_governance_id_check_correct() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let gov = gs::take_gov(&scenario);

        // Construct payload: governance_id (32) | ntt_action (1) | action_data
        let gov_id_bytes = bytes32::from_address(object::id_address(&gov));
        let mut payload = bytes32::to_bytes(gov_id_bytes);
        bytes::push_u8(&mut payload, 5); // NTT action (e.g. ACTION_PAUSE)
        bytes::push_u8(&mut payload, 42); // Some action data

        // Should succeed — correct governance ID
        let (action, action_data) = governance::test_parse_governance_payload(&gov, payload);
        assert!(action == 5);
        assert!(action_data.length() == 1);

        gs::return_gov(gov);
        scenario.end();
    }

    #[test, expected_failure(abort_code = governance::EGovernanceIdMismatch)]
    fun test_governance_id_check_wrong_id() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let gov = gs::take_gov(&scenario);

        // Construct payload with WRONG governance ID
        let wrong_id = bytes32::from_bytes(
            x"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        );
        let payload = bytes32::to_bytes(wrong_id);

        // Should abort — wrong governance ID
        governance::test_parse_governance_payload(&gov, payload);

        gs::return_gov(gov);
        scenario.end();
    }

    // ─── Capability Transfer Tests ───

    #[test]
    fun test_receive_caps() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup_empty(&mut scenario);

        // Gov exists but has no caps
        let gov = gs::take_gov(&scenario);
        let gov_addr = object::id_address(&gov);

        // Transfer caps to governance object address
        let admin_cap = scenario.take_from_sender<AdminCap>();
        let upgrade_cap = scenario.take_from_sender<upgrades::UpgradeCap>();
        transfer::public_transfer(admin_cap, gov_addr);
        transfer::public_transfer(upgrade_cap, gov_addr);
        gs::return_gov(gov);

        // Next transaction: receive caps
        scenario.next_tx(gs::admin());
        let mut gov = gs::take_gov(&scenario);
        let admin_recv = test_scenario::most_recent_receiving_ticket<AdminCap>(
            &object::id(&gov),
        );
        governance::receive_admin_cap(&mut gov, admin_recv);
        let upgrade_recv = test_scenario::most_recent_receiving_ticket<upgrades::UpgradeCap>(
            &object::id(&gov),
        );
        governance::receive_upgrade_cap(&mut gov, upgrade_recv);

        // Verify governance can now use caps via decree
        let mut ntt_state = gs::take_ntt_state(&scenario);
        // ACTION_PAUSE = 5
        governance::execute_pause(
            &mut gov, &mut ntt_state, governance::new_decree(5, vector[]),
        );
        assert!(state::is_paused(&ntt_state));

        gs::return_gov(gov);
        gs::return_ntt_state(ntt_state);
        scenario.end();
    }

    #[test]
    fun test_handoff() {
        let mut scenario = test_scenario::begin(gs::admin());

        // 1. Setup gov_a with caps (fresh deploy)
        gs::setup(&mut scenario);
        let gov_a = gs::take_gov(&scenario);
        let gov_a_id = object::id(&gov_a);
        gs::return_gov(gov_a);

        // 2. Create gov_b (empty)
        scenario.next_tx(gs::admin());
        governance::create_test_only(test_scenario::ctx(&mut scenario));

        // 3. Find gov_b by taking both shared GovernanceStates
        scenario.next_tx(gs::admin());
        let g1: GovernanceState = test_scenario::take_shared(&scenario);
        let g2: GovernanceState = test_scenario::take_shared(&scenario);
        let (gov_b_id, gov_b_address) = if (object::id(&g1) == gov_a_id) {
            (object::id(&g2), object::id_address(&g2))
        } else {
            (object::id(&g1), object::id_address(&g1))
        };
        test_scenario::return_shared(g1);
        test_scenario::return_shared(g2);

        // 4. Transfer caps from gov_a to gov_b's address
        scenario.next_tx(gs::admin());
        let mut gov_a = test_scenario::take_shared_by_id<GovernanceState>(&scenario, gov_a_id);
        governance::test_transfer_ownership(&mut gov_a, gov_b_address);
        test_scenario::return_shared(gov_a);

        // 5. Receive caps into gov_b
        scenario.next_tx(gs::admin());
        let mut gov_b = test_scenario::take_shared_by_id<GovernanceState>(
            &scenario, gov_b_id,
        );
        let admin_recv = test_scenario::most_recent_receiving_ticket<AdminCap>(
            &object::id(&gov_b),
        );
        governance::receive_admin_cap(&mut gov_b, admin_recv);
        let upgrade_recv = test_scenario::most_recent_receiving_ticket<upgrades::UpgradeCap>(
            &object::id(&gov_b),
        );
        governance::receive_upgrade_cap(&mut gov_b, upgrade_recv);

        // 6. Verify gov_b can use the caps via decree
        let mut ntt_state = gs::take_ntt_state(&scenario);
        // ACTION_PAUSE = 5
        governance::execute_pause(
            &mut gov_b, &mut ntt_state, governance::new_decree(5, vector[]),
        );
        assert!(state::is_paused(&ntt_state));

        gs::return_ntt_state(ntt_state);
        test_scenario::return_shared(gov_b);
        test_scenario::return_shared(
            test_scenario::take_shared_by_id<GovernanceState>(&scenario, gov_a_id),
        );
        scenario.end();
    }

    #[test, expected_failure]
    fun test_action_fails_without_cap() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup_empty(&mut scenario);

        let mut gov = gs::take_gov(&scenario);
        let mut ntt_state = gs::take_ntt_state(&scenario);

        // Trying to execute on empty gov should abort
        // (EFieldDoesNotExist from dynamic_object_field)
        // ACTION_PAUSE = 5
        governance::execute_pause(
            &mut gov, &mut ntt_state, governance::new_decree(5, vector[]),
        );

        gs::return_gov(gov);
        gs::return_ntt_state(ntt_state);
        scenario.end();
    }

    #[test, expected_failure(abort_code = governance::EAdminCapAlreadySet)]
    fun test_double_receive_admin_cap_fails() {
        let mut scenario = test_scenario::begin(gs::admin());

        // Use setup_empty twice to get two sets of caps
        gs::setup_empty(&mut scenario);

        let gov = gs::take_gov(&scenario);
        let gov_addr = object::id_address(&gov);

        // Transfer first admin cap to gov
        let admin_cap = scenario.take_from_sender<AdminCap>();
        transfer::public_transfer(admin_cap, gov_addr);
        // Keep upgrade cap and second admin cap aside
        let upgrade_cap = scenario.take_from_sender<upgrades::UpgradeCap>();
        transfer::public_transfer(upgrade_cap, gs::admin());
        gs::return_gov(gov);

        // Receive first admin cap
        scenario.next_tx(gs::admin());
        {
            let mut gov = gs::take_gov(&scenario);
            let admin_recv = test_scenario::most_recent_receiving_ticket<AdminCap>(
                &object::id(&gov),
            );
            governance::receive_admin_cap(&mut gov, admin_recv);
            gs::return_gov(gov);
        };

        // Now get a second AdminCap by creating another NTT deployment
        // (done via the scenario module helper)
        gs::setup_second_ntt(&mut scenario);

        // Transfer second admin cap to gov
        scenario.next_tx(gs::admin());
        {
            let gov = gs::take_gov(&scenario);
            let gov_addr = object::id_address(&gov);
            let admin_cap2 = scenario.take_from_sender<AdminCap>();
            transfer::public_transfer(admin_cap2, gov_addr);
            gs::return_gov(gov);
        };

        // Try to receive second admin cap — should fail with EAdminCapAlreadySet
        scenario.next_tx(gs::admin());
        let mut gov = gs::take_gov(&scenario);
        let admin_recv2 = test_scenario::most_recent_receiving_ticket<AdminCap>(
            &object::id(&gov),
        );
        governance::receive_admin_cap(&mut gov, admin_recv2);

        gs::return_gov(gov);
        scenario.end();
    }

    #[test]
    fun test_transfer_with_only_admin_cap() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup_empty(&mut scenario);

        let gov = gs::take_gov(&scenario);
        let gov_addr = object::id_address(&gov);

        // Only transfer admin cap (not upgrade cap)
        let admin_cap = scenario.take_from_sender<AdminCap>();
        transfer::public_transfer(admin_cap, gov_addr);
        // Keep upgrade cap with admin
        let upgrade_cap = scenario.take_from_sender<upgrades::UpgradeCap>();
        transfer::public_transfer(upgrade_cap, gs::admin());
        gs::return_gov(gov);

        // Receive admin cap only
        scenario.next_tx(gs::admin());
        let mut gov = gs::take_gov(&scenario);
        let admin_recv = test_scenario::most_recent_receiving_ticket<AdminCap>(
            &object::id(&gov),
        );
        governance::receive_admin_cap(&mut gov, admin_recv);

        // Transfer ownership with only admin cap
        let target_addr = @0xBEEF;
        governance::test_transfer_ownership(&mut gov, target_addr);

        gs::return_gov(gov);
        scenario.end();
    }

    #[test, expected_failure(abort_code = governance::ENoCapToTransfer)]
    fun test_transfer_empty_fails() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup_empty(&mut scenario);

        let mut gov = gs::take_gov(&scenario);

        // Keep caps with admin, don't send to gov
        let admin_cap = scenario.take_from_sender<AdminCap>();
        let upgrade_cap = scenario.take_from_sender<upgrades::UpgradeCap>();
        transfer::public_transfer(admin_cap, gs::admin());
        transfer::public_transfer(upgrade_cap, gs::admin());

        // Try to transfer ownership from empty gov — should fail
        governance::test_transfer_ownership(&mut gov, @0xBEEF);

        gs::return_gov(gov);
        scenario.end();
    }

    // ─── Action Mismatch Tests ───

    #[test, expected_failure(abort_code = governance::EActionMismatch)]
    fun test_set_peer_action_mismatch() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);
        let mut ntt_state = gs::take_ntt_state(&scenario);
        let clock = gs::take_clock(&mut scenario);

        // Build valid set_peer payload but with wrong action (2 instead of 1)
        let mut payload = vector[];
        bytes::push_u16_be(&mut payload, gs::peer_chain_id());
        payload.append(x"0000000000000000000000000000000000000000000000000000000000000001");
        bytes::push_u8(&mut payload, gs::decimals());
        bytes::push_u64_be(&mut payload, gs::rate_limit());

        let decree = governance::new_decree(2, payload); // ACTION_SET_THRESHOLD, not SET_PEER
        governance::execute_set_peer(&mut gov, &mut ntt_state, decree, &clock);

        gs::return_gov(gov);
        gs::return_ntt_state(ntt_state);
        gs::return_clock(clock);
        scenario.end();
    }

    #[test, expected_failure(abort_code = governance::EActionMismatch)]
    fun test_pause_action_mismatch() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);
        let mut ntt_state = gs::take_ntt_state(&scenario);

        // Send ACTION_UNPAUSE (6) to execute_pause (expects 5)
        governance::execute_pause(
            &mut gov, &mut ntt_state, governance::new_decree(6, vector[]),
        );

        gs::return_gov(gov);
        gs::return_ntt_state(ntt_state);
        scenario.end();
    }

    #[test, expected_failure(abort_code = governance::EActionMismatch)]
    fun test_authorize_upgrade_action_mismatch() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);

        // Send ACTION_SET_PEER (1) to execute_authorize_upgrade (expects 10)
        let digest = x"deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
        let decree = governance::new_decree(1, digest);
        let _ticket = governance::execute_authorize_upgrade(&mut gov, decree);

        abort 0 // unreachable
    }

    #[test, expected_failure(abort_code = governance::EActionMismatch)]
    fun test_transfer_ownership_action_mismatch() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);

        // Send ACTION_PAUSE (5) to execute_transfer_ownership (expects 11)
        let new_owner = x"0000000000000000000000000000000000000000000000000000000000001234";
        governance::execute_transfer_ownership(
            &mut gov, governance::new_decree(5, new_owner),
        );

        gs::return_gov(gov);
        scenario.end();
    }

    // ─── Payload Truncation Tests ───

    #[test, expected_failure]
    fun test_set_peer_truncated_payload() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);
        let mut ntt_state = gs::take_ntt_state(&scenario);
        let clock = gs::take_clock(&mut scenario);

        // Truncated payload: only chain_id (2 bytes), missing peer_address/decimals/limit
        let mut payload = vector[];
        bytes::push_u16_be(&mut payload, gs::peer_chain_id());

        let decree = governance::new_decree(1, payload);
        governance::execute_set_peer(&mut gov, &mut ntt_state, decree, &clock);

        gs::return_gov(gov);
        gs::return_ntt_state(ntt_state);
        gs::return_clock(clock);
        scenario.end();
    }

    #[test, expected_failure]
    fun test_set_threshold_trailing_bytes() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);
        let mut ntt_state = gs::take_ntt_state(&scenario);

        // Register a transceiver first so threshold=1 is valid
        let type_a = type_name::with_defining_ids<test_transceiver_a::TransceiverAuth>()
            .into_string().into_bytes();
        let mut reg_a = vector[];
        reg_a.append(x"0000000000000000000000000000000000000000000000000000000000000100");
        bytes::push_u16_be(&mut reg_a, type_a.length() as u16);
        reg_a.append(type_a);
        governance::execute_register_transceiver<test_transceiver_a::TransceiverAuth, gs::GOVERNANCE_SCENARIO>(
            &mut gov, &mut ntt_state, governance::new_decree(7, reg_a),
        );

        // Threshold payload with trailing garbage — cursor::destroy_empty should abort
        let mut payload = vector[];
        bytes::push_u8(&mut payload, 1);
        bytes::push_u8(&mut payload, 0xFF); // trailing byte

        let decree = governance::new_decree(2, payload);
        governance::execute_set_threshold(&mut gov, &mut ntt_state, decree);

        gs::return_gov(gov);
        gs::return_ntt_state(ntt_state);
        scenario.end();
    }

    #[test, expected_failure]
    fun test_authorize_upgrade_truncated_digest() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);

        // Truncated digest — only 16 bytes instead of 32
        let short_digest = x"deadbeefdeadbeefdeadbeefdeadbeef";
        let decree = governance::new_decree(10, short_digest);
        let _ticket = governance::execute_authorize_upgrade(&mut gov, decree);

        abort 0 // unreachable
    }

    #[test, expected_failure]
    fun test_transfer_ownership_empty_payload() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);

        // Empty payload — should abort when trying to read 32-byte address
        governance::execute_transfer_ownership(
            &mut gov, governance::new_decree(11, vector[]),
        );

        gs::return_gov(gov);
        scenario.end();
    }

    // ─── Type Mismatch Test ───

    #[test, expected_failure(abort_code = governance::ETransceiverTypeMismatch)]
    fun test_register_transceiver_type_mismatch() {
        let mut scenario = test_scenario::begin(gs::admin());
        gs::setup(&mut scenario);

        let mut gov = gs::take_gov(&scenario);
        let mut ntt_state = gs::take_ntt_state(&scenario);

        // Build payload with type_name of TransceiverAuth A...
        let type_a = type_name::with_defining_ids<test_transceiver_a::TransceiverAuth>()
            .into_string().into_bytes();
        let mut payload = vector[];
        payload.append(x"0000000000000000000000000000000000000000000000000000000000000100");
        bytes::push_u16_be(&mut payload, type_a.length() as u16);
        payload.append(type_a);

        // ...but provide TransceiverAuth B as the type parameter
        governance::execute_register_transceiver<test_transceiver_b::TransceiverAuth, gs::GOVERNANCE_SCENARIO>(
            &mut gov, &mut ntt_state, governance::new_decree(7, payload),
        );

        gs::return_gov(gov);
        gs::return_ntt_state(ntt_state);
        scenario.end();
    }
}
