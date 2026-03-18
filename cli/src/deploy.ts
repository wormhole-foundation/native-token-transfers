import fs from "fs";
import {
  chainToPlatform,
  type Chain,
  type ChainAddress,
  type ChainContext,
  type Network,
  type WormholeConfigOverrides,
} from "@wormhole-foundation/sdk";
import type { Ntt } from "@wormhole-foundation/sdk-definitions-ntt";
import type { EvmNtt } from "@wormhole-foundation/sdk-evm-ntt";
import type { EvmChains } from "@wormhole-foundation/sdk-evm";
import type { SolanaChains } from "@wormhole-foundation/sdk-solana";
import { SolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";
import type { SuiChains } from "@wormhole-foundation/sdk-sui";
import type { SuiNtt } from "@wormhole-foundation/sdk-sui-ntt";

import type { SignerType } from "./signers/getSigner";
import type { CclConfig, SuiDeploymentResult } from "./commands/shared";
import { createWorkTree, warnLocalDeployment } from "./tag";
import { deployEvm, upgradeEvm } from "./evm/deploy";
import { deploySvm, upgradeSolana } from "./solana/deploy";
import { deploySui, upgradeSui } from "./sui/deploy";

export async function upgrade<N extends Network, C extends Chain>(
  _fromVersion: string,
  toVersion: string | null,
  ntt: Ntt<N, C>,
  ctx: ChainContext<N, C>,
  signerType: SignerType,
  evmVerify: boolean,
  managerVariant?: string,
  solanaPayer?: string,
  solanaProgramKeyPath?: string,
  solanaBinaryPath?: string,
  gasEstimateMultiplier?: number,
  overrides?: WormholeConfigOverrides<Network>
): Promise<void> {
  // TODO: check that fromVersion is safe to upgrade to toVersion from
  const platform = chainToPlatform(ctx.chain);
  const worktree = toVersion ? createWorkTree(platform, toVersion) : ".";
  switch (platform) {
    case "Evm": {
      const evmNtt = ntt as EvmNtt<N, EvmChains>;
      const evmCtx = ctx as ChainContext<N, EvmChains>;
      return upgradeEvm(
        worktree,
        evmNtt,
        evmCtx,
        signerType,
        evmVerify,
        managerVariant,
        gasEstimateMultiplier
      );
    }
    case "Solana": {
      if (solanaPayer === undefined || !fs.existsSync(solanaPayer)) {
        console.error("Payer not found. Specify with --payer");
        process.exit(1);
      }
      const solanaNtt = ntt as SolanaNtt<N, SolanaChains>;
      const solanaCtx = ctx as ChainContext<N, SolanaChains>;
      return upgradeSolana(
        worktree,
        toVersion,
        solanaNtt,
        solanaCtx,
        solanaPayer,
        solanaProgramKeyPath,
        solanaBinaryPath,
        overrides
      );
    }
    case "Sui": {
      const suiNtt = ntt as SuiNtt<N, SuiChains>;
      const suiCtx = ctx as ChainContext<N, SuiChains>;
      return upgradeSui(worktree, toVersion, suiNtt, suiCtx, signerType);
    }
    default:
      throw new Error("Unsupported platform");
  }
}

export async function deploy<N extends Network, C extends Chain>(
  version: string | null,
  mode: Ntt.Mode,
  ch: ChainContext<N, C>,
  token: string,
  signerType: SignerType,
  evmVerify: boolean,
  yes: boolean,
  managerVariant?: string,
  solanaPayer?: string,
  solanaProgramKeyPath?: string,
  solanaBinaryPath?: string,
  solanaPriorityFee?: number,
  suiGasBudget?: number,
  suiPackagePath?: string,
  suiWormholeState?: string,
  suiTreasuryCap?: string,
  gasEstimateMultiplier?: number,
  cclConfig?: CclConfig | null,
  overrides?: WormholeConfigOverrides<Network>
): Promise<ChainAddress<C> | SuiDeploymentResult<C>> {
  if (version === null) {
    await warnLocalDeployment(yes);
  }
  const platform = chainToPlatform(ch.chain);
  const worktree = version ? createWorkTree(platform, version) : ".";
  switch (platform) {
    case "Evm":
      return await deployEvm(
        worktree,
        mode,
        ch,
        token,
        signerType,
        evmVerify,
        managerVariant || "standard",
        gasEstimateMultiplier,
        cclConfig
      );
    case "Solana": {
      if (solanaPayer === undefined || !fs.existsSync(solanaPayer)) {
        console.error("Payer not found. Specify with --payer");
        process.exit(1);
      }
      const solanaCtx = ch as ChainContext<N, SolanaChains>;
      return (await deploySvm(
        worktree,
        version,
        mode,
        solanaCtx,
        token,
        solanaPayer,
        true,
        solanaProgramKeyPath,
        solanaBinaryPath,
        solanaPriorityFee,
        overrides
      )) as ChainAddress<C>;
    }
    case "Sui": {
      const suiCtx = ch as ChainContext<N, Chain>; // TODO: Use proper SuiChains type
      return (await deploySui(
        worktree,
        version,
        mode,
        suiCtx,
        token,
        signerType,
        true,
        undefined,
        suiGasBudget,
        suiPackagePath,
        suiWormholeState,
        suiTreasuryCap
      )) as any;
    }
    default:
      throw new Error("Unsupported platform");
  }
}
