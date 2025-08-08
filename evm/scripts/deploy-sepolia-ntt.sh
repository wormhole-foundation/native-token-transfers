#!/bin/bash

# Deploy Sepolia NTT using configuration from .env.sepolia
# This script loads the Sepolia-specific environment variables and runs the Forge deployment

echo "Deploying NTT to Sepolia..."

# Load Sepolia-specific .env file
if [ ! -f .env.sepolia ]; then
    echo "Error: .env.sepolia file not found!"
    exit 1
fi

source .env.sepolia

# Export all environment variables so they're available to the forge script
export PRIVATE_KEY
export RPC_URL  
export RELEASE_CORE_BRIDGE_ADDRESS
export RELEASE_MODE
export RELEASE_WORMHOLE_CHAIN_ID
export RELEASE_RATE_LIMIT_DURATION
export RELEASE_SKIP_RATE_LIMIT
export RELEASE_OUTBOUND_LIMIT
export RELEASE_WORMHOLE_RELAYER_ADDRESS
export RELEASE_SPECIAL_RELAYER_ADDRESS
export RELEASE_CONSISTENCY_LEVEL
export RELEASE_GAS_LIMIT
export ETHERSCAN_API_KEY

echo "Environment variables loaded and exported from .env.sepolia:"
echo "  RPC_URL=$RPC_URL"
echo "  RELEASE_CORE_BRIDGE_ADDRESS=$RELEASE_CORE_BRIDGE_ADDRESS"
echo "  RELEASE_MODE=$RELEASE_MODE (1=BURNING for destination chain)"
echo "  RELEASE_WORMHOLE_CHAIN_ID=$RELEASE_WORMHOLE_CHAIN_ID"
echo "  RELEASE_RATE_LIMIT_DURATION=$RELEASE_RATE_LIMIT_DURATION"
echo "  RELEASE_SKIP_RATE_LIMIT=$RELEASE_SKIP_RATE_LIMIT"
echo "  RELEASE_OUTBOUND_LIMIT=$RELEASE_OUTBOUND_LIMIT"

# Check if private key is set
if [ -z "$PRIVATE_KEY" ]; then
    echo "Error: PRIVATE_KEY not set in .env.sepolia file!"
    echo "Please add your Sepolia private key to .env.sepolia"
    exit 1
fi

# Run the Forge deployment script
echo ""
echo "Running Forge deployment..."
forge script script/DeploySepoliaNtt.s.sol \
    --rpc-url $RPC_URL \
    --private-key $PRIVATE_KEY \
    --broadcast \
    --slow \
    -vvvv

echo "Deployment complete!"