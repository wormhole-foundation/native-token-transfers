import type { Platform } from "@wormhole-foundation/sdk";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { colors } from "./colors.js";
import { askForConfirmation } from "./prompts.js";

export function getAvailableVersions<P extends Platform>(
  platform: P
): string[] {
  const tags = execSync(`git tag --list 'v*+${platform.toLowerCase()}'`, {
    stdio: ["ignore", null, null],
  })
    .toString()
    .trim()
    .split("\n");
  return tags.map((tag) => tag.split("+")[0].slice(1));
}

export function getGitTagName<P extends Platform>(
  platform: P,
  version: string
): string | undefined {
  const found = execSync(
    `git tag --list 'v${version}+${platform.toLowerCase()}'`,
    {
      stdio: ["ignore", null, null],
    }
  )
    .toString()
    .trim();
  return found;
}

export function resolveVersion(
  latest: boolean,
  ver: string | undefined,
  local: boolean,
  platform: Platform
): string | null {
  if ((latest ? 1 : 0) + (ver ? 1 : 0) + (local ? 1 : 0) !== 1) {
    console.error("Specify exactly one of --latest, --ver, or --local");
    const available = getAvailableVersions(platform);
    console.error(
      `Available versions for ${platform}:\n${available.join("\n")}`
    );
    process.exit(1);
  }
  if (latest) {
    const available = getAvailableVersions(platform);
    return available.sort().reverse()[0];
  } else if (ver) {
    return ver;
  } else {
    // local version
    return null;
  }
}

export function createWorkTree(platform: Platform, version: string): string {
  const tag = getGitTagName(platform, version);
  if (!tag) {
    console.error(`No tag found matching ${version} for ${platform}`);
    process.exit(1);
  }

  const worktreeName = `.deployments/${platform}-${version}`;

  if (fs.existsSync(worktreeName)) {
    console.log(
      colors.yellow(
        `Worktree already exists at ${worktreeName}. Resetting to ${tag}`
      )
    );
    execSync(`git -C ${worktreeName} reset --hard ${tag}`, {
      stdio: "inherit",
    });
  } else {
    // create worktree
    execSync(`git worktree add ${worktreeName} ${tag}`, {
      stdio: "inherit",
    });
  }

  // NOTE: we create this symlink whether or not the file exists.
  // this way, if it's created later, the symlink will be correct
  const overridesSrc = path.resolve("overrides.json");
  const overridesDst = path.resolve(worktreeName, "overrides.json");
  fs.rmSync(overridesDst, { force: true });
  fs.symlinkSync(overridesSrc, overridesDst);

  console.log(
    colors.green(`Created worktree at ${worktreeName} from tag ${tag}`)
  );
  return worktreeName;
}

export function warnLocalDeployment(yes: boolean): Promise<void> {
  if (!yes) {
    console.warn(
      colors.yellow(
        "WARNING: You are deploying from your local working directory."
      )
    );
    console.warn(
      colors.yellow(
        "This bypasses version control and may deploy untested changes."
      )
    );
    console.warn(
      colors.yellow(
        "Ensure your local changes are thoroughly tested and compatible."
      )
    );
    return askForConfirmation(
      "Are you sure you want to continue with the local deployment?"
    );
  }
  return Promise.resolve();
}
