// SPDX-License-Identifier: Apache 2

/// Wormhole governance contract for NTT on Sui.
///
/// Since Sui intentionally prohibits dynamic dispatch, and each NTT deployment
/// is a separate package with its own types, one governance package must be
/// deployed per NTT deployment. This package stores the NTT AdminCap and
/// UpgradeCap as dynamic object fields, and all admin operations require a
/// Wormhole governance VAA signed by the guardian set.
///
/// Capabilities can be transferred to a new governance contract via
/// `execute_transfer_ownership` (VAA-gated). The new governance receives
/// them via `receive_admin_cap` / `receive_upgrade_cap`.
///
/// ## Security: Governance Package Immutability
///
/// The governance package enforces its own immutability at the contract level.
/// The only way to create a `GovernanceState` is through `create()`, which
/// consumes the package's `UpgradeCap` via `make_immutable`. The existence
/// of a `GovernanceState` proves the governance package cannot be upgraded.
///
/// ## Governance VAA Format
///
/// This contract uses the GeneralPurposeGovernance module identifier, shared
/// with the EVM and Solana governance contracts. The wire format follows the
/// Wormhole governance packet standard:
///
/// The Wormhole governance message envelope (handled by `governance_message`):
///   MODULE (32 bytes, "GeneralPurposeGovernance" left-padded)
///   ACTION (1 byte, SUI_CALL = 3)
///   CHAIN  (2 bytes, Sui chain ID)
///
/// The payload returned by `take_payload` (parsed by this module):
///   GOVERNANCE_ID (32 bytes) | NTT_ACTION (1 byte) | ACTION_DATA (variable)
///
/// The NTT_ACTION byte identifies the specific NTT admin operation (1-11).
///
/// ## PTB Usage
///
/// ```
/// 0. Publish ntt_governance package → init() creates DeployerCap
/// 1. Call governance::create(deployer_cap, upgrade_cap) → makes package immutable, creates GovernanceState
/// 2. Transfer AdminCap + UpgradeCap to GovernanceState address
/// 3. Call receive_admin_cap() + receive_upgrade_cap()
/// 4. vaa::parse_and_verify(wormhole_state, vaa_bytes, clock) → VAA
/// 5. governance::verify_and_consume(gov_state, wormhole_state, vaa) → GovernanceDecree
/// 6. governance::execute_<action><T>(gov_state, ntt_state, decree, ...)
/// ```
///
/// For upgrades (multi-step):
/// ```
/// 1. vaa::parse_and_verify(...) → VAA
/// 2. governance::verify_and_consume(gov_state, wormhole_state, vaa) → GovernanceDecree
/// 3. governance::execute_authorize_upgrade(gov_state, decree) → UpgradeTicket
/// 4. sui::package::upgrade(ticket, modules, deps, policy) → UpgradeReceipt
/// 5. governance::execute_commit_upgrade<T>(gov_state, ntt_state, receipt)
/// ```
module ntt_governance::governance {
    use sui::clock::Clock;
    use sui::dynamic_object_field as ofield;
    use sui::transfer::Receiving;
    use std::type_name;
    use wormhole::bytes;
    use wormhole::bytes32;
    use wormhole::consumed_vaas;
    use wormhole::cursor;
    use wormhole::external_address;
    use wormhole::governance_message;
    use wormhole::vaa::{Self, VAA};
    use ntt::state::AdminCap;
    use ntt::upgrades;
    use ntt::peer;

    // ─── Errors ───

    #[error]
    const EGovernanceIdMismatch: vector<u8> =
        b"Governance ID in payload does not match this instance";

    #[error]
    const ETransceiverTypeMismatch: vector<u8> =
        b"Transceiver type in payload does not match provided type parameter";

    #[error]
    const EAdminCapAlreadySet: vector<u8> =
        b"AdminCap already stored in this governance instance";

    #[error]
    const EUpgradeCapAlreadySet: vector<u8> =
        b"UpgradeCap already stored in this governance instance";

    #[error]
    const ENoCapToTransfer: vector<u8> =
        b"No capability stored to transfer";

    #[error]
    const EActionMismatch: vector<u8> =
        b"Decree action does not match expected action for this function";

    // ─── Events ───

    /// Emitted when a governance action is executed, providing an on-chain
    /// audit trail for all governance operations.
    public struct GovernanceActionExecuted has copy, drop {
        /// The NTT action ID (1-11) from the payload
        action: u8,
        /// Digest of the VAA that authorised this action
        vaa_digest: address,
    }

