import fs from "fs";
import {
  Client,
  ECDSA,
  Wallet,
  isValidClassicAddress,
  type SubmittableTransaction,
  type TxResponse,
} from "xrpl";
import type {
  Network,
  WormholeConfigOverrides,
} from "@wormhole-foundation/sdk-connect";
import { colors } from "../colors.js";

/** Default public XRPL WebSocket endpoints, keyed by Wormhole network. */
export const XRPL_ENDPOINTS: Record<Network, string> = {
  Mainnet: "wss://xrplcluster.com",
  Testnet: "wss://s.altnet.rippletest.net:51233",
  Devnet: "wss://s.devnet.rippletest.net:51233",
};

/** Public XRPL faucet hosts (testnet/devnet only). */
export const XRPL_FAUCET_HOSTS: Partial<Record<Network, string>> = {
  Testnet: "faucet.altnet.rippletest.net",
  Devnet: "faucet.devnet.rippletest.net",
};

/**
 * Resolve the XRPL endpoint to connect to. Precedence:
 *   --rpc flag  >  overrides.json (chains.Xrpl.rpc)  >  built-in network default.
 */
export function resolveXrplEndpoint(
  network: Network,
  rpcOverride?: string,
  overrides?: WormholeConfigOverrides<Network>
): string {
  if (rpcOverride) return rpcOverride;
  // `Xrpl` may not be a typed chain key in the SDK; access defensively.
  const fromOverrides = (overrides?.chains as any)?.Xrpl?.rpc as
    | string
    | undefined;
  if (fromOverrides) return fromOverrides;
  return XRPL_ENDPOINTS[network];
}

/** Connect a client to `endpoint`, run `fn`, and always disconnect afterwards. */
export async function withXrplClient<T>(
  endpoint: string,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client(endpoint);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

/**
 * Autofill, sign, and submit a transaction, waiting for validation.
 * Throws if the engine result is anything other than `tesSUCCESS`.
 */
export async function submitTx(
  client: Client,
  wallet: Wallet,
  tx: SubmittableTransaction
): Promise<TxResponse> {
  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);
  const meta = result.result.meta;
  const code =
    meta && typeof meta !== "string" ? meta.TransactionResult : undefined;
  if (code !== "tesSUCCESS") {
    throw new Error(
      `${tx.TransactionType} failed: ${code ?? "unknown result"} (hash ${result.result.hash})`
    );
  }
  return result;
}

/** Throw unless `address` is a valid XRPL classic (r-) address. */
export function validateRAddress(address: string): string {
  if (!isValidClassicAddress(address)) {
    throw new Error(`Invalid XRPL address: ${address}`);
  }
  return address;
}

/**
 * Account reserve settings from the connected server (in XRP): the base reserve
 * plus the per-owned-object increment.
 */
export async function getReserveBase(
  client: Client
): Promise<{ baseXrp: number; incXrp: number }> {
  const info = await client.request({ command: "server_info" });
  const ledger = info.result.info.validated_ledger;
  if (!ledger?.reserve_base_xrp || ledger.reserve_inc_xrp === undefined) {
    throw new Error("Could not read reserve settings from server_info");
  }
  return { baseXrp: ledger.reserve_base_xrp, incXrp: ledger.reserve_inc_xrp };
}

/** Derive a wallet from a seed, optionally forcing the key algorithm. */
export function walletFromSeed(
  seed: string,
  algorithm?: "ed25519" | "secp256k1"
): Wallet {
  const algo =
    algorithm === "ed25519"
      ? ECDSA.ed25519
      : algorithm === "secp256k1"
        ? ECDSA.secp256k1
        : undefined;
  return Wallet.fromSeed(seed, algo ? { algorithm: algo } : undefined);
}

/** Read a seed from a flag value, falling back to an environment variable. */
export function loadSeed(
  flagValue: string | undefined,
  flagName: string,
  envName: string
): string {
  const seed = flagValue ?? process.env[envName];
  if (!seed) {
    throw new Error(
      `Missing seed: pass --${flagName} or set ${envName} in the environment`
    );
  }
  return seed;
}

/** MPT issuance flags (see xrpl.org MPTokenIssuanceCreate). */
export const MPT_FLAGS = {
  tfMPTCanLock: 0x0002, // issuer can lock/freeze individual holders
  tfMPTRequireAuth: 0x0004, // issuer must authorise each holder
  tfMPTCanEscrow: 0x0008, // tokens can be escrowed
  tfMPTCanTrade: 0x0010, // tokens can be placed on the DEX
  tfMPTCanTransfer: 0x0020, // holders can transfer (omit = issuer-only)
  tfMPTCanClawback: 0x0040, // issuer can claw back tokens from holders
} as const;

