/**
 * E2E test: NTT deployment on a local Solana test validator.
 *
 * Spawns a `solana-test-validator` with the Wormhole core bridge + post-message
 * shim loaded as genesis programs, plus the local v4 NTT program at its
 * `declare_id`, then drives `ntt` end-to-end via `Bun.spawn`. Asserts on
 * deployment.json contents and (where it makes sense) on-chain state.
 *
 * The pre-loaded NTT program lets us exercise the multi-tenant
 * `add-chain --instance-of <programId>` path without needing the program-id
 * keypair (which we don't have for the mainnet `nttiK1Sep…` address): the
 * validator hosts the binary at its declared id, and the CLI just creates
 * Instance accounts under it.
 *
 * Prerequisites:
 *  - `solana-test-validator`, `solana-keygen`, `spl-token` on PATH.
 *  - `solana/target/deploy/example_native_token_transfers.so` built with
 *    `declare_id!` matching `solana/Anchor.toml`'s
 *    `[programs.localnet] example_native_token_transfers` entry. Run
 *    `anchor build -- --features mainnet` in `solana/` first if missing.
 *  - macOS: `COPYFILE_DISABLE=1` in env (set automatically below) so the
 *    validator's genesis-archive unpacker doesn't choke on `._foo` files.
 *
 * Run:
 *   bun test cli/e2e/e2e-solana.test.ts
 *
 * Per-test and beforeAll timeouts are set in-file (the default 5s isn't
 * enough — validator boot ≈ 10s, full add-chain ≈ 70s), so no `--timeout`
 * flag is needed.
 *
 * Logging knobs:
 *   NTT_E2E_DEBUG=1    one progress line per `ntt` invocation
 *                      (command + exit code). Useful for "where is
 *                      the test stuck?" without dumping SDK noise.
 *   NTT_E2E_VERBOSE=1  full stdout+stderr of every `ntt` invocation
 *                      (includes the swallowed-errors noise from
 *                      `addSolanaInstance` against a local validator).
 *
 * On failure, the full stdout+stderr of the failing `ntt` invocation is
 * dumped through the thrown error regardless of these flags.
 *
 * The spawned `solana-test-validator`'s output is appended to
 * /tmp/ntt-e2e-validator.log unconditionally; `tail -f` it in another
 * shell to watch slot advancement / RPC activity in real time.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as anchor from "@coral-xyz/anchor";
import * as spl from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Constants & paths
// ---------------------------------------------------------------------------

const CLI = path.resolve(import.meta.dir, "../src/index.ts");
const SOLANA_DIR = path.resolve(import.meta.dir, "../../solana");

// Solana test-validator ports — pick something the rest of the test suite
// doesn't use so we can run alongside `anchor test`.
const RPC_PORT = 8910;
const FAUCET_PORT = 8911;
const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;

// Wormhole core bridge fixtures (mainnet snapshots committed under
// solana/tests). Mirrors the [[test.genesis]] / [[test.validator.account]]
// blocks in solana/Anchor.toml.
const CORE_BRIDGE = "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth";
const POST_MSG_SHIM = "EtZMZM22ViKMo4r5y4Anovs3wKQ2owUmDpjygnMMcdEX";
const VERIFY_VAA_SHIM = "EFaNWErqAtVWufdNb7yofSHHfWFos843DFpu4JBw24at";
const CORE_BRIDGE_CONFIG = "2yVjuQwpsvdsrywzsJJVs9Ueh4zayyo5DYJbBNc3DDpn";
const CORE_BRIDGE_FEE_COLLECTOR =
  "9bFNrXNb2WTx8fMHXCheaZqkLZ3YCCaiqTftHxeintHy";
const GUARDIAN_SET_0 = "DS7qfSAgYsonPpKoAjcGhX9VFjXdGkiHjEDkTidf8H2P";

// ---------------------------------------------------------------------------
// Test state
// ---------------------------------------------------------------------------

let validator: ReturnType<typeof Bun.spawn> | null = null;
let validatorDir: string;
let testDir: string;
let connection: Connection;

let nttProgramId: string; // the declare_id from Anchor.toml
let payer: Keypair; // pre-funded payer for all CLI calls
let payerPath: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read the example_native_token_transfers program id from Anchor.toml. */
function readDeclaredProgramId(): string {
  const anchorToml = fs.readFileSync(
    path.join(SOLANA_DIR, "Anchor.toml"),
    "utf8"
  );
  const m = anchorToml.match(/example_native_token_transfers\s*=\s*"([^"]+)"/);
  if (!m) {
    throw new Error(
      "Could not find example_native_token_transfers in solana/Anchor.toml"
    );
  }
  return m[1]!;
}