    // ─── Constants ───

    /// Wormhole governance module name, shared across EVM, Solana, and Sui.
    /// Left-padded to 32 bytes via `bytes32::from_bytes`.
    const MODULE_NAME: vector<u8> = b"GeneralPurposeGovernance";

    /// Governance action for the Wormhole envelope. Each runtime has its own:
    ///   EVM_CALL = 1, SOLANA_CALL = 2, SUI_CALL = 3
    const ACTION_SUI_CALL: u8 = 3;

    // NTT action IDs encoded in the governance payload (after GOVERNANCE_ID)
    const ACTION_SET_PEER: u8 = 1;
    const ACTION_SET_THRESHOLD: u8 = 2;
    const ACTION_SET_OUTBOUND_LIMIT: u8 = 3;
    const ACTION_SET_INBOUND_LIMIT: u8 = 4;
    const ACTION_PAUSE: u8 = 5;
    const ACTION_UNPAUSE: u8 = 6;
    const ACTION_REGISTER_TRANSCEIVER: u8 = 7;
    const ACTION_ENABLE_TRANSCEIVER: u8 = 8;
    const ACTION_DISABLE_TRANSCEIVER: u8 = 9;
    const ACTION_AUTHORIZE_UPGRADE: u8 = 10;
    const ACTION_TRANSFER_OWNERSHIP: u8 = 11;

    // ─── Types ───

    /// Phantom witness for Wormhole `DecreeTicket`/`DecreeReceipt`
    /// parameterisation. Only this module can instantiate it, ensuring only
    /// this module can initiate governance VAA verification.
    public struct GovernanceWitness has drop {}

    /// Hot-potato returned by `verify_and_consume`. Contains the verified
    /// action ID and action-specific payload. Must be consumed by an
    /// `execute_*` function in the same transaction.
    public struct GovernanceDecree {
        action: u8,
        payload: vector<u8>,
    }

    /// Key types for dynamic object fields storing capabilities.
    public struct AdminCapKey has copy, drop, store {}
    public struct UpgradeCapKey has copy, drop, store {}

    /// Capability created at `init`, which will be destroyed once
    /// `create` is called. This ensures only the deployer can
    /// create the shared `GovernanceState`.
    public struct DeployerCap has key, store { id: UID }

    /// Shared object holding governance state. Capabilities (AdminCap,
    /// UpgradeCap) are stored as dynamic object fields, preserving their
    /// top-level identity in the object store. This allows caps to be
    /// transferred out for governance handoff to a new contract.
    public struct GovernanceState has key {
        id: UID,
        consumed_vaas: consumed_vaas::ConsumedVAAs,
    }

    // ─── Initialization ───

    /// Called automatically when module is first published. Transfers
    /// `DeployerCap` to sender. The deployer must then call `create()`
    /// to make the package immutable and create the `GovernanceState`.
    fun init(ctx: &mut TxContext) {
        transfer::transfer(DeployerCap { id: object::new(ctx) }, ctx.sender());
    }

    /// Consume the `DeployerCap`, make this package immutable by destroying
    /// its `UpgradeCap`, and create the shared `GovernanceState`.
    /// The existence of a `GovernanceState` proves this package is immutable.
    #[allow(lint(share_owned))]
    public fun create(
        deployer: DeployerCap,
        upgrade_cap: sui::package::UpgradeCap,
        ctx: &mut TxContext,
    ) {
        let DeployerCap { id } = deployer;
        object::delete(id);

        wormhole::package_utils::assert_package_upgrade_cap<DeployerCap>(
            &upgrade_cap,
            sui::package::compatible_policy(),
            1,
        );
        sui::package::make_immutable(upgrade_cap);

        transfer::share_object(GovernanceState {
            id: object::new(ctx),
            consumed_vaas: consumed_vaas::new(ctx),
        });
    }

    // ─── Capability Receiving ───

    /// Receive an `AdminCap` that was transferred to this governance object.
    /// Permissionless — the cap is already owned by this GovernanceState.
    public fun receive_admin_cap(
        gov: &mut GovernanceState,
        cap: Receiving<AdminCap>,
    ) {
        assert!(!ofield::exists_<AdminCapKey>(&gov.id, AdminCapKey {}), EAdminCapAlreadySet);
        let admin_cap = transfer::public_receive(&mut gov.id, cap);
        ofield::add(&mut gov.id, AdminCapKey {}, admin_cap);
    }

