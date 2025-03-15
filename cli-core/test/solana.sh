#!/usr/bin/env bash

# This script deploys the NTT program to a local Solana test validator and
# upgrades it.
#
# TODO: this script should be separated into
# 1) a general purpose validator startup script
# 2) the actual test script that sets up the NTT program and runs the tests
#
# We could then write multiple tests easily. For now, this will do.
# TODO: add better test coverage (registrations, pausing, etc)

set -euo pipefail

# Default values
PORT=6000
FAUCET_PORT=6100
NETWORK="http://127.0.0.1:$PORT"
KEYS_DIR="keys"
OVERRIDES_FILE="overrides.json"
DEPLOYMENT_FILE="deployment.json"
KEEP_ALIVE=false
USE_TMP_DIR=false

# Function to display usage information
usage() {
    cat << EOF
Usage: $0 [options]

Options:
    -h, --help              Show this help message
    -p, --port PORT         Set the RPC port (default: 6000)
    -f, --faucet-port PORT  Set the faucet port (default: 6100)
    -k, --keys-dir DIR      Set the keys directory (default: keys)
    -o, --overrides FILE    Set the overrides file (default: overrides.json)
    -d, --deployment FILE   Set the deployment file (default: deployment.json)
    --keep-alive            Keep the validator running after the script finishes
    --use-tmp-dir           Use a temporary directory for deployment (useful for testing)
EOF
    exit 1
}

# Parse command-line options
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            usage
            ;;
        -p|--port)
            PORT="$2"
            shift 2
            ;;
        -f|--faucet-port)
            FAUCET_PORT="$2"
            shift 2
            ;;
        -k|--keys-dir)
            KEYS_DIR="$2"
            shift 2
            ;;
        -o|--overrides)
            OVERRIDES_FILE="$2"
            shift 2
            ;;
        -d|--deployment)
            DEPLOYMENT_FILE="$2"
            shift 2
            ;;
        --keep-alive)
            KEEP_ALIVE=true
            shift
            ;;
        --use-tmp-dir)
            USE_TMP_DIR=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            usage
            ;;
    esac
done

# Update NETWORK variable based on potentially changed PORT
NETWORK="http://127.0.0.1:$PORT"

validator_dir=$(mktemp -d)

if [ "$USE_TMP_DIR" = true ]; then
   tmp_dir=$(mktemp -d)
   cd "$tmp_dir" || exit
   ntt new test-ntt
   cd test-ntt || exit
fi

# Function to clean up resources
cleanup() {
    echo "Cleaning up..."
    kill "$pid" 2>/dev/null || true
    rm -rf "$validator_dir"
    if [ "$USE_TMP_DIR" = true ]; then
        rm -rf "$tmp_dir"
    fi
    if [ -f "${OVERRIDES_FILE}.bak" ]; then
        mv "${OVERRIDES_FILE}.bak" "$OVERRIDES_FILE"
    else
        rm -f "$OVERRIDES_FILE"
    fi
    solana config set --keypair "$old_default_keypair" > /dev/null
}

# Set up trap for cleanup
trap cleanup EXIT

# Prepare directories and files
rm -rf "$KEYS_DIR"
mkdir -p "$KEYS_DIR"

# Backup and create overrides file
cp "$OVERRIDES_FILE" "${OVERRIDES_FILE}.bak" 2>/dev/null || true
cat << EOF > "$OVERRIDES_FILE"
{
  "chains": {
    "Solana": {
      "rpc": "$NETWORK"
    }
  }
}
EOF

# Start Solana test validator
pushd "$validator_dir" || exit
# TODO: the deployment doesn't fully work, because we need to load in the wormhole program and its associated
# accounts. This is a bit tedious, but would be great to do.
# NOTE: this will not run in an emulated x86 docker environment (on an arm mac
# host), because the binary needs AVX instructions which the emulator doesn't
# support.
solana-test-validator --rpc-port "$PORT" --faucet-port "$FAUCET_PORT" > /dev/null 2>&1 &
pid=$!
popd || exit

old_default_keypair=$(solana config get keypair | awk '{print $3}')

# Wait for validator to start
echo "Waiting for Solana test validator to start..."
for _ in {1..30}; do
    if solana cluster-version -u "$NETWORK" &>/dev/null; then
        echo "Solana test validator started successfully."
        break
    fi
    sleep 1
done

# Check if validator started successfully
if ! kill -0 "$pid" 2>/dev/null; then
    echo "Failed to start solana-test-validator"
    exit 1
fi

# Initialize NTT
rm -rf "$DEPLOYMENT_FILE"
ntt init Mainnet

# Generate and configure keypairs
pushd "$KEYS_DIR" || exit
keypair=$(solana-keygen grind --starts-with w:1 --ignore-case | grep 'Wrote keypair' | awk '{print $4}')
keypair=$(realpath "$keypair")
solana config set --keypair "$keypair"

# Airdrop SOL
solana airdrop 50 -u "$NETWORK" --keypair "$keypair"
# This steps is a bit voodoo -- we airdrop to this special address, which is
# needed for querying the program version. For more info, grep for these pubkeys in the ntt repo.
solana airdrop 1 Hk3SdYTJFpawrvRz4qRztuEt2SqoCG7BGj2yJfDJSFbJ -u "$NETWORK" --keypair "$keypair" > /dev/null
solana airdrop 1 98evdAiWr7ey9MAQzoQQMwFQkTsSR6KkWQuFqKrgwNwb -u "$NETWORK" --keypair "$keypair" > /dev/null

# Create and configure token
token=$(spl-token create-token --program-id TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb -u "$NETWORK" | grep "Address:" | awk '{print $2}')
echo "Token: $token"

ntt_keypair=$(solana-keygen grind --starts-with ntt:1 --ignore-case | grep 'Wrote keypair' | awk '{print $4}')
ntt_keypair_without_json=${ntt_keypair%.json}
ntt_keypair=$(realpath "$ntt_keypair")
popd || exit

# Set token authority
authority=$(ntt solana token-authority "$ntt_keypair_without_json")
echo "Authority: $authority"
spl-token authorize "$token" mint "$authority" -u "$NETWORK"

# Add chain and upgrade
ntt add-chain Solana --ver 1.0.0 --mode burning --token "$token" --payer "$keypair" --program-key "$ntt_keypair"

echo "Getting status"
ntt status || true

solana program extend "$ntt_keypair_without_json" 100000 -u "$NETWORK"
ntt upgrade Solana --ver 2.0.0 --payer "$keypair" --program-key "$ntt_keypair" --yes
ntt status || true

ntt push --payer "$keypair" --yes

cat "$DEPLOYMENT_FILE"

if [ "$KEEP_ALIVE" = true ]; then
    # wait for C-c to kill the validator
    # print information about the running validator
    echo "==============================="
    echo "Validator is running on port $PORT"
    echo "Faucet is running on port $FAUCET_PORT"
    echo "Keys are stored in $KEYS_DIR"
    echo "Overrides are stored in $OVERRIDES_FILE"

    echo "Press Ctrl-C to stop the validator..."
    while true; do
        sleep 1
    done
fi
