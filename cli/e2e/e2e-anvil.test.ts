/**
 * E2E test: NTT deployment on Anvil forks of Sepolia and Base Sepolia.
 *
 * This test:
 *  1. Starts two Anvil instances forking Sepolia and Base Sepolia
 *  2. Impersonates the DANTE token admin to grant MINTER_ROLE
 *  3. Deploys NTT in burning mode on both chains via the local CLI
 *  4. Pulls on-chain config, sets inbound limits, pushes config
 *  5. Verifies deployment status matches on-chain
 *
 * Uses custom finality (instant + 1 block) on Sepolia for fast VAAs.
 *
 * Prerequisites: anvil, cast, forge (foundry toolchain), bun
 *
 * Run: bun test cli/e2e/ --timeout 600000
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI = path.resolve(import.meta.dir, "../src/index.ts");

const SEPOLIA_PORT = 18545;
const BASE_SEPOLIA_PORT = 18546;
const SEPOLIA_FORK_RPC = `http://127.0.0.1:${SEPOLIA_PORT}`;
const BASE_SEPOLIA_FORK_RPC = `http://127.0.0.1:${BASE_SEPOLIA_PORT}`;

// Public RPCs for forking
const SEPOLIA_RPC =
  process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const BASE_SEPOLIA_RPC =
  process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";

// Anvil's default account #0
const ANVIL_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// DANTE token deployer / admin — we impersonate this address on the fork
const ADMIN_ADDRESS = "0x491aE4A7bE91BB6b84232bAC79A9Cd5AB017E715";

// DANTE tokens
const DANTE_SEPOLIA = "0x771e6eD6057E6da9BA7f88f82833dF52B3Eb947A";
const DANTE_BASE_SEPOLIA = "0xb270c9F2cD63815e2c3a277Deeb0A35F514672Be";

// Roles
const MINTER_ROLE =
  "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";
const DEFAULT_ADMIN_ROLE =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// Wormhole core bridges (for setting message fee)
const SEPOLIA_CORE_BRIDGE = "0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78";
const BASE_SEPOLIA_CORE_BRIDGE = "0x79A1027a6A159502049F10906D333EC57E95F083";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let anvilSepolia: ReturnType<typeof Bun.spawn> | null = null;
let anvilBaseSepolia: ReturnType<typeof Bun.spawn> | null = null;
let testDir: string = "";

/** Wait for an RPC endpoint to respond. */
async function waitForRpc(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_blockNumber",
          params: [],
          id: 1,
        }),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(500);
  }
  throw new Error(`RPC ${url} did not become ready within ${timeoutMs}ms`);
}

/** Set Wormhole core bridge message fee to 0.001 ETH via storage override. */
async function setCoreBridgeFee(
  rpcUrl: string,
  coreBridge: string
): Promise<void> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "anvil_setStorageAt",
      params: [
        coreBridge,
        "0x7", // messageFee storage slot
        "0x00000000000000000000000000000000000000000000000000038D7EA4C68000", // 0.001 ETH
      ],
      id: 1,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `anvil_setStorageAt failed for ${coreBridge}: HTTP ${res.status}`
    );
  }
  const json = (await res.json()) as { error?: { message: string } };
  if (json.error) {
    throw new Error(
      `anvil_setStorageAt failed for ${coreBridge}: ${json.error.message}`
    );
  }
}

/** Grant a role on an AccessControl token using anvil impersonation. */
async function grantRoleImpersonated(
  rpcUrl: string,
  token: string,
  role: string,
  account: string,
  impersonateAdmin: string
): Promise<void> {
  // Impersonate the admin
  await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "anvil_impersonateAccount",
      params: [impersonateAdmin],
      id: 1,
    }),
  });

  // Grant role
  const proc = Bun.spawn(
    [
      "cast",
      "send",
      token,
      "grantRole(bytes32,address)",
      role,
      account,
      "--from",
      impersonateAdmin,
      "--rpc-url",
      rpcUrl,
      "--unlocked",
    ],
    { stdout: "pipe", stderr: "pipe" }
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`cast send grantRole failed (exit ${exitCode}): ${stderr}`);
  }

  // Stop impersonation
  await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "anvil_stopImpersonatingAccount",
      params: [impersonateAdmin],
      id: 1,
    }),
  });
}

