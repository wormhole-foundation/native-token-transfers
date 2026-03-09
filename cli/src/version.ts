import fs from "fs";

export function nttVersion(): {
  version: string;
  commit: string;
  path: string;
  remote: string;
} | null {
  const nttDir = `${process.env.HOME}/.ntt-cli`;
  try {
    const versionFile = fs.readFileSync(`${nttDir}/version`).toString().trim();
    const parts = versionFile.split("\n");
    if (parts.length < 4) return null;
    const [commit, installPath, version, remote] = parts;
    return { version, commit, path: installPath, remote };
  } catch {
    return null;
  }
}

export function formatNttVersion(): string {
  const ver = nttVersion();
  if (!ver) {
    return "ntt version: unknown";
  }
  const { version, commit, path, remote } = ver;
  const defaultPath = `${process.env.HOME}/.ntt-cli/.checkout`;
  const remoteString = remote.includes("wormhole-foundation")
    ? ""
    : `${remote}@`;
  if (path === defaultPath) {
    return `ntt v${version} (${remoteString}${commit})`;
  } else {
    return `ntt v${version} (${remoteString}${commit}) from ${path}`;
  }
}
