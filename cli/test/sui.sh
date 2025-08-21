#!/usr/bin/env bash

# This script deploys the NTT program to a local Sui test network
# Prerequisites:
# - Local Sui node running (sui start --with-faucet)
# - Sui CLI configured

set -euo pipefail

# Change to project root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

# Default values
NETWORK="local"
SUI_RPC_URL="http://127.0.0.1:9000"
DEPLOYMENT_FILE="deployment.json"
OVERRIDES_FILE="overrides.json"
KEEP_ALIVE=false
USE_TMP_DIR=false

# Set SUI_CONFIG_DIR if not already set
if [ -z "${SUI_CONFIG_DIR:-}" ]; then
    # Check for .sui directory in project root
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
    if [ -d "$PROJECT_ROOT/.sui" ]; then
        export SUI_CONFIG_DIR="$PROJECT_ROOT/.sui"
    fi
fi

# Function to display usage information
usage() {
    cat << EOF
Usage: $0 [options]

Options:
    -h, --help              Show this help message
    -n, --network NETWORK   Set the Sui network (default: local)
    -r, --rpc-url URL       Set the Sui RPC URL (default: http://127.0.0.1:9000)
    -d, --deployment FILE   Set the deployment file (default: deployment.json)
    -o, --overrides FILE    Set the overrides file (default: overrides.json)
    --keep-alive            Keep the script running after deployment
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
        -n|--network)
            NETWORK="$2"
            shift 2
            ;;
        -r|--rpc-url)
            SUI_RPC_URL="$2"
            shift 2
            ;;
        -d|--deployment)
            DEPLOYMENT_FILE="$2"
            shift 2
            ;;
        -o|--overrides)
            OVERRIDES_FILE="$2"
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

if [ "$USE_TMP_DIR" = true ]; then
   tmp_dir=$(mktemp -d)
   cd "$tmp_dir" || exit
   ntt new test-ntt
   cd test-ntt || exit
fi

# Function to clean up resources
cleanup() {
    echo "Cleaning up..."
    if [ "$USE_TMP_DIR" = true ]; then
        rm -rf "$tmp_dir"
    fi
    if [ -f "${OVERRIDES_FILE}.bak" ]; then
        mv "${OVERRIDES_FILE}.bak" "$OVERRIDES_FILE"
    else
        rm -f "$OVERRIDES_FILE"
    fi
}

# Set up trap for cleanup
# trap cleanup EXIT

# Backup and create overrides file
cp "$OVERRIDES_FILE" "${OVERRIDES_FILE}.bak" 2>/dev/null || true
cat << EOF > "$OVERRIDES_FILE"
{
  "chains": {
    "Sui": {
      "rpc": "$SUI_RPC_URL"
    }
  }
}
EOF

# Check if Sui node is running
echo "Checking Sui network connectivity..."
if ! sui client objects --json >/dev/null 2>&1; then
    echo "Failed to connect to Sui network. Make sure your local Sui node is running."
    echo "Run: sui start --with-faucet"
    exit 1
fi

# Get active address
ACTIVE_ADDRESS=$(sui client active-address)
echo "Using Sui address: $ACTIVE_ADDRESS"

# Export the private key for the active address
# Get the active keystore entry
ACTIVE_ALIAS=$(sui client addresses --json | jq -r '.activeAddress' || echo "")
if [ -z "$ACTIVE_ALIAS" ]; then
    echo "No active address found. Creating a new one..."
    sui client new-address ed25519
    ACTIVE_ADDRESS=$(sui client active-address)
fi

# Export private key
PRIVATE_KEY=$(sui keytool export --key-identity "$ACTIVE_ADDRESS" --json 2>/dev/null | jq -r '.exportedPrivateKey' || echo "")
if [ -n "$PRIVATE_KEY" ]; then
    export SUI_PRIVATE_KEY="$PRIVATE_KEY"
    echo "Private key exported for deployment"
else
    echo "Warning: Could not export private key. You may need to set SUI_PRIVATE_KEY manually."
fi

# Check balance
BALANCE_OUTPUT=$(sui client balance --json 2>/dev/null || echo '[[],false]')
# The output is a tuple [balances, has_next_page]
BALANCES=$(echo "$BALANCE_OUTPUT" | jq -r '.[0]')
if [ "$BALANCES" = "[]" ] || [ "$BALANCES" = "null" ]; then
    echo "No SUI balance found. Requesting from faucet..."
    curl -X POST http://127.0.0.1:9123/gas \
        -H 'Content-Type: application/json' \
        -d "{\"FixedAmountRequest\":{\"recipient\":\"$ACTIVE_ADDRESS\"}}" || {
        echo "Failed to request from faucet. You may need to manually fund the address."
    }
    sleep 2
fi

# Initialize NTT deployment
rm -rf "$DEPLOYMENT_FILE"
ntt init Devnet

# Create a test token (using SUI for simplicity in this test)
# In a real deployment, you would create your own token type
TOKEN_TYPE="0x2::sui::SUI"
echo "Using token type: $TOKEN_TYPE"

# Deploy NTT
echo "Deploying NTT to Sui..."
ntt add-chain Sui \
    --mode burning \
    --token "$TOKEN_TYPE" \
    --path "$DEPLOYMENT_FILE" \
    --yes \
    --local \
    --sui-gas-budget 500000000 \
    --sui-wormhole-state "0xd6d208df9266c35caa7cb1d974feac206319adb5d3b45dc139d328b8f04cfafa"

# Get deployment status
echo "Getting deployment status..."
ntt status || true

# Push configuration
echo "Pushing configuration..."
ntt push --yes || true

# Test setPeer functionality
echo "Testing setPeer functionality..."
echo "Setting up a mock Ethereum peer for testing..."

# Use a mock Ethereum NTT manager address for testing
MOCK_ETHEREUM_MANAGER="0x742d35Cc6634C0532925a3b8D0C85e3c4e5cBB8D"
ETHEREUM_TOKEN_DECIMALS=18
INBOUND_LIMIT="1000000000000000000"  # 1 ETH equivalent

ntt manual set-peer Ethereum "$MOCK_ETHEREUM_MANAGER" \
    --chain Sui \
    --token-decimals "$ETHEREUM_TOKEN_DECIMALS" \
    --inbound-limit "$INBOUND_LIMIT" \
    --path "$DEPLOYMENT_FILE" \
    --network Devnet || {
    echo "setPeer test failed, but continuing..."
}

echo "setPeer test completed."

# Display deployment info
echo "==============================="
echo "Deployment completed!"
echo "Deployment file: $DEPLOYMENT_FILE"
cat "$DEPLOYMENT_FILE"

if [ "$KEEP_ALIVE" = true ]; then
    echo "==============================="
    echo "Deployment is complete. Script will keep running."
    echo "Press Ctrl-C to exit..."
    while true; do
        sleep 1
    done
fi