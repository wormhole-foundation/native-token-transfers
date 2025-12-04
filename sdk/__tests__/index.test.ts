import { web3 } from "@coral-xyz/anchor";
import { chainToPlatform, UniversalAddress } from "@wormhole-foundation/sdk-connect";
import { registerRelayers } from "./accountant.js";
import { Ctx, deploy, setMessageFee, testHub, testPausing, testTempStacksHub, wh } from "./utils.js";
import { ethers } from "ethers";
import { test } from '@jest/globals';
import { Cl, cvToValue, fetchCallReadOnlyFunction } from "@stacks/transactions";

// Note: Currently, in order for this to run, the evm bindings with extra contracts must be build
// To do that, at the root, run `npm run generate:test`
jest.setTimeout(6000000);

// https://github.com/wormhole-foundation/wormhole/blob/347357b251e850a51eca351943cf71423c4f0bc3/scripts/devnet-consts.json#L257
const ETH_PRIVATE_KEY =
  "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d"; // Ganache default private key

// https://github.com/wormhole-foundation/wormhole/blob/347357b251e850a51eca351943cf71423c4f0bc3/scripts/devnet-consts.json#L272
const ETH_PRIVATE_KEY_2 =
  "0x646f1ce2fdad0e6deeeb5c7e8e5543bdde65e86029e2fd9fc169899c440a7913"; // Ganache account 3

// https://github.com/wormhole-foundation/wormhole/blob/347357b251e850a51eca351943cf71423c4f0bc3/sdk/js/src/token_bridge/__tests__/utils/consts.ts#L33-L38
const SOL_PRIVATE_KEY = web3.Keypair.fromSecretKey(
  new Uint8Array([
    14, 173, 153, 4, 176, 224, 201, 111, 32, 237, 183, 185, 159, 247, 22, 161,
    89, 84, 215, 209, 212, 137, 10, 92, 157, 49, 29, 192, 101, 164, 152, 70, 87,
    65, 8, 174, 214, 157, 175, 126, 98, 90, 54, 24, 100, 177, 247, 77, 19, 112,
    47, 44, 165, 109, 233, 102, 14, 86, 109, 29, 134, 145, 132, 141,
  ])
);

// https://github.com/wormhole-foundation/wormhole/blob/347357b251e850a51eca351943cf71423c4f0bc3/sdk/js/src/nft_bridge/__tests__/utils/consts.ts#L24C51-L29C2
const SOL_PRIVATE_KEY_2 = web3.Keypair.fromSecretKey(
  new Uint8Array([
    118, 84, 4, 83, 83, 183, 31, 184, 20, 172, 95, 146, 7, 107, 141, 183, 124,
    196, 66, 246, 215, 243, 54, 61, 118, 188, 239, 237, 168, 108, 227, 169, 93,
    119, 180, 216, 9, 169, 30, 4, 167, 235, 188, 51, 70, 24, 181, 227, 189, 59,
    163, 161, 252, 219, 17, 105, 197, 241, 19, 66, 205, 188, 232, 131,
  ])
);

const STACKS_PRIVATE_KEY = 
  "714a5bf161a680ebb2670c5ea6e8bcd75f299eae234412af0cf12d21e11ae09901"; // Clarinet acc 1

// https://github.com/wormhole-foundation/wormhole/blob/347357b251e850a51eca351943cf71423c4f0bc3/wormchain/contracts/tools/__tests__/test_ntt_accountant.ts#L139
const ACCT_MNEMONIC =
  "quality vacuum heart guard buzz spike sight swarm shove special gym robust assume sudden deposit grid alcohol choice devote leader tilt noodle tide penalty";

// https://github.com/wormhole-foundation/wormhole/blob/347357b251e850a51eca351943cf71423c4f0bc3/scripts/devnet-consts.json#L211
const ACCT_MNEMONIC_2 =
  "notice oak worry limit wrap speak medal online prefer cluster roof addict wrist behave treat actual wasp year salad speed social layer crew genius";

