#[test_only]
module ntt::ntt_tests {
    use sui::coin::Coin;
    use sui::test_scenario;
    use wormhole::external_address;
    use ntt::ntt_scenario;
    use ntt::state::{Self};
    use ntt::ntt;
    use ntt::upgrades;
    use ntt_common::ntt_manager_message;
    use ntt_common::native_token_transfer;
    use ntt::test_transceiver_a;
    use ntt::test_transceiver_b;
    use ntt::test_transceiver_c;

    const TEST_AMOUNT: u64 = 1000000001; // 1 token with 9 decimals and some dust
    const TEST_DUST: u64 = 1;

    #[test]
    fun test_basic_setup() {
        let (admin, _, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(admin);
        ntt_scenario::setup(&mut scenario);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_transceiver_registration() {
        let (admin, _, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(admin);
        ntt_scenario::setup(&mut scenario);

        // Test that transceivers were properly registered
        let state = ntt_scenario::take_state(&scenario);
        assert!(state::get_enabled_transceivers(&state).count_ones() == 2);
        ntt_scenario::return_state(state);

        test_scenario::end(scenario);
    }

    #[test]
    fun test_transfer_message_creation() {
        let (admin, _, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(admin);
        ntt_scenario::setup(&mut scenario);

        let recipient = x"000000000000000000000000000000000000000000000000000000000000dead";
        let message = ntt_scenario::create_test_message(TEST_AMOUNT, recipient, 1);

        // Verify message contents
        let (_id, _sender, transfer) = message.destruct();
        let to_chain = transfer.get_to_chain();
        assert!(to_chain == ntt_scenario::chain_id());

        test_scenario::end(scenario);
    }

    #[test]
    fun test_message_attestation() {
        let (admin, _, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(admin);
        ntt_scenario::setup(&mut scenario);

        // Create test message
        let recipient = x"000000000000000000000000000000000000000000000000000000000000dead";
        let message = ntt_scenario::create_test_message(TEST_AMOUNT, recipient, 1);

        // Get state and vote on message
        let mut state = ntt_scenario::take_state(&scenario);
        state::vote<test_transceiver_a::TransceiverAuth, ntt_scenario::NTT_SCENARIO>(&mut state, ntt_scenario::peer_chain_id(), message);

        // Verify vote was counted
        let inbox_item = state::borrow_inbox_item<ntt_scenario::NTT_SCENARIO>(&state, ntt_scenario::peer_chain_id(), message);
        let vote_count = inbox_item.count_enabled_votes(&state::get_enabled_transceivers(&state));
        assert!(vote_count == 1);

        ntt_scenario::return_state(state);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_message_threshold() {
        let (admin, _, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(admin);
        ntt_scenario::setup(&mut scenario);

        // Create test message
        let recipient = x"000000000000000000000000000000000000000000000000000000000000dead";
        let message = ntt_scenario::create_test_message(TEST_AMOUNT, recipient, 1);

        // Get state and vote with both transceivers
        let mut state = ntt_scenario::take_state(&scenario);

        // First vote
        state::vote<test_transceiver_a::TransceiverAuth, _>(&mut state, ntt_scenario::peer_chain_id(), message);
        {
            let inbox_item = state::borrow_inbox_item(&state, ntt_scenario::peer_chain_id(), message);
            let vote_count = inbox_item.count_enabled_votes(&state::get_enabled_transceivers(&state));
            assert!(vote_count == 1);
        };

        // Second vote
        state::vote<test_transceiver_b::TransceiverAuth, _>(&mut state, ntt_scenario::peer_chain_id(), message);
        {
            let inbox_item = state::borrow_inbox_item(&state, ntt_scenario::peer_chain_id(), message);
            let vote_count = inbox_item.count_enabled_votes(&state::get_enabled_transceivers(&state));
            assert!(vote_count == 2);
            // Verify threshold is met
            assert!(vote_count >= state.get_threshold());
        };

        ntt_scenario::return_state(state);
        test_scenario::end(scenario);
    }

    #[test, expected_failure(abort_code = ::ntt::transceiver_registry::EUnregisteredTransceiver)]
    fun test_unregistered_transceiver_cant_vote() {
        let (admin, _, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(admin);
        ntt_scenario::setup(&mut scenario);

        // Create test message
        let recipient = x"000000000000000000000000000000000000000000000000000000000000dead";
        let message = ntt_scenario::create_test_message(TEST_AMOUNT, recipient, 1);

        // Get state and vote with both transceivers
        let mut state = ntt_scenario::take_state(&scenario);

        state::vote<test_transceiver_c::TransceiverAuth, ntt_scenario::NTT_SCENARIO>(&mut state, ntt_scenario::peer_chain_id(), message);
        {
            let inbox_item = state::borrow_inbox_item(&state, ntt_scenario::peer_chain_id(), message);
            let vote_count = inbox_item.count_enabled_votes(&state::get_enabled_transceivers(&state));
            assert!(vote_count == 1);
        };

        ntt_scenario::return_state(state);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_transfer() {
        let (_, user_a, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        scenario.next_tx(user_a);

        // Take state and clock
        let mut state = ntt_scenario::take_state(&scenario);
        let clock = ntt_scenario::take_clock(&mut scenario);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        let coins = state.mint_for_test(TEST_AMOUNT, scenario.ctx());

        // Create transfer ticket
        let recipient = x"000000000000000000000000000000000000000000000000000000000000dead";
        let (ticket, dust) = ntt::prepare_transfer(
            &state,
            coins,
            &coin_meta,
            ntt_scenario::peer_chain_id(), // recipient_chain
            recipient,
            option::none(),
            false // should_queue
        );

        assert!(dust.value() == TEST_DUST);

        // Initial balance check
        let initial_balance = if (state.borrow_mode().is_locking()) {
            state.borrow_balance().value()
        } else {
            state.borrow_treasury_cap().total_supply()
        };

        // Execute transfer
        let outbox_key = ntt::transfer_tx_sender(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            ticket,
            &clock,
            scenario.ctx()
        );

        // Verify state after transfer
        if (state.borrow_mode().is_locking()) {
            // In locking mode, tokens should be in the state's balance
            assert!(state.borrow_balance().value() == initial_balance + (TEST_AMOUNT - TEST_DUST))
        } else {
            assert!(state.borrow_treasury_cap().total_supply() == initial_balance - (TEST_AMOUNT - TEST_DUST))
        };

        // Verify outbox item
        let message = *state.borrow_outbox().borrow(outbox_key).borrow_data();

        // Verify message contents
        let (message_id, _, transfer) = message.destruct();
        let (trimmed_amount, _, recipient_addr, to_chain, _payload) = transfer.destruct();
        assert!(trimmed_amount.untrim(ntt_scenario::decimals()) == TEST_AMOUNT - TEST_DUST);
        assert!(to_chain == ntt_scenario::peer_chain_id());
        assert!(recipient_addr.to_bytes() == recipient);

        let transceiver_a_message = state.create_transceiver_message<test_transceiver_a::TransceiverAuth, _>(
            message_id,
            &clock
        );

        let transceiver_b_message = state.create_transceiver_message<test_transceiver_b::TransceiverAuth, _>(
            message_id,
            &clock
        );

        let (manager_message_a, source_manager_a, recipient_manager_a) =
            transceiver_a_message.unwrap_outbound_message(&test_transceiver_a::auth());

        let (manager_message_b, source_manager_b, recipient_manager_b) =
            transceiver_b_message.unwrap_outbound_message(&test_transceiver_b::auth());

        assert!(manager_message_a == manager_message_b);
        assert!(source_manager_a == source_manager_b);
        assert!(recipient_manager_a == recipient_manager_b);

        assert!(source_manager_a == external_address::from_address(object::id_address(&state)));

        let manager_message = ntt_manager_message::map!(manager_message_a, |x| native_token_transfer::parse(x));

        assert!(manager_message == ntt_manager_message::new(
            message_id,
            external_address::from_address(user_a),
            native_token_transfer::new(
                ntt_common::trimmed_amount::new(
                    TEST_AMOUNT / 10, // token has 9 decimals
                    8
                ),
                external_address::from_id(object::id(&coin_meta)),
                recipient_addr,
                ntt_scenario::peer_chain_id(),
                option::none()
            )
        ));

        // Clean up
        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        sui::test_utils::destroy(dust);
        test_scenario::end(scenario);
    }

    #[test, expected_failure(abort_code = ::ntt::outbox::EMessageAlreadySent)]
    fun test_transfer_cant_release_twice() {
        let (_, user_a, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        // Take state and clock
        let mut state = ntt_scenario::take_state(&scenario);
        let clock = ntt_scenario::take_clock(&mut scenario);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        let coins = state.mint_for_test(TEST_AMOUNT, scenario.ctx());

        // Create transfer ticket
        let recipient = x"000000000000000000000000000000000000000000000000000000000000dead";
        let (ticket, dust) = ntt::prepare_transfer(
            &state,
            coins,
            &coin_meta,
            ntt_scenario::peer_chain_id(), // recipient_chain
            recipient,
            option::none(),
            false // should_queue
        );

        // Execute transfer
        let outbox_key = ntt::transfer_tx_sender(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            ticket,
            &clock,
            scenario.ctx()
        );

        let message = *state.borrow_outbox().borrow(outbox_key).borrow_data();
        let (message_id, _, _) = message.destruct();

        let transceiver_a_message = state.create_transceiver_message<test_transceiver_a::TransceiverAuth, _>(
            message_id,
            &clock
        );

        sui::test_utils::destroy(transceiver_a_message);

        // this will fail, because transceiver a already released the message
        let transceiver_a_message = state.create_transceiver_message<test_transceiver_a::TransceiverAuth, _>(
            message_id,
            &clock
        );
        sui::test_utils::destroy(transceiver_a_message);

        // Clean up
        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        sui::test_utils::destroy(dust);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_redeem() {
        let (_, user_a, user_b, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        let mut state = ntt_scenario::take_state(&scenario);
        let clock = ntt_scenario::take_clock(&mut scenario);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        let message_id = wormhole::bytes32::from_u256_be(100);
        let manager_message = ntt_manager_message::new(
            message_id,
            external_address::from_address(user_a),
            native_token_transfer::new(
                ntt_common::trimmed_amount::new(
                    TEST_AMOUNT / 10, // token has 9 decimals
                    8
                ),
                external_address::from_id(object::id(&coin_meta)),
                external_address::from_address(user_b),
                ntt_scenario::chain_id(), // TODO: test with wrong target chain id
                option::none()
            )
        );

        let manager_message_encoded = ntt_manager_message::map!(manager_message, |x| x.to_bytes());

        let validated_transceiver_message_a = ntt_common::validated_transceiver_message::new(
            &test_transceiver_a::auth(),
            ntt_scenario::peer_chain_id(),
            ntt_common::transceiver_message_data::new(
                ntt_scenario::peer_manager_address(),
                external_address::from_address(object::id_address(&state)),
                manager_message_encoded
            )
        );

        let validated_transceiver_message_b = ntt_common::validated_transceiver_message::new(
            &test_transceiver_b::auth(),
            ntt_scenario::peer_chain_id(),
            ntt_common::transceiver_message_data::new(
                ntt_scenario::peer_manager_address(),
                external_address::from_address(object::id_address(&state)),
                manager_message_encoded
            )
        );

        ntt::redeem(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            validated_transceiver_message_a,
            &clock
        );

        ntt::redeem(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            validated_transceiver_message_b,
            &clock
        );

        ntt::release(
            &mut state,
            upgrades::new_version_gated(),
            ntt_scenario::peer_chain_id(),
            manager_message,
            &coin_meta,
            &clock,
            scenario.ctx()
        );

        scenario.next_tx(user_a);

        let coins = scenario.take_from_address<Coin<ntt_scenario::NTT_SCENARIO>>(user_b);

        assert!(coins.value() == TEST_AMOUNT - TEST_DUST);

        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        sui::test_utils::destroy(coins);
        scenario.end();
    }

    #[test, expected_failure(abort_code = ::ntt::ntt::ECantReleaseYet)]
    fun test_redeem_no_threshold() {
        let (_, user_a, user_b, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        let mut state = ntt_scenario::take_state(&scenario);
        let clock = ntt_scenario::take_clock(&mut scenario);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        let message_id = wormhole::bytes32::from_u256_be(100);
        let manager_message = ntt_manager_message::new(
            message_id,
            external_address::from_address(user_a),
            native_token_transfer::new(
                ntt_common::trimmed_amount::new(
                    TEST_AMOUNT / 10, // token has 9 decimals
                    8
                ),
                external_address::from_id(object::id(&coin_meta)),
                external_address::from_address(user_b),
                ntt_scenario::chain_id(),
                option::none()
            )
        );

        let manager_message_encoded = ntt_manager_message::map!(manager_message, |x| x.to_bytes());

        let validated_transceiver_message_a = ntt_common::validated_transceiver_message::new(
            &test_transceiver_a::auth(),
            ntt_scenario::peer_chain_id(),
            ntt_common::transceiver_message_data::new(
                ntt_scenario::peer_manager_address(),
                external_address::from_address(object::id_address(&state)),
                manager_message_encoded
            )
        );

        ntt::redeem(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            validated_transceiver_message_a,
            &clock
        );

        ntt::release(
            &mut state,
            upgrades::new_version_gated(),
            ntt_scenario::peer_chain_id(),
            manager_message,
            &coin_meta,
            &clock,
            scenario.ctx()
        );

        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        scenario.end();
    }

    #[test, expected_failure(abort_code = ::ntt::ntt::ECantReleaseYet)]
    fun test_redeem_no_threshold_double_vote() {
        let (_, user_a, user_b, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        let mut state = ntt_scenario::take_state(&scenario);
        let clock = ntt_scenario::take_clock(&mut scenario);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        let message_id = wormhole::bytes32::from_u256_be(100);
        let manager_message = ntt_manager_message::new(
            message_id,
            external_address::from_address(user_a),
            native_token_transfer::new(
                ntt_common::trimmed_amount::new(
                    TEST_AMOUNT / 10, // token has 9 decimals
                    8
                ),
                external_address::from_id(object::id(&coin_meta)),
                external_address::from_address(user_b),
                ntt_scenario::chain_id(),
                option::none()
            )
        );

        let manager_message_encoded = ntt_manager_message::map!(manager_message, |x| x.to_bytes());

        let validated_transceiver_message_a = ntt_common::validated_transceiver_message::new(
            &test_transceiver_a::auth(),
            ntt_scenario::peer_chain_id(),
            ntt_common::transceiver_message_data::new(
                ntt_scenario::peer_manager_address(),
                external_address::from_address(object::id_address(&state)),
                manager_message_encoded
            )
        );

        ntt::redeem(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            validated_transceiver_message_a,
            &clock
        );

        // NOTE: transceiver A will vote again. it succeeds, but won't tick the vote count
        let validated_transceiver_message_a = ntt_common::validated_transceiver_message::new(
            &test_transceiver_a::auth(),
            ntt_scenario::peer_chain_id(),
            ntt_common::transceiver_message_data::new(
                ntt_scenario::peer_manager_address(),
                external_address::from_address(object::id_address(&state)),
                manager_message_encoded
            )
        );

        ntt::redeem(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            validated_transceiver_message_a,
            &clock
        );

        ntt::release(
            &mut state,
            upgrades::new_version_gated(),
            ntt_scenario::peer_chain_id(),
            manager_message,
            &coin_meta,
            &clock,
            scenario.ctx()
        );

        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        scenario.end();
    }

    #[test, expected_failure(abort_code = ::ntt::ntt::EWrongDestinationChain)]
    fun test_redeem_wrong_dest_chain() {
        let (_, user_a, user_b, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        let mut state = ntt_scenario::take_state(&scenario);
        let clock = ntt_scenario::take_clock(&mut scenario);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        let message_id = wormhole::bytes32::from_u256_be(100);
        let manager_message = ntt_manager_message::new(
            message_id,
            external_address::from_address(user_a),
            native_token_transfer::new(
                ntt_common::trimmed_amount::new(
                    TEST_AMOUNT / 10, // token has 9 decimals
                    8
                ),
                external_address::from_id(object::id(&coin_meta)),
                external_address::from_address(user_b),
                ntt_scenario::chain_id() + 1, // NOTE: wrong destination chain
                option::none()
            )
        );

        let manager_message_encoded = ntt_manager_message::map!(manager_message, |x| x.to_bytes());

        let validated_transceiver_message_a = ntt_common::validated_transceiver_message::new(
            &test_transceiver_a::auth(),
            ntt_scenario::peer_chain_id(),
            ntt_common::transceiver_message_data::new(
                ntt_scenario::peer_manager_address(),
                external_address::from_address(object::id_address(&state)),
                manager_message_encoded
            )
        );

        ntt::redeem(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            validated_transceiver_message_a,
            &clock
        );

        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        scenario.end();
    }

    #[test, expected_failure(abort_code = ::ntt_common::validated_transceiver_message::EInvalidRecipientManager)]
    fun test_redeem_wrong_recipient_manager() {
        let (_, user_a, user_b, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        let mut state = ntt_scenario::take_state(&scenario);
        let clock = ntt_scenario::take_clock(&mut scenario);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        let message_id = wormhole::bytes32::from_u256_be(100);
        let manager_message = ntt_manager_message::new(
            message_id,
            external_address::from_address(user_a),
            native_token_transfer::new(
                ntt_common::trimmed_amount::new(
                    TEST_AMOUNT / 10, // token has 9 decimals
                    8
                ),
                external_address::from_id(object::id(&coin_meta)),
                external_address::from_address(user_b),
                ntt_scenario::chain_id(),
                option::none()
            )
        );

        let manager_message_encoded = ntt_manager_message::map!(manager_message, |x| x.to_bytes());

        let validated_transceiver_message_a = ntt_common::validated_transceiver_message::new(
            &test_transceiver_a::auth(),
            ntt_scenario::peer_chain_id(),
            ntt_common::transceiver_message_data::new(
                ntt_scenario::peer_manager_address(),
                external_address::from_address(@wormhole), // NOTE: wrong recipient manager
                manager_message_encoded
            )
        );

        ntt::redeem(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            validated_transceiver_message_a,
            &clock
        );

        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        scenario.end();
    }

    #[test, expected_failure(abort_code = ::ntt::state::EPaused)]
    fun test_transfer_when_paused() {
        let (admin, user_a, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(admin);
        ntt_scenario::setup(&mut scenario);

        // Take admin cap and state to pause the contract
        let admin_cap = scenario.take_from_address<state::AdminCap>(admin);
        let mut state = ntt_scenario::take_state(&scenario);

        // Pause the contract
        state::pause(&admin_cap, &mut state);
        assert!(state::is_paused(&state));

        ntt_scenario::return_state(state);
        test_scenario::return_to_address(admin, admin_cap);

        // Switch to user and try to transfer
        scenario.next_tx(user_a);

        let mut state = ntt_scenario::take_state(&scenario);
        let clock = ntt_scenario::take_clock(&mut scenario);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);
        let ntt_coin = state.mint_for_test(TEST_AMOUNT, scenario.ctx());

        let recipient = x"000000000000000000000000000000000000000000000000000000000000dead";
        let (ticket, dust) = ntt::prepare_transfer(
            &state,
            ntt_coin,
            &coin_meta,
            ntt_scenario::peer_chain_id(),
            recipient,
            option::none(),
            false
        );

        // This should fail with EPaused
        ntt::transfer_tx_sender(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            ticket,
            &clock,
            scenario.ctx()
        );

        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        sui::test_utils::destroy(dust);
        scenario.end();
    }

    #[test, expected_failure(abort_code = ::ntt::state::EPaused)]
    fun test_redeem_when_paused() {
        let (admin, user_a, user_b, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(admin);
        ntt_scenario::setup(&mut scenario);

        // Take admin cap and state to pause the contract
        let admin_cap = scenario.take_from_address<state::AdminCap>(admin);
        let mut state = ntt_scenario::take_state(&scenario);

        // Pause the contract
        state::pause(&admin_cap, &mut state);

        ntt_scenario::return_state(state);
        test_scenario::return_to_address(admin, admin_cap);

        // Switch to user and try to redeem
        scenario.next_tx(user_a);

        let mut state = ntt_scenario::take_state(&scenario);
        let clock = ntt_scenario::take_clock(&mut scenario);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        let message_id = wormhole::bytes32::from_u256_be(100);
        let manager_message = ntt_manager_message::new(
            message_id,
            external_address::from_address(user_a),
            native_token_transfer::new(
                ntt_common::trimmed_amount::new(
                    TEST_AMOUNT / 10,
                    8
                ),
                external_address::from_id(object::id(&coin_meta)),
                external_address::from_address(user_b),
                ntt_scenario::chain_id(),
                option::none()
            )
        );

        let manager_message_encoded = ntt_manager_message::map!(manager_message, |x| x.to_bytes());

        let validated_transceiver_message = ntt_common::validated_transceiver_message::new(
            &test_transceiver_a::auth(),
            ntt_scenario::peer_chain_id(),
            ntt_common::transceiver_message_data::new(
                ntt_scenario::peer_manager_address(),
                external_address::from_address(object::id_address(&state)),
                manager_message_encoded
            )
        );

        // This should fail with EPaused
        ntt::redeem(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            validated_transceiver_message,
            &clock
        );

        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        scenario.end();
    }

    #[test]
    fun test_pause_unpause() {
        let (admin, user_a, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(admin);
        ntt_scenario::setup(&mut scenario);

        // Take admin cap and state
        let admin_cap = scenario.take_from_address<state::AdminCap>(admin);
        let mut state = ntt_scenario::take_state(&scenario);

        // Initially not paused
        assert!(!state::is_paused(&state));

        // Pause the contract
        state::pause(&admin_cap, &mut state);
        assert!(state::is_paused(&state));

        // Unpause the contract
        state::unpause(&admin_cap, &mut state);
        assert!(!state::is_paused(&state));

        ntt_scenario::return_state(state);
        test_scenario::return_to_address(admin, admin_cap);

        // After unpause, transfers should work
        scenario.next_tx(user_a);

        let mut state = ntt_scenario::take_state(&scenario);
        let clock = ntt_scenario::take_clock(&mut scenario);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);
        let ntt_coin = state.mint_for_test(TEST_AMOUNT, scenario.ctx());

        let recipient = x"000000000000000000000000000000000000000000000000000000000000dead";
        let (ticket, dust) = ntt::prepare_transfer(
            &state,
            ntt_coin,
            &coin_meta,
            ntt_scenario::peer_chain_id(),
            recipient,
            option::none(),
            false
        );

        // This should succeed after unpause
        ntt::transfer_tx_sender(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            ticket,
            &clock,
            scenario.ctx()
        );

        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        sui::test_utils::destroy(dust);
        scenario.end();
    }

    #[test, expected_failure(abort_code = ::ntt::state::EZeroThreshold)]
    fun test_set_threshold_zero_fails() {
        let (admin, _, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(admin);
        ntt_scenario::setup(&mut scenario);

        let admin_cap = scenario.take_from_address<state::AdminCap>(admin);
        let mut state = ntt_scenario::take_state(&scenario);

        // This should fail with EZeroThreshold
        state::set_threshold(&admin_cap, &mut state, 0);

        ntt_scenario::return_state(state);
        test_scenario::return_to_address(admin, admin_cap);
        scenario.end();
    }

    #[test]
    fun test_disable_transceiver_adjusts_threshold() {
        let (admin, _, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(admin);
        ntt_scenario::setup(&mut scenario);

        let admin_cap = scenario.take_from_address<state::AdminCap>(admin);
        let mut state = ntt_scenario::take_state(&scenario);

        // Setup has 2 transceivers enabled with threshold 2
        assert!(state::threshold(&state) == 2);

        // Disable one transceiver (id 1, the second one)
        state::disable_transceiver(&mut state, &admin_cap, 1);

        // Threshold should be reduced to 1 since we now have only 1 enabled transceiver
        assert!(state::threshold(&state) == 1);

        // Disable the remaining transceiver (id 0)
        state::disable_transceiver(&mut state, &admin_cap, 0);

        // Threshold should be reduced to 0 since we have no enabled transceivers
        assert!(state::threshold(&state) == 0);

        ntt_scenario::return_state(state);
        test_scenario::return_to_address(admin, admin_cap);
        scenario.end();
    }

    #[test]
    fun test_threshold_validation_with_valid_values() {
        let (admin, _, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(admin);
        ntt_scenario::setup(&mut scenario);

        let admin_cap = scenario.take_from_address<state::AdminCap>(admin);
        let mut state = ntt_scenario::take_state(&scenario);

        // Test setting valid threshold values (setup has 2 enabled transceivers)
        state::set_threshold(&admin_cap, &mut state, 1);
        assert!(state::threshold(&state) == 1);

        state::set_threshold(&admin_cap, &mut state, 2); // max for 2 transceivers
        assert!(state::threshold(&state) == 2);

        ntt_scenario::return_state(state);
        test_scenario::return_to_address(admin, admin_cap);
        scenario.end();
    }

    #[test, expected_failure(abort_code = ::ntt::state::EThresholdTooHigh)]
    fun test_set_threshold_too_high_fails() {
        let (admin, _, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(admin);
        ntt_scenario::setup(&mut scenario);

        let admin_cap = scenario.take_from_address<state::AdminCap>(admin);
        let mut state = ntt_scenario::take_state(&scenario);

        // Setup has 2 enabled transceivers, so threshold > 2 should fail
        state::set_threshold(&admin_cap, &mut state, 3);

        ntt_scenario::return_state(state);
        test_scenario::return_to_address(admin, admin_cap);
        scenario.end();
    }
}
