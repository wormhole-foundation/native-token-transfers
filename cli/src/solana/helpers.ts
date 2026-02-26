import fs from "fs";
import { execSync } from "child_process";
import { Connection, PublicKey } from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import type { Network } from "@wormhole-foundation/sdk";
import { colors } from "../colors.js";

export async function patchSolanaBinary(
  binary: string,
  wormhole: string,
  solanaAddress: string
) {
  // Ensure binary path exists
  if (!fs.existsSync(binary)) {
    console.error(`.so file not found: ${binary}`);
    process.exit(1);
  }

  // Convert addresses from base58 to Buffer
  const wormholeBuffer = new PublicKey(wormhole).toBuffer();
  const solanaAddressBuffer = new PublicKey(solanaAddress).toBuffer();

  // Read the binary file
  let binaryData = fs.readFileSync(binary);

  // Find and count occurrences of core bridge address
  let occurrences = 0;
  let searchIndex = 0;

  // Replace all occurrences of core bridge with wormhole
  searchIndex = 0;
  while (true) {
    const index = binaryData.indexOf(solanaAddressBuffer, searchIndex);
    if (index === -1) break;
    occurrences++;

    // Replace the bytes at this position
    wormholeBuffer.copy(binaryData, index);
    searchIndex = index + solanaAddressBuffer.length;
  }

  // Write the patched binary back to file
  fs.writeFileSync(binary, binaryData);

  if (occurrences > 0) {
    console.log(
      `Patched binary, replacing ${solanaAddress} with ${wormhole} in ${occurrences} places.`
    );
  }
}

export async function checkSvmBinary(
  binary: string,
  wormhole: string,
  providedProgramId: string,
  version?: string
) {
  // ensure binary path exists
  if (!fs.existsSync(binary)) {
    console.error(`.so file not found: ${binary}`);
    process.exit(1);
  }

  // convert addresses from base58 to Buffer
  const wormholeBuffer = new PublicKey(wormhole).toBuffer();
  const providedProgramIdBuffer = new PublicKey(providedProgramId).toBuffer();
  const versionBuffer = version ? Buffer.from(version, "utf8") : undefined;

  if (!searchBufferInBinary(binary, wormholeBuffer)) {
    console.error(`Wormhole address not found in binary: ${wormhole}`);
    process.exit(1);
  }
  if (!searchBufferInBinary(binary, providedProgramIdBuffer)) {
    console.error(
      `Provided program ID not found in binary: ${providedProgramId}`
    );
    process.exit(1);
  }
  if (versionBuffer && !searchBufferInBinary(binary, versionBuffer)) {
    // TODO: figure out how to search for the version string in the binary
    // console.error(`Version string not found in binary: ${version}`);
    // process.exit(1);
  }
}

// Search for a buffer pattern within a binary file using direct buffer operations
function searchBufferInBinary(
  binaryPath: string,
  searchBuffer: Buffer
): boolean {
  const binaryData = fs.readFileSync(binaryPath);
  return binaryData.indexOf(searchBuffer) !== -1;
}

/**
 * Check if the Solana program supports the bridge-address-from-env feature
 */
export function hasBridgeAddressFromEnvFeature(pwd: string): boolean {
  try {
    const cargoTomlPath = `${pwd}/solana/programs/example-native-token-transfers/Cargo.toml`;
    if (!fs.existsSync(cargoTomlPath)) {
      return false;
    }
    const cargoToml = fs.readFileSync(cargoTomlPath, "utf8");
    // Check if bridge-address-from-env feature is defined
    return cargoToml.includes("bridge-address-from-env");
  } catch (error) {
    return false;
  }
}

export function cargoNetworkFeature(network: Network): string {
  switch (network) {
    case "Mainnet":
      return "mainnet";
    case "Testnet":
      return "solana-devnet";
    case "Devnet":
      return "tilt-devnet";
    default:
      throw new Error("Unsupported network");
  }
}