const makeGetNativeSigner =
  (ethKey: string, solKey: web3.Keypair, stacksKey: string) =>
  (ctx: Partial<Ctx>): any => {
    const platform = chainToPlatform(ctx.context!.chain);
    switch (platform) {
      case "Evm":
        return ethKey;
      case "Solana":
        return solKey;
      case "Stacks":
        return stacksKey;
      default:
        throw (
          "Unsupported platform " + platform + " (add it to getNativeSigner)"
        );
    }
  };

describe("Hub and Spoke Tests", function () {
  beforeAll(async () => {
    // await registerRelayers(ACCT_MNEMONIC);
    // await setMessageFee(["Ethereum", "Bsc"], ethers.parseEther("0.001"));
  });

  afterAll(async () => {
    // await setMessageFee(["Ethereum", "Bsc"], 0n);
  });

  test("Test Solana and Ethereum Hubs", async () => {
    // await Promise.all([
    //   testHub(
    //     "Solana",
    //     "Ethereum",
    //     "Bsc",
    //     makeGetNativeSigner(ETH_PRIVATE_KEY, SOL_PRIVATE_KEY),
    //     ACCT_MNEMONIC
    //   ),
    //   testHub(
    //     "Ethereum",
    //     "Bsc",
    //     "Solana",
    //     makeGetNativeSigner(ETH_PRIVATE_KEY_2, SOL_PRIVATE_KEY_2),
    //     ACCT_MNEMONIC_2
    //   ),
    // ]);
  });
  
  describe.only("Stacks", () => {
    test.only("temp - stacks", async() => {
      // await Promise.all([
      //   testTempStacksHub(
      //     "Stacks",
      //     "Ethereum",
      //     "Solana",
      //     makeGetNativeSigner(ETH_PRIVATE_KEY, SOL_PRIVATE_KEY, STACKS_PRIVATE_KEY),
      //     ACCT_MNEMONIC
      //   )
      // ])
// console.log(Cl.buffer(new UniversalAddress("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2").toUint8Array()))
// const fromHexString = (hexString: string) => Uint8Array.from(hexString.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)));

// const res = await fetchCallReadOnlyFunction({
//     contractAddress: 'ST5ZW3BC07M4P27KFJ6JJ6PKTB1NW79SH0BVYB3W',
//     contractName: 'ntt-manager-v1-8900',
//     functionName: 'parse-token-tf',
//     functionArgs: [
//       Cl.buffer(fromHexString("000000000000000000000000000000000000000000000000000000000000000000000000000000000000000090f8bf6a479f320ead074411a4b0e7944ea8c9c1004f994e54540800000000000f4240000000000000000000000000bc53027c52b0ee6ad90347b8d03a719f30d9d7abda36b89828d4e22d80ffd897c89ed4780fcac601e1d6839f0c1a3eb332914b2f003c"))
//     ],
//     senderAddress: 'ST5ZW3BC07M4P27KFJ6JJ6PKTB1NW79SH0BVYB3W',
//     network: "devnet",
//     client: { baseUrl: 'http://localhost:3999' },
//   })

//   console.log(cvToValue(res))

      await testHub(
        "Stacks",
        "Ethereum",
        "Bsc",
        makeGetNativeSigner(ETH_PRIVATE_KEY, SOL_PRIVATE_KEY, STACKS_PRIVATE_KEY),
        ACCT_MNEMONIC
      )
      // await testHub(
      //   "Ethereum",
      //   "Stacks",
      //   "Bsc",
      //   makeGetNativeSigner(ETH_PRIVATE_KEY, SOL_PRIVATE_KEY, STACKS_PRIVATE_KEY),
      //   ACCT_MNEMONIC
      // )
    })

    test("Pausing", async() => {
      await testPausing("Stacks", makeGetNativeSigner(ETH_PRIVATE_KEY, SOL_PRIVATE_KEY, STACKS_PRIVATE_KEY))
    })
  })
});
