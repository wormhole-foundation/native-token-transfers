# Solidity to Sui Move Uint Type Mappings

## Mapping Strategy
Round up to nearest supported Sui Move type to ensure no overflow during conversion.

## Type Mappings

| Solidity Type | Sui Move Type | Rationale |
|---------------|---------------|-----------|
| uint16 | u32 | Next supported size |
| uint32 | u32 | Direct mapping |
| uint40 | u64 | Next supported size |
| uint48 | u64 | Next supported size |
| uint56 | u64 | Next supported size |
| uint64 | u64 | Direct mapping |
| uint72 | u128 | Next supported size |
| uint112 | u128 | Next supported size |
| uint128 | u128 | Direct mapping |
| uint144 | u256 | Next supported size |
| uint240 | u256 | Next supported size |
| uint256 | u256 | Direct mapping |

## Types Used in Protocol

### Time & Rate Types
- **uint32**: timestamps, rates, intervals → u32
- **uint40**: timestamps, missed intervals → u64
- **uint48**: mint/retrieval IDs, delta indices → u64

### Balance & Amount Types
- **uint112**: principal amounts → u128
- **uint240**: token amounts, collateral → u256
- **uint256**: general amounts, calculations → u256

### Index & Math Types
- **uint128**: continuous indices → u128
- **uint16**: scaled constants (BPS_SCALED_ONE) → u32
- **uint56**: exponential scaling constant → u64
- **uint64**: yearly rates → u64
- **uint72**: intermediate calculations → u128
- **uint144**: multiplied indices → u256