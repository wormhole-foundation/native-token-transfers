import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import type {
  WormholeConfigOverrides,
  Network,
} from "@wormhole-foundation/sdk-connect";
import { Wormhole, isNetwork, networks } from "@wormhole-foundation/sdk";
import sui from "@wormhole-foundation/sdk/platforms/sui";

import { colors } from "../colors.js";
import { getSigner } from "../signers/getSigner";
import { loadConfig } from "../deployments";
import { withSuiEnv } from "../sui/helpers";
import {
  discoverNttAddresses,
  writePublishedTomls,
  buildAndPublishGovernance,
  transferGovernance,
} from "../suiGovernance";

/**
 * Resolve network and NTT state ID for Sui governance commands.
 * Reads from deployment.json (if it exists) and allows CLI overrides.
 */
function resolveSuiDeployment(argv: {
  path?: string;
  network?: string;
  "state-id"?: string;
}): { network: Network; stateId: string } {
  const deploymentPath = argv.path || "deployment.json";
  let fileNetwork: string | undefined;
  let fileStateId: string | undefined;

  if (fs.existsSync(deploymentPath)) {
    const config = loadConfig(deploymentPath);
    fileNetwork = config.network;
    fileStateId = config.chains?.Sui?.manager;
  }

  const network = (argv.network || fileNetwork) as string | undefined;
  const stateId = argv["state-id"] || fileStateId;

  if (!network || !isNetwork(network)) {
    console.error(
      "Could not determine network. Provide --network or ensure deployment.json exists."
    );
    process.exit(1);
  }

  if (network === "Devnet") {
    console.error("Devnet is not supported for governance deployment");
    process.exit(1);
  }

  if (!stateId) {
    console.error(
      "Could not determine NTT State ID. Provide --state-id or ensure deployment.json has chains.Sui.manager."
    );
    process.exit(1);
  }

  return { network, stateId };
}

