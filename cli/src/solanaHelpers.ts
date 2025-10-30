import chalk from "chalk";
import { signSendWait, type AccountAddress } from "@wormhole-foundation/sdk";
import type { SolanaChains } from "@wormhole-foundation/sdk-solana";
import type { SolanaNtt } from "@wormhole-foundation/sdk-solana-ntt";
import type { getSigner as getSignerFn } from "./getSigner";

type SignerReturn = Awaited<ReturnType<typeof getSignerFn>>;

export async function registerSolanaTransceiver<N, C extends SolanaChains>(
  solanaNtt: SolanaNtt<any, C>,
  ctx: any,
  signer: SignerReturn
): Promise<void> {
  const registerTx = solanaNtt.registerWormholeTransceiver({
    payer: signer.address.address as AccountAddress<C>,
    owner: signer.address.address as AccountAddress<C>,
  });
  await signSendWait(ctx, registerTx, signer.signer);
  console.log(chalk.green("Wormhole transceiver registered successfully"));
}