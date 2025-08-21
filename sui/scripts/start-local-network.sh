#!/bin/bash

# Start Local Sui Network for Testing
# This script sets up a local Sui network for NTT development and testing

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SUI_CONFIG_DIR="$PROJECT_ROOT/.sui"
NETWORK_CONFIG="$SUI_CONFIG_DIR/sui_config"

echo "🚀 Starting local Sui network for NTT testing..."

# Clean up any existing network
cleanup() {
    echo "🧹 Cleaning up..."
    pkill -f "sui start" || true
    rm -rf "$SUI_CONFIG_DIR" || true
}

# Set up cleanup trap
trap cleanup EXIT

# Create config directory
mkdir -p "$SUI_CONFIG_DIR"

# Generate genesis config
echo "📝 Generating genesis configuration..."
cd "$SUI_CONFIG_DIR"

# Create a simple genesis config for local testing
cat > genesis.yaml << EOF
---
validator_genesis_info: []
committee_size: 1
epoch_duration_ms: 86400000  # 24 hours
protocol_version: 1
chain_start_timestamp_ms: $(date +%s)000
allow_insertion_of_extra_objects: true

accounts:
  - address: "0x0000000000000000000000000000000000000000000000000000000000000000"
    gas_objects:
      - object_id: "0x0000000000000000000000000000000000000000000000000000000000000001"
        version: 1
        owner: "0x0000000000000000000000000000000000000000000000000000000000000000"
        object_type: "0x2::coin::Coin<0x2::sui::SUI>"
        gas_coin_value: 100000000000000  # 100M SUI
  - address: "0x1111111111111111111111111111111111111111111111111111111111111111"
    gas_objects:
      - object_id: "0x1111111111111111111111111111111111111111111111111111111111111112"
        version: 1
        owner: "0x1111111111111111111111111111111111111111111111111111111111111111"
        object_type: "0x2::coin::Coin<0x2::sui::SUI>"
        gas_coin_value: 100000000000000  # 100M SUI
EOF

# Initialize Sui client configuration
echo "⚙️ Initializing Sui client..."
export SUI_CONFIG_DIR="$SUI_CONFIG_DIR"

# Create client config directory and files manually to avoid interactive prompts
mkdir -p "$SUI_CONFIG_DIR"

# Create a basic client config
cat > "$SUI_CONFIG_DIR/client.yaml" << EOF
keystore:
  File: "$SUI_CONFIG_DIR/sui.keystore"
envs:
  - alias: local
    rpc: "http://127.0.0.1:9000"
    ws: ~
active_env: local
active_address: ~
EOF

# Create empty keystore file
echo '[]' > "$SUI_CONFIG_DIR/sui.keystore"

# Start the local network first so we can generate addresses
echo "🌐 Starting local Sui network on port 9000..."
sui start --with-faucet --force-regenesis > "$SUI_CONFIG_DIR/sui.log" 2>&1 &
SUI_PID=$!

# Wait for network to be ready with better timeout and error handling
echo "⏳ Waiting for network to be ready..."
for i in {1..60}; do
    if curl -s -m 2 http://127.0.0.1:9000 > /dev/null 2>&1; then
        echo "✅ Local Sui network is ready!"
        break
    fi
    if [ $i -eq 60 ]; then
        echo "❌ Failed to start local Sui network"
        echo "📋 Recent log output:"
        tail -20 "$SUI_CONFIG_DIR/sui.log" || echo "No log file found"
        exit 1
    fi
    sleep 1
done

# Test RPC is actually working
echo "🔍 Testing RPC functionality..."
if curl -s -X POST -H "Content-Type: application/json" \
   -d '{"jsonrpc":"2.0","method":"suix_getTotalSupply","params":["0x2::sui::SUI"],"id":1}' \
   http://127.0.0.1:9000 | grep -q "result"; then
    echo "✅ RPC is functioning correctly!"
else
    echo "⚠️  RPC may not be fully ready, but continuing..."
fi

# Generate test keypairs now that network is running
echo "🔑 Generating test keypairs..."
TEST_KEY_1=$(sui client new-address ed25519 test-wallet-1 2>/dev/null | grep -o '0x[a-fA-F0-9]*' | head -1 || echo "")
TEST_KEY_2=$(sui client new-address ed25519 test-wallet-2 2>/dev/null | grep -o '0x[a-fA-F0-9]*' | head -1 || echo "")

