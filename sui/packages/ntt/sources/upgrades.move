module ntt::upgrades {
    use ntt::state::State;

    const VERSION: u64 = 0;

    public struct UpgradeCap has key, store {
        id: UID,
        cap: sui::package::UpgradeCap
    }

    public fun new_upgrade_cap(
        cap: sui::package::UpgradeCap,
        ctx: &mut TxContext
    ): UpgradeCap {
        let id = object::new(ctx);
        wormhole::package_utils::assert_package_upgrade_cap<UpgradeCap>(
            &cap,
            sui::package::compatible_policy(),
            1
        );

        UpgradeCap { id, cap }
    }

    public fun authorize_upgrade(
        cap: &mut UpgradeCap,
        digest: vector<u8>
    ): sui::package::UpgradeTicket {
        let policy = cap.cap.upgrade_policy();
        return cap.cap.authorize_upgrade(policy, digest)
    }

    public fun commit_upgrade<T>(
        cap: &mut UpgradeCap,
        state: &mut State<T>,
        receipt: sui::package::UpgradeReceipt
    ) {
        state.set_version(VERSION);
        cap.cap.commit_upgrade(receipt)
    }

    /// A "marker" type that marks functions that are version gated.
    ///
    /// This is purely for documentation purposes, to make it easier to reason
    /// about which public functions are version gated, because the only way to
    /// consume this is by calling the `version_check` function.
    ///
    /// The contract should never instantiate this type directly, and instead
    /// take it as an argument from public functions. That way, version checking
    /// is immediately visible through the entire callstack just by looking at
    /// function signatures.
    public struct VersionGated {}

    public fun new_version_gated(): VersionGated {
        VersionGated {}
    }

    #[error]
    const EVersionMismatch: vector<u8> =
        b"Version mismatch: the upgrade is not compatible with the current version";

    public fun check_version<T>(
        version_gated: VersionGated,
        state: &State<T>
    ) {
        let VersionGated {} = version_gated;
        if (state.get_version() != VERSION) {
            abort EVersionMismatch
        }
    }
}
