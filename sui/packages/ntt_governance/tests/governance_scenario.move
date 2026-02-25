#[test_only]
/// Test scenario helpers for the NTT governance package.
/// Sets up both NTT state and governance state for integration testing.
#[allow(deprecated_usage)]
module ntt_governance::governance_scenario {
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::coin::{Self, CoinMetadata};
    use sui::clock::{Self, Clock};
    use wormhole::bytes32;
    use wormhole::external_address::{Self, ExternalAddress};
    use ntt::state::{State, AdminCap};
    use ntt::upgrades;
    use ntt_governance::governance::{Self, GovernanceState};

    const ADMIN: address = @0x1111;
    const CHAIN_ID: u16 = 1;
    const PEER_CHAIN_ID: u16 = 2;
    const DECIMALS: u8 = 9;
    const RATE_LIMIT: u64 = 5_000_000_000; // 5 tokens with 9 decimals

    public struct GOVERNANCE_SCENARIO has drop {}

    public fun admin(): address { ADMIN }
    public fun chain_id(): u16 { CHAIN_ID }
    public fun peer_chain_id(): u16 { PEER_CHAIN_ID }
    public fun decimals(): u8 { DECIMALS }
    public fun rate_limit(): u64 { RATE_LIMIT }

    public fun peer_address(): ExternalAddress {
        external_address::new(bytes32::from_bytes(
            x"0000000000000000000000000000000000000000000000000000000000000001",
        ))
    }

    /// Set up a complete governance test environment.
    /// Builds on `setup_empty`, then moves caps from ADMIN into governance.
    ///
    /// After setup, the following shared objects are available:
    /// - `State<GOVERNANCE_SCENARIO>` (NTT state)
    /// - `GovernanceState` (with AdminCap and UpgradeCap)
    /// - `CoinMetadata<GOVERNANCE_SCENARIO>`
    public fun setup(scenario: &mut Scenario) {
        setup_empty(scenario);

        // Move caps from ADMIN into governance
        let admin_cap = scenario.take_from_sender<AdminCap>();
        let upgrade_cap = scenario.take_from_sender<upgrades::UpgradeCap>();
        let mut gov: GovernanceState = ts::take_shared(scenario);
        governance::test_add_caps(&mut gov, admin_cap, upgrade_cap);
        ts::return_shared(gov);

        scenario.next_tx(ADMIN);
    }

    /// Set up an empty governance state (for handoff testing).
    /// Also sets up NTT state. The GovernanceState has no caps.
    ///
    /// After setup, the following shared objects are available:
    /// - `State<GOVERNANCE_SCENARIO>` (NTT state)
    /// - `GovernanceState` (empty, no caps)
    /// - `CoinMetadata<GOVERNANCE_SCENARIO>`
    /// And the following are owned by ADMIN:
    /// - `AdminCap`
    /// - `ntt::upgrades::UpgradeCap`
    public fun setup_empty(scenario: &mut Scenario) {
        // Transaction 1: init both packages
        scenario.next_tx(ADMIN);
        ntt::setup::init_test_only(ts::ctx(scenario));
        governance::create_test_only(ts::ctx(scenario));

        // Transaction 2: complete NTT setup (gov already shared from create_test_only)
        scenario.next_tx(ADMIN);

        let ntt_deployer = ts::take_from_sender<ntt::setup::DeployerCap>(scenario);
        let upgrade_cap = ts::take_from_sender<sui::package::UpgradeCap>(scenario);

        let (treasury_cap, metadata) = coin::create_currency(
            GOVERNANCE_SCENARIO {},
            DECIMALS,
            b"GTEST",
            b"Gov Test Coin",
            b"",
            option::none(),
            ts::ctx(scenario),
        );

        let (admin_cap, ntt_upgrade_cap) = ntt::setup::complete_burning(
            ntt_deployer,
            upgrade_cap,
            CHAIN_ID,
            treasury_cap,
            ts::ctx(scenario),
        );

        // Transfer caps to sender (they'll be used in later transactions)
        transfer::public_transfer(admin_cap, ADMIN);
        transfer::public_transfer(ntt_upgrade_cap, ADMIN);
        transfer::public_share_object(metadata);

        // Transaction 3: shared objects now available
        scenario.next_tx(ADMIN);
    }

    /// Create a second NTT deployment to produce an extra AdminCap.
    /// The AdminCap and UpgradeCap are transferred to ADMIN.
    /// Used for tests that need multiple AdminCaps (e.g. double-receive).
    public fun setup_second_ntt(scenario: &mut Scenario) {
        scenario.next_tx(ADMIN);
        ntt::setup::init_test_only(ts::ctx(scenario));

        scenario.next_tx(ADMIN);
        let ntt_deployer = ts::take_from_sender<ntt::setup::DeployerCap>(scenario);
        let upgrade_cap = ts::take_from_sender<sui::package::UpgradeCap>(scenario);

        let (treasury_cap, metadata) = coin::create_currency(
            GOVERNANCE_SCENARIO {},
            DECIMALS,
            b"GT2",
            b"Gov Test 2",
            b"",
            option::none(),
            ts::ctx(scenario),
        );

        let (admin_cap, ntt_upgrade_cap) = ntt::setup::complete_burning(
            ntt_deployer,
            upgrade_cap,
            CHAIN_ID,
            treasury_cap,
            ts::ctx(scenario),
        );

        transfer::public_transfer(admin_cap, ADMIN);
        transfer::public_transfer(ntt_upgrade_cap, ADMIN);
        transfer::public_share_object(metadata);

        scenario.next_tx(ADMIN);
    }

    // ─── Object Take/Return Helpers ───

    public fun take_gov(scenario: &Scenario): GovernanceState {
        ts::take_shared(scenario)
    }

    public fun return_gov(gov: GovernanceState) {
        ts::return_shared(gov);
    }

    public fun take_ntt_state(scenario: &Scenario): State<GOVERNANCE_SCENARIO> {
        ts::take_shared(scenario)
    }

    public fun return_ntt_state(state: State<GOVERNANCE_SCENARIO>) {
        ts::return_shared(state);
    }

    public fun take_coin_metadata(scenario: &Scenario): CoinMetadata<GOVERNANCE_SCENARIO> {
        ts::take_shared(scenario)
    }

    public fun return_coin_metadata(metadata: CoinMetadata<GOVERNANCE_SCENARIO>) {
        ts::return_shared(metadata);
    }

    public fun take_clock(scenario: &mut Scenario): Clock {
        clock::create_for_testing(ts::ctx(scenario))
    }

    public fun return_clock(clock: Clock) {
        clock::destroy_for_testing(clock);
    }
}

#[test_only]
module ntt_governance::test_transceiver_a {
    public struct TransceiverAuth has drop {}
}

#[test_only]
module ntt_governance::test_transceiver_b {
    public struct TransceiverAuth has drop {}
}
