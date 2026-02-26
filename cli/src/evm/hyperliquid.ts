/**
 * Hyperliquid L1 action helpers for HyperEVM / HyperCore integration
 */

import { ethers, Signature } from "ethers";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { colors } from "../colors.js";

const HYPERLIQUID_API = {
  testnet: "https://api.hyperliquid-testnet.xyz",
  mainnet: "https://api.hyperliquid.xyz",
};

const HYPEREVM_RPC = {
  testnet: "https://rpc.hyperliquid-testnet.xyz/evm",
  mainnet: "https://rpc.hyperliquid.xyz/evm",
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 30_000;

/**
 * fetch() wrapper that aborts and throws after `timeoutMs` milliseconds.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compute the EIP-712 connection-id hash for an L1 action.
 *
 * Hash = keccak256( msgpack(action) || nonce_be_8bytes || vault_byte(s) )
 */
function computeL1ActionHash(
  action: object,
  nonce: number,
  vaultAddress: string | null
): Uint8Array {
  const actionPacked = msgpackEncode(action);
  const nonceBytes = new Uint8Array(8);
  new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce), false); // big-endian
  const vaultBytes =
    vaultAddress === null
      ? new Uint8Array([0])
      : new Uint8Array([1, ...ethers.getBytes(vaultAddress.toLowerCase())]);
  const data = new Uint8Array(
    actionPacked.length + nonceBytes.length + vaultBytes.length
  );
  data.set(actionPacked, 0);
  data.set(nonceBytes, actionPacked.length);
  data.set(vaultBytes, actionPacked.length + nonceBytes.length);
  return ethers.getBytes(ethers.keccak256(data));
}

/**
 * Sign and send an L1 action (Exchange endpoint).
 *
 * NOTE: `vaultAddress` is intentionally omitted from the request body when
 * null — the HyperLiquid API returns HTTP 422 if the field is present as null.
 */