    /// Receive an `UpgradeCap` that was transferred to this governance object.
    /// Permissionless — the cap is already owned by this GovernanceState.
    ///
    /// The type system guarantees the received cap is from the correct NTT
    /// package: `ntt::upgrades::UpgradeCap` is bound to the NTT package at
    /// compile time, and `public_receive` enforces exact type matching
    /// (including package ID). Additionally, `ntt::upgrades::new_upgrade_cap`
    /// validates the inner `sui::package::UpgradeCap` via
    /// `assert_package_upgrade_cap` at creation.
    public fun receive_upgrade_cap(
        gov: &mut GovernanceState,
        cap: Receiving<upgrades::UpgradeCap>,
    ) {
        assert!(!ofield::exists_<UpgradeCapKey>(&gov.id, UpgradeCapKey {}), EUpgradeCapAlreadySet);
        let upgrade_cap = transfer::public_receive(&mut gov.id, cap);
        ofield::add(&mut gov.id, UpgradeCapKey {}, upgrade_cap);
    }

    // ─── Verification ───

    /// Verify a governance VAA, consume its digest for replay protection,
    /// and return a hot-potato `GovernanceDecree` containing the verified
    /// NTT action and action-specific payload.
    ///
    /// The Wormhole envelope uses ACTION_SUI_CALL (3) as the action byte.
    /// The NTT-specific action is encoded in the payload after GOVERNANCE_ID.
    ///
    /// 1. Creates a `DecreeTicket` with GeneralPurposeGovernance module + SUI_CALL action
    /// 2. Verifies the VAA via `governance_message::verify_vaa`
    /// 3. Consumes the VAA digest into `ConsumedVAAs` (replay protection)
    /// 4. Parses governance_id (verifies it targets this instance) and NTT action
    /// 5. Returns a `GovernanceDecree` with the NTT action and remaining payload
    public fun verify_and_consume(
        gov: &mut GovernanceState,
        wh_state: &wormhole::state::State,
        vaa: VAA,
    ): GovernanceDecree {
        let vaa_digest = bytes32::to_address(vaa::digest(&vaa));

        let ticket = governance_message::authorize_verify_local(
            GovernanceWitness {},
            wormhole::state::governance_chain(wh_state),
            wormhole::state::governance_contract(wh_state),
            bytes32::from_bytes(MODULE_NAME),
            ACTION_SUI_CALL,
        );

        let receipt = governance_message::verify_vaa(wh_state, vaa, ticket);
        let payload = governance_message::take_payload(
            &mut gov.consumed_vaas,
            receipt,
        );

        let (action, action_payload) = parse_governance_payload(gov, payload);

        sui::event::emit(GovernanceActionExecuted { action, vaa_digest });

        GovernanceDecree { action, payload: action_payload }
    }

    /// Parse the governance payload: strip the 32-byte governance instance ID
    /// (asserting it matches this `GovernanceState`), extract the NTT action
    /// byte, and return both the action and remaining action-specific data.
    fun parse_governance_payload(
        gov: &GovernanceState,
        payload: vector<u8>,
    ): (u8, vector<u8>) {
        let mut cur = cursor::new(payload);
        let gov_id = object::id_from_address(
            bytes32::to_address(bytes32::take_bytes(&mut cur)),
        );
        assert!(gov_id == object::id(gov), EGovernanceIdMismatch);
        let action = bytes::take_u8(&mut cur);
        (action, cursor::take_rest(cur))
    }

    // ─── Action Handlers ───

    /// Action 1: Set or update a peer on a remote chain.
    /// Payload: chain_id (u16) | peer_address (32) | token_decimals (u8) | inbound_limit (u64)
    public fun execute_set_peer<T>(
        gov: &mut GovernanceState,
        ntt_state: &mut ntt::state::State<T>,
        decree: GovernanceDecree,
        clock: &Clock,
    ) {
        let GovernanceDecree { action, payload } = decree;
        assert!(action == ACTION_SET_PEER, EActionMismatch);

        let mut cur = cursor::new(payload);
        let chain_id = bytes::take_u16_be(&mut cur);
        let peer_address = external_address::take_bytes(&mut cur);
        let token_decimals = bytes::take_u8(&mut cur);
        let inbound_limit = bytes::take_u64_be(&mut cur);
        cursor::destroy_empty(cur);

        let admin_cap: &AdminCap = ofield::borrow(&gov.id, AdminCapKey {});
        ntt::state::set_peer(
            admin_cap,
            ntt_state,
            chain_id,
            peer_address,
            token_decimals,
            inbound_limit,
            clock,
        );
    }