/** Wait until `getVersion` succeeds, then return. */
async function waitForRpc(timeoutMs = 30_000): Promise<void> {
  const conn = new Connection(RPC_URL, "confirmed");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await conn.getVersion();
      return;
    } catch {
      // not ready
    }
    await Bun.sleep(500);
  }
  throw new Error(
    `solana-test-validator did not become ready in ${timeoutMs}ms`
  );
}

/**
 * Drip SOL onto an account via the validator's faucet. `requestAirdrop` is
 * rate-limited per call (capped well below the LAMPORTS_PER_SOL we'd want
 * for a deploy), and the in-RPC `confirmTransaction` wait can race a fresh
 * validator's commitment progression. Loop a few smaller airdrops with a
 * generous total timeout so first-tx flakiness doesn't fail the suite.
 */
async function fundPayer(
  conn: Connection,
  pubkey: PublicKey,
  totalSol: number
): Promise<void> {
  // Shell out to `solana airdrop` rather than `requestAirdrop` directly:
  // the RPC method is silently rate-limited per-IP after one 10-SOL
  // request, while the CLI drips happily.
  // `--commitment confirmed` (vs the CLI default `finalized`) cuts the
  // per-airdrop wait from tens of seconds to ~1 slot. solana-test-validator
  // is single-node so confirmed and finalized give the same guarantees in
  // practice — no second voter to disagree — but the wait is much shorter.
  const proc = Bun.spawn(
    [
      "solana",
      "airdrop",
      String(totalSol),
      pubkey.toBase58(),
      "--url",
      RPC_URL,
      "--commitment",
      "confirmed",
    ],
    { stdout: "ignore", stderr: "pipe" }
  );
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`solana airdrop failed (exit ${exitCode}): ${stderr}`);
  }
  const balance = await conn.getBalance(pubkey, "confirmed");
  if (balance < totalSol * anchor.web3.LAMPORTS_PER_SOL) {
    throw new Error(
      `airdrop reported success but balance is only ${
        balance / anchor.web3.LAMPORTS_PER_SOL
      } / ${totalSol} SOL`
    );
  }
}

/**
 * Run the local NTT CLI from a working directory, capture output.
 *
 * Output is silent by default — passing tests print just the jest result
 * line. On failure (or when `expectExit` mismatches) we always dump the
 * full stdout+stderr through the thrown error so the diagnosis is
 * recoverable from the test runner's report.
 *
 *   NTT_E2E_DEBUG=1   one-line progress per `ntt` invocation: command +
 *                     exit code. Useful for "did the test get past
 *                     step X?" without drowning in CLI noise. Most of
 *                     the noise — `addSolanaInstance` swallows two
 *                     expected-on-local-validator errors (duplicate
 *                     `Initialize` send from confirmation race;
 *                     wormhole core bridge `AlreadyInitialized` from
 *                     mainnet snapshot fixtures) — is suppressed.
 *   NTT_E2E_VERBOSE=1 dump full stdout+stderr of every invocation,
 *                     pass or fail. Match this when you actually want
 *                     to see what the SDK is doing.
 */
