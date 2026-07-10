// Structured-output mode for the NTT CLI.
//
// Enabled by `--json` (anywhere in argv) or `WL_NTT_JSON=1`. While active,
// every stdout write is redirected to stderr — the only thing that lands on
// stdout is the final `{ ok: true, command, data }` line emitted by
// `emitResult()` at the end of a successful command. Callers (`wl sunrise`,
// scripts, the future web server) can read the single trailing line and
// ignore everything else as logs.
//
// Failure paths are intentionally unstructured in v1: a non-zero exit code +
// stderr is the contract. If we ever need typed errors on stdout, add an
// `{ ok: false, ... }` envelope here.

let mode: "human" | "json" = "human";
let originalStdoutWrite: typeof process.stdout.write | null = null;

/**
 * Activate JSON mode if `--json` is in argv or `WL_NTT_JSON=1` is set. Must
 * run before any command handler logs (called from `side-effects.ts` at
 * module load time so the hijack lands before any other import has a chance
 * to write).
 *
 * Bun's `console.log` doesn't always route through `process.stdout.write`, so
 * we override the console methods directly *and* keep a reference to the
 * original `process.stdout.write` for `emitResult` to use.
 */
export function initOutputMode(): void {
  if (mode === "json") return;
  const requested =
    process.env.WL_NTT_JSON === "1" || process.argv.includes("--json");
  if (!requested) return;

  mode = "json";
  originalStdoutWrite = process.stdout.write.bind(process.stdout);

  // Redirect console.log / .info / .warn / .debug to stderr. console.error
  // already goes to stderr; leave it alone.
  const redirect =
    (label: string) =>
    (...args: unknown[]): void => {
      // Use console.error so chalk / colors keep working and we don't have to
      // reimplement util.format.
      console.error(...args);
    };
  console.log = redirect("log") as typeof console.log;
  console.info = redirect("info") as typeof console.info;
  console.warn = redirect("warn") as typeof console.warn;
  console.debug = redirect("debug") as typeof console.debug;

  // Belt-and-braces: also hijack process.stdout.write so any direct stdout
  // write from a transitive dep lands on stderr.
  process.stdout.write = ((chunk: any, ...rest: any[]): boolean =>
    (process.stderr.write as any).call(
      process.stderr,
      chunk,
      ...rest
    )) as typeof process.stdout.write;
}

export function isJsonMode(): boolean {
  return mode === "json";
}

/**
 * Emit the final `{ ok: true, command, data }` line on stdout. No-op in human
 * mode. Call this exactly once at the end of a successful command handler.
 */
export function emitResult(
  command: string,
  data: Record<string, unknown>
): void {
  if (mode !== "json" || !originalStdoutWrite) return;
  originalStdoutWrite(JSON.stringify({ ok: true, command, data }) + "\n");
}
