import fs from "fs";
import path from "path";
import type { WormholeConfigOverrides } from "@wormhole-foundation/sdk-connect";
import {
  chainToPlatform,
  type Chain,
  type Network,
} from "@wormhole-foundation/sdk";
import { colors } from "./colors.js";
import { promptLine, promptYesNo } from "./prompts.js";

export function loadOverrides(): WormholeConfigOverrides<Network> {
  if (fs.existsSync("overrides.json")) {
    console.error(colors.yellow("Using overrides.json"));
    return JSON.parse(fs.readFileSync("overrides.json").toString());
  }
  return {};
}

// Offer to create/update overrides.json with a Solana Mainnet RPC before deploys.
export async function promptSolanaMainnetOverridesIfNeeded(
  network: Network,
  chain: Chain,
  overrides: WormholeConfigOverrides<Network>,
  skipPrompt: boolean
): Promise<void> {
  if (network !== "Mainnet") {
    return;
  }
  if (chainToPlatform(chain) !== "Solana") {
    return;
  }

  const solanaChain: Chain = "Solana";
  const existingRpc = overrides.chains?.[solanaChain]?.rpc;
  if (existingRpc) {
    return;
  }

  if (skipPrompt) {
    console.log(
      colors.cyan(
        "Tip: For Solana Mainnet, set a dedicated RPC in overrides.json (chains.Solana.rpc)."
      )
    );
    return;
  }

  console.log(
    colors.yellow(
      "Solana Mainnet deployments are more reliable with a dedicated RPC endpoint."
    )
  );
  const overridesPath = path.resolve("overrides.json");
  if (fs.existsSync(overridesPath)) {
    console.log(
      colors.cyan(`No Solana RPC override found in ${overridesPath}.`)
    );
  } else {
    console.log(colors.cyan("No overrides.json found in this directory."));
  }

  const wantsOverride = await promptYesNo(
    "Would you like to set one up now?"
  );
  if (!wantsOverride) {
    console.log(colors.gray("Skipping overrides.json setup."));
    return;
  }

  let rpc = "";
  while (true) {
    const input = (
      await promptLine("Solana RPC URL (leave empty to cancel): ")
    ).trim();
    if (!input) {
      console.log(
        colors.yellow("No RPC provided; skipping overrides.json setup.")
      );
      return;
    }
    try {
      const parsed = new URL(input);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Invalid protocol");
      }
      rpc = input;
      break;
    } catch {
      console.error(colors.red("Please enter a valid http(s) RPC URL."));
    }
  }

  const updatedOverrides: WormholeConfigOverrides<Network> = {
    ...overrides,
    chains: {
      ...(overrides.chains ?? {}),
      [solanaChain]: {
        ...(overrides.chains?.[solanaChain] ?? {}),
        rpc,
      },
    },
  };

  fs.writeFileSync(overridesPath, JSON.stringify(updatedOverrides, null, 2));
  Object.assign(overrides, updatedOverrides);
  console.log(colors.green(`Saved Solana RPC override to ${overridesPath}`));
}
