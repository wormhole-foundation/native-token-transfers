import { describe, it, expect } from "bun:test";

describe("Module Exports", () => {
  it("core modules export expected functions", async () => {
    const config = await import("../configuration");
    expect(typeof config.command).toBe("function");
    expect(typeof config.get).toBe("function");

    const deployments = await import("../deployments");
    expect(typeof deployments.loadConfig).toBe("function");

    const error = await import("../error");
    expect(error.isRpcConnectionError).toBeDefined();
    expect(error.handleDeploymentError).toBeDefined();
    expect(error.logRpcError).toBeDefined();

    const diff = await import("../diff");
    expect(diff.diffObjects).toBeDefined();
    expect(diff.colorizeDiff).toBeDefined();

    const colors = await import("../colors");
    expect(colors.colors).toBeDefined();
    expect(colors.colors.red).toBeDefined();
    expect(colors.colors.green).toBeDefined();

    const prompts = await import("../prompts");
    expect(prompts.promptLine).toBeDefined();
    expect(prompts.promptYesNo).toBeDefined();

    const overrides = await import("../overrides");
    expect(overrides.loadOverrides).toBeDefined();
    expect(overrides.promptSolanaMainnetOverridesIfNeeded).toBeDefined();

    const tag = await import("../tag");
    expect(tag.getAvailableVersions).toBeDefined();
    expect(tag.getGitTagName).toBeDefined();
  });

  it("validation.ts exports validators and ensureNttRoot", async () => {
    const mod = await import("../validation");
    expect(mod.ensurePlatformSupported).toBeDefined();
    expect(mod.validatePayerOption).toBeDefined();
    expect(mod.normalizeRpcArgs).toBeDefined();
    expect(mod.retryWithExponentialBackoff).toBeDefined();
    expect(mod.SUPPORTED_PLATFORMS).toBeDefined();
    expect(typeof mod.ensureNttRoot).toBe("function");
  });

  it("signer and EVM modules export expected functions", async () => {
    const signer = await import("../signers/getSigner");
    expect(signer.getSigner).toBeDefined();
    expect(signer.forgeSignerArgs).toBeDefined();

    const ssw = await import("../signers/signSendWait");
    expect(ssw.newSignSendWaiter).toBeDefined();

    const hl = await import("../evm/hyperliquid");
    expect(hl.enableBigBlocks).toBeDefined();
  });

  it("commands/shared.ts exports options and utilities", async () => {
    const mod = await import("../commands/shared");
    expect(mod.options).toBeDefined();
    expect(mod.options.network).toBeDefined();
    expect(mod.options.chain).toBeDefined();
    expect(mod.CCL_CONTRACT_ADDRESSES).toBeDefined();
    expect(mod.EXCLUDED_DIFF_PATHS).toBeDefined();
    expect(mod.getNestedValue).toBeDefined();
    expect(mod.setNestedValue).toBeDefined();
  });

  it("safe command creators have valid yargs shape", async () => {
    // token-transfer imports @wormhole-foundation/sdk-route-ntt which is a
    // workspace package that requires building.  Skip when unavailable (CI unit tests).
    let hasTokenTransfer = true;
    try {
      await import("../commands/token-transfer");
    } catch {
      hasTokenTransfer = false;
    }

    if (hasTokenTransfer) {
      const { createTokenTransferCommand } = await import(
        "../commands/token-transfer"
      );
      const ttCmd = createTokenTransferCommand({});
      expect(ttCmd).toHaveProperty("command");
      expect(ttCmd).toHaveProperty("describe");
      expect(ttCmd).toHaveProperty("builder");
      expect(ttCmd).toHaveProperty("handler");
    }

    const { createConfigCommand } = await import("../commands/config");
    const cfgCmd = createConfigCommand();
    expect(cfgCmd).toHaveProperty("command");
    expect(cfgCmd).toHaveProperty("builder");

    const { createUpdateCommand } = await import("../commands/update");
    expect(typeof createUpdateCommand).toBe("function");

    const { createNewCommand } = await import("../commands/new");
    expect(typeof createNewCommand).toBe("function");

    const { createInitCommand } = await import("../commands/init");
    expect(typeof createInitCommand).toBe("function");
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
  it.skip("index.ts re-exports ensureNttRoot (skip: side-effect on import)", async () => {
    const mod = await import("../index");
    expect(mod.ensureNttRoot).toBeDefined();
  });
});
