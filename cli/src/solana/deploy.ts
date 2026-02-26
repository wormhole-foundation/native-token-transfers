import { execSync } from "child_process";
import fs from "fs";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as spl from "@solana/spl-token";
import {
  encoding,
  signSendWait,
  toUniversal,
  Wormhole,
  type Chain,
  type ChainAddress,
  type ChainContext,
  type Network,
  type WormholeConfigOverrides,
} from "@wormhole-foundation/sdk";
import solana from "@wormhole-foundation/sdk/platforms/solana";
import type { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import type { SolanaChains } from "@wormhole-foundation/sdk-solana";
import { NTT, SolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";

import { getSigner, type SignerType } from "../signers/getSigner";
import { handleDeploymentError } from "../error";
import { ensureNttRoot } from "../validation";
import { askForConfirmation } from "../prompts.js";
import { registerSolanaTransceiver } from "./transceiver";
import {
  patchSolanaBinary,
  checkSvmBinary,
  cargoNetworkFeature,
  checkSolanaVersion,
  checkAnchorVersion,
  checkSvmValidSplMultisig,
  hasBridgeAddressFromEnvFeature,
} from "./helpers";

/**
 * Build the Solana NTT program using anchor build.
 * Uses bridge-address-from-env feature if available, otherwise uses network-specific features.
 * For legacy builds on non-Solana chains, patches the binary after building.
 * @param pwd - Project root directory
 * @param network - Network to build for
 * @param chain - Target chain (used to determine if patching is needed)
 * @param wormhole - Wormhole core bridge address
 * @param overrides - Wormhole SDK config overrides
 * @returns Exit code from anchor build
 */
async function runAnchorBuild(
  pwd: string,
  network: Network,
  chain: Chain,
  wormhole: string,
  overrides?: WormholeConfigOverrides<Network>
): Promise<number> {
  checkAnchorVersion(pwd);

  const useBridgeFromEnv = hasBridgeAddressFromEnvFeature(pwd);

  let buildArgs: string[];
  let buildEnv: NodeJS.ProcessEnv;

  if (useBridgeFromEnv) {
    // New method: use bridge-address-from-env feature with BRIDGE_ADDRESS env var
    console.log(
      `Building with bridge-address-from-env feature (BRIDGE_ADDRESS=${wormhole})...`
    );
    buildArgs = [
      "anchor",
      "build",
      "-p",
      "example_native_token_transfers",
      "--",
      "--no-default-features",
      "--features",
      "bridge-address-from-env",
    ];
    buildEnv = {
      ...process.env,
      BRIDGE_ADDRESS: wormhole,
    };
  } else {
    // Old method: use network-specific feature (mainnet, solana-devnet, tilt-devnet)
    const networkFeature = cargoNetworkFeature(network);
    console.log(`Building with ${networkFeature} feature (legacy method)...`);
    buildArgs = [
      "anchor",
      "build",
      "-p",
      "example_native_token_transfers",
      "--",
      "--no-default-features",
      "--features",
      networkFeature,
    ];
    buildEnv = process.env;
  }

  const proc = Bun.spawn(buildArgs, {
    cwd: `${pwd}/solana`,
    env: buildEnv,
  });

  await proc.exited;
  const exitCode = proc.exitCode ?? 1;

  if (exitCode !== 0) {
    return exitCode;
  }

  // For legacy builds on non-Solana chains, patch the binary
  if (!useBridgeFromEnv && chain !== "Solana") {
    const binary = `${pwd}/solana/target/deploy/example_native_token_transfers.so`;

    // Get Solana mainnet address for patching
    const wh = new Wormhole(network, [solana.Platform], overrides);
    const sol = wh.getChain("Solana");
    const solanaAddress = sol.config.contracts.coreBridge;
    if (!solanaAddress) {
      console.error("Core bridge address not found in Solana config");
      return 1;
    }

    console.log(`Patching binary for ${chain}...`);
    await patchSolanaBinary(binary, wormhole, solanaAddress);
  }

  return exitCode;
}

/**
 * Build the Solana NTT program binary
 * @param pwd - Project root directory
 * @param network - Network to build for (affects cargo features)
 * @param chain - Target chain (for patching non-Solana chains)
 * @param wormhole - Wormhole core bridge address for verification
 * @param version - Version string for verification (optional)
 * @param programKeyPath - Optional path to program keypair (if not provided, will look for {programId}.json)
 * @param binaryPath - Optional path to pre-built binary (if provided, building is skipped)
 * @param overrides - Wormhole SDK config overrides
 * @returns Object containing binary path, program ID, and program keypair path
 */
export async function buildSvm(
  pwd: string,
  network: Network,
  chain: Chain,
  wormhole: string,
  version: string | null,
  programKeyPath?: string,
  binaryPath?: string,
  overrides?: WormholeConfigOverrides<Network>
): Promise<{ binary: string; programId: string; programKeypairPath: string }> {
  ensureNttRoot(pwd);
  checkSolanaVersion(pwd);

  // If binary is provided, still need to get program ID
  const existingProgramId = fs
    .readFileSync(`${pwd}/solana/Anchor.toml`)
    .toString()
    .match(/example_native_token_transfers = "(.*)"/)?.[1];
  if (!existingProgramId) {
    console.error(
      'Program ID not found in Anchor.toml (looked for example_native_token_transfers = "(.*)")'
    );
    process.exit(1);
  }

  let programKeypairPath: string;
  let programKeypair: Keypair;

  if (programKeyPath) {
    if (!fs.existsSync(programKeyPath)) {
      console.error(`Program keypair not found: ${programKeyPath}`);
      process.exit(1);
    }
    programKeypairPath = programKeyPath;
    programKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(programKeyPath).toString()))
    );
  } else {
    const programKeyJson = `${existingProgramId}.json`;
    if (!fs.existsSync(programKeyJson)) {
      console.error(`Program keypair not found: ${programKeyJson}`);
      console.error(
        "Run `solana-keygen` to create a new keypair (either with 'new', or with 'grind'), and pass it to this command with --program-key"
      );
      console.error(
        "For example: solana-keygen grind --starts-with ntt:1 --ignore-case"
      );
      process.exit(1);
    }
    programKeypairPath = programKeyJson;
    programKeypair = Keypair.fromSecretKey(
      new Uint8Array(JSON.parse(fs.readFileSync(programKeyJson).toString()))
    );
    if (existingProgramId !== programKeypair.publicKey.toBase58()) {
      console.error(
        `The private key in ${programKeyJson} does not match the existing program ID: ${existingProgramId}`
      );
      process.exit(1);
    }
  }

  // see if the program key matches the existing program ID. if not, we need
  // to update the latter in the Anchor.toml file and the lib.rs file(s)
  const providedProgramId = programKeypair.publicKey.toBase58();
  if (providedProgramId !== existingProgramId) {
    // only ask for confirmation if the current directory is ".". if it's
    // something else (a worktree) then it's a fresh checkout and we just
    // override the address anyway.
    if (pwd === ".") {
      console.error(
        `Program keypair does not match the existing program ID: ${existingProgramId}`
      );
      await askForConfirmation(
        `Do you want to update the program ID in the Anchor.toml file and the lib.rs file to ${providedProgramId}?`
      );
    }

    const anchorTomlPath = `${pwd}/solana/Anchor.toml`;
    const libRsPath = `${pwd}/solana/programs/example-native-token-transfers/src/lib.rs`;

    const anchorToml = fs.readFileSync(anchorTomlPath).toString();
    const newAnchorToml = anchorToml.replace(
      existingProgramId,
      providedProgramId
    );
    fs.writeFileSync(anchorTomlPath, newAnchorToml);
    const libRs = fs.readFileSync(libRsPath).toString();
    const newLibRs = libRs.replace(existingProgramId, providedProgramId);
    fs.writeFileSync(libRsPath, newLibRs);
  }

  let binary: string;

  if (binaryPath) {
    console.log(`Using provided binary: ${binaryPath}`);
    binary = binaryPath;
  } else {
    // build the program
    console.log(`Building SVM program for ${network}...`);
    const exitCode = await runAnchorBuild(
      pwd,
      network,
      chain,
      wormhole,
      overrides
    );
    if (exitCode !== 0) {
      process.exit(exitCode);
    }

    binary = `${pwd}/solana/target/deploy/example_native_token_transfers.so`;
    console.log(`Build complete: ${binary}`);
  }

  // Verify the binary contains expected addresses and version
  console.log(`Verifying binary...`);
  await checkSvmBinary(
    binary,
    wormhole,
    providedProgramId,
    version ?? undefined
  );
  console.log(`✓ Binary verification passed`);

  return {
    binary,
    programId: providedProgramId,
    programKeypairPath,
  };
}

