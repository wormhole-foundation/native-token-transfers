import readline from "readline";

type PromptOptions = {
  abortOnSigint?: boolean;
};

/** Prompt for a single line of input from stdin. */
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

/** Prompt for a yes/no confirmation and return the choice. */
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

export async function askForConfirmation(
  prompt: string = "Do you want to continue?"
): Promise<void> {
  const confirmed = await promptYesNo(prompt);
  if (!confirmed) {
    console.log("Aborting");
    process.exit(0);
  }
}