/** Run the local NTT CLI from the test project directory. */
async function ntt(
  args: string[],
  opts?: { stdin?: string; timeout?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: testDir,
    stdout: "pipe",
    stderr: "pipe",
    stdin: opts?.stdin ? "pipe" : undefined,
    env: {
      ...process.env,
      ETH_PRIVATE_KEY: ANVIL_PRIVATE_KEY,
      // Suppress interactive prompts where possible
      CI: "true",
    },
  });

  if (opts?.stdin && proc.stdin) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }

  const timeout = opts?.timeout ?? 300_000;
  const stdoutP = new Response(proc.stdout).text();
  const stderrP = new Response(proc.stderr).text();

  const result = await Promise.race([
    Promise.all([stdoutP, stderrP, proc.exited]).then(
      ([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode })
    ),
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        proc.kill();
        reject(new Error(`ntt ${args[0]} timed out after ${timeout}ms`));
      }, timeout)
    ),
  ]);

  return { ...result, exitCode: result.exitCode as number };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("E2E: NTT deployment on Anvil forks", () => {
  beforeAll(async () => {
    // Require foundry toolchain
    if (!Bun.which("anvil")) {
      throw new Error(
        "anvil not found. Install foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup"
      );
    }
    if (!Bun.which("cast")) {
      throw new Error(
        "cast not found. Install foundry: curl -L https://foundry.paradigm.xyz | bash && foundryup"
      );
    }

    // 1. Start Anvil forks
    anvilSepolia = Bun.spawn(
      [
        "anvil",
        "--silent",
        "--fork-url",
        SEPOLIA_RPC,
        "--port",
        String(SEPOLIA_PORT),
        "--auto-impersonate",
      ],
      { stdout: "ignore", stderr: "ignore" }
    );

    anvilBaseSepolia = Bun.spawn(
      [
        "anvil",
        "--silent",
        "--fork-url",
        BASE_SEPOLIA_RPC,
        "--port",
        String(BASE_SEPOLIA_PORT),
        "--auto-impersonate",
      ],
      { stdout: "ignore", stderr: "ignore" }
    );

    await Promise.all([
      waitForRpc(SEPOLIA_FORK_RPC),
      waitForRpc(BASE_SEPOLIA_FORK_RPC),
    ]);

    // 2. Set core bridge message fee
    await Promise.all([
      setCoreBridgeFee(SEPOLIA_FORK_RPC, SEPOLIA_CORE_BRIDGE),
      setCoreBridgeFee(BASE_SEPOLIA_FORK_RPC, BASE_SEPOLIA_CORE_BRIDGE),
    ]);

    // 3. Grant DEFAULT_ADMIN_ROLE and MINTER_ROLE to Anvil's account on both tokens
    //    (so the CLI can deploy and the NTT Manager can mint)
    await Promise.all([
      grantRoleImpersonated(
        SEPOLIA_FORK_RPC,
        DANTE_SEPOLIA,
        DEFAULT_ADMIN_ROLE,
        ANVIL_ADDRESS,
        ADMIN_ADDRESS
      ),
      grantRoleImpersonated(
        BASE_SEPOLIA_FORK_RPC,
        DANTE_BASE_SEPOLIA,
        DEFAULT_ADMIN_ROLE,
        ANVIL_ADDRESS,
        ADMIN_ADDRESS
      ),
    ]);
    await Promise.all([
      grantRoleImpersonated(
        SEPOLIA_FORK_RPC,
        DANTE_SEPOLIA,
        MINTER_ROLE,
        ANVIL_ADDRESS,
        ADMIN_ADDRESS
      ),
      grantRoleImpersonated(
        BASE_SEPOLIA_FORK_RPC,
        DANTE_BASE_SEPOLIA,
        MINTER_ROLE,
        ANVIL_ADDRESS,
        ADMIN_ADDRESS
      ),
    ]);

    // 4. Create test project directory
    testDir = fs.mkdtempSync("/tmp/ntt-e2e-anvil-");
  });

  afterAll(() => {
    // Kill Anvil processes
    anvilSepolia?.kill();
    anvilBaseSepolia?.kill();

    // Clean up test directory
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("create NTT project and initialize for Testnet", async () => {
    // ntt new must run from outside a git repo
    const proc = Bun.spawn(["bun", "run", CLI, "new", "ntt-project"], {
      cwd: testDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    // Update testDir to point inside the project
    testDir = path.join(testDir, "ntt-project");

    // Write .env
    fs.writeFileSync(
      path.join(testDir, ".env"),
      `ETH_PRIVATE_KEY=${ANVIL_PRIVATE_KEY}\n`
    );

    // Write overrides.json to point at Anvil forks
    fs.writeFileSync(
      path.join(testDir, "overrides.json"),
      JSON.stringify(
        {
          chains: {
            Sepolia: { rpc: SEPOLIA_FORK_RPC },
            BaseSepolia: { rpc: BASE_SEPOLIA_FORK_RPC },
          },
        },
        null,
        2
      )
    );

    // Init Testnet
    const init = await ntt(["init", "Testnet"]);
    expect(init.exitCode).toBe(0);

    // Verify deployment.json exists
    const deploymentPath = path.join(testDir, "deployment.json");
    expect(fs.existsSync(deploymentPath)).toBe(true);
    const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
    expect(deployment.network).toBe("Testnet");
    expect(deployment.chains).toEqual({});
  }, 120_000);

  test("deploy NTT to Sepolia fork with custom finality (instant + 1 block)", async () => {
    const result = await ntt(
      [
        "add-chain",
        "Sepolia",
        "--latest",
        "--mode",
        "burning",
        "--token",
        DANTE_SEPOLIA,
        "--skip-verify",
        "--yes",
        "--unsafe-custom-finality",
        "200:1",
      ],
      {
        // Pipe "yes" for the custom finality confirmation prompt
        stdin: "yes\n",
        timeout: 600_000,
      }
    );

    // Show output for debugging
    if (result.exitCode !== 0) {
      console.error("add-chain Sepolia stdout:", result.stdout);
      console.error("add-chain Sepolia stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);

    // Verify chain was added to deployment.json
    const deployment = JSON.parse(
      fs.readFileSync(path.join(testDir, "deployment.json"), "utf8")
    );
    expect(deployment.chains.Sepolia).toBeDefined();
    expect(deployment.chains.Sepolia.mode).toBe("burning");
    expect(deployment.chains.Sepolia.token).toBe(DANTE_SEPOLIA);
    expect(deployment.chains.Sepolia.manager).toBeTruthy();
    expect(
      deployment.chains.Sepolia.transceivers.wormhole.address
    ).toBeTruthy();
  }, 600_000);

  test("deploy NTT to Base Sepolia fork", async () => {
    const result = await ntt(
      [
        "add-chain",
        "BaseSepolia",
        "--latest",
        "--mode",
        "burning",
        "--token",
        DANTE_BASE_SEPOLIA,
        "--skip-verify",
        "--yes",
      ],
      { timeout: 600_000 }
    );

    if (result.exitCode !== 0) {
      console.error("add-chain BaseSepolia stdout:", result.stdout);
      console.error("add-chain BaseSepolia stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);

    const deployment = JSON.parse(
      fs.readFileSync(path.join(testDir, "deployment.json"), "utf8")
    );
    expect(deployment.chains.BaseSepolia).toBeDefined();
    expect(deployment.chains.BaseSepolia.mode).toBe("burning");
    expect(deployment.chains.BaseSepolia.token).toBe(DANTE_BASE_SEPOLIA);
  }, 600_000);

  test("grant MINTER_ROLE to NTT Managers on both chains", async () => {
    const deployment = JSON.parse(
      fs.readFileSync(path.join(testDir, "deployment.json"), "utf8")
    );
    const sepoliaManager = deployment.chains.Sepolia.manager;
    const baseSepoliaManager = deployment.chains.BaseSepolia.manager;

    // Grant MINTER_ROLE to both managers (impersonating admin)
    await Promise.all([
      grantRoleImpersonated(
        SEPOLIA_FORK_RPC,
        DANTE_SEPOLIA,
        MINTER_ROLE,
        sepoliaManager,
        ADMIN_ADDRESS
      ),
      grantRoleImpersonated(
        BASE_SEPOLIA_FORK_RPC,
        DANTE_BASE_SEPOLIA,
        MINTER_ROLE,
        baseSepoliaManager,
        ADMIN_ADDRESS
      ),
    ]);

    // Verify roles were granted
    for (const [rpc, token, manager] of [
      [SEPOLIA_FORK_RPC, DANTE_SEPOLIA, sepoliaManager],
      [BASE_SEPOLIA_FORK_RPC, DANTE_BASE_SEPOLIA, baseSepoliaManager],
    ] as const) {
      const proc = Bun.spawn(
        [
          "cast",
          "call",
          token,
          "hasRole(bytes32,address)(bool)",
          MINTER_ROLE,
          manager,
          "--rpc-url",
          rpc,
        ],
        { stdout: "pipe", stderr: "pipe" }
      );
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(
          `cast call hasRole failed (exit ${exitCode}): ${stderr}`
        );
      }
      const out = (await new Response(proc.stdout).text()).trim();
      expect(out).toBe("true");
    }
  }, 30_000);

  test("pull config to sync on-chain state", async () => {
    const result = await ntt(["pull", "--yes"]);
    if (result.exitCode !== 0) {
      console.error("pull stdout:", result.stdout);
      console.error("pull stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    const output = result.stdout + result.stderr;
    expect(
      output.includes("Updated deployment.json") ||
        output.includes("already up to date")
    ).toBe(true);
  }, 120_000);

  test("update inbound limits to match outbound and push", async () => {
    const deploymentPath = path.join(testDir, "deployment.json");
    const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

    // Set inbound limits to match outbound on both chains
    const sepoliaOutbound = deployment.chains.Sepolia.limits.outbound;
    const baseOutbound = deployment.chains.BaseSepolia.limits.outbound;

    deployment.chains.Sepolia.limits.inbound = {
      BaseSepolia: sepoliaOutbound,
    };
    deployment.chains.BaseSepolia.limits.inbound = {
      Sepolia: baseOutbound,
    };

    fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));

    // Push
    const result = await ntt(["push", "--yes"], { timeout: 300_000 });
    if (result.exitCode !== 0) {
      console.error("push stdout:", result.stdout);
      console.error("push stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
  }, 300_000);

  test("status reports deployment is up to date", async () => {
    const result = await ntt(["status"], { timeout: 120_000 });
    const output = result.stdout + result.stderr;
    if (result.exitCode !== 0) {
      console.error("status stdout:", result.stdout);
      console.error("status stderr:", result.stderr);
    }
    expect(result.exitCode).toBe(0);
    expect(output).toContain("up to date");
  }, 120_000);

  test("deployment.json has correct structure", async () => {
    const deployment = JSON.parse(
      fs.readFileSync(path.join(testDir, "deployment.json"), "utf8")
    );

    // Both chains present
    expect(Object.keys(deployment.chains)).toEqual(["Sepolia", "BaseSepolia"]);

    for (const chain of ["Sepolia", "BaseSepolia"] as const) {
      const c = deployment.chains[chain];
      expect(c.mode).toBe("burning");
      expect(c.paused).toBe(false);
      expect(c.manager).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(c.transceivers.threshold).toBe(1);
      expect(c.transceivers.wormhole.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
      expect(c.limits.outbound).toBeTruthy();

      // Inbound limits should be set
      const otherChain = chain === "Sepolia" ? "BaseSepolia" : "Sepolia";
      expect(c.limits.inbound[otherChain]).toBeTruthy();
      expect(c.limits.inbound[otherChain]).not.toBe("0.000000000000000000");
    }
  }, 5_000);
});
