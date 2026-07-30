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
        std::unit_test::destroy(dust);
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

        std::unit_test::destroy(transceiver_a_message);

        // this will fail, because transceiver a already released the message
        let transceiver_a_message = state.create_transceiver_message<test_transceiver_a::TransceiverAuth, _>(
            message_id,
            &clock
        );
        std::unit_test::destroy(transceiver_a_message);

        // Clean up
        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        std::unit_test::destroy(dust);
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
        std::unit_test::destroy(coins);
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
        std::unit_test::destroy(dust);
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
        std::unit_test::destroy(dust);
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


    #[test]
    fun test_transfer_with_refill() {
        let (_, user_a, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        scenario.next_tx(user_a);

        // Take state and clock
        let mut state = ntt_scenario::take_state(&scenario);
        let mut clock = ntt_scenario::take_clock(&mut scenario);
        clock.increment_for_testing(1_000);

        // Drain limit for the rate limit refill 
        let drain: u64 = 2_000_000_000; //
        let result = state.borrow_peer_mut(ntt_scenario::peer_chain_id())
            .borrow_inbound_rate_limit_mut()
            .consume_or_delay(&clock, drain);
        assert!(result.is_consumed()); // sanity: drain < limit (5e9), so consumed

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

        let outbound_capacity = state.borrow_outbox_mut().borrow_rate_limit_mut(); 
        let outbound_limit_before = outbound_capacity.limit();
        let outbound_capacity_before = outbound_capacity.capacity_at_last_tx();
        let outbound_last_tx_timestamp_before = outbound_capacity.last_tx_timestamp();

        let inbound =
            state.borrow_peer_mut(ntt_scenario::peer_chain_id())
                .borrow_inbound_rate_limit_mut();

        let inbound_limit_before       = inbound.limit();
        let inbound_capacity_before    = inbound.capacity_at_last_tx();
        
        // Execute transfer
        let outbox_key = ntt::transfer_tx_sender(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            ticket,
            &clock,
            scenario.ctx()
        );

        // Rate limit data after the transfer
        let outbound_capacity = state.borrow_outbox_mut().borrow_rate_limit_mut(); 
        let outbound_limit_after = outbound_capacity.limit();
        let outbound_capacity_after = outbound_capacity.capacity_at_last_tx();
        let outbound_last_tx_timestamp_after = outbound_capacity.last_tx_timestamp();

        let inbound =
            state.borrow_peer_mut(ntt_scenario::peer_chain_id())
                .borrow_inbound_rate_limit_mut();

        let inbound_limit_after       = inbound.limit();
        let inbound_capacity_after    = inbound.capacity_at_last_tx();
        let inbound_last_tx_after     = inbound.last_tx_timestamp();

        // Outbound and inbound rate limit comparisons
        assert!(outbound_limit_after == outbound_limit_before);   
        assert!(outbound_last_tx_timestamp_after > outbound_last_tx_timestamp_before);             
        assert!(outbound_last_tx_timestamp_after == clock.timestamp_ms());      
        assert!(outbound_capacity_after == (outbound_capacity_before) - (TEST_AMOUNT - TEST_DUST));  
        assert!(inbound_limit_after == inbound_limit_before);               
        assert!(inbound_last_tx_after == clock.timestamp_ms());      
        assert!(inbound_capacity_after == (inbound_capacity_before) + (TEST_AMOUNT - TEST_DUST));  

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

        // Advance past the 24h queue delay so the item becomes releasable.
        clock.increment_for_testing(86_400_000);

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
        std::unit_test::destroy(dust);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_transfer_queued_released_after_delay() {
        let (_, user_a, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        scenario.next_tx(user_a);

        // Take state, adminCap, and clock
        let mut state = ntt_scenario::take_state(&scenario);
        let admin_cap = ntt_scenario::take_admin_cap(&scenario);
        let mut clock = ntt_scenario::take_clock(&mut scenario);
        clock.increment_for_testing(1_000);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        // Set the rate limit
        let limit: u64 = 1;
        state::set_outbound_rate_limit(&admin_cap, &mut state, limit, &clock); 

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
            true // should_queue
        );

        // Rate limit information before the transfer
        let outbound_capacity = state.borrow_outbox_mut().borrow_rate_limit_mut(); 
        let outbound_limit_before = outbound_capacity.limit();
        let outbound_capacity_before = outbound_capacity.capacity_at_last_tx();
        let outbound_last_tx_timestamp_before = outbound_capacity.last_tx_timestamp();

        let inbound =
            state.borrow_peer_mut(ntt_scenario::peer_chain_id())
                .borrow_inbound_rate_limit_mut();

        let inbound_limit_before       = inbound.limit();
        let inbound_capacity_before    = inbound.capacity_at_last_tx();
        let inbound_last_tx_before     = inbound.last_tx_timestamp();

        // Execute transfer but with a later timestamp
        let outbox_key = ntt::transfer_tx_sender(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            ticket,
            &clock,
            scenario.ctx()
        );

        // Rate limit data after the transfer
        let outbound_capacity = state.borrow_outbox_mut().borrow_rate_limit_mut(); 
        let outbound_limit_after = outbound_capacity.limit();
        let outbound_capacity_after = outbound_capacity.capacity_at_last_tx();
        let outbound_last_tx_timestamp_after = outbound_capacity.last_tx_timestamp();

        let inbound =
            state.borrow_peer_mut(ntt_scenario::peer_chain_id())
                .borrow_inbound_rate_limit_mut();

        let inbound_limit_after       = inbound.limit();
        let inbound_capacity_after    = inbound.capacity_at_last_tx();
        let inbound_last_tx_after     = inbound.last_tx_timestamp();

        // Outbound and inbound rate limit comparisons
        assert!(outbound_limit_after == outbound_limit_before);   
        assert!(outbound_last_tx_timestamp_after == outbound_last_tx_timestamp_before);             
        assert!(outbound_capacity_after == outbound_capacity_before);  
        assert!(inbound_limit_after == inbound_limit_before);               
        assert!(inbound_last_tx_after == inbound_last_tx_before);             
        assert!(inbound_capacity_after == inbound_capacity_before);  

        // queued transfer at clock t: release is now + RATE_LIMIT_DURATION (24h)=
        let release_timestamp = state.borrow_outbox().borrow(outbox_key).borrow_release_timestamp();
        assert!(release_timestamp == clock.timestamp_ms() + 86_400_000);

        let message = *state.borrow_outbox().borrow(outbox_key).borrow_data();

        // Verify it's the transfer we expect.
        let (message_id, _sender, transfer) = message.destruct();
        let (trimmed_amount, _src_token, recipient_addr, to_chain, _payload) = transfer.destruct();
        assert!(trimmed_amount.untrim(ntt_scenario::decimals()) == TEST_AMOUNT - TEST_DUST);
        assert!(to_chain == ntt_scenario::peer_chain_id());
        assert!(recipient_addr.to_bytes() == recipient);

        // Advance past the 24h queue delay so the item becomes releasable.
        clock.increment_for_testing(86_400_000);

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
        ntt_scenario::return_admin_cap(admin_cap);
        std::unit_test::destroy(dust);
        test_scenario::end(scenario);
    }

     #[test, expected_failure(abort_code = ::ntt::ntt::ETransferExceedsRateLimit)]
    fun test_transfer_exceeds_rate_limit_no_queue() {
        let (_, user_a, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        scenario.next_tx(user_a);

        // Take state, adminCap, and clock
        let mut state = ntt_scenario::take_state(&scenario);
        let admin_cap = ntt_scenario::take_admin_cap(&scenario);
        let mut clock = ntt_scenario::take_clock(&mut scenario);
        clock.increment_for_testing(1_000);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        // Set the rate limit
        let limit: u64 = 1;
        state::set_outbound_rate_limit(&admin_cap, &mut state, limit, &clock); 

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

        // Execute transfer but with a later timestamp
        let _outbox_key = ntt::transfer_tx_sender(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            ticket,
            &clock,
            scenario.ctx()
        );

        // Clean up
        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        ntt_scenario::return_admin_cap(admin_cap);
        std::unit_test::destroy(dust);
        test_scenario::end(scenario);

    }
    #[test, expected_failure]
    fun test_transfer_queued_release_too_early() {
        let (_, user_a, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        scenario.next_tx(user_a);

        // Take state, adminCap, and clock
        let mut state = ntt_scenario::take_state(&scenario);
        let admin_cap = ntt_scenario::take_admin_cap(&scenario);
        let mut clock = ntt_scenario::take_clock(&mut scenario);
        clock.increment_for_testing(1_000);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        // Set the rate limit
        let limit: u64 = 1;
        state::set_outbound_rate_limit(&admin_cap, &mut state, limit, &clock); 

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
            true // should_queue
        );

        // Rate limit information before the transfer
        let outbound_capacity = state.borrow_outbox_mut().borrow_rate_limit_mut(); 
        let outbound_limit_before = outbound_capacity.limit();
        let outbound_capacity_before = outbound_capacity.capacity_at_last_tx();
        let outbound_last_tx_timestamp_before = outbound_capacity.last_tx_timestamp();

        let inbound =
            state.borrow_peer_mut(ntt_scenario::peer_chain_id())
                .borrow_inbound_rate_limit_mut();

        let inbound_limit_before       = inbound.limit();
        let inbound_capacity_before    = inbound.capacity_at_last_tx();
        let inbound_last_tx_before     = inbound.last_tx_timestamp();

        // Execute transfer but with a later timestamp
        let outbox_key = ntt::transfer_tx_sender(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            ticket,
            &clock,
            scenario.ctx()
        );

        // Rate limit data after the transfer
        let outbound_capacity = state.borrow_outbox_mut().borrow_rate_limit_mut(); 
        let outbound_limit_after = outbound_capacity.limit();
        let outbound_capacity_after = outbound_capacity.capacity_at_last_tx();
        let outbound_last_tx_timestamp_after = outbound_capacity.last_tx_timestamp();

        let inbound =
            state.borrow_peer_mut(ntt_scenario::peer_chain_id())
                .borrow_inbound_rate_limit_mut();

        let inbound_limit_after       = inbound.limit();
        let inbound_capacity_after    = inbound.capacity_at_last_tx();
        let inbound_last_tx_after     = inbound.last_tx_timestamp();

        // Outbound and inbound rate limit comparisons
        assert!(outbound_limit_after == outbound_limit_before);   
        assert!(outbound_last_tx_timestamp_after == outbound_last_tx_timestamp_before);             
        assert!(outbound_capacity_after == outbound_capacity_before);  
        assert!(inbound_limit_after == inbound_limit_before);               
        assert!(inbound_last_tx_after == inbound_last_tx_before);             
        assert!(inbound_capacity_after == inbound_capacity_before);  

        // queued transfer at clock t: release is now + RATE_LIMIT_DURATION (24h)=
        let release_timestamp = state.borrow_outbox().borrow(outbox_key).borrow_release_timestamp();
        assert!(release_timestamp == clock.timestamp_ms() + 86_400_000);

        let message = *state.borrow_outbox().borrow(outbox_key).borrow_data();

        // Verify it's the transfer we expect.
        let (message_id, _sender, transfer) = message.destruct();
        let (trimmed_amount, _src_token, recipient_addr, to_chain, _payload) = transfer.destruct();
        assert!(trimmed_amount.untrim(ntt_scenario::decimals()) == TEST_AMOUNT - TEST_DUST);
        assert!(to_chain == ntt_scenario::peer_chain_id());
        assert!(recipient_addr.to_bytes() == recipient);

        // DO NOT advance past the 24h queue delay. Don't want this to be releasable. 
        // Fails here
        let transceiver_a_message = state.create_transceiver_message<test_transceiver_a::TransceiverAuth, _>(
            message_id,
            &clock
        );

        // Clean up
        std::unit_test::destroy(transceiver_a_message);
        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        ntt_scenario::return_admin_cap(admin_cap);
        std::unit_test::destroy(dust);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_transfer_queued_rate_limit_unchanged() {
        let (_, user_a, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        scenario.next_tx(user_a);

        // Take state, adminCap, and clock
        let mut state = ntt_scenario::take_state(&scenario);
        let admin_cap = ntt_scenario::take_admin_cap(&scenario);
        let mut clock = ntt_scenario::take_clock(&mut scenario);
        clock.increment_for_testing(1_000);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        // Set the rate limit
        let limit: u64 = 1;
        state::set_outbound_rate_limit(&admin_cap, &mut state, limit, &clock); 

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
            true // should_queue
        );

        // Rate limit information before the transfer
        let outbound_capacity = state.borrow_outbox_mut().borrow_rate_limit_mut(); 
        let outbound_limit_before = outbound_capacity.limit();
        let outbound_capacity_before = outbound_capacity.capacity_at_last_tx();

        let inbound =
            state.borrow_peer_mut(ntt_scenario::peer_chain_id())
                .borrow_inbound_rate_limit_mut();

        let inbound_limit_before       = inbound.limit();
        let inbound_capacity_before    = inbound.capacity_at_last_tx();
        let inbound_last_tx_before     = inbound.last_tx_timestamp();

        // Execute transfer but with a later timestamp
        let outbox_key = ntt::transfer_tx_sender(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            ticket,
            &clock,
            scenario.ctx()
        );

        // Rate limit data after the transfer
        let outbound_capacity = state.borrow_outbox_mut().borrow_rate_limit_mut(); 
        let outbound_limit_after = outbound_capacity.limit();
        let outbound_capacity_after = outbound_capacity.capacity_at_last_tx();

        let inbound =
            state.borrow_peer_mut(ntt_scenario::peer_chain_id())
                .borrow_inbound_rate_limit_mut();

        let inbound_limit_after       = inbound.limit();
        let inbound_capacity_after    = inbound.capacity_at_last_tx();
        let inbound_last_tx_after     = inbound.last_tx_timestamp();

        // Outbound and inbound rate limit comparisons
        assert!(outbound_limit_after == outbound_limit_before);   
        assert!(outbound_capacity_after == outbound_capacity_before);  
        assert!(inbound_limit_after == inbound_limit_before);               
        assert!(inbound_last_tx_after == inbound_last_tx_before);             
        assert!(inbound_capacity_after == inbound_capacity_before);  

        // queued transfer at clock t: release is now + RATE_LIMIT_DURATION (24h)=
        let release_timestamp = state.borrow_outbox().borrow(outbox_key).borrow_release_timestamp();
        assert!(release_timestamp == clock.timestamp_ms() + 86_400_000);

        let message = *state.borrow_outbox().borrow(outbox_key).borrow_data();

        // Verify it's the transfer we expect.
        let (_message_id, _sender, transfer) = message.destruct();
        let (trimmed_amount, _src_token, recipient_addr, to_chain, _payload) = transfer.destruct();
        assert!(trimmed_amount.untrim(ntt_scenario::decimals()) == TEST_AMOUNT - TEST_DUST);
        assert!(to_chain == ntt_scenario::peer_chain_id());
        assert!(recipient_addr.to_bytes() == recipient);

    
        // Clean up
        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        ntt_scenario::return_admin_cap(admin_cap);
        std::unit_test::destroy(dust);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_transfer_rate_limit_timestamps() {
        let (_, user_a, _, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        scenario.next_tx(user_a);

        // Take state, adminCap, and clock
        let mut state = ntt_scenario::take_state(&scenario);
        let admin_cap = ntt_scenario::take_admin_cap(&scenario);
        let mut clock = ntt_scenario::take_clock(&mut scenario);
        clock.increment_for_testing(1_000);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        let coins = state.mint_for_test(TEST_AMOUNT, scenario.ctx());

        // Increase time
        clock.increment_for_testing(1_000);

        // Create transfer ticket
        let recipient = x"000000000000000000000000000000000000000000000000000000000000dead";
        let (ticket, dust) = ntt::prepare_transfer(
            &state,
            coins,
            &coin_meta,
            ntt_scenario::peer_chain_id(), // recipient_chain
            recipient,
            option::none(),
            true // should_queue
        );

        // Rate limit information before the transfer
        let outbound_capacity = state.borrow_outbox_mut().borrow_rate_limit_mut(); 
        let outbound_last_tx_before = outbound_capacity.last_tx_timestamp();

        let inbound =
            state.borrow_peer_mut(ntt_scenario::peer_chain_id())
                .borrow_inbound_rate_limit_mut();

        let inbound_last_tx_before     = inbound.last_tx_timestamp();

        // Execute transfer but with a later timestamp
        let outbox_key = ntt::transfer_tx_sender(
            &mut state,
            upgrades::new_version_gated(),
            &coin_meta,
            ticket,
            &clock,
            scenario.ctx()
        );

        // Rate limit data after the transfer
        let outbound_capacity = state.borrow_outbox_mut().borrow_rate_limit_mut(); 
        let outbound_last_tx_after = outbound_capacity.last_tx_timestamp();

        let inbound =
            state.borrow_peer_mut(ntt_scenario::peer_chain_id())
                .borrow_inbound_rate_limit_mut();

        let inbound_last_tx_after     = inbound.last_tx_timestamp();

        // The transfer records the current clock time as last_tx_timestamp for
        // both the inbound and outbound rate limiters. The clock is not advanced
        // between the snapshots, so `before + time == after` holds exactly.
        let time = clock.timestamp_ms();

        // Both limiters started at 0 (set during setup at clock time 0).
        assert!(inbound_last_tx_before == 0);
        assert!(outbound_last_tx_before == 0);

        // Inbound and outbound timestamps advance to exactly the transfer time.
        assert!(inbound_last_tx_after == inbound_last_tx_before + time);
        assert!(outbound_last_tx_after == outbound_last_tx_before + time);

        // Both limiters are updated to the same timestamp.
        assert!(outbound_last_tx_after == inbound_last_tx_after);

        let message = *state.borrow_outbox().borrow(outbox_key).borrow_data();

        // Verify it's the transfer we expect.
        let (_message_id, _sender, transfer) = message.destruct();
        let (trimmed_amount, _src_token, recipient_addr, to_chain, _payload) = transfer.destruct();
        assert!(trimmed_amount.untrim(ntt_scenario::decimals()) == TEST_AMOUNT - TEST_DUST);
        assert!(to_chain == ntt_scenario::peer_chain_id());
        assert!(recipient_addr.to_bytes() == recipient);

    
        // Clean up
        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        ntt_scenario::return_admin_cap(admin_cap);
        std::unit_test::destroy(dust);
        test_scenario::end(scenario);
    }

    #[test]
    fun test_redeem_queued() {
        let (_, user_a, user_b, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        // Take state, adminCap, and clock
        let mut state = ntt_scenario::take_state(&scenario);
        let admin_cap = ntt_scenario::take_admin_cap(&scenario);
        let mut clock = ntt_scenario::take_clock(&mut scenario);
        clock.increment_for_testing(1_000);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        // Set the rate limit
        // set_peer performs a rate limit update if called in this way
        let low_inbound_limit: u64 = 1; 
        state::set_peer(
            &admin_cap,
            &mut state,
            ntt_scenario::peer_chain_id(),   
            ntt_scenario::peer_manager_address(), 
            ntt_scenario::decimals(),
            low_inbound_limit,
            &clock,
        );

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

        let inbox_item = state::borrow_inbox_item(&state, ntt_scenario::peer_chain_id(), manager_message);

        // Both transceivers voted, and the low inbound limit forced the transfer
        // into the delayed-release queue (24h from the redeem timestamp).
        assert!(inbox_item.count_votes() == 2);
        assert!(inbox_item.is_release_after());
        assert!(!inbox_item.is_released());
        assert!(inbox_item.release_after_timestamp() == clock.timestamp_ms() + 86_400_000);

        // Wait out the queue delay, then complete it:
        clock.increment_for_testing(86_400_000);
        ntt::release(
            &mut state,
            upgrades::new_version_gated(),
            ntt_scenario::peer_chain_id(),
            manager_message,
            &coin_meta,
            &clock,
            scenario.ctx()
        );

        let inbox_item = state::borrow_inbox_item(&state, ntt_scenario::peer_chain_id(), manager_message);
        assert!(inbox_item.is_released());

        scenario.next_tx(user_a);

        let coins = scenario.take_from_address<Coin<ntt_scenario::NTT_SCENARIO>>(user_b);

        assert!(coins.value() == TEST_AMOUNT - TEST_DUST);

        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        ntt_scenario::return_admin_cap(admin_cap);
        std::unit_test::destroy(coins);
        scenario.end();
    }

    #[test]
    fun test_redeem_rate_limit_values() {
        let (_, user_a, user_b, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        // Take state, adminCap, and clock
        let mut state = ntt_scenario::take_state(&scenario);
        let admin_cap = ntt_scenario::take_admin_cap(&scenario);
        let mut clock = ntt_scenario::take_clock(&mut scenario);
        clock.increment_for_testing(1_000);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        // Drain outbox limit to test backflow
        let drain: u64 = 2_000_000_000; 
        let r = state.borrow_outbox_mut().borrow_rate_limit_mut().consume_or_delay(&clock, drain);
        assert!(r.is_consumed());

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

        let validated_transceiver_message_b = ntt_common::validated_transceiver_message::new(
            &test_transceiver_b::auth(),
            ntt_scenario::peer_chain_id(),
            ntt_common::transceiver_message_data::new(
                ntt_scenario::peer_manager_address(),
                external_address::from_address(object::id_address(&state)),
                manager_message_encoded
            )
        );

        let outbound_capacity = state.borrow_outbox_mut().borrow_rate_limit_mut(); 
        let outbound_limit_before = outbound_capacity.limit();
        let outbound_capacity_before = outbound_capacity.capacity_at_last_tx();

        let inbound =
            state.borrow_peer_mut(ntt_scenario::peer_chain_id())
                .borrow_inbound_rate_limit_mut();

        let inbound_limit_before       = inbound.limit();
        let inbound_capacity_before    = inbound.capacity_at_last_tx();

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

        let outbound_capacity = state.borrow_outbox_mut().borrow_rate_limit_mut(); 
        let outbound_limit_after = outbound_capacity.limit();
        let outbound_capacity_after = outbound_capacity.capacity_at_last_tx();

        let inbound =
            state.borrow_peer_mut(ntt_scenario::peer_chain_id())
                .borrow_inbound_rate_limit_mut();

        let inbound_limit_after       = inbound.limit();
        let inbound_capacity_after    = inbound.capacity_at_last_tx();

        // Rate limit validations
        assert!(inbound_limit_after == inbound_limit_before);
        assert!(outbound_limit_after == outbound_limit_before);
        assert!(outbound_capacity_after == (outbound_capacity_before + (TEST_AMOUNT - TEST_DUST)));
        assert!(inbound_capacity_after == (inbound_capacity_before - (TEST_AMOUNT - TEST_DUST)));

        scenario.next_tx(user_a);

        let coins = scenario.take_from_address<Coin<ntt_scenario::NTT_SCENARIO>>(user_b);

        assert!(coins.value() == TEST_AMOUNT - TEST_DUST);

        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        ntt_scenario::return_admin_cap(admin_cap);
        std::unit_test::destroy(coins);
        scenario.end();
    }

    #[test]
    fun test_redeem_rate_limit_timestamps() {
        let (_, user_a, user_b, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        // Take state, adminCap, and clock
        let mut state = ntt_scenario::take_state(&scenario);
        let admin_cap = ntt_scenario::take_admin_cap(&scenario);
        let mut clock = ntt_scenario::take_clock(&mut scenario);
        clock.increment_for_testing(1_000);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        // Drain outbox limit to test backflow
        let drain: u64 = 2_000_000_000; 
        let r = state.borrow_outbox_mut().borrow_rate_limit_mut().consume_or_delay(&clock, drain);
        assert!(r.is_consumed());

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

        let validated_transceiver_message_b = ntt_common::validated_transceiver_message::new(
            &test_transceiver_b::auth(),
            ntt_scenario::peer_chain_id(),
            ntt_common::transceiver_message_data::new(
                ntt_scenario::peer_manager_address(),
                external_address::from_address(object::id_address(&state)),
                manager_message_encoded
            )
        );

        let outbound_capacity = state.borrow_outbox_mut().borrow_rate_limit_mut(); 
        let outbound_last_tx_timestamp_before = outbound_capacity.last_tx_timestamp();

        let inbound =
            state.borrow_peer_mut(ntt_scenario::peer_chain_id())
                .borrow_inbound_rate_limit_mut();

        let inbound_last_tx_timestamp_before    = inbound.last_tx_timestamp();

        // Increment the clock for the transfer
        let time_increase = 500; 
        clock.increment_for_testing(time_increase);

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

        let outbound_capacity = state.borrow_outbox_mut().borrow_rate_limit_mut(); 
        let outbound_last_tx_timestamp_after = outbound_capacity.last_tx_timestamp();

        let inbound =
            state.borrow_peer_mut(ntt_scenario::peer_chain_id())
                .borrow_inbound_rate_limit_mut();

        let inbound_last_tx_timestamp_after    = inbound.last_tx_timestamp();

        // Ensure that the inbound, and outbound last_tx_timestamp value was updated
        assert!(inbound_last_tx_timestamp_after == clock.timestamp_ms());
        assert!(inbound_last_tx_timestamp_after > inbound_last_tx_timestamp_before);
        assert!(outbound_last_tx_timestamp_after == clock.timestamp_ms());
        assert!(outbound_last_tx_timestamp_after > outbound_last_tx_timestamp_before);

        scenario.next_tx(user_a);

        let coins = scenario.take_from_address<Coin<ntt_scenario::NTT_SCENARIO>>(user_b);

        assert!(coins.value() == TEST_AMOUNT - TEST_DUST);

        ntt_scenario::return_state(state);
        ntt_scenario::return_clock(clock);
        ntt_scenario::return_coin_metadata(coin_meta);
        ntt_scenario::return_admin_cap(admin_cap);
        std::unit_test::destroy(coins);
        scenario.end();
    }

    #[test, expected_failure(abort_code = ::ntt::ntt::ECantReleaseYet)]
    fun test_redeem_queued_release_too_early() {
        let (_, user_a, user_b, _) = ntt_scenario::test_addresses();
        let mut scenario = test_scenario::begin(user_a);
        ntt_scenario::setup(&mut scenario);

        // Take state, adminCap, and clock
        let mut state = ntt_scenario::take_state(&scenario);
        let admin_cap = ntt_scenario::take_admin_cap(&scenario);
        let mut clock = ntt_scenario::take_clock(&mut scenario);
        clock.increment_for_testing(1_000);
        let coin_meta = ntt_scenario::take_coin_metadata(&scenario);

        // Set the rate limit
        // set_peer performs a rate limit update if called in this way
        let low_inbound_limit: u64 = 1; 
        state::set_peer(
            &admin_cap,
            &mut state,
            ntt_scenario::peer_chain_id(),   
            ntt_scenario::peer_manager_address(), 
            ntt_scenario::decimals(),
            low_inbound_limit,
            &clock,
        );

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

        // DON'T wait out the queue delay. Fail if withdrawn too early.
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
        ntt_scenario::return_admin_cap(admin_cap);
        scenario.end();
    }

}
