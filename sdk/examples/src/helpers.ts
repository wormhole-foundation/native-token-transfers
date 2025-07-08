import {
  Wormhole,
  chainToPlatform,
  encoding,
  type Chain,
  type ChainAddress,
  type ChainContext,
  type Network,
  type Signer,
} from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/platforms/evm";
import solana from "@wormhole-foundation/sdk/platforms/solana";

export interface SignerStuff<N extends Network, C extends Chain> {
  chain: ChainContext<N, C>;
  signer: Signer<N, C>;
  address: ChainAddress<C>;
}

const DEVNET_SOL_PRIVATE_KEY = encoding.b58.encode(
  new Uint8Array([
    14, 173, 153, 4, 176, 224, 201, 111, 32, 237, 183, 185, 159, 247, 22, 161,
    89, 84, 215, 209, 212, 137, 10, 92, 157, 49, 29, 192, 101, 164, 152, 70, 87,
    65, 8, 174, 214, 157, 175, 126, 98, 90, 54, 24, 100, 177, 247, 77, 19, 112,
    47, 44, 165, 109, 233, 102, 14, 86, 109, 29, 134, 145, 132, 141,
  ])
);
const DEVNET_ETH_PRIVATE_KEY =
  "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d"; // Ganache default private key

export async function getSigner<N extends Network, C extends Chain>(
  chain: ChainContext<N, C>
): Promise<SignerStuff<N, C>> {
  // Read in from `.env`
  (await import("dotenv")).config();

  let signer: Signer;
  const platform = chainToPlatform(chain.chain);
  switch (platform) {
    case "Solana":
      signer = await solana.getSigner(
        await chain.getRpc(),
        getEnv("OTHER_SOL_PRIVATE_KEY", DEVNET_SOL_PRIVATE_KEY),
        { debug: false }
      );
      break;
    case "Evm":
      signer = await evm.getSigner(
        await chain.getRpc(),
        getEnv("ETH_PRIVATE_KEY", DEVNET_ETH_PRIVATE_KEY)
      );
      break;
    default:
      throw new Error("Unrecognized platform: " + platform);
  }

  return {
    chain,
    signer: signer as Signer<N, C>,
    address: Wormhole.chainAddress(chain.chain, signer.address()),
  };
}

// Use .env.example as a template for your .env file and populate it with secrets
// for funded accounts on the relevant chain+network combos to run the example
function getEnv(key: string, dev?: string): string {
  // If we're in the browser, return empty string
  if (typeof process === "undefined") return "";
  // Otherwise, return the env var or error
  const val = process.env[key];
  if (!val) {
    if (dev) return dev;
    throw new Error(
      `Missing env var ${key}, did you forget to set values in '.env'?`
    );
  }

  return val;
}
