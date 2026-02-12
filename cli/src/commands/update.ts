import { execSync } from "child_process";
import { $ } from "bun";
import type { Argv } from "yargs";

export function createUpdateCommand() {
  return {
    command: "update",
    describe: "update the NTT CLI",
    builder: (yargs: Argv) =>
      yargs
        .option("path", {
          describe:
            "Path to a local NTT repo to install from. If not specified, the latest version will be installed.",
          type: "string" as const,
        })
        .option("branch", {
          describe: "Git branch to install from",
          type: "string" as const,
        })
        .option("repo", {
          describe: "Git repository to install from",
          type: "string" as const,
        })
        .example("$0 update", "Update the NTT CLI to the latest version")
        .example(
          "$0 update --path /path/to/ntt",
          "Update the NTT CLI from a local repo"
        )
        .example(
          "$0 update --branch cli",
          "Update the NTT CLI to the cli branch"
        ),
    handler: async (argv: any) => {
      const localPath = argv["path"];
      if (localPath) {
        if (argv["ref"]) {
          console.error("Cannot specify both --path and --ref");
          process.exit(1);
        }
        if (argv["repo"]) {
          console.error("Cannot specify both --path and --repo");
          process.exit(1);
        }
        await $`${localPath}/cli/install.sh`;
      } else {
        let branchArg = "";
        let repoArg = "";
        if (argv["branch"]) {
          branchArg = `--branch ${argv["branch"]}`;
        }
        if (argv["repo"]) {
          repoArg = `--repo ${argv["repo"]}`;
        }
        const installScript =
          "https://raw.githubusercontent.com/wormhole-foundation/native-token-transfers/main/cli/install.sh";
        // save it to "$HOME/.ntt-cli/install.sh"
        const nttDir = `${process.env.HOME}/.ntt-cli`;
        const installer = `${nttDir}/install.sh`;
        execSync(`mkdir -p ${nttDir}`);
        execSync(`curl -s ${installScript} > ${installer}`);
        execSync(`chmod +x ${installer}`);
        execSync(`${installer} ${branchArg} ${repoArg}`, { stdio: "inherit" });
      }
    },
  };
}