async function ntt(
  args: string[],
  opts?: { cwd?: string; timeout?: number; expectExit?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const debug = !!process.env.NTT_E2E_DEBUG;
  const verbose = !!process.env.NTT_E2E_VERBOSE;
  if (debug || verbose) {
    console.log(`[ntt] $ ntt ${args.join(" ")}`);
  }
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: opts?.cwd ?? testDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "true" },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (verbose) {
    if (stdout) console.log(`[ntt stdout]\n${stdout}`);
    if (stderr) console.log(`[ntt stderr]\n${stderr}`);
  }
  if (debug || verbose) {
    console.log(`[ntt] exit=${exitCode}`);
  }
  if (opts?.expectExit !== undefined && exitCode !== opts.expectExit) {
    throw new Error(
      `ntt ${args.join(" ")} exited ${exitCode}, expected ${opts.expectExit}\n` +
        `stdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }
  return { stdout, stderr, exitCode };
}

/** Read deployment.json from the current testDir. */
function readDeployment(): any {
  return JSON.parse(
    fs.readFileSync(path.join(testDir, "deployment.json"), "utf8")
  );
}

/**
 * Wrapper around the `spl-token` CLI to create a Token-2022 mint. We use
 * the CLI rather than `spl.createMint` because the JS client's
 * confirmation strategy is fragile on a fresh test-validator (frequent
 * BlockheightExceeded on multi-ix txs); the CLI retries internally.
 */
async function splCreateMint(): Promise<PublicKey> {
  const proc = Bun.spawn(
    [
      "spl-token",
      "create-token",
      "--program-id",
      spl.TOKEN_2022_PROGRAM_ID.toBase58(),
      "--decimals",
      "9",
      "--url",
      RPC_URL,
      "--fee-payer",
      payerPath,
      "--mint-authority",
      payerPath,
      "--output",
      "json",
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`spl-token create-token failed: ${stderr}`);
  }
  const parsed = JSON.parse(stdout) as { commandOutput: { address: string } };
  return new PublicKey(parsed.commandOutput.address);
}

/** Hand mint authority over to a new pubkey via the `spl-token` CLI. */
async function splSetMintAuthority(
  mint: PublicKey,
  newAuthority: PublicKey
): Promise<void> {
  const proc = Bun.spawn(
    [
      "spl-token",
      "authorize",
      mint.toBase58(),
      "mint",
      newAuthority.toBase58(),
      "--url",
      RPC_URL,
      "--fee-payer",
      payerPath,
      "--owner",
      payerPath,
    ],
    { stdout: "ignore", stderr: "pipe" }
  );
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`spl-token authorize failed: ${stderr}`);
  }
}

/** Write `overrides.json` so `ntt` talks to our local validator. */
function writeOverrides(): void {
  fs.writeFileSync(
    path.join(testDir, "overrides.json"),
    JSON.stringify({ chains: { Solana: { rpc: RPC_URL } } }, null, 2)
  );
}

function writeKeypair(pathname: string, keypair: Keypair): void {
  fs.writeFileSync(pathname, JSON.stringify(Array.from(keypair.secretKey)));
}

async function deriveInstanceTokenAuthority(
  instance: PublicKey
): Promise<PublicKey> {
  const taResult = await ntt(
    [
      "solana",
      "token-authority",
      nttProgramId,
      "--instance",
      instance.toBase58(),
    ],
    { expectExit: 0 }
  );
  return new PublicKey(taResult.stdout.trim().split("\n").pop()!);
}

async function addSolanaInstanceCli(
  mint: PublicKey,
  instanceKeypairPath: string
): Promise<void> {
  await ntt(
    [
      "add-chain",
      "Solana",
      "--ver",
      "4.0.0",
      "--mode",
      "burning",
      "--token",
      mint.toBase58(),
      "--payer",
      payerPath,
      "--instance-of",
      nttProgramId,
      "--instance-key",
      instanceKeypairPath,
      "--yes",
    ],
    { expectExit: 0, timeout: 120_000 }
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("CLI e2e (Solana, multi-tenant)", () => {
  beforeAll(async () => {
    nttProgramId = readDeclaredProgramId();

    const nttSo = path.join(
      SOLANA_DIR,
      "target/deploy/example_native_token_transfers.so"
    );
    if (!fs.existsSync(nttSo)) {
      throw new Error(
        `${nttSo} not found. Run \`anchor build -- --features mainnet\` in ${SOLANA_DIR}.`
      );
    }

    // 1. Spin up an isolated validator with the wormhole core bridge + shims
    //    loaded as genesis programs and the v4 NTT .so loaded at its
    //    declared id. Mirrors the [[test.genesis]] / [[test.validator.account]]
    //    setup in solana/Anchor.toml so `initializeOrUpdateLUT`'s wormhole
    //    CPI can actually find the bridge.
    validatorDir = fs.mkdtempSync("/tmp/ntt-e2e-validator-");
    // Tee validator stdout/stderr to /tmp/ntt-e2e-validator.log so a hanging
    // run is debuggable: `tail -f /tmp/ntt-e2e-validator.log` shows
    // initialization progress, RPC traffic, slot advancement, etc. We open
    // it append-mode so successive runs accumulate.
    const validatorLogPath = "/tmp/ntt-e2e-validator.log";
    const validatorLogFd = fs.openSync(validatorLogPath, "a");
    fs.writeSync(
      validatorLogFd,
      `\n=== ${new Date().toISOString()} starting validator ===\n`
    );
    if (process.env.NTT_E2E_DEBUG) {
      console.log(`[validator] log -> ${validatorLogPath}`);
    }
    validator = Bun.spawn(
      [
        "solana-test-validator",
        "--reset",
        "--quiet",
        "--rpc-port",
        String(RPC_PORT),
        "--faucet-port",
        String(FAUCET_PORT),
        // Default 64 ticks/slot @ 160 ticks/s ≈ 400ms slots — total
        // confirmation latency adds up across the deploy+initialize+LUT
        // pipeline. 16 ticks/slot ≈ 100ms slots (4× faster) keeps
        // blockhash validity (~150 slots) at ~15s, comfortably above any
        // single-tx confirmation. Single-node validator already finalizes
        // immediately, so we don't need extra slot duration for safety.
        "--ticks-per-slot",
        "16",
        "--ledger",
        path.join(validatorDir, "ledger"),
        "--bpf-program",
        nttProgramId,
        nttSo,
        "--bpf-program",
        CORE_BRIDGE,
        path.join(SOLANA_DIR, "tests/fixtures/mainnet_core_bridge.so"),
        "--bpf-program",
        POST_MSG_SHIM,
        path.join(
          SOLANA_DIR,
          "tests/fixtures/mainnet_wormhole_post_message_shim.so"
        ),
        "--bpf-program",
        VERIFY_VAA_SHIM,
        path.join(
          SOLANA_DIR,
          "tests/fixtures/mainnet_wormhole_verify_vaa_shim.so"
        ),
        "--account",
        CORE_BRIDGE_CONFIG,
        path.join(SOLANA_DIR, "tests/accounts/mainnet/core_bridge_config.json"),
        "--account",
        CORE_BRIDGE_FEE_COLLECTOR,
        path.join(
          SOLANA_DIR,
          "tests/accounts/mainnet/core_bridge_fee_collector.json"
        ),
        "--account",
        GUARDIAN_SET_0,
        path.join(SOLANA_DIR, "tests/accounts/mainnet/guardian_set_0.json"),
      ],
      {
        env: { ...process.env, COPYFILE_DISABLE: "1" },
        stdout: validatorLogFd,
        stderr: validatorLogFd,
      }
    );
    await waitForRpc();
    connection = new Connection(RPC_URL, "confirmed");

    // 2. Pre-fund a payer keypair we'll thread through every `ntt` call.
    //    Solana program rent for a ~700KB BPF program is ~5 SOL; 25 SOL is
    //    well above what any single test needs.
    payer = Keypair.generate();
    await fundPayer(connection, payer.publicKey, 25);

    // 3. Pre-fund the SDK's hardcoded "version probe" sender pubkeys. The
    //    SDK's `SolanaNtt.getVersion` invokes the on-chain `version`
    //    instruction via `simulateTransaction` (no signing) but the
    //    simulation still requires the fee-payer account to exist with
    //    enough lamports to cover the (simulated) fee. On mainnet/devnet
    //    these are real funded accounts; on a fresh local validator they
    //    don't exist yet, the simulate fails, and the SDK silently falls
    //    back to "3.0.0" — which then trips our v4-instance / v3-no-
    //    instance constraint in the SolanaNtt constructor.
    for (const probe of [
      "Hk3SdYTJFpawrvRz4qRztuEt2SqoCG7BGj2yJfDJSFbJ", // mainnet/devnet
      "98evdAiWr7ey9MAQzoQQMwFQkTsSR6KkWQuFqKrgwNwb", // localhost
      "6sbzC1eH4FTujJXWj51eQe25cYvr4xfXbJ1vAj7j2k5J", // CI devnet
    ]) {
      await fundPayer(connection, new PublicKey(probe), 1);
    }

    // 4. Make a clean working dir per suite run; CLI commands will write
    //    deployment.json + overrides.json here.
    testDir = fs.mkdtempSync("/tmp/ntt-e2e-solana-");
    payerPath = path.join(testDir, "payer.json");
    fs.writeFileSync(payerPath, JSON.stringify(Array.from(payer.secretKey)));
  }, 120_000); // validator boot + airdrops + version-probe funding

  afterAll(() => {
    validator?.kill();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    if (validatorDir && fs.existsSync(validatorDir)) {
      fs.rmSync(validatorDir, { recursive: true, force: true });
    }
  });

  test("`ntt init Mainnet` creates deployment.json", async () => {
    await ntt(["init", "Mainnet"], { expectExit: 0 });
    const dep = readDeployment();
    expect(dep.network).toBe("Mainnet");
    expect(dep.chains).toEqual({});
  });

  // Per-test timeout: deploy + initialize + LUT + register + broadcast
  // round-trips against the local validator land in ~70s on a warm machine.
  // Hardcode 180s here so callers don't need `bun test --timeout` magic.
  test("`add-chain --instance-of` creates a multi-tenant instance and persists `instance` in deployment.json", async () => {
    writeOverrides();

    // Generate the per-instance keypair up front so we can derive the
    // matching `token_authority` PDA before creating the mint.
    const instanceKeypair = Keypair.generate();
    const instanceKeypairPath = path.join(testDir, "instance-a.json");
    writeKeypair(instanceKeypairPath, instanceKeypair);

    // Compute the per-instance token_authority PDA via the CLI itself
    // (proving the new `--instance` flag works) and capture the address.
    const tokenAuthority = await deriveInstanceTokenAuthority(
      instanceKeypair.publicKey
    );

    // Create the mint with the per-instance token_authority as mint
    // authority from the start. v4 initialize's mint-authority constraint
    // expects exactly this. We shell out to `spl-token create-token`
    // instead of `spl.createMint`: the JS client's confirmation strategy
    // races the local validator (fresh validator + multi-instruction tx
    // → frequent BlockheightExceeded), while the CLI tool retries
    // internally and is reliable here. Mirrors `cli/test/solana.sh`.
    const mint = await splCreateMint();
    await splSetMintAuthority(mint, tokenAuthority);

    // Run add-chain. `--instance-of` skips the deploy step (the program is
    // already loaded by the validator) and just creates the Instance.
    await addSolanaInstanceCli(mint, instanceKeypairPath);

    const dep = readDeployment();
    expect(dep.chains.Solana).toBeDefined();
    expect(dep.chains.Solana.manager).toBe(nttProgramId);
    expect(dep.chains.Solana.instance).toBe(
      instanceKeypair.publicKey.toBase58()
    );
    expect(dep.chains.Solana.version.startsWith("4.")).toBe(true);
    expect(dep.chains.Solana.mode).toBe("burning");
    expect(dep.chains.Solana.token).toBe(mint.toBase58());
  }, 180_000);

  test("`ntt upgrade Solana --ver 4.0.0` from v3 is blocked by canUpgrade()", async () => {
    // canUpgrade() reads `currentVersion` straight off chainConfig.version
    // from deployment.json (before any chain interaction), so we can stage
    // a synthetic v3 deployment in an isolated dir and assert the block
    // fires without needing a real v3 program on chain.
    const upgradeTestDir = fs.mkdtempSync("/tmp/ntt-e2e-upgrade-");
    try {
      // Plausible v3 deployment.json shape. Manager value is arbitrary —
      // canUpgrade() doesn't dereference it.
      const dep = {
        network: "Mainnet",
        chains: {
          Solana: {
            version: "2.0.0",
            mode: "burning",
            paused: false,
            owner: payer.publicKey.toBase58(),
            manager: "ntTSft4TuqNLFPehBZKokku3kAVTDAFQxEyot5jQi3S",
            token: "So11111111111111111111111111111111111111112",
            transceivers: {
              threshold: 1,
              wormhole: {
                address: "9SLh85VZ47ihpVUfsmsX9oN4hLcyajzh4Hq8X9MwzBoz",
              },
            },
            limits: { outbound: "0.000000000", inbound: {} },
          },
        },
      };
      fs.writeFileSync(
        path.join(upgradeTestDir, "deployment.json"),
        JSON.stringify(dep, null, 2)
      );

      const { stderr, exitCode } = await ntt(
        ["upgrade", "Solana", "--ver", "4.0.0", "--payer", payerPath, "--yes"],
        { cwd: upgradeTestDir }
      );
      expect(exitCode).not.toBe(0);
      expect(stderr).toMatch(
        /cannot upgrade Solana from .* to 4\.0\.0 in place/
      );
    } finally {
      fs.rmSync(upgradeTestDir, { recursive: true, force: true });
    }
  });
});
