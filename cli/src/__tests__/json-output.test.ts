import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  setDefaultTimeout,
} from "bun:test";
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

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ntt-json-test-"));
  });

  afterEach(() => {
    if (workDir && fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("ntt init --json emits a single JSON envelope on stdout", async () => {
    const { stdout, exitCode } = await runCli(["init", "Testnet", "--json"], {
      cwd: workDir,
    });
    expect(exitCode).toBe(0);
    // stdout should be exactly the JSON envelope (plus trailing newline).
    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("init");
    expect(parsed.data.network).toBe("Testnet");
    expect(parsed.data.path).toBe("deployment.json");
  });

  it("WL_NTT_JSON=1 activates the same envelope without --json flag", async () => {
    const { stdout, exitCode } = await runCli(["init", "Mainnet"], {
      cwd: workDir,
      env: { WL_NTT_JSON: "1" },
    });
    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("init");
    expect(parsed.data.network).toBe("Mainnet");
  });

  it("human mode is unchanged (no JSON envelope on stdout)", async () => {
    const { stdout, stderr, exitCode } = await runCli(["init", "Testnet"], {
      cwd: workDir,
    });
    expect(exitCode).toBe(0);
    // Human-readable messages on stdout, no JSON envelope.
    expect(stdout).toContain("deployment.json created");
    expect(stdout).not.toContain('"ok":true');
    // Should NOT have routed human output to stderr in human mode.
    expect(stderr).not.toContain("deployment.json created");
  });

  it("--json routes human messages to stderr, keeping stdout clean", async () => {
    const { stdout, stderr, exitCode } = await runCli(
      ["init", "Testnet", "--json"],
      { cwd: workDir }
    );
    expect(exitCode).toBe(0);
    expect(stderr).toContain("deployment.json created");
    // stdout must be ONLY the JSON envelope.
    expect(stdout.trim()).toMatch(/^\{.*\}$/);
  });
});
