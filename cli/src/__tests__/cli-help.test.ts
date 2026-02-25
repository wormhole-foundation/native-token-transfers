import { describe, it, expect } from "bun:test";
import path from "path";

const CLI = path.resolve(import.meta.dir, "../index.ts");

async function runCli(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd: process.cwd(),
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

// ── Maintained lists of expected commands and subcommands ────────────────────
// Update these when adding or removing CLI commands.

const EXPECTED_COMMANDS = [
  "config",
  "update",
  "new",
  "add-chain",
  "upgrade",
  "clone",
  "init",
  "pull",
  "push",
  "status",
  "set-mint-authority",
  "transfer-ownership",
  "token-transfer",
  "solana",
  "hype",
  "manual",
];

const SOLANA_SUBCOMMANDS = [
  "key-base58",
  "token-authority",
  "ata",
  "create-spl-multisig",
  "build",
];

const CONFIG_SUBCOMMANDS = ["set-chain", "unset-chain", "get-chain"];

// ── Tests ───────────────────────────────────────────────────────────────────

describe("CLI Help Output", () => {
  it("main --help shows all expected top-level commands", async () => {
    const { stdout, exitCode } = await runCli("--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
    for (const cmd of EXPECTED_COMMANDS) {
      expect(stdout).toContain(cmd);
    }
  });

  it("every top-level command --help exits with 0", async () => {
    const results = await Promise.all(
      EXPECTED_COMMANDS.map(async (cmd) => {
        const { exitCode, stdout } = await runCli(cmd, "--help");
        return { cmd, exitCode, hasOutput: stdout.length > 0 };
      })
    );
    const failures = results.filter((r) => r.exitCode !== 0 || !r.hasOutput);
    expect(failures).toEqual([]);
  });

  it("solana subcommands are listed and their --help exits with 0", async () => {
    const { stdout: solanaHelp } = await runCli("solana", "--help");
    for (const sub of SOLANA_SUBCOMMANDS) {
      expect(solanaHelp).toContain(sub);
    }
    const results = await Promise.all(
      SOLANA_SUBCOMMANDS.map(async (sub) => {
        const { exitCode, stdout } = await runCli("solana", sub, "--help");
        return { sub, exitCode, hasOutput: stdout.length > 0 };
      })
    );
    const failures = results.filter((r) => r.exitCode !== 0 || !r.hasOutput);
    expect(failures).toEqual([]);
  });

  it("config subcommands are listed and their --help exits with 0", async () => {
    const { stdout: configHelp } = await runCli("config", "--help");
    for (const sub of CONFIG_SUBCOMMANDS) {
      expect(configHelp).toContain(sub);
    }
    const results = await Promise.all(
      CONFIG_SUBCOMMANDS.map(async (sub) => {
        const { exitCode, stdout } = await runCli("config", sub, "--help");
        return { sub, exitCode, hasOutput: stdout.length > 0 };
      })
    );
    const failures = results.filter((r) => r.exitCode !== 0 || !r.hasOutput);
    expect(failures).toEqual([]);
  });

  it("manual and hype subcommands are listed", async () => {
    const { stdout: manualHelp } = await runCli("manual", "--help");
    expect(manualHelp).toContain("set-peer");

    const { stdout: hypeHelp } = await runCli("hype", "--help");
    expect(hypeHelp).toContain("set-big-blocks");
  });
});

describe("Command-specific options", () => {
  it("add-chain shows expected options", async () => {
    const { stdout } = await runCli("add-chain", "--help");
    expect(stdout).toContain("--mode");
    expect(stdout).toContain("--token");
    expect(stdout).toContain("--latest");
    expect(stdout).toContain("--skip-verify");
  });

  it("push shows --yes option", async () => {
    const { stdout } = await runCli("push", "--help");
    expect(stdout).toContain("--yes");
  });

  it("init shows network positional", async () => {
    const { stdout } = await runCli("init", "--help");
    expect(stdout).toContain("network");
  });

  it("token-transfer shows expected options", async () => {
    const { stdout } = await runCli("token-transfer", "--help");
    expect(stdout).toContain("--amount");
    expect(stdout).toContain("--network");
  });
});
