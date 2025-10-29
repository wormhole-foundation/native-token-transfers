# Wormhole Governance program

This program is designed to be a generic governance program that can be used to execute arbitrary instructions on behalf of a guardian set.
The program being governed simply needs to expose admin instructions that can be invoked by a signer account (that's checked by the program's access control logic).

If the signer is set to be the "governance" PDA of this program, then the governance instruction is able to invoke the program's admin instructions.

# Building

The program interacts with the Wormhole program, and as such, needs to be aware of Wormhole's address. By default, the solana mainnet address is supplied. To override this, we can build like this:

```sh
BRIDGE_ADDRESS=worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth cargo build-sbf --no-default-features --features bridge-address-from-env
```
