import { colors } from "./colors.js";
import {
  signSendWait,
  type AccountAddress,
  chainToPlatform,
} from "@wormhole-foundation/sdk";
import type { SolanaChains } from "@wormhole-foundation/sdk-solana";
import type { SolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";

export async function registerSolanaTransceiver<N, C extends SolanaChains>(
  solanaNtt: SolanaNtt<any, C>,
  ctx: any,
  signer: any
): Promise<void> {
  if (!ctx || chainToPlatform(ctx.chain) !== "Solana") {
    throw new Error("registerSolanaTransceiver called with non-Solana context");
  }

  const registerTx = solanaNtt.registerWormholeTransceiver({
    payer: signer.address.address as any as AccountAddress<C>,
    owner: signer.address.address as any as AccountAddress<C>,
  });
  await signSendWait(ctx, registerTx, signer.signer as any);
  console.log(colors.green("Wormhole transceiver registered successfully"));
}
