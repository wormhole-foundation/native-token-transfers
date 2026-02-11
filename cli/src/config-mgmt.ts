import * as solanaWeb3 from "@solana/web3.js";
import {
  assertChain,
  canonicalAddress,
  chainToPlatform,
  signSendWait,
  toUniversal,
  Wormhole,
  type AccountAddress,
  type Chain,
  type ChainAddress,
  type ChainContext,
  type Network,
  type UnsignedTransaction,
  type WormholeConfigOverrides,
} from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/platforms/evm";
import solana from "@wormhole-foundation/sdk/platforms/solana";
import sui from "@wormhole-foundation/sdk/platforms/sui";
import type { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import {
  SolanaAddress,
  type SolanaChains,
} from "@wormhole-foundation/sdk-solana";
import { NTT, SolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";

import { colors } from "./colors.js";
import { colorizeDiff, diffObjects } from "./diff";
import { getSigner, type SignerType } from "./signers/getSigner";
import type { newSignSendWaiter } from "./signers/signSendWait.js";
import { EXCLUDED_DIFF_PATHS } from "./commands/shared";
import type { ChainConfig, Config } from "./deployments";
import type { Deployment } from "./validation";
import { parseUnits } from "ethers";
import {
  nttFromManager,
  formatNumber,
  getVersion,
  pullInboundLimits,
} from "./query";
import { askForConfirmation } from "./prompts.js";
import { upgrade } from "./deploy";

export async function pushDeployment<C extends Chain>(
  deployment: Deployment<C>,
  signSendWaitFunc: ReturnType<typeof newSignSendWaiter>,
  signerType: SignerType,
  evmVerify: boolean,
  yes: boolean,
  filePath?: string,
  gasEstimateMultiplier?: number,
  dangerouslyTransferOwnershipInOneStep?: boolean,
  overrides?: WormholeConfigOverrides<Network>
): Promise<void> {
  const diff = diffObjects(
    deployment.config.local!,
    deployment.config.remote!,
    EXCLUDED_DIFF_PATHS
  );
  if (Object.keys(diff).length === 0) {
    return;
  }

  const canonical = canonicalAddress(deployment.manager);
  console.log(`Pushing changes to ${deployment.manager.chain} (${canonical})`);

  console.log(colors.reset(colorizeDiff(diff)));
  if (!yes) {
    await askForConfirmation();
  }

  const ctx = deployment.ctx;

  const signer = await getSigner(ctx, signerType, undefined, filePath);

  let txs = [];
  // we perform this last to make sure we don't accidentally lock ourselves out
  let updateOwner: ReturnType<typeof deployment.ntt.setOwner> | undefined =
    undefined;
  let managerUpgrade: { from: string; to: string } | undefined;
  for (const k of Object.keys(diff)) {
    if (k === "version") {
      // TODO: check against existing version, and make sure no major version changes
      managerUpgrade = { from: diff[k]!.pull!, to: diff[k]!.push! };
    } else if (k === "owner") {
      const address: AccountAddress<C> = toUniversal(
        deployment.manager.chain,
        diff[k]?.push!
      );
      // For Solana, we need to use the low-level transfer ownership instructions
      if (chainToPlatform(deployment.manager.chain) === "Solana") {
        const solanaNtt = deployment.ntt as SolanaNtt<
          typeof deployment.ctx.config.network,
          SolanaChains
        >;
        const owner = new SolanaAddress(signer.address.address).unwrap();
        const newOwner = new SolanaAddress(address).unwrap();

        // Use one-step or two-step based on flag
        const ix = dangerouslyTransferOwnershipInOneStep
          ? await NTT.createTransferOwnershipOneStepUncheckedInstruction(
              solanaNtt.program,
              { owner, newOwner }
            )
          : await NTT.createTransferOwnershipInstruction(solanaNtt.program, {
              owner,
              newOwner,
            });

        const tx = new solanaWeb3.Transaction();
        tx.add(ix);
        tx.feePayer = owner;
        // Convert to AsyncGenerator format expected by updateOwner
        updateOwner = (async function* () {
          yield solanaNtt.createUnsignedTx(
            { transaction: tx },
            dangerouslyTransferOwnershipInOneStep
              ? "Transfer ownership (1-step)"
              : "Propose ownership transfer (2-step)"
          ) as UnsignedTransaction<any, any>;
        })();
      } else {
        updateOwner = deployment.ntt.setOwner(address, signer.address.address);
      }
    } else if (k === "pauser") {
      const address: AccountAddress<C> = toUniversal(
        deployment.manager.chain,
        diff[k]?.push!
      );
      txs.push(deployment.ntt.setPauser(address, signer.address.address));
    } else if (k === "paused") {
      if (diff[k]?.push === true) {
        txs.push(deployment.ntt.pause(signer.address.address));
      } else {
        txs.push(deployment.ntt.unpause(signer.address.address));
      }
    } else if (k === "limits") {
      const newOutbound = diff[k]?.outbound?.push;
      if (newOutbound) {
        const newOutboundBigint = parseUnits(newOutbound, deployment.decimals);
        txs.push(
          deployment.ntt.setOutboundLimit(
            newOutboundBigint,
            signer.address.address
          )
        );
      }
      const inbound = diff[k]?.inbound;
      if (inbound) {
        for (const chain of Object.keys(inbound)) {
          assertChain(chain);
          const newInbound = inbound[chain]?.push;
          if (newInbound) {
            const newInboundBigint = parseUnits(
              newInbound,
              deployment.decimals
            );
            txs.push(
              deployment.ntt.setInboundLimit(
                chain,
                newInboundBigint,
                signer.address.address
              )
            );
          }
        }
      }
    } else if (k === "transceivers") {
      // TODO: refactor this nested loop stuff into separate functions at least
      // alternatively we could first recursively collect all the things
      // to do into a flattened list (with entries like
      // transceivers.wormhole.pauser), and have a top-level mapping of
      // these entries to how they should be handled
      for (const j of Object.keys(diff[k] as object)) {
        if (j === "threshold") {
          const newThreshold = diff[k]![j]!.push;
          if (newThreshold !== undefined) {
            txs.push(
              deployment.ntt.setThreshold(newThreshold, signer.address.address)
            );
          }
        } else if (j === "wormhole") {
          for (const l of Object.keys(diff[k]![j] as object)) {
            if (l === "pauser") {
              const newTransceiverPauser = toUniversal(
                deployment.manager.chain,
                diff[k]![j]![l]!.push!
              );
              txs.push(
                deployment.whTransceiver.setPauser(
                  newTransceiverPauser,
                  signer.address.address
                )
              );
            } else {
              console.error(`Unsupported field: ${k}.${j}.${l}`);
              process.exit(1);
            }
          }
        } else {
          console.error(`Unsupported field: ${k}.${j}`);
          process.exit(1);
        }
      }
    } else {
      console.error(`Unsupported field: ${k}`);
      process.exit(1);
    }
  }
  if (managerUpgrade) {
    await upgrade(
      managerUpgrade.from,
      managerUpgrade.to,
      deployment.ntt,
      ctx,
      signerType,
      evmVerify,
      undefined,
      undefined,
      undefined,
      undefined,
      gasEstimateMultiplier,
      overrides
    );
  }
  for (const tx of txs) {
    await signSendWaitFunc(ctx, tx, signer.signer);
  }
  if (updateOwner) {
    await signSendWaitFunc(ctx, updateOwner, signer.signer);
  }
}

export async function pullDeployments(
  deployments: Config,
  network: Network,
  verbose: boolean,
  overrides?: WormholeConfigOverrides<Network>
): Promise<Partial<{ [C in Chain]: Deployment<Chain> }>> {
  let deps: Partial<{ [C in Chain]: Deployment<Chain> }> = {};

  for (const [chain, deployment] of Object.entries(deployments.chains)) {
    if (verbose) {
      process.stdout.write(`Fetching config for ${chain}......\n`);
    }
    assertChain(chain);
    const managerAddress: string | undefined = deployment.manager;
    if (managerAddress === undefined) {
      console.error(`manager field not found for chain ${chain}`);
      // process.exit(1);
      continue;
    }
    const [remote, ctx, ntt, decimals] = await pullChainConfig(
      network,
      { chain, address: toUniversal(chain, managerAddress) },
      overrides
    );
    const local = deployments.chains[chain];

    // TODO: what if it's not index 0...
    // we should check that the address of this transceiver matches the
    // address in the config. currently we just assume that ix 0 is the wormhole one
    const whTransceiver = await ntt.getTransceiver(0);
    if (whTransceiver === null) {
      console.error(`Wormhole transceiver not found for ${chain}`);
      process.exit(1);
    }

    deps[chain] = {
      ctx,
      ntt,
      decimals,
      manager: { chain, address: toUniversal(chain, managerAddress) },
      whTransceiver,
      config: {
        remote,
        local,
      },
    };
  }

  const config = Object.fromEntries(
    Object.entries(deps).map(([k, v]) => [k, v.config.remote])
  );
  const ntts = Object.fromEntries(
    Object.entries(deps).map(([k, v]) => [k, v.ntt])
  );
  await pullInboundLimits(ntts, config, verbose);
  return deps;
}

export async function pullChainConfig<N extends Network, C extends Chain>(
  network: N,
  manager: ChainAddress<C>,
  overrides?: WormholeConfigOverrides<N>
): Promise<
  [ChainConfig, ChainContext<typeof network, C>, Ntt<typeof network, C>, number]
> {
  const wh = new Wormhole(
    network,
    [solana.Platform, evm.Platform, sui.Platform],
    overrides
  );
  const ch = wh.getChain(manager.chain);

  const nativeManagerAddress = canonicalAddress(manager);

  const {
    ntt,
    addresses,
  }: { ntt: Ntt<N, C>; addresses: Partial<Ntt.Contracts> } =
    await nttFromManager<N, C>(ch, nativeManagerAddress);

  const mode = await ntt.getMode();
  const outboundLimit = await ntt.getOutboundLimit();
  const threshold = await ntt.getThreshold();

  const decimals = await ntt.getTokenDecimals();
  // insert decimal point into number
  const outboundLimitDecimals = formatNumber(outboundLimit, decimals);

  const paused = await ntt.isPaused();
  const owner = await ntt.getOwner();
  const pauser = await ntt.getPauser();

  const version = getVersion(manager.chain, ntt);

  const transceiverPauser = await ntt
    .getTransceiver(0)
    .then((t) => t?.getPauser() ?? null);

  const config: ChainConfig = {
    version,
    mode,
    paused,
    owner: owner.toString(),
    manager: nativeManagerAddress,
    token: addresses.token!,
    transceivers: {
      threshold,
      wormhole: { address: addresses.transceiver!.wormhole! },
    },
    limits: {
      outbound: outboundLimitDecimals,
      inbound: {},
    },
  };
  if (transceiverPauser) {
    config.transceivers.wormhole.pauser = transceiverPauser.toString();
  }
  if (pauser) {
    config.pauser = pauser.toString();
  }
  return [config, ch, ntt, decimals];
}
