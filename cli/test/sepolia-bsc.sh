#!/usr/bin/env bash
# This script creates two forks (Bsc and Sepolia) and creates an NTT deployment
# on both of them.
# It's safe to run these tests outside of docker, as we create an isolated temporary
# directory for the tests.

set -euox pipefail

BSC_PORT=8545
SEPOLIA_PORT=8546
BSC_RPC_URL=https://bsc-testnet-rpc.publicnode.com
SEPOLIA_RPC_URL=wss://ethereum-sepolia-rpc.publicnode.com
SEPOLIA_FORK_RPC_URL=http://127.0.0.1:$SEPOLIA_PORT
BSC_FORK_RPC_URL=http://127.0.0.1:$BSC_PORT
SEPOLIA_CORE_BRIDGE=0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78
BSC_CORE_BRIDGE=0x68605AD7b15c732a30b1BbC62BE8F2A509D74b4D

anvil --silent --rpc-url $BSC_RPC_URL -p "$BSC_PORT" &
pid1=$!
anvil --silent --rpc-url $SEPOLIA_RPC_URL -p "$SEPOLIA_PORT" &
pid2=$!
# check both processes are running
if ! kill -0 $pid1 || ! kill -0 $pid2; then
  echo "Failed to start the servers"
  exit 1
fi

# wait for RPC endpoints to be ready
wait_for_rpc() {
  local url=$1
  local max_attempts=30
  local attempt=1
  
  echo "Waiting for RPC endpoint $url to be ready..."
  while [ $attempt -le $max_attempts ]; do
    if curl -s -X POST "$url" \
      -H "Content-Type: application/json" \
      --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' > /dev/null 2>&1; then
      echo "RPC endpoint $url is ready"
      return 0
    fi
    echo "Attempt $attempt/$max_attempts: RPC not ready yet, waiting..."
    sleep 1
    attempt=$((attempt + 1))
  done
  echo "RPC endpoint $url failed to become ready after $max_attempts attempts"
  return 1
}

wait_for_rpc "$SEPOLIA_FORK_RPC_URL" || exit 1
wait_for_rpc "$BSC_FORK_RPC_URL" || exit 1

# setting core bridge fee to 0.001 (7 = `messageFee` storage slot)
curl "$SEPOLIA_FORK_RPC_URL" -H "Content-Type: application/json" --data "{\"jsonrpc\":\"2.0\",\"method\":\"anvil_setStorageAt\",\"params\":[\"$SEPOLIA_CORE_BRIDGE\", 7 ,\"0x00000000000000000000000000000000000000000000000000038D7EA4C68000\"],\"id\":1}"
curl "$BSC_FORK_RPC_URL" -H "Content-Type: application/json" --data "{\"jsonrpc\":\"2.0\",\"method\":\"anvil_setStorageAt\",\"params\":[\"$BSC_CORE_BRIDGE\", 7 ,\"0x00000000000000000000000000000000000000000000000000038D7EA4C68000\"],\"id\":1}"

# create tmp directory
dir=$(mktemp -d)

cleanup() {
  kill $pid1 $pid2
  rm -rf $dir
}

trap "cleanup" INT TERM EXIT

# devnet private key
export ETH_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

echo "Running tests..."
cd $dir
ntt new test-ntt
cd test-ntt
ntt init Testnet

# write overrides.json
cat <<EOF > overrides.json
{
  "chains": {
    "Bsc": {
      "rpc": "$BSC_FORK_RPC_URL"
    },
    "Sepolia": {
      "rpc": "$SEPOLIA_FORK_RPC_URL"
    }
  }
}
EOF

ntt add-chain Bsc --token 0x0B15635FCF5316EdFD2a9A0b0dC3700aeA4D09E6 --mode locking --skip-verify --latest
ntt add-chain Sepolia --token 0xB82381A3fBD3FaFA77B3a7bE693342618240067b --skip-verify --ver 1.0.0

ntt pull --yes
ntt push --yes

# ugprade Sepolia to 1.1.0
ntt upgrade Sepolia --ver 1.1.0 --skip-verify --yes
# now upgrade to the local version.
ntt upgrade Sepolia --local --skip-verify --yes

ntt pull --yes

# transfer ownership to
NEW_OWNER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
NEW_OWNER_SECRET=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d

jq '.chains.Bsc.owner = "'$NEW_OWNER'"' deployment.json > deployment.json.tmp && mv deployment.json.tmp deployment.json
jq '.chains.Sepolia.owner = "'$NEW_OWNER'"' deployment.json > deployment.json.tmp && mv deployment.json.tmp deployment.json
ntt push --yes

# check the owner has been updated
jq '.chains.Bsc.owner == "'$NEW_OWNER'"' deployment.json
jq '.chains.Sepolia.owner == "'$NEW_OWNER'"' deployment.json

export ETH_PRIVATE_KEY=$NEW_OWNER_SECRET

jq '.chains.Bsc.paused = true' deployment.json > deployment.json.tmp && mv deployment.json.tmp deployment.json

ntt push --yes
jq '.chains.Bsc.paused == true' deployment.json

ntt status

cat deployment.json