// MPTokenIssuanceCreate field limits (per the XRPL protocol reference).
export const MPT_MAX_ASSET_SCALE = 255; // UInt8
export const MPT_MAX_TRANSFER_FEE = 50_000; // tenths of a basis point (= 50%)
export const MPT_MAX_METADATA_BYTES = 1024;
export const MPT_MAX_AMOUNT = 2n ** 63n - 1n; // UInt64 ceiling for MaximumAmount

/**
 * Validate MPTokenIssuanceCreate parameters client-side so we fail with a clear
 * message instead of an opaque XRPL `tem...` engine result.
 */
export function validateMptIssuanceParams(params: {
  assetScale: number;
  transferFee: number;
  flags: number;
  maxAmount?: string;
}): void {
  const { assetScale, transferFee, flags, maxAmount } = params;

  if (
    !Number.isInteger(assetScale) ||
    assetScale < 0 ||
    assetScale > MPT_MAX_ASSET_SCALE
  ) {
    throw new Error(
      `--asset-scale must be an integer between 0 and ${MPT_MAX_ASSET_SCALE}`
    );
  }

  if (
    !Number.isInteger(transferFee) ||
    transferFee < 0 ||
    transferFee > MPT_MAX_TRANSFER_FEE
  ) {
    throw new Error(
      `--transfer-fee must be an integer between 0 and ${MPT_MAX_TRANSFER_FEE} (tenths of a basis point; ${MPT_MAX_TRANSFER_FEE} = 50%)`
    );
  }

  if (transferFee > 0 && !(flags & MPT_FLAGS.tfMPTCanTransfer)) {
    throw new Error(
      "--transfer-fee can only be set when the tfMPTCanTransfer flag is enabled"
    );
  }

  if (maxAmount !== undefined) {
    if (!/^\d+$/.test(maxAmount)) {
      throw new Error("--max-amount must be a non-negative integer (UInt64)");
    }
    const value = BigInt(maxAmount);
    if (value === 0n) {
      throw new Error("--max-amount must be greater than 0");
    }
    if (value > MPT_MAX_AMOUNT) {
      throw new Error(`--max-amount exceeds the maximum (2^63 - 1)`);
    }
  }
}

/**
 * Parse a comma-separated list of MPT flag names (or raw integers) into the
 * combined `Flags` bitfield. e.g. "tfMPTCanTransfer,tfMPTCanClawback" or "96".
 */
export function parseMptFlags(input?: string): number {
  if (!input) return 0;
  let flags = 0;
  for (const raw of input.split(",")) {
    const token = raw.trim();
    if (token === "") continue;
    if (token in MPT_FLAGS) {
      flags |= MPT_FLAGS[token as keyof typeof MPT_FLAGS];
    } else if (/^(0x[0-9a-fA-F]+|\d+)$/.test(token)) {
      flags |= Number(token);
    } else {
      throw new Error(
        `Unknown MPT flag '${token}'. Valid flags: ${Object.keys(
          MPT_FLAGS
        ).join(", ")}, or a raw integer.`
      );
    }
  }
  return flags;
}

/**
 * Resolve `--metadata-json` (inline JSON string or a path to a .json file)
 * into the uppercase hex string expected by `MPTokenMetadata`.
 */
export function loadMetadataHex(input?: string): string | undefined {
  if (!input) return undefined;
  const jsonStr = fs.existsSync(input) ? fs.readFileSync(input, "utf8") : input;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      "--metadata-json must be valid JSON (inline) or a path to a .json file"
    );
  }
  // Stored as a UTF-8 blob with minimal whitespace; XRPL caps it at 1024 bytes.
  const bytes = Buffer.from(JSON.stringify(parsed));
  if (bytes.length > MPT_MAX_METADATA_BYTES) {
    throw new Error(
      `--metadata-json is ${bytes.length} bytes; the MPTokenMetadata limit is ${MPT_MAX_METADATA_BYTES} bytes`
    );
  }
  return bytes.toString("hex").toUpperCase();
}

/**
 * Validate/normalise an IOU currency code: a 3-character ASCII code or a
 * 40-character hex code (for non-standard codes like RLUSD).
 */
export function normalizeCurrency(code: string): string {
  if (code.length === 3) return code;
  if (code.length === 40 && /^[0-9a-fA-F]{40}$/.test(code)) {
    return code.toUpperCase();
  }
  throw new Error(
    `Invalid currency '${code}': expected a 3-character code or a 40-character hex code`
  );
}

/** Run a command body, printing errors in the CLI's style and exiting 1. */
export async function runXrpl(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(
      colors.red(`Error: ${err instanceof Error ? err.message : String(err)}`)
    );
    process.exit(1);
  }
}
