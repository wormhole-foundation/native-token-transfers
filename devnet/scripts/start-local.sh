#!/usr/bin/env bash
set -euo pipefail
ANVIL_A_PORT=8545
ANVIL_B_PORT=8546
CHAIN_A_ID=31337
CHAIN_B_ID=31338
BLOCK_TIME=${BLOCK_TIME:-1}
# Space-separated list of addresses to pre-fund on both chains (override via env)
FUND_ADDRESSES=${FUND_ADDRESSES:-"0xce178188095c35676407b43208a05e9d5c4a8bc9 0x30ab12d7254ee06bc856b30a0524d3e77c89f4c8"}
# Amount to fund in wei (hex string). Default ≈ 1,000 ETH.
FUND_WEI_HEX=${FUND_WEI_HEX:-0x3635C9ADC5DEA00000}

if ! command -v anvil >/dev/null 2>&1; then
  echo "anvil not found. Install Foundry: https://book.getfoundry.sh/" >&2
  exit 1
fi
if ! command -v cast >/dev/null 2>&1; then
  echo "cast not found. Install Foundry (includes cast): https://book.getfoundry.sh/" >&2
  exit 1
fi

anvil --chain-id "$CHAIN_A_ID" --port "$ANVIL_A_PORT" --block-time "$BLOCK_TIME" --steps-tracing --silent &
PID_A=$!

anvil --chain-id "$CHAIN_B_ID" --port "$ANVIL_B_PORT" --block-time "$BLOCK_TIME" --steps-tracing --silent &
PID_B=$!

echo "Chain A (id=$CHAIN_A_ID) running at http://127.0.0.1:$ANVIL_A_PORT (pid $PID_A)"
echo "Chain B (id=$CHAIN_B_ID) running at http://127.0.0.1:$ANVIL_B_PORT (pid $PID_B)"

# Wait for both RPCs to be ready
for URL in "http://127.0.0.1:$ANVIL_A_PORT" "http://127.0.0.1:$ANVIL_B_PORT"; do
  for i in {1..50}; do
    if curl -fsS -X POST "$URL" -H 'Content-Type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"web3_clientVersion","params":[]}' >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
done

# Pre-fund requested addresses on both chains
echo "Pre-funding addresses on Chain A and Chain B with ${FUND_WEI_HEX} wei..."
for ADDR in $FUND_ADDRESSES; do
  # Normalize to lowercase 0x-prefixed
  LADDR=$(echo "$ADDR" | tr '[:upper:]' '[:lower:]')
  # Pass params as separate args (not a JSON array string)
  cast rpc --rpc-url "http://127.0.0.1:$ANVIL_A_PORT" anvil_setBalance "$LADDR" "$FUND_WEI_HEX" >/dev/null
  cast rpc --rpc-url "http://127.0.0.1:$ANVIL_B_PORT" anvil_setBalance "$LADDR" "$FUND_WEI_HEX" >/dev/null
  echo "  → Funded $LADDR on A:$ANVIL_A_PORT and B:$ANVIL_B_PORT"
done

echo "Use 'kill $PID_A' and 'kill $PID_B' to stop the nodes."
wait
