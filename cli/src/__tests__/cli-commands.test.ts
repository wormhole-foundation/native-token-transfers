import { describe, expect, test } from "bun:test";
import { suppressConsole, restoreConsole } from "./setup";

const CLI = "cli/src/index.ts";

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

describe("Command help output", () => {
  const commands = [
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

  for (const cmd of commands) {
    test(`${cmd} --help exits with 0`, async () => {
      const { exitCode, stdout } = await runCli(cmd, "--help");
      expect(exitCode).toBe(0);
      expect(stdout.length).toBeGreaterThan(0);
    });
  }
});

describe("add-chain help", () => {
  test("shows expected options", async () => {
    const { stdout } = await runCli("add-chain", "--help");
    expect(stdout).toContain("--mode");
    expect(stdout).toContain("--token");
    expect(stdout).toContain("--latest");
    expect(stdout).toContain("--skip-verify");
  });
});

describe("push help", () => {
  test("shows expected options", async () => {
    const { stdout } = await runCli("push", "--help");
    expect(stdout).toContain("--yes");
  });
});

describe("init help", () => {
  test("shows network positional", async () => {
    const { stdout } = await runCli("init", "--help");
    expect(stdout).toContain("network");
  });
});

describe("token-transfer help", () => {
  test("shows expected options", async () => {
    const { stdout } = await runCli("token-transfer", "--help");
    expect(stdout).toContain("--amount");
    expect(stdout).toContain("--network");
  });
});

describe("solana subcommands help", () => {
  const subcommands = [
    "key-base58",
    "token-authority",
    "ata",
    "create-spl-multisig",
    "build",
  ];

  for (const sub of subcommands) {
    test(`solana ${sub} --help exits with 0`, async () => {
      const { exitCode, stdout } = await runCli("solana", sub, "--help");
      expect(exitCode).toBe(0);
      expect(stdout.length).toBeGreaterThan(0);
    });
  }
});

describe("config subcommands help", () => {
  const subcommands = ["set-chain", "unset-chain", "get-chain"];

  for (const sub of subcommands) {
    test(`config ${sub} --help exits with 0`, async () => {
      const { exitCode, stdout } = await runCli("config", sub, "--help");
      expect(exitCode).toBe(0);
      expect(stdout.length).toBeGreaterThan(0);
    });
  }
});
