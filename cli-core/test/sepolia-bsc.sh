#!/usr/bin/env bash
# This script creates two forks (Bsc and Sepolia) and creates an NTT deployment
# on both of them.
# It's safe to run these tests outside of docker, as we create an isolated temporary
# directory for the tests.

set -euox pipefail

BSC_PORT=8545
SEPOLIA_PORT=8546

anvil --silent --rpc-url https://bsc-testnet-rpc.publicnode.com -p "$BSC_PORT" &
pid1=$!
anvil --silent --rpc-url wss://ethereum-sepolia-rpc.publicnode.com -p "$SEPOLIA_PORT" &
pid2=$!

# check both processes are running
if ! kill -0 $pid1 || ! kill -0 $pid2; then
  echo "Failed to start the servers"
  exit 1
fi

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
      "rpc": "http://127.0.0.1:$BSC_PORT"
    },
    "Sepolia": {
      "rpc": "http://127.0.0.1:$SEPOLIA_PORT"
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
