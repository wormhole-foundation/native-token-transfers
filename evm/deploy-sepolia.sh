#!/bin/bash

# Load environment variables from .env.sepolia
set -a
source .env.sepolia
set +a

# Deploy using forge
forge script script/DeploySepoliaNtt.s.sol \
    --rpc-url $RPC_URL \
    --private-key $PRIVATE_KEY \
    --broadcast