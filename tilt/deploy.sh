#!/bin/sh

cd /app/example-messaging-endpoint/evm
RPC_URL=http://eth-devnet:8545 bash ./sh/deployEndpoint.sh
OUR_CHAIN_ID=4 EVM_CHAIN_ID=1397 RPC_URL=http://eth-devnet2:8545 bash ./sh/deployEndpoint.sh

cd /app/example-messaging-executor/evm
RPC_URL=http://eth-devnet:8545 bash ./sh/deployExecutor.sh
OUR_CHAIN_ID=4 EVM_CHAIN_ID=1397 RPC_URL=http://eth-devnet2:8545 bash ./sh/deployExecutor.sh

cd /app/example-messaging-adapter-wormhole-guardians/evm

export ENDPOINT=$(jq -r '.returns.deployedAddress.value' <<< cat /app/example-messaging-endpoint/evm/broadcast/DeployEndpoint.s.sol/1337/run-latest.json)
export EXECUTOR=$(jq -r '.returns.deployedAddress.value' <<< cat /app/example-messaging-executor/evm/broadcast/DeployExecutor.s.sol/1337/run-latest.json)
RPC_URL=http://eth-devnet:8545 bash ./sh/deployWormholeGuardiansAdapterWithExecutor.sh

export ENDPOINT=$(jq -r '.returns.deployedAddress.value' <<< cat /app/example-messaging-endpoint/evm/broadcast/DeployEndpoint.s.sol/1397/run-latest.json)
export EXECUTOR=$(jq -r '.returns.deployedAddress.value' <<< cat /app/example-messaging-executor/evm/broadcast/DeployExecutor.s.sol/1397/run-latest.json)
OUR_CHAIN_ID=4 EVM_CHAIN_ID=1397 RPC_URL=http://eth-devnet2:8545 bash ./sh/deployWormholeGuardiansAdapterWithExecutor.sh

export WGA_ADDR=$(jq -r '.returns.deployedAddress.value' <<< cat ./broadcast/DeployWormholeGuardiansAdapterWithExecutor.s.sol/1337/run-latest.json)
export PEER_CHAIN_ID=4
export PEER_ADDR="0x000000000000000000000000$(jq -r '.returns.deployedAddress.value' <<< cat ./broadcast/DeployWormholeGuardiansAdapterWithExecutor.s.sol/1397/run-latest.json | cut -d 'x' -f2)"
RPC_URL=http://eth-devnet:8545 bash ./sh/setPeer.sh

export WGA_ADDR=$(jq -r '.returns.deployedAddress.value' <<< cat ./broadcast/DeployWormholeGuardiansAdapterWithExecutor.s.sol/1397/run-latest.json)
export PEER_CHAIN_ID=2
export PEER_ADDR="0x000000000000000000000000$(jq -r '.returns.deployedAddress.value' <<< cat ./broadcast/DeployWormholeGuardiansAdapterWithExecutor.s.sol/1337/run-latest.json | cut -d 'x' -f2)"
RPC_URL=http://eth-devnet2:8545 bash ./sh/setPeer.sh