    /// Action 2: Set the attestation threshold.
    /// Payload: threshold (u8)
    public fun execute_set_threshold<T>(
        gov: &mut GovernanceState,
        ntt_state: &mut ntt::state::State<T>,
        decree: GovernanceDecree,
    ) {
        let GovernanceDecree { action, payload } = decree;
        assert!(action == ACTION_SET_THRESHOLD, EActionMismatch);

        let mut cur = cursor::new(payload);
        let threshold = bytes::take_u8(&mut cur);
        cursor::destroy_empty(cur);

        let admin_cap: &AdminCap = ofield::borrow(&gov.id, AdminCapKey {});
        ntt::state::set_threshold(admin_cap, ntt_state, threshold);
    }

    /// Action 3: Set the outbound rate limit.
    /// Payload: limit (u64)
    public fun execute_set_outbound_limit<T>(
        gov: &mut GovernanceState,
        ntt_state: &mut ntt::state::State<T>,
        decree: GovernanceDecree,
        clock: &Clock,
    ) {
        let GovernanceDecree { action, payload } = decree;
        assert!(action == ACTION_SET_OUTBOUND_LIMIT, EActionMismatch);

        let mut cur = cursor::new(payload);
        let limit = bytes::take_u64_be(&mut cur);
        cursor::destroy_empty(cur);

        let admin_cap: &AdminCap = ofield::borrow(&gov.id, AdminCapKey {});
        ntt::state::set_outbound_rate_limit(admin_cap, ntt_state, limit, clock);
    }

    /// Action 4: Set the inbound rate limit for a specific chain.
    /// Reads existing peer address and decimals, updates only the rate limit.
    /// Payload: chain_id (u16) | limit (u64)
    public fun execute_set_inbound_limit<T>(
        gov: &mut GovernanceState,
        ntt_state: &mut ntt::state::State<T>,
        decree: GovernanceDecree,
        clock: &Clock,
    ) {
        let GovernanceDecree { action, payload } = decree;
        assert!(action == ACTION_SET_INBOUND_LIMIT, EActionMismatch);

        let mut cur = cursor::new(payload);
        let chain_id = bytes::take_u16_be(&mut cur);
        let limit = bytes::take_u64_be(&mut cur);
        cursor::destroy_empty(cur);

        // Read existing peer data to preserve address and decimals
        let existing = ntt_state.borrow_peer(chain_id);
        let address = *peer::borrow_address(existing);
        let decimals = peer::get_token_decimals(existing);

        let admin_cap: &AdminCap = ofield::borrow(&gov.id, AdminCapKey {});
        ntt::state::set_peer(
            admin_cap, ntt_state, chain_id, address, decimals, limit, clock,
        );
    }

    /// Action 5: Pause the NTT contract.
    /// Payload: (empty)
    public fun execute_pause<T>(
        gov: &mut GovernanceState,
        ntt_state: &mut ntt::state::State<T>,
        decree: GovernanceDecree,
    ) {
        let GovernanceDecree { action, payload } = decree;
        assert!(action == ACTION_PAUSE, EActionMismatch);

        let cur = cursor::new(payload);
        cursor::destroy_empty(cur);

        let admin_cap: &AdminCap = ofield::borrow(&gov.id, AdminCapKey {});
        ntt::state::pause(admin_cap, ntt_state);
    }

    /// Action 6: Unpause the NTT contract.
    /// Payload: (empty)
    public fun execute_unpause<T>(
        gov: &mut GovernanceState,
        ntt_state: &mut ntt::state::State<T>,
        decree: GovernanceDecree,
    ) {
        let GovernanceDecree { action, payload } = decree;
        assert!(action == ACTION_UNPAUSE, EActionMismatch);

        let cur = cursor::new(payload);
        cursor::destroy_empty(cur);

        let admin_cap: &AdminCap = ofield::borrow(&gov.id, AdminCapKey {});
        ntt::state::unpause(admin_cap, ntt_state);
    }

