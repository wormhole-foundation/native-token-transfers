import { execSync } from "child_process";
import fs from "fs";
import { ethers } from "ethers";
import {
  toUniversal,
  type Chain,
  type ChainAddress,
  type ChainContext,
  type Network,
} from "@wormhole-foundation/sdk";
import type { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import type {
  EvmNtt,
  EvmNttWormholeTranceiver,
} from "@wormhole-foundation/sdk-evm-ntt";
import type { EvmChains } from "@wormhole-foundation/sdk-evm";

import { colors } from "../colors.js";
import { getSigner, forgeSignerArgs, type SignerType } from "../signers/getSigner";
import { handleDeploymentError } from "../error";
import { ensureNttRoot } from "../validation";
import { askForConfirmation } from "../prompts.js";
import type { CclConfig } from "../commands/shared";
import {
  withDeploymentScript,
  detectDeployScriptVersion,
  supportsManagerVariants,
  getSlowFlag,
  getGasMultiplier,
  buildVerifierArgs,
  seedForgeCache,
} from "./helpers";

export async function upgradeEvm<N extends Network, C extends EvmChains>(
  pwd: string,
  ntt: EvmNtt<N, C>,
  ctx: ChainContext<N, C>,
  signerType: SignerType,
  evmVerify: boolean,
  managerVariant?: string,
  gasEstimateMultiplier?: number
): Promise<void> {
  ensureNttRoot(pwd);

  console.log("Upgrading EVM chain", ctx.chain);

  const signer = await getSigner(ctx, signerType);
  const signerArgs = forgeSignerArgs(signer.source);

  console.log("Installing forge dependencies...");
  execSync("forge install", {
    cwd: `${pwd}/evm`,
    stdio: "pipe",
  });

  seedForgeCache(`${pwd}/evm`);

  let verifyArgs: string = "";
  if (evmVerify) {
    const verifyArgsArray = buildVerifierArgs(ctx.chain);
    verifyArgs = verifyArgsArray.join(" ");
  }

  // Detect script version to determine upgrade strategy
  const scriptVersion = detectDeployScriptVersion(pwd);
  console.log(`Detected deploy script version: ${scriptVersion}`);

  // Validate manager variant support for upgrades
  const variant = managerVariant || "standard";
  if (variant !== "standard") {
    if (!supportsManagerVariants(pwd)) {
      console.error(
        `Manager variant '${variant}' is not supported in this version. ` +
          `The NttManagerNoRateLimiting.sol contract does not exist.`
      );
      process.exit(1);
    }
    if (scriptVersion < 2) {
      console.error(
        `Manager variant selection requires deploy script version 2+, but found version ${scriptVersion}. ` +
          `Please upgrade to a newer version that supports manager variants.`
      );
      process.exit(1);
    }
  }

  console.log("Upgrading manager...");
  const slowFlag = getSlowFlag(ctx.chain);
  const gasMultiplier = getGasMultiplier(gasEstimateMultiplier);

  // Use bundled v1 scripts if version 1 detected
  const useBundledV1 = scriptVersion === 1;

  await withDeploymentScript(pwd, useBundledV1, async () => {
    const command = `forge script --via-ir script/DeployWormholeNtt.s.sol \
--rpc-url "${ctx.config.rpc}" \
--sig "upgrade(address)" \
${ntt.managerAddress} \
${signerArgs} \
--broadcast ${slowFlag} ${gasMultiplier} \
${verifyArgs} | tee last-run.stdout`;

    execSync(command, {
      cwd: `${pwd}/evm`,
      stdio: "inherit",
      env: {
        ...process.env,
        MANAGER_VARIANT: variant,
      },
    });
  });
}

export async function deployEvm<N extends Network, C extends Chain>(
  pwd: string,
  mode: Ntt.Mode,
  ch: ChainContext<N, C>,
  token: string,
  signerType: SignerType,
  verify: boolean,
  managerVariant: string,
  gasEstimateMultiplier?: number,
  cclConfig?: CclConfig | null
): Promise<ChainAddress<C>> {
  ensureNttRoot(pwd);

  const wormhole = ch.config.contracts.coreBridge;
  if (!wormhole) {
    console.error("Core bridge not found");
    process.exit(1);
  }

  const rpc = ch.config.rpc;
  let provider: ethers.JsonRpcProvider;
  let decimals: number;

  try {
    provider = new ethers.JsonRpcProvider(rpc);
    const abi = ["function decimals() external view returns (uint8)"];
    const tokenContract = new ethers.Contract(token, abi, provider);
    decimals = await tokenContract.decimals();
  } catch (error) {
    handleDeploymentError(error, ch.chain, ch.network, rpc);
  }

  const modeUint = mode === "locking" ? 0 : 1;
  const signer = await getSigner(ch, signerType);
  const signerArgs = forgeSignerArgs(signer.source);

  let verifyArgs: string[] = [];
  if (verify) {
    verifyArgs = buildVerifierArgs(ch.chain);
  }

  console.log("Installing forge dependencies...");
  execSync("forge install", {
    cwd: `${pwd}/evm`,
    stdio: "pipe",
  });

  seedForgeCache(`${pwd}/evm`);

  // Detect script version to determine deployment strategy
  const scriptVersion = detectDeployScriptVersion(pwd);
  console.log(`Detected deploy script version: ${scriptVersion}`);

  // Validate manager variant support
  if (managerVariant !== "standard") {
    if (!supportsManagerVariants(pwd)) {
      console.error(
        `Manager variant '${managerVariant}' is not supported in this version. ` +
          `The NttManagerNoRateLimiting.sol contract does not exist.`
      );
      process.exit(1);
    }
    if (scriptVersion < 2) {
      console.error(
        `Manager variant selection requires deploy script version 2+, but found version ${scriptVersion}. ` +
          `Please upgrade to a newer version that supports manager variants.`
      );
      process.exit(1);
    }
  }

  console.log("Deploying manager...");
  const deploy = async (simulate: boolean): Promise<string> => {
    const simulateArg = simulate ? "" : "--skip-simulation";
    const slowFlag = getSlowFlag(ch.chain);
    const gasMultiplier = getGasMultiplier(gasEstimateMultiplier);

    // Use bundled v1 scripts if version 1 detected
    const useBundledV1 = scriptVersion === 1;

    await withDeploymentScript(pwd, useBundledV1, async () => {
      try {
        let command: string;
        let env: NodeJS.ProcessEnv = { ...process.env };

        if (scriptVersion === 1) {
          // Version 1: Use explicit signature with parameters (6 params including relayers)
          // The bundled v1 scripts expect relayer addresses, use zero addresses as defaults
          const zeroAddress = "0x0000000000000000000000000000000000000000";
          const sig = "run(address,address,address,address,uint8,uint8)";
          command = `forge script --via-ir script/DeployWormholeNtt.s.sol \
--rpc-url "${rpc}" \
${simulateArg} \
--sig "${sig}" ${wormhole} ${token} ${zeroAddress} ${zeroAddress} ${decimals} ${modeUint} \
--broadcast ${slowFlag} ${gasMultiplier} ${verifyArgs.join(
            " "
          )} ${signerArgs} 2>&1 | tee last-run.stdout`;
        } else {
          // Version 2+: Use environment variables
          env = {
            ...env,
            RELEASE_CORE_BRIDGE_ADDRESS: wormhole,
            RELEASE_TOKEN_ADDRESS: token,
            RELEASE_DECIMALS: decimals.toString(),
            RELEASE_MODE: modeUint.toString(),
            RELEASE_CONSISTENCY_LEVEL: cclConfig ? "203" : "202",
            RELEASE_GAS_LIMIT: "500000",
            MANAGER_VARIANT: managerVariant,
          };

          // Add CCL-specific environment variables when CCL is enabled
          if (cclConfig) {
            env.RELEASE_CUSTOM_CONSISTENCY_LEVEL =
              cclConfig.customConsistencyLevel.toString();
            env.RELEASE_ADDITIONAL_BLOCKS =
              cclConfig.additionalBlocks.toString();
            env.RELEASE_CUSTOM_CONSISTENCY_LEVEL_ADDRESS =
              cclConfig.cclContractAddress;
          }

          command = `forge script --via-ir script/DeployWormholeNtt.s.sol \
--rpc-url "${rpc}" \
${simulateArg} \
--broadcast ${slowFlag} ${gasMultiplier} ${verifyArgs.join(
            " "
          )} ${signerArgs} 2>&1 | tee last-run.stdout`;
        }

        execSync(command, {
          cwd: `${pwd}/evm`,
          encoding: "utf8",
          stdio: "inherit",
          env,
        });
      } catch (error) {
        console.error("Failed to deploy manager");
        // NOTE: we don't exit here. instead, we check if the manager was
        // deployed successfully (below) and proceed if it was.
        // process.exit(1);
      }
    });
    return fs.readFileSync(`${pwd}/evm/last-run.stdout`).toString();
  };

  // we attempt to deploy with simulation first, then without if it fails
  let out = await deploy(true);
  if (out.includes("Simulated execution failed")) {
    if (out.includes("NotActivated")) {
      console.error(
        "Simulation failed, likely because the token contract is compiled against a different EVM version. It's probably safe to continue without simulation."
      );
      await askForConfirmation(
        "Do you want to proceed with the deployment without simulation?"
      );
    } else {
      console.error(
        "Simulation failed. Please read the error message carefully, and proceed with caution."
      );
      await askForConfirmation(
        "Do you want to proceed with the deployment without simulation?"
      );
    }
    out = await deploy(false);
  }

  if (!out) {
    console.error("Failed to deploy manager");
    process.exit(1);
  }
  const logs = out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const manager = logs.find((l) => l.includes("NttManager: 0x"))?.split(" ")[1];
  if (!manager) {
    // Extract error lines from output to show the actual failure reason
    const errorLine = logs.find((l) => l.startsWith("Error:"));
    if (errorLine) {
      console.error(colors.red(`\nDeployment failed: ${errorLine}`));
    } else {
      console.error(colors.red("Manager not found in deployment output"));
    }
    process.exit(1);
  }
  const universalManager = toUniversal(ch.chain, manager);

  // Display CCL configuration summary if CCL was used
  if (cclConfig) {
    const levelNames: Record<number, string> = {
      200: "instant",
      201: "safe",
      202: "finalized",
    };
    console.log("");
    console.log(colors.cyan("Custom Consistency Level Configuration:"));
    console.log(colors.cyan(`  - Consistency Level: 203 (Custom)`));
    console.log(
      colors.cyan(
        `  - Base Finality: ${cclConfig.customConsistencyLevel} (${levelNames[cclConfig.customConsistencyLevel]})`
      )
    );
    console.log(
      colors.cyan(`  - Additional Blocks: ${cclConfig.additionalBlocks}`)
    );
    console.log(
      colors.cyan(`  - CCL Contract: ${cclConfig.cclContractAddress}`)
    );
    console.log("");
  }

  return { chain: ch.chain, address: universalManager };
}
