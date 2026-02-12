import { describe, expect, test, spyOn, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import { checkConfigErrors, validateChain } from "../validation";

const SRC_DIR = path.resolve(import.meta.dir, "..");

// ─── Fix #15: checkConfigErrors guards ──────────────────────────────────────

describe("Fix #15: checkConfigErrors — undefined local config / limits", () => {
  test("handles undefined config.local without TypeError", () => {
    // Before fix: `deployment.config.local!` → access .limits on undefined → TypeError
    const deps = {
      Sepolia: {
        decimals: 18,
        config: { local: undefined },
      } as any,
    };
    expect(() => checkConfigErrors(deps)).not.toThrow();
    expect(checkConfigErrors(deps)).toBeGreaterThan(0);
  });

  test("handles undefined config.limits without TypeError", () => {
    // Before fix: `config.limits.outbound` → TypeError when limits is missing
    const deps = {
      Sepolia: {
        decimals: 18,
        config: {
          local: {
            mode: "locking",
            paused: false,
            owner: "0x1",
            manager: "0x2",
            token: "0x3",
            transceivers: { threshold: 1, wormhole: { address: "0x4" } },
            // limits deliberately omitted
          },
        },
      } as any,
    };
    expect(() => checkConfigErrors(deps)).not.toThrow();
    expect(checkConfigErrors(deps)).toBeGreaterThan(0);
  });

  test("returns 0 for valid config with proper limits", () => {
    const deps = {
      Sepolia: {
        decimals: 18,
        config: {
          local: {
            limits: {
              outbound: "1000.0",
              inbound: { BaseSepolia: "500.0" },
            },
          },
        },
      } as any,
    };
    expect(checkConfigErrors(deps)).toBe(0);
  });
});

// ─── Fix #8: validateChain Sepolia counterpart ──────────────────────────────

describe("Fix #8: validateChain — Sepolia counterpart detection", () => {
  let exitSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    exitSpy?.mockRestore();
    errorSpy?.mockRestore();
  });

  test("rejects Testnet chain that has a Sepolia counterpart", () => {
    // Before fix: `chains.find((c) => c === `${c}Sepolia`)` — loop var `c` instead
    // of param `chain`, so `c` is compared to itself+"Sepolia" → always false.
    // After fix: `chains.find((c) => c === `${chain}Sepolia`)` — works correctly.
    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    errorSpy = spyOn(console, "error").mockImplementation(() => {});

    // "Base" has a "BaseSepolia" counterpart in the SDK chains list
    expect(() => validateChain("Testnet", "Base" as any)).toThrow(
      "process.exit"
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("deprecated")
    );
  });

  test("allows Testnet chain without Sepolia counterpart", () => {
    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    // "Solana" has no "SolanaSepolia"
    expect(() => validateChain("Testnet", "Solana" as any)).not.toThrow();
  });

  test("does not reject chains on Mainnet", () => {
    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    expect(() => validateChain("Mainnet", "Base" as any)).not.toThrow();
  });
});

// ─── Fix #10: instanceof ordering ───────────────────────────────────────────

describe("Fix #10: instanceof ordering — SendTransactionError before Error", () => {
  function assertSubclassFirst(filePath: string) {
    const source = fs.readFileSync(filePath, "utf-8");
    const lines = source.split("\n");

    // Collect all instanceof check line numbers and types
    const checks: { line: number; type: string }[] = [];
    lines.forEach((lineText, i) => {
      if (lineText.includes("instanceof SendTransactionError")) {
        checks.push({ line: i, type: "SendTransactionError" });
      } else if (lineText.includes("instanceof Error")) {
        checks.push({ line: i, type: "Error" });
      }
    });

    // Group into pairs within the same catch block (< 10 lines apart)
    for (let i = 0; i < checks.length - 1; i++) {
      const a = checks[i];
      const b = checks[i + 1];
      if (a.type !== b.type && Math.abs(a.line - b.line) < 10) {
        // SendTransactionError must come before Error
        expect(a.type).toBe("SendTransactionError");
        expect(b.type).toBe("Error");
        i++; // skip paired entry
      }
    }

    // Ensure we actually found pairs (not vacuously true)
    expect(checks.length).toBeGreaterThanOrEqual(2);
  }

  test("set-mint-authority.ts — all catch blocks correct", () => {
    assertSubclassFirst(path.join(SRC_DIR, "commands/set-mint-authority.ts"));
  });

  test("solana.ts — all catch blocks correct", () => {
    assertSubclassFirst(path.join(SRC_DIR, "commands/solana.ts"));
  });
});