    /// Action 7: Register a new transceiver type.
    /// The caller provides `Transceiver` as a type parameter in the PTB;
    /// we verify it matches the fully qualified type name in the VAA payload.
    /// Payload: state_object_id (32) | type_name_len (u16) | type_name (utf8)
    public fun execute_register_transceiver<Transceiver, T>(
        gov: &mut GovernanceState,
        ntt_state: &mut ntt::state::State<T>,
        decree: GovernanceDecree,
    ) {
        let GovernanceDecree { action, payload } = decree;
        assert!(action == ACTION_REGISTER_TRANSCEIVER, EActionMismatch);

        let mut cur = cursor::new(payload);
        let state_object_id = object::id_from_address(
            bytes32::to_address(bytes32::take_bytes(&mut cur)),
        );
        let type_name_len = bytes::take_u16_be(&mut cur);
        let encoded_type_name = bytes::take_bytes(&mut cur, type_name_len as u64);
        cursor::destroy_empty(cur);

        // Verify the caller's type parameter matches what the VAA authorised
        let actual_type_name = type_name::with_defining_ids<Transceiver>().into_string().into_bytes();
        assert!(encoded_type_name == actual_type_name, ETransceiverTypeMismatch);

        let admin_cap: &AdminCap = ofield::borrow(&gov.id, AdminCapKey {});
        ntt::state::register_transceiver<Transceiver, T>(
            ntt_state,
            state_object_id,
            admin_cap,
        );
    }

    /// Action 8: Enable a transceiver by ID.
    /// Payload: transceiver_id (u8)
    public fun execute_enable_transceiver<T>(
        gov: &mut GovernanceState,
        ntt_state: &mut ntt::state::State<T>,
        decree: GovernanceDecree,
    ) {
        let GovernanceDecree { action, payload } = decree;
        assert!(action == ACTION_ENABLE_TRANSCEIVER, EActionMismatch);

        let mut cur = cursor::new(payload);
        let transceiver_id = bytes::take_u8(&mut cur);
        cursor::destroy_empty(cur);

        let admin_cap: &AdminCap = ofield::borrow(&gov.id, AdminCapKey {});
        ntt::state::enable_transceiver(ntt_state, admin_cap, transceiver_id);
    }

    /// Action 9: Disable a transceiver by ID.
    /// Payload: transceiver_id (u8)
    public fun execute_disable_transceiver<T>(
        gov: &mut GovernanceState,
        ntt_state: &mut ntt::state::State<T>,
        decree: GovernanceDecree,
    ) {
        let GovernanceDecree { action, payload } = decree;
        assert!(action == ACTION_DISABLE_TRANSCEIVER, EActionMismatch);

        let mut cur = cursor::new(payload);
        let transceiver_id = bytes::take_u8(&mut cur);
        cursor::destroy_empty(cur);

        let admin_cap: &AdminCap = ofield::borrow(&gov.id, AdminCapKey {});
        ntt::state::disable_transceiver(ntt_state, admin_cap, transceiver_id);
    }

    /// Action 10: Authorise a package upgrade.
    /// Returns a hot-potato `UpgradeTicket` that must be consumed by
    /// `sui::package::upgrade` in the same PTB.
    /// Payload: digest (32 bytes)
    public fun execute_authorize_upgrade(
        gov: &mut GovernanceState,
        decree: GovernanceDecree,
    ): sui::package::UpgradeTicket {
        let GovernanceDecree { action, payload } = decree;
        assert!(action == ACTION_AUTHORIZE_UPGRADE, EActionMismatch);

        let mut cur = cursor::new(payload);
        let digest = bytes::take_bytes(&mut cur, 32);
        cursor::destroy_empty(cur);

        let upgrade_cap: &mut upgrades::UpgradeCap = ofield::borrow_mut(&mut gov.id, UpgradeCapKey {});
        upgrades::authorize_upgrade(upgrade_cap, digest)
    }

    /// Commit a package upgrade after `sui::package::upgrade` completes.
    /// No VAA needed — authorisation was already verified in
    /// `execute_authorize_upgrade`. The `receipt` is a hot-potato from
    /// `sui::package::upgrade`.
    public fun execute_commit_upgrade<T>(
        gov: &mut GovernanceState,
        ntt_state: &mut ntt::state::State<T>,
        receipt: sui::package::UpgradeReceipt,
    ) {
        let upgrade_cap: &mut upgrades::UpgradeCap = ofield::borrow_mut(&mut gov.id, UpgradeCapKey {});
        upgrades::commit_upgrade(upgrade_cap, ntt_state, receipt);
    }