export function createSuiCommand(overrides: WormholeConfigOverrides<Network>) {
  return {
    command: ["sui"] as const,
    describe: "Sui commands",
    builder: (yargs: any) => {
      return yargs
        .command(
          "deploy-governance",
          "Deploy the NTT governance package against an existing NTT deployment",
          (yargs: any) =>
            yargs
              .option("path", {
                describe: "Path to deployment.json",
                type: "string",
                default: "deployment.json",
              })
              .option("network", {
                alias: "n",
                describe: "Network (inferred from deployment.json if omitted)",
                choices: networks,
                type: "string",
              })
              .option("state-id", {
                describe:
                  "NTT State object ID (inferred from deployment.json if omitted)",
                type: "string",
              })
              .option("gas-budget", {
                describe: "Gas budget for transactions",
                type: "number",
                default: 500000000,
              })
              .option("package-path", {
                describe:
                  "Path to project root containing sui/packages/ (default: cwd)",
                type: "string",
              })
              .option("transfer", {
                describe:
                  "Also transfer AdminCap + UpgradeCap to the governance contract",
                type: "boolean",
                default: false,
              })
              .option("admin-cap", {
                describe: "AdminCap object ID override (only with --transfer)",
                type: "string",
              })
              .option("upgrade-cap", {
                describe:
                  "UpgradeCap object ID override (only with --transfer)",
                type: "string",
              }),
          async (argv: any) => {
            const { network, stateId } = resolveSuiDeployment(argv);
            const gasBudget = argv["gas-budget"] ?? 500000000;
            const packagePath = argv["package-path"] || ".";
            const doTransfer = argv["transfer"] ?? false;

            console.log(colors.blue("Deploying NTT Governance on Sui"));
            console.log(`NTT State: ${stateId}`);
            console.log(`Network: ${network}`);
            console.log(`Gas budget: ${gasBudget}`);

            const wh = new Wormhole(network, [sui.Platform], overrides);
            const ch = wh.getChain("Sui");
            const pwd = path.resolve(packagePath);

            await withSuiEnv(pwd, ch, async () => {
              const signer = await getSigner(ch, "privateKey");
              const suiSigner = signer.signer as any;
              const client = suiSigner.client;

              // ── Step 1: Discover addresses from State object ──

              console.log("Discovering package addresses from State object...");
              const addresses = await discoverNttAddresses(client, stateId);
              console.log(`NTT Package: ${addresses.nttPackageId}`);
              console.log(
                `NTT Common Package: ${addresses.nttCommonPackageId}`
              );

              // ── Step 2: Generate Published.toml files ──

              const chainIdentifier = execSync("sui client chain-identifier", {
                encoding: "utf8",
                env: process.env,
              }).trim();
              console.log(`Chain identifier: ${chainIdentifier}`);

              const buildEnv = network === "Mainnet" ? "mainnet" : "testnet";
              const packagesPath = `${pwd}/sui/packages`;

              const cleanupPublishedTomls = writePublishedTomls(
                packagesPath,
                buildEnv,
                chainIdentifier,
                addresses.nttPackageId,
                addresses.nttCommonPackageId
              );

              try {
                // ── Step 3: Build, publish, and make immutable ──

                const { govPackageId, govStateId } =
                  await buildAndPublishGovernance(
                    client,
                    suiSigner._signer,
                    packagesPath,
                    buildEnv,
                    gasBudget
                  );

                console.log(
                  colors.green(
                    `Governance package published at: ${govPackageId}`
                  )
                );
                console.log(`GovernanceState created at: ${govStateId}`);

                // ── Step 4: Optionally transfer caps ──

                if (doTransfer) {
                  await transferGovernance(
                    client,
                    suiSigner._signer,
                    stateId,
                    govStateId,
                    {
                      adminCapOverride: argv["admin-cap"],
                      upgradeCapOverride: argv["upgrade-cap"],
                      gasBudget,
                      govPackageId,
                    }
                  );
                  console.log(
                    colors.green(
                      "Caps received into GovernanceState successfully"
                    )
                  );
                }

                // ── Summary ──

                console.log(
                  "\n" +
                    colors.green(
                      "Governance deployment completed successfully!"
                    )
                );
                console.log(`Governance Package ID: ${govPackageId}`);
                console.log(`GovernanceState ID:    ${govStateId}`);
                console.log(`Package immutability:  enforced`);
                if (doTransfer) {
                  console.log(
                    `AdminCap + UpgradeCap transferred to GovernanceState`
                  );
                } else {
                  console.log(
                    colors.yellow("\nTo transfer caps to governance, run:")
                  );
                  console.log(`  ntt sui transfer-governance ${govStateId}`);
                }
              } finally {
                cleanupPublishedTomls();
              }
            });
          }
        )
        .command(
          "transfer-governance <governance-state-id>",
          "Transfer AdminCap + UpgradeCap to a deployed GovernanceState",
          (yargs: any) =>
            yargs
              .positional("governance-state-id", {
                describe: "GovernanceState object ID",
                type: "string",
                demandOption: true,
              })
              .option("path", {
                describe: "Path to deployment.json",
                type: "string",
                default: "deployment.json",
              })
              .option("network", {
                alias: "n",
                describe: "Network (inferred from deployment.json if omitted)",
                choices: networks,
                type: "string",
              })
              .option("state-id", {
                describe:
                  "NTT State object ID (inferred from deployment.json if omitted)",
                type: "string",
              })
              .option("admin-cap", {
                describe:
                  "AdminCap object ID (auto-discovered from State if omitted)",
                type: "string",
              })
              .option("upgrade-cap", {
                describe:
                  "UpgradeCap object ID (auto-discovered from State if omitted)",
                type: "string",
              })
              .option("gas-budget", {
                describe: "Gas budget for transactions",
                type: "number",
                default: 500000000,
              })
              .option("package-path", {
                describe:
                  "Path to project root containing sui/packages/ (default: cwd)",
                type: "string",
              })
              .option("skip-verification", {
                describe:
                  "Skip verifying that the governance contract targets the correct NTT",
                type: "boolean",
                default: false,
              }),
          async (argv: any) => {
            const { network, stateId } = resolveSuiDeployment(argv);
            const govStateId = argv["governance-state-id"]!;
            const gasBudget = argv["gas-budget"] ?? 500000000;
            const packagePath = argv["package-path"] || ".";

            console.log(colors.blue("Transferring caps to GovernanceState"));
            console.log(`NTT State: ${stateId}`);
            console.log(`GovernanceState: ${govStateId}`);
            console.log(`Network: ${network}`);

            const wh = new Wormhole(network, [sui.Platform], overrides);
            const ch = wh.getChain("Sui");
            const pwd = path.resolve(packagePath);

            await withSuiEnv(pwd, ch, async () => {
              const signer = await getSigner(ch, "privateKey");
              const suiSigner = signer.signer as any;

              await transferGovernance(
                suiSigner.client,
                suiSigner._signer,
                stateId,
                govStateId,
                {
                  adminCapOverride: argv["admin-cap"],
                  upgradeCapOverride: argv["upgrade-cap"],
                  gasBudget,
                  skipVerification: argv["skip-verification"],
                }
              );

              console.log(
                colors.green(
                  "\nCaps transferred to GovernanceState successfully!"
                )
              );
            });
          }
        )
        .demandCommand();
    },
    handler: () => {},
  };
}
