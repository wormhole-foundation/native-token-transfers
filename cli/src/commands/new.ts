import { execSync } from "child_process";
import { $ } from "bun";
import type { Argv } from "yargs";

export function createNewCommand() {
  return {
    command: "new <path>",
    describe: "create a new NTT project",
    builder: (yargs: Argv) =>
      yargs
        .positional("path", {
          describe: "Path to the project",
          type: "string" as const,
          demandOption: true,
        })
        .example(
          "$0 new my-ntt-project",
          "Create a new NTT project in the 'my-ntt-project' directory"
        ),
    handler: async (argv: any) => {
      const git = execSync(
        "git rev-parse --is-inside-work-tree || echo false",
        {
          stdio: ["inherit", null, null],
        }
      );
      if (git.toString().trim() === "true") {
        console.error("Already in a git repository");
        process.exit(1);
      }
      const path = argv["path"];
      await $`git clone -b main https://github.com/wormhole-foundation/native-token-transfers.git ${path}`;
    },
  };
}