echo "Generated test addresses:"
echo "  Test Wallet 1: $TEST_KEY_1"
echo "  Test Wallet 2: $TEST_KEY_2"

PRIVKEY_1=$(sui keytool export --key-identity test-wallet-1 --json  | jq .exportedPrivateKey -r | xargs sui keytool convert --json | jq '.base64WithFlag' -r)
PRIVKEY_2=$(sui keytool export --key-identity test-wallet-2 --json  | jq .exportedPrivateKey -r | xargs sui keytool convert --json | jq '.base64WithFlag' -r)

echo "  Test Wallet 1 Private Key: $PRIVKEY_1"
echo "  Test Wallet 2 Private Key: $PRIVKEY_2"

# Wait a bit for faucet to be ready
echo "⏳ Waiting for faucet..."
sleep 5

# Test faucet availability first
echo "🔍 Testing faucet availability..."
if curl -s -m 5 http://127.0.0.1:9123 > /dev/null 2>&1; then
    echo "✅ Faucet is responding!"

    # Request faucet for test addresses
    echo "💰 Requesting test funds from faucet..."
    if [ -n "$TEST_KEY_1" ]; then
        sui client faucet --address "$TEST_KEY_1" || echo "⚠️  Faucet request failed for wallet 1"
    fi
    if [ -n "$TEST_KEY_2" ]; then
        sui client faucet --address "$TEST_KEY_2" || echo "⚠️  Faucet request failed for wallet 2"
    fi
else
    echo "⚠️  Faucet not ready yet - you can request funds manually later"
    echo "💡 Manual faucet request:"
    echo "   curl -X POST http://127.0.0.1:9123/gas -H 'Content-Type: application/json' -d '{\"FixedAmountRequest\":{\"recipient\":\"YOUR_ADDRESS\"}}'"
fi

# Deploy Wormhole contracts
echo ""
echo "🐛 Deploying Wormhole contracts..."
WORMHOLE_DIR="$PROJECT_ROOT/.wormhole"

# Clone or update the wormhole repository
if [ -d "$WORMHOLE_DIR" ]; then
    echo "📂 Updating existing Wormhole repository..."
    cd "$WORMHOLE_DIR"
    git fetch origin
    git checkout sui/modernise-package-envs
    git reset --hard origin/sui/modernise-package-envs
else
    echo "📥 Cloning Wormhole repository..."
    git clone https://github.com/wormholelabs-xyz/wormhole "$WORMHOLE_DIR"
    cd "$WORMHOLE_DIR"
    git checkout sui/modernise-package-envs
fi

# Deploy Wormhole contracts
echo "🚀 Deploying Wormhole contracts to local network..."
cd "$WORMHOLE_DIR/sui"
./scripts/deploy.sh devnet --private-key "$PRIVKEY_1"

# Switch to devnet configuration
echo "🔄 Switching to devnet configuration..."
./scripts/switch.sh devnet

echo "✅ Wormhole contracts deployed successfully!"

# Save important info for tests
cat > "$PROJECT_ROOT/sui/test-config.json" << EOF
{
  "network": "localnet",
  "rpc": "http://127.0.0.1:9000",
  "faucet": "http://127.0.0.1:9123/gas",
  "testAddresses": {
    "wallet1": "$TEST_KEY_1",
    "wallet2": "$TEST_KEY_2"
  },
  "configDir": "$SUI_CONFIG_DIR",
  "wormholeDir": "$WORMHOLE_DIR"
}
EOF

echo "📄 Test configuration saved to sui/test-config.json"
echo ""
echo "🎉 Local Sui network is running!"
echo "   RPC endpoint: http://127.0.0.1:9000"
echo "   Faucet: http://127.0.0.1:9123/gas"
echo "   Network PID: $SUI_PID"
echo ""
echo "💡 To deploy NTT for testing:"
echo "   cd cli"
echo "   npm run build"
echo "   node dist/index.js add-chain --chain Sui --network Localnet --rpc http://127.0.0.1:9000"
echo ""
echo "🛑 Press Ctrl+C to stop the network"

# Function to cleanup on exit
cleanup() {
    echo ""
    echo "🧹 Cleaning up network..."
    kill $SUI_PID 2>/dev/null || true
    wait $SUI_PID 2>/dev/null || true
    echo "✅ Network stopped"
}

# Set up signal handlers
trap cleanup INT TERM EXIT

# Keep the script running
wait $SUI_PID