    // ─── Ownership Transfer ───

    /// Action 11: Transfer ownership (AdminCap + UpgradeCap) to a new address.
    /// Transfers both caps (if present) to `new_owner`. If only one cap is
    /// stored, transfers just that one.
    /// Payload: new_owner (32 bytes)
    ///
    /// WARNING: `new_owner` is used as-is from the VAA payload with no on-chain
    /// validation that the address is a valid GovernanceState, EOA, or even
    /// non-zero. A guardian-signed VAA with an incorrect `new_owner` will
    /// permanently and irrecoverably lose admin/upgrade control. Operators must
    /// verify the address in the governance proposal before signing.
    public fun execute_transfer_ownership(
        gov: &mut GovernanceState,
        decree: GovernanceDecree,
    ) {
        let GovernanceDecree { action, payload } = decree;
        assert!(action == ACTION_TRANSFER_OWNERSHIP, EActionMismatch);

        let mut cur = cursor::new(payload);
        let new_owner = bytes32::to_address(bytes32::take_bytes(&mut cur));
        cursor::destroy_empty(cur);

        let has_admin = ofield::exists_<AdminCapKey>(&gov.id, AdminCapKey {});
        let has_upgrade = ofield::exists_<UpgradeCapKey>(&gov.id, UpgradeCapKey {});
        assert!(has_admin || has_upgrade, ENoCapToTransfer);

        if (has_admin) {
            let cap: AdminCap = ofield::remove(&mut gov.id, AdminCapKey {});
            transfer::public_transfer(cap, new_owner);
        };
        if (has_upgrade) {
            let cap: upgrades::UpgradeCap = ofield::remove(&mut gov.id, UpgradeCapKey {});
            transfer::public_transfer(cap, new_owner);
        };
    }

    // ─── Test Helpers ───

    #[test_only]
    public fun init_test_only(ctx: &mut TxContext) {
        init(ctx);
        transfer::public_transfer(
            sui::package::test_publish(object::id_from_address(@ntt_governance), ctx),
            ctx.sender(),
        );
    }

    /// Create a `GovernanceState` directly for testing, skipping
    /// the `DeployerCap` + `UpgradeCap` ceremony.
    #[test_only]
    #[allow(lint(share_owned))]
    public fun create_test_only(ctx: &mut TxContext) {
        transfer::share_object(GovernanceState {
            id: object::new(ctx),
            consumed_vaas: consumed_vaas::new(ctx),
        });
    }

    #[test_only]
    public fun test_add_caps(
        gov: &mut GovernanceState,
        admin_cap: AdminCap,
        upgrade_cap: upgrades::UpgradeCap,
    ) {
        ofield::add(&mut gov.id, AdminCapKey {}, admin_cap);
        ofield::add(&mut gov.id, UpgradeCapKey {}, upgrade_cap);
    }

    #[test_only]
    public fun new_decree(action: u8, payload: vector<u8>): GovernanceDecree {
        GovernanceDecree { action, payload }
    }

    /// Transfer ownership without VAA verification. Test-only equivalent
    /// of `execute_transfer_ownership`.
    #[test_only]
    public fun test_transfer_ownership(
        gov: &mut GovernanceState,
        new_owner: address,
    ) {
        let has_admin = ofield::exists_<AdminCapKey>(&gov.id, AdminCapKey {});
        let has_upgrade = ofield::exists_<UpgradeCapKey>(&gov.id, UpgradeCapKey {});
        assert!(has_admin || has_upgrade, ENoCapToTransfer);

        if (has_admin) {
            let cap: AdminCap = ofield::remove(&mut gov.id, AdminCapKey {});
            transfer::public_transfer(cap, new_owner);
        };
        if (has_upgrade) {
            let cap: upgrades::UpgradeCap = ofield::remove(&mut gov.id, UpgradeCapKey {});
            transfer::public_transfer(cap, new_owner);
        };
    }

    /// Parse a governance payload (governance_id + ntt_action + action_data),
    /// verify the governance_id matches this instance, and return the
    /// (action, action_data). Uses the same code path as `verify_and_consume`.
    #[test_only]
    public fun test_parse_governance_payload(
        gov: &GovernanceState,
        payload: vector<u8>,
    ): (u8, vector<u8>) {
        parse_governance_payload(gov, payload)
    }
}
