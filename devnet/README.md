## Local Wormhole: Minimal .env + Bridge and NTT Transfers

All commands run from the repo root.

### 1) .env
Create a `.env` at the repo root :
```bash
DEPLOYER_KEY=<your_anvil_deployer_private_key>
DEV_GUARDIAN_KEY=<your_dev_guardian_private_key>
```

### 2) Start two local chains (keep running)
```bash
chmod +x devnet/scripts/start-local.sh
./devnet/scripts/start-local.sh
```

### 3) Deploy Core and Token Bridge
```bash
npx tsx devnet/scripts/deploy-core.ts
npx tsx devnet/scripts/deploy-tokenbridge.ts
```

Register chains (governance VAAs) both ways:
```bash
npx tsx devnet/scripts/register-chain.ts --source=chainA --dest=chainB
npx tsx devnet/scripts/register-chain.ts --source=chainB --dest=chainA
```

### 4) Token Bridge transfers (A→B and B→A)
Attest WETH on A and create wrapped on B:
```bash
export TOKEN_A=$(jq -r '.chains.chainA.weth' devnet/config/deployment.local.json)
npx tsx devnet/scripts/attest-and-wrap.ts --source=chainA --dest=chainB --token=$TOKEN_A
```

Transfer A→B:
```bash
export RECIPIENT=0x30ab12d7254ee06bc856b30a0524d3e77c89f4c8
npx tsx devnet/scripts/transfer-and-complete.ts \
  --source=chainA --dest=chainB --token=$TOKEN_A \
  --amount=1000000000000000000 --recipient=$RECIPIENT --wrap=true
```

Resolve wrapped token on B, then transfer B→A:
```bash
WRAP_JSON=$(npx tsx devnet/tools/get-wrapped.ts --source=chainA --dest=chainB --token=$TOKEN_A)
export WRAPPED_B=$(echo "$WRAP_JSON" | jq -r '.wrapped')
npx tsx devnet/scripts/transfer-and-complete.ts \
  --source=chainB --dest=chainA --token=$WRAPPED_B \
  --amount=1000000000000000000 --recipient=$RECIPIENT
```

### 5) NTT transfers (A→B and B→A)
Deploy NTT on both chains (LOCKING mode, no rate limiting):
```bash
npx tsx devnet/scripts/deploy-ntt-forge.ts --chain=chainA --variant=noRateLimiting --mode=locking
npx tsx devnet/scripts/deploy-ntt-forge.ts --chain=chainB --variant=noRateLimiting --mode=locking
```

Configure peers and prefund destination manager:
```bash
npx tsx devnet/scripts/configure-ntt.ts
```

Run the relayer (keep this running in a separate terminal):
```bash
npx tsx devnet/tools/relayer.ts --fromBlockA=0
```

Fund sender WETH if needed:
```bash
WETH_A=$(jq -r '.chains.chainA.weth' devnet/config/deployment.local.json)
WETH_B=$(jq -r '.chains.chainB.weth' devnet/config/deployment.local.json)
cast send "$WETH_A" 'deposit()' --value 1000000000000000000 --rpc-url http://127.0.0.1:8545 --private-key $DEPLOYER_KEY
cast send "$WETH_B" 'deposit()' --value 1000000000000000000 --rpc-url http://127.0.0.1:8546 --private-key $DEPLOYER_KEY
```

Transfer A→B:
```bash
export RECIPIENT=0x30ab12d7254ee06bc856b30a0524d3e77c89f4c8
npx tsx devnet/scripts/ntt-transfer.ts --source=chainA --dest=chainB --amount=1000000000000000000 --recipient=$RECIPIENT
```

Transfer B→A:
```bash
npx tsx devnet/scripts/ntt-transfer.ts --source=chainB --dest=chainA --amount=1000000000000000000 --recipient=$RECIPIENT
```

