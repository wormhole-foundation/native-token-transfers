import { describe, it, expect } from "bun:test";
import path from "path";

// Run the local CLI source directly with bun for integration tests.
const CLI_ENTRY = path.resolve(import.meta.dir, "../index.ts");

async function runCli(...args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

describe("CLI Help Output", () => {
  it("should display help without errors", async () => {
    const { stdout, exitCode } = await runCli("--help");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
  });

  it("should list all top-level commands", async () => {
    const { stdout } = await runCli("--help");

    const expectedCommands = [
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

    for (const cmd of expectedCommands) {
      expect(stdout).toContain(cmd);
    }
  });

  it("should show solana subcommands", async () => {
    const { stdout } = await runCli("solana", "--help");

    expect(stdout).toContain("key-base58");
    expect(stdout).toContain("token-authority");
    expect(stdout).toContain("ata");
    expect(stdout).toContain("create-spl-multisig");
    expect(stdout).toContain("build");
  });

  it("should show config subcommands", async () => {
    const { stdout } = await runCli("config", "--help");

    expect(stdout).toContain("set-chain");
    expect(stdout).toContain("unset-chain");
    expect(stdout).toContain("get-chain");
  });

  it("should show manual subcommands", async () => {
    const { stdout } = await runCli("manual", "--help");

    expect(stdout).toContain("set-peer");
  });

  it("should show hype subcommands", async () => {
    const { stdout } = await runCli("hype", "--help");

    expect(stdout).toContain("set-big-blocks");
  });
});
