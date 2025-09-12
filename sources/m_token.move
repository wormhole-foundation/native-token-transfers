module sui_m::m_token {
    use sui::coin::{Self, TreasuryCap, Coin};
    use sui::table::{Self, Table};
    use sui::event;
    use sui_m::continuous_indexing::{Self, ContinuousIndexing};
    use sui_m::continuous_indexing_math::{divide_down, divide_up, multiply_down};

    // ============ Constants ============

    /// Token decimals (6 decimals like in Solidity)
    const DECIMALS: u8 = 6;

    /// Token name
    const NAME: vector<u8> = b"M by M0";

    /// Token symbol
    const SYMBOL: vector<u8> = b"M";

    /// The scaling of rates for exponent math
    const EXP_SCALED_ONE: u128 = 1_000_000_000_000; // 1e12

    // ============ Error Codes ============

    /// Error when the index from the Hub chain has not yet been propagated
    const EIndexNotInitialized: u64 = 1;

    /// Error when there is insufficient balance
    const EInsufficientBalance: u64 = 2;

    /// Error when calling stopEarning for an approved earner
    const EIsApprovedEarner: u64 = 3;

    /// Error when calling startEarning for a non-approved earner
    const ENotApprovedEarner: u64 = 4;

    /// Error when principal of total supply would overflow
    const EOverflowsPrincipalOfTotalSupply: u64 = 6;

    /// Error when amount is zero
    const EInsufficientAmount: u64 = 9;

    /// Error when recipient is invalid
    const EInvalidRecipient: u64 = 10;

    /// Error when account balance not found
    const EAccountNotFound: u64 = 11;

    // ============ Structs ============

    /// MToken coin type witness
    public struct M_TOKEN has drop {}

    /// Account balance information
    /// Tracks both earning and non-earning balances
    public struct AccountBalance has store {
        /// True if the account is earning, false otherwise
        is_earning: bool,
        /// Balance (for non-earning) or balance principal (for earning)
        /// uint240 in Solidity → u256 in Sui for safety
        raw_balance: u256
    }

    /// Global MToken state - shared object
    public struct MTokenGlobal has key {
        id: UID,
        /// Treasury capability for minting/burning
        treasury_cap: TreasuryCap<M_TOKEN>,
        /// Continuous indexing state
        indexing: ContinuousIndexing,
        /// Portal address that can mint/burn
        portal: address,
        /// Registrar address for earner approvals
        registrar: address,
        /// Total non-earning supply (uint240 → u256)
        total_non_earning_supply: u256,
        /// Principal of total earning supply (uint112 → u128)
        principal_of_total_earning_supply: u128,
        /// Account balances table
        balances: Table<address, AccountBalance>,
        /// Approved earners table (managed by registrar logic)
        approved_earners: Table<address, bool>
    }

    /// Portal capability - allows minting and burning
    /// Only the portal address should have this
    public struct PortalCap has key, store {
        id: UID
    }

    /// Registrar capability - allows managing earner approvals
    public struct RegistrarCap has key, store {
        id: UID
    }

    // ============ Events ============

    /// Emitted when account starts earning
    public struct StartedEarning has copy, drop {
        account: address
    }

    /// Emitted when account stops earning
    public struct StoppedEarning has copy, drop {
        account: address
    }

    /// Emitted on mint operations
    public struct Mint has copy, drop {
        recipient: address,
        amount: u256
    }

    /// Emitted on burn operations
    public struct Burn has copy, drop {
        account: address,
        amount: u256
    }

    // ============ Init Function ============

    /// Initialize the MToken module
    fun init(witness: M_TOKEN, ctx: &mut TxContext) {
        // Create the currency
        let (treasury_cap, metadata) =
            coin::create_currency(
                witness,
                DECIMALS,
                SYMBOL,
                NAME,
                b"M Token on Sui",
                option::none(),
                ctx
            );

        // Create the ContinuousIndexing instance
        let indexing = continuous_indexing::new(ctx);

        // Get deployer address (will be updated with actual portal/registrar)
        let deployer = tx_context::sender(ctx);

        // Create the global state
        let global = MTokenGlobal {
            id: object::new(ctx),
            treasury_cap,
            indexing,
            portal: deployer, // Will be updated to actual portal
            registrar: deployer, // Will be updated to actual registrar
            total_non_earning_supply: 0,
            principal_of_total_earning_supply: 0,
            balances: table::new(ctx),
            approved_earners: table::new(ctx)
        };

        // Create portal capability
        let portal_cap = PortalCap { id: object::new(ctx) };

        // Create registrar capability
        let registrar_cap = RegistrarCap { id: object::new(ctx) };

        // Share the global state
        transfer::share_object(global);

        // Transfer capabilities to deployer (to be transferred to proper addresses)
        transfer::transfer(portal_cap, deployer);
        transfer::transfer(registrar_cap, deployer);

        // Freeze the metadata
        transfer::public_freeze_object(metadata);
    }

    // ============ Portal Functions ============

    /// Mint tokens with index update (requires Portal capability)
    public fun mint(
        global: &mut MTokenGlobal,
        _cap: &PortalCap,
        recipient: address,
        amount: u256,
        index: u128,
        ctx: &mut TxContext
    ) {
        // Update index first
        continuous_indexing::update_index(
            &mut global.indexing, index, tx_context::epoch_timestamp_ms(ctx) / 1000
        );

        // Then mint tokens
        mint_no_index(global , _cap, recipient, amount, ctx);
    }

    /// Mint tokens without index update (requires Portal capability)
    public fun mint_no_index(
        global: &mut MTokenGlobal,
        _cap: &PortalCap,
        recipient: address,
        amount: u256,
        ctx: &mut TxContext
    ) {
        assert!(amount > 0, EInsufficientAmount);
        assert!(recipient != @0x0, EInvalidRecipient);

        // Check overflow protection (converted from Solidity logic)
        let max_u240 =
            1766847064778384329583297500742918515827483896875618958121606201292619775u256; // 2^240 - 1
        let max_u112 = 5192296858534827628530496329220095u128; // 2^112 - 1

        assert!(
            global.total_non_earning_supply + amount <= max_u240
                && (global.principal_of_total_earning_supply as u256)
                    + (
                        get_principal_amount_rounded_up_with_index(
                            global.total_non_earning_supply + amount,
                            current_index(global)
                        ) as u256
                    ) < (max_u112 as u256),
            EOverflowsPrincipalOfTotalSupply
        );

        // Get or create balance entry
        if (!table::contains(&global.balances, recipient)) {
            table::add(
                &mut global.balances,
                recipient,
                AccountBalance { is_earning: false, raw_balance: 0 }
            );
        };

        let current_idx = current_index(global);
        let balance = table::borrow_mut(&mut global.balances, recipient);

        if (balance.is_earning) {
            // Add earning amount (principal rounded down)
            let principal_amount =
                get_principal_amount_rounded_down_with_index(amount, current_idx);
            balance.raw_balance = balance.raw_balance + (principal_amount as u256);
            global.principal_of_total_earning_supply =
                global.principal_of_total_earning_supply + principal_amount;
        } else {
            // Add non-earning amount
            balance.raw_balance = balance.raw_balance + amount;
            global.total_non_earning_supply = global.total_non_earning_supply + amount;
        };

        // Mint actual coins and transfer to recipient
        let coin = coin::mint(&mut global.treasury_cap, (amount as u64), ctx);
        transfer::public_transfer(coin, recipient);

        // Emit event
        event::emit(Mint { recipient, amount });
    }

    /// Burn tokens from caller (requires Portal capability)
    public fun burn(
        global: &mut MTokenGlobal,
        _cap: &PortalCap,
        coin_to_burn: Coin<M_TOKEN>,
        ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        let amount = (coin::value(&coin_to_burn) as u256);

        assert!(amount > 0, EInsufficientAmount);
        assert!(table::contains(&global.balances, sender), EAccountNotFound);

        let current_idx = current_index(global);
        let balance = table::borrow_mut(&mut global.balances, sender);

        if (balance.is_earning) {
            // Subtract earning amount (principal rounded up in favor of protocol)
            let principal_amount =
                get_principal_amount_rounded_up_with_index(amount, current_idx);
            assert!(
                balance.raw_balance >= (principal_amount as u256), EInsufficientBalance
            );

            balance.raw_balance = balance.raw_balance - (principal_amount as u256);
            global.principal_of_total_earning_supply =
                global.principal_of_total_earning_supply - principal_amount;
        } else {
            // Subtract non-earning amount
            assert!(balance.raw_balance >= amount, EInsufficientBalance);

            balance.raw_balance = balance.raw_balance - amount;
            global.total_non_earning_supply = global.total_non_earning_supply - amount;
        };

        // Burn the actual coin
        coin::burn(&mut global.treasury_cap, coin_to_burn);

        // Emit event
        event::emit(Burn { account: sender, amount });
    }

    /// Update index (requires Portal capability)
    public fun update_index(
        global: &mut MTokenGlobal,
        _cap: &PortalCap,
        index: u128,
        ctx: &mut TxContext
    ) {
        continuous_indexing::update_index(
            &mut global.indexing, index, tx_context::epoch_timestamp_ms(ctx) / 1000
        );
    }

    // ============ Registrar Functions ============

    /// Approve an account as earner (requires Registrar capability)
    public fun approve_earner(
        global: &mut MTokenGlobal, _cap: &RegistrarCap, account: address
    ) {
        if (table::contains(&global.approved_earners, account)) {
            *table::borrow_mut(&mut global.approved_earners, account) = true;
        } else {
            table::add(&mut global.approved_earners, account, true);
        }
    }

    /// Revoke earner approval (requires Registrar capability)
    public fun revoke_earner(
        global: &mut MTokenGlobal, _cap: &RegistrarCap, account: address
    ) {
        if (table::contains(&global.approved_earners, account)) {
            *table::borrow_mut(&mut global.approved_earners, account) = false;
        }
    }

    // ============ User Functions ============

    /// Start earning (caller must be approved)
    public fun start_earning(
        global: &mut MTokenGlobal, ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);

        // Check if approved earner
        assert!(is_approved_earner(global , sender), ENotApprovedEarner);

        // Check if index is initialized
        assert!(current_index(global) != EXP_SCALED_ONE, EIndexNotInitialized);

        // Get or create balance entry
        if (!table::contains(&global.balances, sender)) {
            table::add(
                &mut global.balances,
                sender,
                AccountBalance { is_earning: false, raw_balance: 0 }
            );
        };

        let current_idx = current_index(global);
        let balance = table::borrow_mut(&mut global.balances, sender);

        // If already earning, do nothing
        if (balance.is_earning) return;

        // Start earning
        event::emit(StartedEarning { account: sender });
        balance.is_earning = true;

        let amount = balance.raw_balance;
        if (amount == 0) return;

        // Convert non-earning balance to principal (rounded down)
        let principal_amount =
            get_principal_amount_rounded_down_with_index(amount, current_idx);
        balance.raw_balance = (principal_amount as u256);

        // Update global accounting
        global.principal_of_total_earning_supply =
            global.principal_of_total_earning_supply + principal_amount;
        global.total_non_earning_supply = global.total_non_earning_supply - amount;
    }

    /// Stop earning (caller stops their own earning)
    public fun stop_earning(
        global: &mut MTokenGlobal, ctx: &mut TxContext
    ) {
        let sender = tx_context::sender(ctx);
        stop_earning_internal(global , sender);
    }

    /// Force stop earning for an account (only if not approved)
    public fun stop_earning_for(
        global: &mut MTokenGlobal, account: address, _ctx: &mut TxContext
    ) {
        // Check that account is not an approved earner
        assert!(!is_approved_earner(global , account), EIsApprovedEarner);

        stop_earning_internal(global , account);
    }

    /// Internal function to stop earning for an account
    fun stop_earning_internal(
        global: &mut MTokenGlobal, account: address
    ) {
        if (!table::contains(&global.balances, account))
            return;

        let current_idx = current_index(global);
        let balance = table::borrow_mut(&mut global.balances, account);

        // If not earning, do nothing
        if (!balance.is_earning) return;

        // Stop earning
        event::emit(StoppedEarning { account });
        balance.is_earning = false;

        let principal_amount = (balance.raw_balance as u128);
        if (principal_amount == 0) return;

        // Convert principal to present amount (rounded down)
        let amount = get_present_amount_with_index(principal_amount, current_idx);
        balance.raw_balance = amount;

        // Update global accounting
        global.total_non_earning_supply = global.total_non_earning_supply + amount;
        global.principal_of_total_earning_supply =
            global.principal_of_total_earning_supply - principal_amount;
    }

    // ============ Helper Functions ============

    /// Get principal amount rounded down from present amount using current index
    fun get_principal_amount_rounded_down_with_index(
        present_amount: u256, index: u128
    ): u128 {
        divide_down(present_amount, index)
    }

    /// Get principal amount rounded up from present amount using current index
    fun get_principal_amount_rounded_up_with_index(
        present_amount: u256, index: u128
    ): u128 {
        divide_up(present_amount, index)
    }

    /// Get present amount from principal using current index (rounded down)
    fun get_present_amount_with_index(
        principal_amount: u128, index: u128
    ): u256 {
        multiply_down(principal_amount, index)
    }

    // ============ View Functions ============

    /// Get total earning supply
    public fun total_earning_supply(global: &MTokenGlobal): u256 {
        get_present_amount_with_index(
            global.principal_of_total_earning_supply, current_index(global)
        )
    }

    /// Get total supply (earning + non-earning)
    public fun total_supply(global: &MTokenGlobal): u256 {
        global.total_non_earning_supply + total_earning_supply(global)
    }

    /// Get principal balance of an account (only for earning accounts)
    public fun principal_balance_of(
        global: &MTokenGlobal, account: address
    ): u256 {
        if (!table::contains(&global.balances, account))
            return 0;

        let balance = table::borrow(&global.balances, account);
        if (balance.is_earning) {
            balance.raw_balance
        } else { 0 }
    }

    /// Get effective balance of an account (present value)
    public fun balance_of(global: &MTokenGlobal, account: address): u256 {
        if (!table::contains(&global.balances, account))
            return 0;

        let balance = table::borrow(&global.balances, account);
        if (balance.is_earning) {
            // Convert principal to present amount
            get_present_amount_with_index(
                (balance.raw_balance as u128), current_index(global)
            )
        } else {
            balance.raw_balance
        }
    }

    /// Check if account is earning
    public fun is_earning(global: &MTokenGlobal, account: address): bool {
        if (!table::contains(&global.balances, account))
            return false;

        let balance = table::borrow(&global.balances, account);
        balance.is_earning
    }

    /// Get current index
    public fun current_index(global: &MTokenGlobal): u128 {
        continuous_indexing::current_index(&global.indexing)
    }

    /// Check if account is approved earner
    public fun is_approved_earner(
        global: &MTokenGlobal, account: address
    ): bool {
        if (!table::contains(&global.approved_earners, account))
            return false;

        *table::borrow(&global.approved_earners, account)
    }

    /// Get portal address
    public fun portal(global: &MTokenGlobal): address {
        global.portal
    }

    /// Get registrar address
    public fun registrar(global: &MTokenGlobal): address {
        global.registrar
    }

    /// Get total non-earning supply
    public fun total_non_earning_supply(global: &MTokenGlobal): u256 {
        global.total_non_earning_supply
    }

    /// Get principal of total earning supply
    public fun principal_of_total_earning_supply(global: &MTokenGlobal): u128 {
        global.principal_of_total_earning_supply
    }
}
