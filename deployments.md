## NTT Deployment:

This document serves as an example of a possible order of execution of commands to perform a full deployment of NTT on Solana + one or more EVMs.

### Requirements:

NTT needs the following contracts to be able to operate. This doc assumes that these contracts are already deployed by the time you execute this deployment.

Deployed by NTT deployment owner:

- an ntt token

Deployed by wormhole:

- wormhole core layer
- wormhole relayer (you can use wormhole's public one or deploy your own)

### High level description of the process:

To have a multi-chain NTT setup working a few things need to happen.

- Deploy managers on EVM
- Register managers on NTT Token
- Deploy Transceivers on EVM
- Deploy NTT Program on Solana
- Set Mint authority to NTT program
- Initialize NTT program on Solana
- Cross register managers (let each manager know about the other managers)
- Cross register transceivers

## EVM Deployment:

### Environments & Configuration:

These scripts are implemented in way that helps keep track of the deployed addresses by reading contract addresses from json files that can be commited to the repository. Multiple environments are supported through the use of the `ENV` environment variable.
To create or use a new env all that needs to be done is to create a new directory on `evm/ts-scripts/config/<my-env>` with the name of the env you want to use and then set the environment variable ENV to the same value (ie on linux: `export ENV="my-env"`)
Inside the configuration directory, there needs to be a few files that will contain all the configuration you need to set up a full NTT deployment:

- `chains.json` contains the configuration used by the deployment runner such as what rpcs will be used or what chains will it run scripts against
- `contracts.json` this file contains the addresses of all contracts related to this deployment and will be used any time a script needs to know about the address of other of the contracts. Addresses of contracts will be written to this file as the deployment progress (ie after deploying managers we'll add the manager addresses here)
- `managers.json` contains the configuration that will be applied to managers
- `transceivers.json` contains the configuration that will be applied to transceivers
- `peers.json` contains the configuration that will be used for contract cross-registrations

> When a script deploys new contracts, it outputs the resulting addresseses on the directory `ts-scripts/output/<scripts-name>/<timestamp>.json (aside from logging them). Whenever we need to configure the addresses of a contract that we have just deployed we'll fetch the new addresses from those files.

### Deployment Steps:

- create/update `evm/config/<env>/contracts.json` as needed
- create/update `evm/config/<env>/managers.json` as needed
- create/update `evm/config/<env>/transceivers.json` as needed
- Set environment variables:

```
export FOUNDRY_PROFILE=prod
export WALLET_KEY="ledger"
export LEDGER_BIP32_PATH=""
export ENV=testnet
```

- Build:

```shell
make build-evm-prod
cd evm/ts-scripts
npm install
cd ..
npm --prefix ./ts-scripts run build # builds typescript bindings to evm/ts-scripts/output
```

- Deploy Managers:

```shell
bash -c ./ts-scripts/shell/deploy-managers.sh
#
# Use the addresses to update the `contracts.json` file
#
```

- Now that you have deployed your manager, you can go to your token deployment and configure the token to be managed by the managers you have deployed (aka, call `setMinter` on the token to the manager address).
- Deploy Transceivers:

```shell
bash -c ./ts-scripts/shell/deploy-transceivers.sh
#
# Use the addresses to update the `contracts.json` file
#
```

- Configure Managers:

```shell
bash -c ./ts-scripts/shell/configure-managers.sh
```

## Solana Deployment:

- set environment:

```shell
# Runner Configurations:
export SOLANA_RPC_URL=""
export WORMHOLE_PROGRAM_ID="" # wormhole core layer program id
export LEDGER_DERIVATION_PATH="" # derivation path

# Deployment configuration:
export MINT_ADDRESS="" # the program id of your spl token
```

- Create and set the pub key of the program:

```shell
solana-keygen grind --ignore-case --starts-with ntt:1
```

- use the pub key created to replace the `declare_id!` macro value on `lib.rs`
- export the pub-key of the program:

```
export NTT_PROGRAM_ID=<your-program-key>
```

- Build:

```
cd solana
anchor build --arch sbf -- --features "mainnet" # if you are deploying to tesnet, you should use "solana-devnet" instead of mainnet
```

- Deploy:

```
solana program -k usb://ledger?key=<your derivation path> deploy --url $SOLANA_RPC_URL --program-id "$NTT_PROGRAM_ID.json" target/deploy/example_native_token_transfers.so
```

- Initialize the program:

```shell
make build
npx tsx ./ts/scripts/initializeNtt.ts
#
# The script will print the manager emitter address PDA. You can always derive
# this pda again, but might be easier if you take note of it at this point.
# You'll need it later to do cross-registrations.
#
```

## Cross Registrations:

### EVM cross Registrations:

- Create or update evm/config/<env>/peers.json (this file contains the data of all peers that the different evm deployments should know about. Note that the evm cross-registration script can find the addresses of its evm peers, but it can't find the solana peer address, so for solana you'll need to add two extra properties `managerAddress` and `transceiverAddress`. They correspond to the solana ntt deployment program-id and the manager-emitter-address PDA (the one printed during solana program initialization)
- Run update peers script:

```shell
bash -c ./ts-scripts/shell/update-peer-addresses.sh
```

### Solana Cross Registrations:

- update `evmNttDeployments` on solana/ts/scripts/env.ts with the addresses of your EVM managers and transceivers.
- Run cross registrations script:

```shell
npx tsx ./ts/scripts/updatePeers.ts
```

## Contract Bytecode Verification:

### EVM verification:

On evm there are scripts that verify the deployed contracts. To run them you'll need a file with the etherscan scanners keys per each of the supported chains.
Such file should have this structure:

```json
[
  {
    "chainId": 6,
    "etherscan": "YOUR-ETTHERSCAN-API_KEY"
  }
]
```

Run verification scripts:

```
export SCANNER_TOKENS_FILE_PATH="the/path/to/file/above"
bash -c ./evm/ts-scripts/shell/verify-managers.sh
bash -c ./evm/ts-scripts/shell/verify-transceivers.sh
```

Finally, go to the etherscan scanner of the different chains and link the verified proxy to the verified implementation.

### Solana Verification:

TODO
