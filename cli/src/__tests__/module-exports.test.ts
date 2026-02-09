import { describe, it, expect } from "bun:test";

describe("Module Exports", () => {
  it("configuration.ts exports command builder and get", async () => {
    const mod = await import("../configuration");
    expect(mod.command).toBeDefined();
    expect(typeof mod.command).toBe("function");
    expect(mod.get).toBeDefined();
    expect(typeof mod.get).toBe("function");
  });

  it("token-transfer.ts exports createTokenTransferCommand", async () => {
    const mod = await import("../commands/token-transfer");
    expect(mod.createTokenTransferCommand).toBeDefined();
    expect(typeof mod.createTokenTransferCommand).toBe("function");
  });

  it("tokenTransfer command has valid yargs shape", async () => {
    const { createTokenTransferCommand } = await import(
      "../commands/token-transfer"
    );
    const cmd = createTokenTransferCommand({});
    expect(cmd).toHaveProperty("command");
    expect(cmd).toHaveProperty("describe");
    expect(cmd).toHaveProperty("builder");
    expect(cmd).toHaveProperty("handler");
  });

  it("deployments.ts exports loadConfig", async () => {
    const mod = await import("../deployments");
    expect(mod.loadConfig).toBeDefined();
    expect(typeof mod.loadConfig).toBe("function");
  });

  it("error.ts exports error handlers", async () => {
    const mod = await import("../error");
    expect(mod.isRpcConnectionError).toBeDefined();
    expect(mod.handleDeploymentError).toBeDefined();
    expect(mod.logRpcError).toBeDefined();
  });

  it("diff.ts exports diffObjects and colorizeDiff", async () => {
    const mod = await import("../diff");
    expect(mod.diffObjects).toBeDefined();
    expect(mod.colorizeDiff).toBeDefined();
  });

  it("validation.ts exports validators and ensureNttRoot", async () => {
    const mod = await import("../validation");
    expect(mod.ensurePlatformSupported).toBeDefined();
    expect(mod.validatePayerOption).toBeDefined();
    expect(mod.normalizeRpcArgs).toBeDefined();
    expect(mod.retryWithExponentialBackoff).toBeDefined();
    expect(mod.SUPPORTED_PLATFORMS).toBeDefined();
    expect(mod.ensureNttRoot).toBeDefined();
    expect(typeof mod.ensureNttRoot).toBe("function");
  });

  it("getSigner.ts exports getSigner and forgeSignerArgs", async () => {
    const mod = await import("../signers/getSigner");
    expect(mod.getSigner).toBeDefined();
    expect(mod.forgeSignerArgs).toBeDefined();
  });

  it("colors.ts exports colors object", async () => {
    const mod = await import("../colors");
    expect(mod.colors).toBeDefined();
    expect(mod.colors.red).toBeDefined();
    expect(mod.colors.green).toBeDefined();
    expect(mod.colors.blue).toBeDefined();
  });

  it("prompts.ts exports prompt functions", async () => {
    const mod = await import("../prompts");
    expect(mod.promptLine).toBeDefined();
    expect(mod.promptYesNo).toBeDefined();
  });

  it("overrides.ts exports loadOverrides", async () => {
    const mod = await import("../overrides");
    expect(mod.loadOverrides).toBeDefined();
    expect(mod.promptSolanaMainnetOverridesIfNeeded).toBeDefined();
  });

  it("signSendWait.ts exports newSignSendWaiter", async () => {
    const mod = await import("../signers/signSendWait");
    expect(mod.newSignSendWaiter).toBeDefined();
  });

  it("tag.ts exports version helpers", async () => {
    const mod = await import("../tag");
    expect(mod.getAvailableVersions).toBeDefined();
    expect(mod.getGitTagName).toBeDefined();
  });

  it("hyperliquid.ts exports enableBigBlocks", async () => {
    const mod = await import("../evm/hyperliquid");
    expect(mod.enableBigBlocks).toBeDefined();
  });

  it("commands/shared.ts exports options and shared types", async () => {
    const mod = await import("../commands/shared");
    expect(mod.options).toBeDefined();
    expect(mod.options.network).toBeDefined();
    expect(mod.options.chain).toBeDefined();
    expect(mod.CCL_CONTRACT_ADDRESSES).toBeDefined();
    expect(mod.EXCLUDED_DIFF_PATHS).toBeDefined();
    expect(mod.getNestedValue).toBeDefined();
    expect(mod.setNestedValue).toBeDefined();
  });

  it("commands that don't depend on index.ts export valid creators", async () => {
    const config = await import("../commands/config");
    expect(typeof config.createConfigCommand).toBe("function");
    const cmd = config.createConfigCommand();
    expect(cmd).toHaveProperty("command");
    expect(cmd).toHaveProperty("builder");

    const update = await import("../commands/update");
    expect(typeof update.createUpdateCommand).toBe("function");

    const newCmd = await import("../commands/new");
    expect(typeof newCmd.createNewCommand).toBe("function");

    const init = await import("../commands/init");
    expect(typeof init.createInitCommand).toBe("function");
  });

  // commands/index.ts barrel re-exports commands that import from ../index.ts,
  // which triggers yargs.parse() as a side effect.
  it.skip("commands/index.ts barrel exports all command creators (skip: side-effect on import)", async () => {
    const mod = await import("../commands/index");
    expect(mod.createAddChainCommand).toBeDefined();
    expect(mod.createConfigCommand).toBeDefined();
  });

  // index.ts has side effects on import (yargs.parse() runs immediately),
  // so we can't import it in a test without triggering the CLI.
  // ensureNttRoot is now tested via the validation.ts test above.
  it.skip("index.ts re-exports ensureNttRoot (skip: side-effect on import)", async () => {
    const mod = await import("../index");
    expect(mod.ensureNttRoot).toBeDefined();
  });
});
