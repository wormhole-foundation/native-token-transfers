import { describe, it, expect } from "bun:test";
import { $ } from "bun";

// Use the installed ntt binary for integration tests.
// The CLI is installed at ~/.ntt-cli and linked to ~/.bun/bin/ntt.
// We test against the installed version to verify command structure.
// After restructuring, we rebuild and re-test to confirm nothing broke.
const NTT = "ntt";

describe("CLI Help Output", () => {
  it("should display help without errors", async () => {
    const result = await $`${NTT} --help`.quiet().nothrow();
    const stdout = result.stdout.toString();

    expect(result.exitCode).toBe(0);
    expect(stdout).toContain("Commands:");
  });

  it("should list all top-level commands", async () => {
    const result = await $`${NTT} --help`.quiet().nothrow();
    const stdout = result.stdout.toString();

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
      "manual",
    ];

    for (const cmd of expectedCommands) {
      expect(stdout).toContain(cmd);
    }
  });

  it("should show solana subcommands", async () => {
    const result = await $`${NTT} solana --help`.quiet().nothrow();
    const stdout = result.stdout.toString();

    expect(stdout).toContain("key-base58");
    expect(stdout).toContain("token-authority");
    expect(stdout).toContain("ata");
    expect(stdout).toContain("create-spl-multisig");
    expect(stdout).toContain("build");
  });

  it("should show config subcommands", async () => {
    const result = await $`${NTT} config --help`.quiet().nothrow();
    const stdout = result.stdout.toString();

    expect(stdout).toContain("set-chain");
    expect(stdout).toContain("unset-chain");
    expect(stdout).toContain("get-chain");
  });

  it("should show manual subcommands", async () => {
    const result = await $`${NTT} manual --help`.quiet().nothrow();
    const stdout = result.stdout.toString();

    expect(stdout).toContain("set-peer");
  });
});
