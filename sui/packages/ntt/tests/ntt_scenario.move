#[test_only]
/// This module implements ways to initialize NTT in a test scenario.
/// It provides common setup functions and test utilities.
module ntt::ntt_scenario {
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::coin::{Self, CoinMetadata};
    use sui::clock::{Self, Clock};
    use wormhole::external_address::{Self, ExternalAddress};
    use wormhole::bytes32;
    use ntt::state::{Self, State, AdminCap};
    use ntt::mode;
    use ntt_common::trimmed_amount;
    use ntt_common::native_token_transfer::{Self, NativeTokenTransfer};
    use ntt_common::ntt_manager_message::{Self, NttManagerMessage};

    // Test addresses
    const ADMIN: address = @0x1111;
    const USER_A: address = @0xAAAA;
    const USER_B: address = @0xBBBB;
    const USER_C: address = @0xCCCC;

    // Test constants
    const CHAIN_ID: u16 = 1;
    const PEER_CHAIN_ID: u16 = 2;
    const DECIMALS: u8 = 9;
    const RATE_LIMIT: u64 = 5000000000; // 5 tokens with 9 decimals
    const THRESHOLD: u8 = 2;

    public fun chain_id(): u16 {
        CHAIN_ID
    }

    public fun peer_chain_id(): u16 {
        PEER_CHAIN_ID
    }

    public fun peer_manager_address(): ExternalAddress {
        external_address::new(bytes32::from_bytes(x"0000000000000000000000000000000000000000000000000000000000000001"))
    }

    public fun decimals(): u8 {
        DECIMALS
    }

    // Test helper structs
    public struct NTT_SCENARIO has drop {}

    /// Set up a basic NTT test environment with:
    /// - Test coin with treasury cap
    /// - NTT state in burning mode
    /// - Two registered transceivers
    /// - One peer chain
    /// - Clock for rate limiting
    /// TODO: create a locking mode test
    public fun setup(scenario: &mut Scenario) {
        let sender = scenario.sender();
        scenario.next_tx(ADMIN);

        // Create test coin
        let (treasury_cap, metadata) = coin::create_currency(
            NTT_SCENARIO {},
            DECIMALS,
            b"TEST",
            b"Test Coin",
            b"A test coin for NTT",
            option::none(),
            ts::ctx(scenario)
        );

        // Initialize NTT state
        let (mut state, admin_cap) = state::new(
            CHAIN_ID,
            mode::burning(),
            option::some(treasury_cap),
            object::id_from_address(@0x10), // dummy upgrade cap ID
            ts::ctx(scenario)
        );

        let id1 = object::id_from_address(@0x100);
        let id2 = object::id_from_address(@0x101);

        // Register transceivers
        state::register_transceiver<ntt::test_transceiver_a::TransceiverAuth, _>(&mut state, id1, &admin_cap);
        assert!(state.threshold() == 1, 0); // ensure threshold is set to 1

        state::register_transceiver<ntt::test_transceiver_b::TransceiverAuth, _>(&mut state, id2, &admin_cap);
        assert!(state.threshold() == 1, 0); // ensure threshold is still 1

        // Create clock for rate limiting
        let clock = take_clock(scenario);

        // Set up a test peer
        let peer_address = peer_manager_address();
        state::set_peer(&admin_cap, &mut state, PEER_CHAIN_ID, peer_address, DECIMALS, RATE_LIMIT, &clock);

        // Set threshold
        state::set_threshold(&admin_cap, &mut state, THRESHOLD);

        // Transfer objects to shared storage
        transfer::public_share_object(state);
        transfer::public_transfer(admin_cap, ADMIN);
        return_clock(clock);
        transfer::public_share_object(metadata);
        scenario.next_tx(sender);
    }

    /// Helper function to create a test transfer message
    public fun create_test_message(
        amount: u64,
        recipient: vector<u8>,
        sequence: u64
    ): NttManagerMessage<NativeTokenTransfer> {
        let trimmed_amount = trimmed_amount::trim(amount, DECIMALS, DECIMALS);
        let recipient_addr = external_address::new(bytes32::from_bytes(recipient));
        let source_token = external_address::new(bytes32::from_bytes(x"0000000000000000000000000000000000000000000000000000000000000002"));

        let transfer = native_token_transfer::new(
            trimmed_amount,
            source_token,
            recipient_addr,
            CHAIN_ID,
            option::none()
        );

        let sender = external_address::new(bytes32::from_bytes(x"0000000000000000000000000000000000000000000000000000000000000003"));
        let id = bytes32::from_u256_be((sequence as u256));

        ntt_manager_message::new(id, sender, transfer)
    }

    /// Helper function to take NTT state from scenario
    public fun take_state(scenario: &Scenario): State<NTT_SCENARIO> {
        ts::take_shared(scenario)
    }

    /// Helper function to return NTT state to scenario
    public fun return_state(state: State<NTT_SCENARIO>) {
        ts::return_shared(state);
    }

    /// Helper function to take admin cap from scenario
    public fun take_admin_cap(scenario: &Scenario): AdminCap {
        ts::take_from_address<AdminCap>(scenario, ADMIN)
    }

    /// Helper function to return admin cap to scenario
    public fun return_admin_cap(cap: AdminCap) {
        transfer::public_transfer(cap, ADMIN);
    }

    public fun take_coin_metadata(scenario: &Scenario): CoinMetadata<NTT_SCENARIO> {
        ts::take_shared(scenario)
    }

    public fun return_coin_metadata(metadata: CoinMetadata<NTT_SCENARIO>) {
        ts::return_shared(metadata);
    }

    /// Helper function to take clock from scenario
    public fun take_clock(scenario: &mut Scenario): Clock {
        clock::create_for_testing(ts::ctx(scenario))
    }

    public fun return_clock(clock: Clock) {
        clock::destroy_for_testing(clock)
    }

    /// Helper function to get test addresses
    public fun test_addresses(): (address, address, address, address) {
        (ADMIN, USER_A, USER_B, USER_C)
    }
}

#[test_only]
module ntt::test_transceiver_a {
    public struct TransceiverAuth has drop {}

    public fun auth(): TransceiverAuth {
        TransceiverAuth {}
    }
}

#[test_only]
module ntt::test_transceiver_b {
    public struct TransceiverAuth has drop {}

    public fun auth(): TransceiverAuth {
        TransceiverAuth {}
    }
}

#[test_only]
module ntt::test_transceiver_c {
    public struct TransceiverAuth has drop {}

    public fun auth(): TransceiverAuth {
        TransceiverAuth {}
    }
}
