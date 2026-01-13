import readline from "readline";

export async function promptLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

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

export async function promptYesNo(
  prompt: string,
  options?: { defaultYes?: boolean }
): Promise<boolean> {
  const defaultYes = options?.defaultYes ?? false;
  const suffix = defaultYes ? " [Y/n]" : " [y/N]";
  const answer = (await promptLine(`${prompt}${suffix}`)).trim().toLowerCase();
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