export async function deploySvm<N extends Network, C extends SolanaChains>(
  pwd: string,
  version: string | null,
  mode: Ntt.Mode,
  ch: ChainContext<N, C>,
  token: string,
  payer: string,
  initialize: boolean,
  managerKeyPath?: string,
  binaryPath?: string,
  priorityFee?: number,
  overrides?: WormholeConfigOverrides<Network>
): Promise<ChainAddress<C>> {
  const wormhole = ch.config.contracts.coreBridge;
  if (!wormhole) {
    console.error("Core bridge not found");
    process.exit(1);
  }

  // Build the Solana program (or use provided binary)
  const buildResult = await buildSvm(
    pwd,
    ch.network,
    ch.chain,
    wormhole,
    version,
    managerKeyPath,
    binaryPath,
    overrides
  );
  const {
    binary,
    programId: providedProgramId,
    programKeypairPath,
  } = buildResult;

  // First we check that the provided mint's mint authority is the program's token authority PDA when in burning mode.
  // This is checked in the program initialiser anyway, but we can save some
  // time by checking it here and failing early (not to mention better
  // diagnostics).

  const emitter = NTT.transceiverPdas(providedProgramId)
    .emitterAccount()
    .toBase58();
  const payerKeypair = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(payer).toString()))
  );

  // this is not super pretty... I want to initialise the 'ntt' object, but
  // because it's not deployed yet, fetching the version will fail, and thus default to whatever the default version is.
  // We want to use the correct version (because the sdk's behaviour depends on it), so we first create a dummy ntt instance,
  // let that fill in all the necessary fields, and then create a new instance with the correct version.
  // It should be possible to avoid this dummy object and just instantiate 'SolanaNtt' directly, but I wasn't
  // sure where the various pieces are plugged together and this seemed easier.
  // TODO: refactor this to avoid the dummy object
  const dummy: SolanaNtt<N, C> = (await ch.getProtocol("Ntt", {
    ntt: {
      manager: providedProgramId,
      token: token,
      transceiver: { wormhole: emitter },
    },
  })) as SolanaNtt<N, C>;

  const ntt: SolanaNtt<N, C> = new SolanaNtt(
    dummy.network,
    dummy.chain,
    dummy.connection,
    dummy.contracts,
    version ?? undefined
  );

  // get the mint authority of 'token'
  const tokenMint = new PublicKey(token);
  const connection: Connection = await ch.getRpc();
  let mintInfo;
  try {
    mintInfo = await connection.getAccountInfo(tokenMint);
  } catch (error) {
    handleDeploymentError(error, ch.chain, ch.network, ch.config.rpc);
  }
  if (!mintInfo) {
    console.error(`Mint ${token} not found on ${ch.chain} ${ch.network}`);
    process.exit(1);
  }
  const mint = spl.unpackMint(tokenMint, mintInfo, mintInfo.owner);
  const tokenAuthority = ntt.pdas.tokenAuthority();

  if (mode === "burning") {
    // verify mint authority is token authority or valid SPL Multisig
    const actualMintAuthority: string | null =
      mint.mintAuthority?.toBase58() ?? null;
    if (actualMintAuthority !== tokenAuthority.toBase58()) {
      const isValidSplMultisig =
        actualMintAuthority &&
        (await checkSvmValidSplMultisig(
          connection,
          new PublicKey(actualMintAuthority),
          mintInfo.owner,
          tokenAuthority
        ));
      if (!isValidSplMultisig) {
        console.error(`Mint authority mismatch for ${token}`);
        console.error(
          `Expected: ${tokenAuthority.toBase58()} or valid SPL Multisig`
        );
        console.error(`Actual: ${actualMintAuthority}`);
        console.error(
          `Set the mint authority to the program's token authority PDA with e.g.:`
        );
        console.error(
          `ntt set-mint-authority --token ${token} --manager ${providedProgramId} --chain Solana`
        );
        process.exit(1);
      }
    }
  }

  // Deploy the binary (patching was already done during build for legacy builds on non-Solana chains)
  const skipDeploy = false;

  if (!skipDeploy) {
    // if buffer.json doesn't exist, create it
    if (!fs.existsSync(`buffer.json`)) {
      execSync(`solana-keygen new -o buffer.json --no-bip39-passphrase`);
    } else {
      console.info("buffer.json already exists.");
      await askForConfirmation(
        "Do you want continue an exiting deployment? If not, delete the buffer.json file and run the command again."
      );
    }

    const deployCommand = [
      "solana",
      "program",
      "deploy",
      "--program-id",
      programKeypairPath,
      "--buffer",
      `buffer.json`,
      binary,
      "--keypair",
      payer,
      "-u",
      ch.config.rpc,
      "--commitment",
      "finalized",
    ];

    if (priorityFee !== undefined) {
      deployCommand.push("--with-compute-unit-price", priorityFee.toString());
    }

    const deployProc = Bun.spawn(deployCommand);

    const out = await new Response(deployProc.stdout).text();

    await deployProc.exited;

    if (deployProc.exitCode !== 0) {
      process.exit(deployProc.exitCode ?? 1);
    }

    // success. remove buffer.json
    fs.unlinkSync("buffer.json");

    console.log(out);
  }

  if (initialize) {
    // wait 3 seconds
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const tx = ntt.initialize(
      toUniversal(ch.chain, payerKeypair.publicKey.toBase58()),
      {
        mint: new PublicKey(token),
        mode,
        outboundLimit: 100000000n,
        ...(mode === "burning" &&
          !mint.mintAuthority!.equals(tokenAuthority) && {
            multisigTokenAuthority: mint.mintAuthority!,
          }),
      }
    );

    const signer = await getSigner(
      ch,
      "privateKey",
      encoding.b58.encode(payerKeypair.secretKey)
    );

    try {
      await signSendWait(ch, tx, signer.signer);
    } catch (e: any) {
      console.error(e.logs);
    }

    // After initialize, attempt to register the Wormhole transceiver
    try {
      await registerSolanaTransceiver(ntt as any, ch, signer);
    } catch (e: any) {
      console.error(e.logs);
    }
  }

  return { chain: ch.chain, address: toUniversal(ch.chain, providedProgramId) };
}

export async function upgradeSolana<N extends Network, C extends SolanaChains>(
  pwd: string,
  version: string | null,
  ntt: SolanaNtt<N, C>,
  ctx: ChainContext<N, C>,
  payer: string,
  programKeyPath?: string,
  binaryPath?: string,
  overrides?: WormholeConfigOverrides<Network>
): Promise<void> {
  if (version === null) {
    throw new Error("Cannot upgrade Solana to local version"); // TODO: this is not hard to enabled
  }
  const mint = (await ntt.getConfig()).mint;
  await deploySvm(
    pwd,
    version,
    await ntt.getMode(),
    ctx,
    mint.toBase58(),
    payer,
    false,
    programKeyPath,
    binaryPath,
    undefined,
    overrides
  );
  // TODO: call initializeOrUpdateLUT. currently it's done in the following 'ntt push' step.
}
