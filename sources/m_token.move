module sui_m::m_token {
    use sui::object;
    use sui::coin::{Self, TreasuryCap};
    use sui::table::{Self, Table};
    use sui_m::continuous_indexing::{Self, ContinuousIndexing};

    // ============ Constants ============

    /// Token decimals (6 decimals like in Solidity)
    const DECIMALS: u8 = 6;

    /// Token name
    const NAME: vector<u8> = b"M by M^0";

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

    /// Error when the caller is not the Portal
    const ENotPortal: u64 = 5;

    /// Error when principal of total supply would overflow
    const EOverflowsPrincipalOfTotalSupply: u64 = 6;

    /// Error when the Portal address is zero
    const EZeroPortal: u64 = 7;

    /// Error when the Registrar address is zero
    const EZeroRegistrar: u64 = 8;

    /// Error when amount is zero
    const EInsufficientAmount: u64 = 9;

    /// Error when recipient is invalid
    const EInvalidRecipient: u64 = 10;

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

    // ============ Portal Functions (to be implemented) ============

    // Mint with index update
    // public fun mint(global: &mut MTokenGlobal, cap: &PortalCap, recipient: address, amount: u256, index: u128, ctx: &mut TxContext)

    // Mint without index update
    // public fun mint_no_index(global: &mut MTokenGlobal, cap: &PortalCap, recipient: address, amount: u256, ctx: &mut TxContext)

    // Burn from sender
    // public fun burn(global: &mut MTokenGlobal, cap: &PortalCap, coin: Coin<M_TOKEN>, ctx: &mut TxContext)

    // Update index
    // public fun update_index(global: &mut MTokenGlobal, cap: &PortalCap, index: u128, ctx: &mut TxContext)

    // ============ Registrar Functions (to be implemented) ============

    // Approve an account as earner
    // public fun approve_earner(global: &mut MTokenGlobal, cap: &RegistrarCap, account: address)

    // Revoke earner approval
    // public fun revoke_earner(global: &mut MTokenGlobal, cap: &RegistrarCap, account: address)

    // ============ User Functions (to be implemented) ============

    // Start earning (caller must be approved)
    // public fun start_earning(global: &mut MTokenGlobal, ctx: &mut TxContext)

    // Stop earning (caller stops their own earning)
    // public fun stop_earning(global: &mut MTokenGlobal, ctx: &mut TxContext)

    // Force stop earning for an account (only if not approved)
    // public fun stop_earning_for(global: &mut MTokenGlobal, account: address, ctx: &mut TxContext)

    // ============ View Functions (to be implemented) ============

    // Get total earning supply
    // public fun total_earning_supply(global: &MTokenGlobal): u256

    // Get total supply (earning + non-earning)
    // public fun total_supply(global: &MTokenGlobal): u256

    // Get principal balance of an account
    // public fun principal_balance_of(global: &MTokenGlobal, account: address): u256

    // Get balance of an account
    // public fun balance_of(global: &MTokenGlobal, account: address): u256

    // Check if account is earning
    // public fun is_earning(global: &MTokenGlobal, account: address): bool

    // Get current index
    // public fun current_index(global: &MTokenGlobal): u128

    // Check if account is approved earner
    // public fun is_approved_earner(global: &MTokenGlobal, account: address): bool
}
