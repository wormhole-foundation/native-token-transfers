// TODO: these functions belong in an sdk for the executor (where the types can be shared)
import axios from "axios";
import { Chain, chainToChainId } from "@wormhole-foundation/sdk";
export async function fetchQuote(
  srcChain: Chain,
  dstChain: Chain
): Promise<`0x${string}`> {
  const ret = await axios.get(
    `http://executor:3000/v0/quote/${chainToChainId(srcChain)}/${chainToChainId(
      dstChain
    )}`
  );
  return ret.data.signedQuote;
}
export async function fetchEstimate(
  quote: `0x${string}`,
  relayInstructions: `0x${string}`
): Promise<bigint> {
  const ret = await axios.get(
    `http://executor:3000/v0/estimate/${quote}/${relayInstructions}/`
  );
  return BigInt(ret.data.estimate);
}
