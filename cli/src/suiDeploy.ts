import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const MIN_SUI_VERSION = "1.63.0";

function parseVersion(version: string): number[] {
  return version.split(".").map(Number);
}

function versionAtLeast(current: string, minimum: string): boolean {
  const cur = parseVersion(current);
  const min = parseVersion(minimum);
  for (let i = 0; i < min.length; i++) {
    if ((cur[i] ?? 0) > min[i]) return true;
    if ((cur[i] ?? 0) < min[i]) return false;
  }
  return true;
}

export function checkSuiVersion(): void {
  let output: string;
  try {
    output = execFileSync("sui", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Could not run 'sui --version'. Is the Sui CLI installed?");
  }
  // Output format: "sui 1.63.2-abc123"
  const match = output.match(/sui\s+(\d+\.\d+\.\d+)/);
  if (!match) {
    throw new Error(`Could not parse Sui version from: ${output}`);
  }
  const version = match[1];
  if (!versionAtLeast(version, MIN_SUI_VERSION)) {
    throw new Error(
      `Sui CLI version ${version} is too old. Minimum required: ${MIN_SUI_VERSION}. ` +
        `Please update with: cargo install --locked --git https://github.com/MystenLabs/sui.git sui`
    );
  }
  console.log(`Sui CLI version: ${version}`);
}

export function buildSuiPackage(
  packagesPath: string,
  packageName: string,
  buildEnv: string
): void {
  console.log(`Building ${packageName} package...`);
  try {
    execFileSync("sui", ["move", "build", "-e", buildEnv], {
      cwd: path.join(packagesPath, packageName),
      stdio: "inherit",
      env: process.env,
    });
  } catch (e) {
    console.error(`Failed to build ${packageName} package`);
    throw e;
  }
}

export interface SuiPublishResult {
  packageId: string;
  objectChanges: any[];
}

export function publishSuiPackage(
  packagesPath: string,
  packageName: string,
  gasBudget: number
): SuiPublishResult {
  console.log(`Publishing ${packageName} package...`);
  const result = execFileSync(
    "sui",
    ["client", "publish", "--gas-budget", String(gasBudget), "--json"],
    {
      cwd: path.join(packagesPath, packageName),
      encoding: "utf8",
      env: process.env,
    }
  );
  const deploy = JSON.parse(result.substring(result.indexOf("{")));
  if (!deploy.objectChanges) {
    throw new Error(`Failed to deploy ${packageName} package`);
  }
  const packageId = deploy.objectChanges.find(
    (c: any) => c.type === "published"
  )?.packageId;
  if (!packageId) {
    throw new Error(`Could not find package ID for ${packageName} in publish result`);
  }
  console.log(`${packageName} deployed at: ${packageId}`);
  return { packageId, objectChanges: deploy.objectChanges };
}

/**
 * Find a created object in transaction objectChanges by type substring.
 * If `shared` is true, only matches shared objects.
 */
export function findCreatedObject(
  objectChanges: any[],
  typeSubstring: string,
  shared?: boolean
): string | undefined {
  return objectChanges.find(
    (c: any) =>
      c.type === "created" &&
      c.objectType?.includes(typeSubstring) &&
      (!shared || c.owner?.Shared)
  )?.objectId;
}

/**
 * Generate Published.toml content for a Sui package.
 * Tells the build system the package is already published at the given address.
 */
export function generatePublishedToml(
  env: string,
  chainId: string,
  packageId: string
): string {
  return `[published.${env}]\nchain-id = "${chainId}"\npublished-at = "${packageId}"\noriginal-id = "${packageId}"\nversion = 1\n`;
}

export function parsePublishedToml(
  filePath: string,
  env: string
): { packageId: string; upgradeCap: string } {
  const content = fs.readFileSync(filePath, "utf8");
  const section = content.match(
    new RegExp(`\\[published\\.${env}\\][\\s\\S]*?(?=\\[|$)`)
  );
  if (!section) throw new Error(`No [published.${env}] section in ${filePath}`);
  const publishedAt = section[0].match(/published-at\s*=\s*"(0x[0-9a-f]+)"/);
  const upgradeCap = section[0].match(
    /upgrade-capability\s*=\s*"(0x[0-9a-f]+)"/
  );
  if (!publishedAt?.[1])
    throw new Error(`No published-at in [published.${env}] of ${filePath}`);
  if (!upgradeCap?.[1])
    throw new Error(
      `No upgrade-capability in [published.${env}] of ${filePath}`
    );
  return {
    packageId: publishedAt[1],
    upgradeCap: upgradeCap[1],
  };
}

export function movePublishedTomlToMainTree(
  packagesPath: string,
  mainTreePackagesPath: string,
  packageNames: string[]
): void {
  for (const pkg of packageNames) {
    const worktreePath = `${packagesPath}/${pkg}/Published.toml`;
    const mainTreePath = `${mainTreePackagesPath}/${pkg}/Published.toml`;

    if (
      fs.existsSync(worktreePath) &&
      !fs.lstatSync(worktreePath).isSymbolicLink()
    ) {
      fs.copyFileSync(worktreePath, mainTreePath);
      fs.unlinkSync(worktreePath);
      fs.rmSync(worktreePath, { force: true });
      fs.symlinkSync(path.resolve(mainTreePath), path.resolve(worktreePath));
      console.log(`Moved Published.toml for ${pkg} to ${mainTreePath}`);
    }
  }
}

export interface SuiSetupProgress {
  nttStateId?: string;
  nttAdminCapId?: string;
  transceiverStateId?: string;
  whTransceiverAdminCapId?: string;
  transceiverRegistered?: boolean;
}

export function readSetupProgress(filePath: string): SuiSetupProgress {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

export function saveSetupProgress(
  filePath: string,
  progress: SuiSetupProgress
): void {
  fs.writeFileSync(filePath, JSON.stringify(progress, null, 2));
}