// ─── Fix #9: error message uses tokenMint, not undefined token ──────────────

describe("Fix #9: error message references tokenMint not CLI arg", () => {
  test("Mint-not-found message uses tokenMint.toBase58()", () => {
    const source = fs.readFileSync(
      path.join(SRC_DIR, "commands/set-mint-authority.ts"),
      "utf-8"
    );
    // Before fix: `Mint ${token} not found` — `token` is the CLI arg, undefined when deployed
    expect(source).not.toMatch(/Mint \$\{token\} not found/);
    expect(source).toMatch(/Mint \$\{tokenMint\.toBase58\(\)\} not found/);
  });
});

// ─── Fix #14: sui/helpers.ts — no shell injection via execSync ──────────────

describe("Fix #14: sui/helpers.ts — execFileSync only, no execSync", () => {
  test("source does not use execSync", () => {
    const source = fs.readFileSync(
      path.join(SRC_DIR, "sui/helpers.ts"),
      "utf-8"
    );
    // Before fix: execSync with template literals — shell injection risk
    expect(source).not.toMatch(/\bexecSync\b/);
    expect(source).toMatch(/\bexecFileSync\b/);
  });
});

// ─── Fix #11: config-mgmt.ts — no contradictory ?. + ! ──────────────────────

describe("Fix #11: config-mgmt.ts — no diff[k]?.push! pattern", () => {
  test("uses diff[k]!.push! not diff[k]?.push!", () => {
    const source = fs.readFileSync(
      path.join(SRC_DIR, "config-mgmt.ts"),
      "utf-8"
    );
    // Before fix: `diff[k]?.push!` — optional chain followed by non-null assertion
    // is contradictory (?.returns undefined when nullish, ! just lies to TS)
    // After fix: `diff[k]!.push!` — correct since keys come from Object.keys(diff)
    expect(source).not.toMatch(/diff\[k\]\?\.push!/);
  });
});

// ─── Fix #12: deploy.ts — block scoping in switch cases ─────────────────────

describe("Fix #12: deploy.ts — switch cases use block scoping", () => {
  test("no case label followed directly by const (missing block scope)", () => {
    const source = fs.readFileSync(path.join(SRC_DIR, "deploy.ts"), "utf-8");
    // Before fix: `case "Evm":\n      const evmNtt = ...` — const leaks across cases
    // After fix:  `case "Evm": {\n      const evmNtt = ...` — block-scoped
    // The regex matches a case label followed by whitespace then const (no { in between)
    expect(source).not.toMatch(/case "[A-Za-z]+":\s+const /);
  });
});

// ─── Fix #13: sui/helpers.ts — no debug statements or dead code ─────────────

describe("Fix #13: sui/helpers.ts — cleanup", () => {
  test("no stray console.error(rpcUrl) debug statement", () => {
    const source = fs.readFileSync(
      path.join(SRC_DIR, "sui/helpers.ts"),
      "utf-8"
    );
    expect(source).not.toMatch(/console\.error\(rpcUrl\)/);
  });

  test("no unused buildPackageName variable", () => {
    const source = fs.readFileSync(
      path.join(SRC_DIR, "sui/helpers.ts"),
      "utf-8"
    );
    expect(source).not.toMatch(/buildPackageName/);
  });

  test("truncated comment is completed", () => {
    const source = fs.readFileSync(
      path.join(SRC_DIR, "sui/helpers.ts"),
      "utf-8"
    );
    // Before fix: "// localhost not supported for now, because the" (truncated)
    expect(source).not.toMatch(/because the\s*$/m);
  });
});
