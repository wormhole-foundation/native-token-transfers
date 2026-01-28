import readline from "readline";

type PromptOptions = {
  abortOnSigint?: boolean;
};

/**
 * Prompts the user for a single line of input on stdin.
 *
 * If the input stream is closed or the prompt is aborted (e.g., Ctrl+C), the
 * function resolves with an empty string unless `options.abortOnSigint` is true.
 *
 * @param prompt - The text displayed to the user before reading input
 * @param options - Optional behavior flags
 * @param options.abortOnSigint - When true, treat Ctrl+C as a hard abort and exit the process with code 130; when false, resolve with an empty string on Ctrl+C (default: false)
 * @returns The line of input entered by the user, or an empty string if the prompt was closed or aborted
 */
export async function promptLine(
  prompt: string,
  options?: PromptOptions
): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  // When enabled, treat Ctrl+C as a hard abort.
  const abortOnSigint = options?.abortOnSigint ?? false;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };

    rl.once("SIGINT", () => {
      process.stdout.write("\n");
      if (abortOnSigint) {
        process.exit(130);
      }
      settle("");
      rl.close();
    });

    rl.once("close", () => {
      if (!settled) {
        settle("");
      }
    });

    rl.question(prompt, (answer) => {
      settle(answer);
      rl.close();
    });
  });
}

/**
 * Ask the user for a yes/no confirmation and indicate which option was chosen.
 *
 * @param prompt - The text to display to the user (a suffix of ` [Y/n]` or ` [y/N]` is appended based on `defaultYes`).
 * @param options.defaultYes - If `true`, an empty response counts as confirmation; otherwise an empty response counts as rejection. Defaults to `false`.
 * @param options.abortOnSigint - If `true`, SIGINT (Ctrl+C) will cause the process to exit with code `130`. If `false`, SIGINT is treated as an empty response. Defaults to `false`.
 * @returns `true` if the user confirms by entering `y` or `yes`; `false` for `n`, `no`, any other input, or when input is empty and `defaultYes` is `false`.
 */
export async function promptYesNo(
  prompt: string,
  options?: { defaultYes?: boolean; abortOnSigint?: boolean }
): Promise<boolean> {
  const defaultYes = options?.defaultYes ?? false;
  const suffix = defaultYes ? " [Y/n]" : " [y/N]";
  const answer = (
    await promptLine(`${prompt}${suffix}`, {
      abortOnSigint: options?.abortOnSigint,
    })
  )
    .trim()
    .toLowerCase();
  if (!answer) {
    return defaultYes;
  }
  if (answer === "y" || answer === "yes") {
    return true;
  }
  if (answer === "n" || answer === "no") {
    return false;
  }
  return false;
}