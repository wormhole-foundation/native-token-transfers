import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  setDefaultTimeout,
} from "bun:test";
import { Keypair } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";

const CLI = path.resolve(import.meta.dir, "../index.ts");
const SUBPROCESS_TIMEOUT = 30_000;

setDefaultTimeout(SUBPROCESS_TIMEOUT);

async function runCli(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: opts?.cwd ?? process.cwd(),
    env: { ...process.env, ...(opts?.env ?? {}) },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("--json output mode", () => {
  let workDir: string;

  let cliAvailable = true;

  beforeAll(async () => {
    const { exitCode, stderr } = await runCli(["--help"]);
    if (exitCode !== 0 && stderr.includes("Cannot find module")) {
      cliAvailable = false;
    }
  });

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ntt-json-test-"));
  });

  afterEach(() => {
    if (workDir && fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("ntt init --json emits a single JSON envelope on stdout", async () => {
    if (!cliAvailable) return; // SDK packages not built — skip
    const deploymentPath = path.join(workDir, "deployment.json");
    const { stdout, stderr, exitCode } = await runCli([
      "init",
      "Testnet",
      "--path",
      deploymentPath,
      "--json",
    ]);
    expect(exitCode, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);
    // stdout should be exactly the JSON envelope (plus trailing newline).
    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("init");
    expect(parsed.data.network).toBe("Testnet");
    expect(parsed.data.path).toBe(deploymentPath);
  });

  it("WL_NTT_JSON=1 activates the same envelope without --json flag", async () => {
    if (!cliAvailable) return; // SDK packages not built — skip
    const deploymentPath = path.join(workDir, "deployment.json");
    const { stdout, stderr, exitCode } = await runCli(
      ["init", "Mainnet", "--path", deploymentPath],
      {
        env: { WL_NTT_JSON: "1" },
      }
    );
    expect(exitCode, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);
    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("init");
    expect(parsed.data.network).toBe("Mainnet");
  });

  it("human mode is unchanged (no JSON envelope on stdout)", async () => {
    if (!cliAvailable) return; // SDK packages not built — skip
    const deploymentPath = path.join(workDir, "deployment.json");
    const { stdout, stderr, exitCode } = await runCli([
      "init",
      "Testnet",
      "--path",
      deploymentPath,
    ]);
    expect(exitCode, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);
    // Human-readable messages on stdout, no JSON envelope.
    expect(stdout).toContain(`${deploymentPath} created`);
    expect(stdout).not.toContain('"ok":true');
    // Should NOT have routed human output to stderr in human mode.
    expect(stderr).not.toContain(`${deploymentPath} created`);
  });

  it("--json routes human messages to stderr, keeping stdout clean", async () => {
    if (!cliAvailable) return; // SDK packages not built — skip
    const deploymentPath = path.join(workDir, "deployment.json");
    const { stdout, stderr, exitCode } = await runCli([
      "init",
      "Testnet",
      "--path",
      deploymentPath,
      "--json",
    ]);
    expect(exitCode, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);
    expect(stderr).toContain(`${deploymentPath} created`);
    // stdout must be ONLY the JSON envelope.
    expect(stdout.trim()).toMatch(/^\{.*\}$/);
  });

  it("solana key-base58 --json keeps the private key on stdout, never stderr", async () => {
    if (!cliAvailable) return;
    const keypairPath = path.join(workDir, "keypair.json");
    const secret = Array.from(Keypair.generate().secretKey);
    fs.writeFileSync(keypairPath, JSON.stringify(secret));

    const { stdout, stderr, exitCode } = await runCli([
      "solana",
      "key-base58",
      keypairPath,
      "--json",
    ]);
    expect(exitCode, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0);

    const key = stdout.trim();
    expect(key.length).toBeGreaterThan(0);
    expect(key).not.toContain("\n");
    expect(key).not.toContain("{");
    expect(stderr).not.toContain(key);
  });
});