// Check Solana toolchain version against Anchor.toml requirements
export function checkSolanaVersion(pwd: string): void {
  try {
    // Read required version from Anchor.toml
    const anchorToml = fs.readFileSync(`${pwd}/solana/Anchor.toml`, "utf8");
    const versionMatch = anchorToml.match(/solana_version = "(.+)"/);

    if (!versionMatch) {
      console.warn(
        colors.yellow("Warning: Could not find solana_version in Anchor.toml")
      );
      return;
    }

    const requiredVersion = versionMatch[1];

    // Get current Solana version and detect client type
    let currentVersion: string;
    let clientType: "agave" | "solanalabs";
    try {
      const output = execSync("solana --version", {
        encoding: "utf8",
        stdio: "pipe",
      });
      const versionMatch = output.match(/solana-cli (\d+\.\d+\.\d+)/);
      if (!versionMatch) {
        console.error(colors.red("Error: Could not parse solana CLI version"));
        process.exit(1);
      }
      currentVersion = versionMatch[1];

      // Detect client type
      if (output.includes("Agave")) {
        clientType = "agave";
      } else if (output.includes("SolanaLabs")) {
        clientType = "solanalabs";
      } else {
        // Default to agave if we can't detect
        clientType = "agave";
      }
    } catch (error) {
      console.error(
        colors.red(
          "Error: solana CLI not found. Please install the Solana toolchain."
        )
      );
      console.error(
        colors.yellow(
          'Install with: sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"'
        )
      );
      process.exit(1);
    }

    if (currentVersion !== requiredVersion) {
      console.log(colors.yellow(`Solana version mismatch detected:`));
      console.log(
        colors.yellow(`  Required: ${requiredVersion} (from Anchor.toml)`)
      );
      console.log(colors.yellow(`  Current:  ${currentVersion}`));
      console.log(colors.yellow(`\nSwitching to required version...`));

      // Run the appropriate version switch command
      const installCommand =
        clientType === "agave"
          ? `agave-install init ${requiredVersion}`
          : `solana-install init ${requiredVersion}`;

      try {
        execSync(installCommand, { stdio: "inherit" });
        console.log(
          colors.green(
            `Successfully switched to Solana version ${requiredVersion}`
          )
        );
      } catch (error) {
        console.error(
          colors.red(`Failed to switch Solana version using ${installCommand}`)
        );
        console.error(colors.red(`Please run manually: ${installCommand}`));
        process.exit(1);
      }
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      console.warn(colors.yellow("Warning: Could not read Anchor.toml file"));
    } else {
      console.warn(
        colors.yellow(
          `Warning: Failed to check Solana version: ${
            error instanceof Error ? error.message : error
          }`
        )
      );
    }
  }
}

export function checkAnchorVersion(pwd: string) {
  try {
    // Read required version from Anchor.toml
    const anchorToml = fs.readFileSync(`${pwd}/solana/Anchor.toml`, "utf8");
    const versionMatch = anchorToml.match(/anchor_version = "(.+)"/);

    if (!versionMatch) {
      console.error(
        colors.red("Error: Could not find anchor_version in Anchor.toml")
      );
      process.exit(1);
    }

    const expected = versionMatch[1];

    // Check if Anchor CLI is installed
    try {
      execSync("which anchor");
    } catch {
      console.error(
        "Anchor CLI is not installed.\nSee https://www.anchor-lang.com/docs/installation"
      );
      process.exit(1);
    }

    // Get current Anchor version
    const version = execSync("anchor --version").toString().trim();
    // version looks like "anchor-cli 0.14.0"
    const [_, v] = version.split(" ");
    if (v !== expected) {
      console.error(colors.red(`Anchor CLI version mismatch!`));
      console.error(colors.red(`  Required: ${expected} (from Anchor.toml)`));
      console.error(colors.red(`  Current:  ${v}`));
      console.error(
        colors.yellow(`\nTo fix this, install the correct version of Anchor`)
      );
      console.error(
        colors.gray("See https://www.anchor-lang.com/docs/installation")
      );
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      console.error(colors.red("Error: Could not read Anchor.toml file"));
      console.error(
        colors.yellow(`Expected file at: ${pwd}/solana/Anchor.toml`)
      );
      process.exit(1);
    } else {
      throw error;
    }
  }
}

export async function checkSvmValidSplMultisig(
  connection: Connection,
  address: PublicKey,
  programId: PublicKey,
  tokenAuthority: PublicKey
): Promise<boolean> {
  let isMultisigTokenAuthority = false;
  try {
    const multisigInfo = await spl.getMultisig(
      connection,
      address,
      undefined,
      programId
    );
    if (multisigInfo.m === 1) {
      const n = multisigInfo.n;
      for (let i = 0; i < n; ++i) {
        // TODO: not sure if there's an easier way to loop through and check
        if (
          (
            multisigInfo[`signer${i + 1}` as keyof spl.Multisig] as PublicKey
          ).equals(tokenAuthority)
        ) {
          isMultisigTokenAuthority = true;
          break;
        }
      }
    }
  } catch {}
  return isMultisigTokenAuthority;
}