async function sendL1Action(
  wallet: ethers.Wallet,
  action: object,
  isTestnet: boolean
): Promise<{ status?: string; response?: unknown }> {
  const apiUrl = isTestnet ? HYPERLIQUID_API.testnet : HYPERLIQUID_API.mainnet;
  const nonce = Date.now();
  const connectionId = computeL1ActionHash(action, nonce, null);

  const sig = Signature.from(
    await wallet.signTypedData(
      {
        name: "Exchange",
        version: "1",
        chainId: 1337,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      {
        Agent: [
          { name: "source", type: "string" },
          { name: "connectionId", type: "bytes32" },
        ],
      },
      { source: isTestnet ? "b" : "a", connectionId }
    )
  );

  // vaultAddress is omitted entirely (not sent as null) to avoid HTTP 422
  const res = await fetchWithTimeout(`${apiUrl}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action,
      nonce,
      signature: { r: sig.r, s: sig.s, v: sig.v },
    }),
  });

  const json = (await res.json()) as { status?: string; response?: unknown };
  if (!res.ok || json.status === "err") {
    throw new Error(JSON.stringify(json.response ?? json));
  }
  return json;
}

/**
 * Enable or disable big blocks for HyperEVM deployments.
 * Big blocks are required for deploying large contracts like NTT.
 */
export async function setHyperEvmBigBlocks(
  privateKey: string,
  enable: boolean,
  isTestnet: boolean
): Promise<{ success: boolean; address: string; error?: string }> {
  const apiUrl = isTestnet ? HYPERLIQUID_API.testnet : HYPERLIQUID_API.mainnet;
  const action = { type: "evmUserModify", usingBigBlocks: enable };
  const nonce = Date.now();

  let wallet: ethers.Wallet | undefined;
  try {
    wallet = new ethers.Wallet(privateKey);
    // Compute action hash: keccak256(msgpack(action) + nonce_bytes + vault_byte)
    const actionPacked = msgpackEncode(action);
    const nonceBytes = new Uint8Array(8);
    new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce), false);
    const data = new Uint8Array(actionPacked.length + nonceBytes.length + 1);
    data.set(actionPacked, 0);
    data.set(nonceBytes, actionPacked.length);
    data[data.length - 1] = 0; // no vault

    const connectionId = ethers.keccak256(data);

    // Sign with EIP-712
    const sig = Signature.from(
      await wallet.signTypedData(
        {
          name: "Exchange",
          version: "1",
          chainId: 1337,
          verifyingContract: "0x0000000000000000000000000000000000000000",
        },
        {
          Agent: [
            { name: "source", type: "string" },
            { name: "connectionId", type: "bytes32" },
          ],
        },
        { source: isTestnet ? "b" : "a", connectionId }
      )
    );

    const res = await fetchWithTimeout(`${apiUrl}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        nonce,
        signature: { r: sig.r, s: sig.s, v: sig.v },
        vaultAddress: null,
      }),
    });

    const json = (await res.json()) as { status?: string; response?: unknown };
    if (!res.ok || json.status === "err") {
      throw new Error(JSON.stringify(json.response ?? json));
    }

    return { success: true, address: wallet.address };
  } catch (error) {
    return {
      success: false,
      address: wallet?.address ?? "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * CLI helper to enable/disable big blocks with console output and error handling
 */
export async function enableBigBlocks(
  isTestnet: boolean,
  enable: boolean = true
): Promise<void> {
  const privateKey = process.env.ETH_PRIVATE_KEY;
  if (!privateKey) {
    console.error(
      colors.red(
        "ETH_PRIVATE_KEY environment variable is not set. Please set it to your deployer wallet's private key."
      )
    );
    process.exit(1);
  }

  const networkName = isTestnet ? "HyperEVM Testnet" : "HyperEVM Mainnet";
  console.log(
    colors.cyan(
      `${enable ? "Enabling" : "Disabling"} big blocks on ${networkName}...`
    )
  );

  const result = await setHyperEvmBigBlocks(privateKey, enable, isTestnet);
  if (result.success) {
    console.log(
      colors.green(
        `Successfully ${enable ? "enabled" : "disabled"} big blocks for address ${result.address}`
      )
    );
  } else {
    console.error(colors.red(`Failed to set big blocks: ${result.error}`));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// HyperCore linking: requestEvmContract + finalizeEvmContract
// ---------------------------------------------------------------------------

/**
 * Step 1 of linking: request that a HyperCore spot token be backed by an
 * EVM contract.  The `address` is force-lowercased before msgpack encoding —
 * the API recovers the signer from the hash so casing must be canonical.
 */
export async function spotRequestEvmContract(
  privateKey: string,
  token: number,
  address: string,
  evmExtraWeiDecimals: number,
  isTestnet: boolean
): Promise<void> {
  const wallet = new ethers.Wallet(privateKey);
  const action = {
    type: "spotDeploy",
    requestEvmContract: {
      token,
      address: address.toLowerCase(), // MUST be lowercase
      evmExtraWeiDecimals,
    },
  };
  await sendL1Action(wallet, action, isTestnet);
}

/**
 * Step 2 of linking: finalize the EVM contract link using the deployer nonce
 * at which the ERC-20 contract was created.
 *
 * The action type is `finalizeEvmContract` (top-level, NOT nested under
 * `spotDeploy`).
 */
export async function spotFinalizeEvmContract(
  privateKey: string,
  token: number,
  nonce: number,
  isTestnet: boolean
): Promise<void> {
  const wallet = new ethers.Wallet(privateKey);
  const action = {
    type: "finalizeEvmContract",
    token,
    input: { create: { nonce } },
  };
  await sendL1Action(wallet, action, isTestnet);
}

// ---------------------------------------------------------------------------
// spotSend — bridge OUT (HyperCore → HyperEVM)
// ---------------------------------------------------------------------------

/**
 * Send spot tokens from HyperCore to a HyperEVM address via the asset bridge.
 *
 * This uses a *different* signing scheme from L1 actions:
 *   - EIP-712 domain name: "HyperliquidSignTransaction"
 *   - Chain ID: 421614 (testnet) or 42161 (mainnet) — NOT 1337
 *   - The `time` field acts as the nonce and is included in both the action
 *     object and the typed-data payload.
 *   - `vaultAddress` must be omitted from the request body entirely.
 */
export async function spotSend(
  privateKey: string,
  destination: string,
  token: string, // e.g. "WSV:0x7d816f61ba433274b37f7c2df8cb62e5"
  amount: string, // human-readable, e.g. "1.0"
  isTestnet: boolean
): Promise<void> {
  const apiUrl = isTestnet ? HYPERLIQUID_API.testnet : HYPERLIQUID_API.mainnet;
  const wallet = new ethers.Wallet(privateKey);
  const time = Date.now();

  const action = {
    type: "spotSend",
    hyperliquidChain: isTestnet ? "Testnet" : "Mainnet",
    signatureChainId: isTestnet ? "0x66eee" : "0xa4b1",
    destination,
    token,
    amount,
    time,
  };

  const domain = {
    name: "HyperliquidSignTransaction",
    version: "1",
    chainId: isTestnet ? 421614 : 42161,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  };

  const types = {
    "HyperliquidTransaction:SpotSend": [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination", type: "string" },
      { name: "token", type: "string" },
      { name: "amount", type: "string" },
      { name: "time", type: "uint64" },
    ],
  };

  const value = {
    hyperliquidChain: action.hyperliquidChain,
    destination: action.destination,
    token: action.token,
    amount: action.amount,
    time: action.time,
  };

  const sig = Signature.from(await wallet.signTypedData(domain, types, value));

  // vaultAddress omitted entirely — never send as null
  const res = await fetchWithTimeout(`${apiUrl}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action,
      nonce: time,
      signature: { r: sig.r, s: sig.s, v: sig.v },
    }),
  });

  const json = (await res.json()) as { status?: string; response?: unknown };
  if (!res.ok || json.status === "err") {
    throw new Error(JSON.stringify(json.response ?? json));
  }
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Compute the deterministic asset bridge address for a given HyperCore token
 * index.
 *
 * Formula: 0x200000000000000000000000000000000000{tokenIndex hex, 4 digits}
 */
export function computeAssetBridge(tokenIndex: number): string {
  if (!Number.isInteger(tokenIndex) || tokenIndex < 0 || tokenIndex > 0xffff) {
    throw new Error("tokenIndex must be an integer in range [0, 65535]");
  }
  const hex = tokenIndex.toString(16).padStart(4, "0");
  return `0x200000000000000000000000000000000000${hex}`;
}

/**
 * Return the checksum address for a private key (no network call needed).
 */
export function getDeployerAddress(privateKey: string): string {
  return new ethers.Wallet(privateKey).address;
}

/**
 * Find the CREATE deployment nonce at which `deployer` produced
 * `targetAddress`.  Iterates from nonce 0 upward.
 *
 * Throws if not found within `maxNonce` iterations.
 */
export function computeDeployNonce(
  deployer: string,
  targetAddress: string,
  maxNonce = 1000
): number {
  const target = targetAddress.toLowerCase();
  for (let nonce = 0; nonce <= maxNonce; nonce++) {
    const derived = ethers
      .getCreateAddress({ from: deployer, nonce })
      .toLowerCase();
    if (derived === target) return nonce;
  }
  throw new Error(
    `Could not find deploy nonce for ${targetAddress} from ${deployer} within ${maxNonce} iterations`
  );
}

/**
 * Resolve a practical nonce search bound from HyperEVM, then derive the
 * CREATE nonce for `targetAddress`.
 *
 * Uses the deployer's current tx count as the upper bound, with a minimum
 * floor so low-activity accounts still work out of the box.
 */
export async function computeDeployNonceFromHyperEvm(
  deployer: string,
  targetAddress: string,
  isTestnet: boolean,
  hardCap = 1_000_000
): Promise<number> {
  const rpcUrl = isTestnet ? HYPEREVM_RPC.testnet : HYPEREVM_RPC.mainnet;
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const txCount = await provider.getTransactionCount(deployer, "latest");
  const boundedMax = Math.min(Math.max(txCount + 32, 1000), hardCap);
  return computeDeployNonce(deployer, targetAddress, boundedMax);
}

/**
 * Bridge tokens from HyperEVM into HyperCore by calling ERC-20
 * `transfer(assetBridge, amount)` on the HyperEVM RPC.
 *
 * `amount` is a human-readable string (e.g. "1.0"). The ERC-20's `decimals()`
 * is queried on-chain and used to convert to the raw uint256 before sending.
 *
 * Returns the transaction hash.
 */
export async function bridgeIn(
  privateKey: string,
  tokenAddress: string,
  assetBridge: string,
  amount: string,
  isTestnet: boolean
): Promise<string> {
  const rpcUrl = isTestnet ? HYPEREVM_RPC.testnet : HYPEREVM_RPC.mainnet;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  const erc20Abi = [
    "function decimals() view returns (uint8)",
    "function transfer(address to, uint256 amount) returns (bool)",
  ];
  const token = new ethers.Contract(tokenAddress, erc20Abi, wallet);
  const decimals = Number(await token.decimals());
  const rawAmount = ethers.parseUnits(amount, decimals);

  const tx = await token.transfer(assetBridge, rawAmount);
  await tx.wait();
  return tx.hash as string;
}

/**
 * Query the HyperLiquid info API for the spot token string
 * in the form `"NAME:0x<tokenId>"`.
 *
 * Used as the `token` field in `spotSend`.
 */
export async function getSpotTokenString(
  tokenIndex: number,
  isTestnet: boolean
): Promise<string> {
  const apiUrl = isTestnet ? HYPERLIQUID_API.testnet : HYPERLIQUID_API.mainnet;

  const res = await fetchWithTimeout(`${apiUrl}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "spotMeta" }),
  });

  if (!res.ok) {
    throw new Error(`spotMeta request failed: ${res.status} ${res.statusText}`);
  }

  type SpotToken = { index: number; name: string; tokenId: string };
  type SpotMeta = { tokens: SpotToken[] };
  const json = (await res.json()) as SpotMeta;

  const token = json.tokens.find((t) => t.index === tokenIndex);
  if (!token) {
    throw new Error(`Token index ${tokenIndex} not found in spotMeta`);
  }

  return `${token.name}:${token.tokenId}`;
}
