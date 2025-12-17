#!/usr/bin/env bash

# Build Solana NTT contracts v2.0.0
# This script pre-compiles the v2.0.0 contracts with a fixed test program ID.
# Run in parallel with build-solana-v1.sh to speed up CI.

set -euo pipefail

VERSION="2.0.0"
TAG="v${VERSION}+solana"
OUTPUT_DIR="${OUTPUT_DIR:-/tmp/solana-artifacts}"

# Fixed test program keypair - used for CI testing only
# Public key: Bvv5frBLZmx28CgsAKvYvgXypvo3TvsHrHW2mqWqmHCm
TEST_KEYPAIR='[179,77,30,203,65,57,43,106,6,167,254,168,64,241,242,193,139,67,253,246,58,52,110,1,51,195,213,151,73,98,212,80,162,100,171,164,23,249,197,233,44,2,3,48,4,239,57,48,31,204,108,53,53,170,172,128,215,24,89,68,249,99,174,234]'
TEST_PROGRAM_ID="Bvv5frBLZmx28CgsAKvYvgXypvo3TvsHrHW2mqWqmHCm"

echo "=== Building Solana NTT ${VERSION} ==="

# Create output directory for artifacts
mkdir -p "$OUTPUT_DIR/v${VERSION}"

# Write the test keypair
echo "$TEST_KEYPAIR" > "$OUTPUT_DIR/v${VERSION}/program-keypair.json"

# Create a temporary directory for this version
tmp_dir=$(mktemp -d)
trap "rm -rf $tmp_dir" EXIT

cd "$tmp_dir" || exit

# Clone the repo at the specific tag
git clone --depth 1 --branch "$TAG" https://github.com/wormhole-foundation/native-token-transfers.git ntt
cd ntt/solana || exit

# Update Anchor.toml with test program ID
echo "Patching Anchor.toml with test program ID: $TEST_PROGRAM_ID"
sed -i.bak "s/example_native_token_transfers = \".*\"/example_native_token_transfers = \"$TEST_PROGRAM_ID\"/" Anchor.toml

# Also update the declare_id! macro in the program source
echo "Patching lib.rs with test program ID"
sed -i.bak "s/declare_id!(\"[^\"]*\")/declare_id!(\"$TEST_PROGRAM_ID\")/" programs/example-native-token-transfers/src/lib.rs

echo "Building with anchor..."
anchor build --arch sbf -- --no-default-features --features mainnet

echo "=== v${VERSION} build complete ==="

# Copy the .so files we need
cp target/deploy/*.so "$OUTPUT_DIR/v${VERSION}/" 2>/dev/null || \
cp target/sbf-solana-solana/release/*.so "$OUTPUT_DIR/v${VERSION}/" 2>/dev/null || \
{ echo "ERROR: Could not find .so files in target/deploy or target/sbf-solana-solana/release"; exit 1; }

ls -la "$OUTPUT_DIR/v${VERSION}/"
