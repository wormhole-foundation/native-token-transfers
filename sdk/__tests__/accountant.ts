import { encoding } from "@wormhole-foundation/sdk-base";
import {
  getWallet,
  getWormchainSigningClient,
} from "@wormhole-foundation/wormchain-sdk";

export const ZERO_FEE = {
  amount: [{ amount: "0", denom: "uworm" }],
  gas: "200000",
};

// cache the client and signer
let clientAndSigner: {
  [privateKey: string]: {
    client: Awaited<ReturnType<typeof getWormchainSigningClient>>;
    signer: string;
  };
} = {};

async function getClientAndSigner(privateKey: string) {
  return (
    clientAndSigner[privateKey] ||
    (await (async () => {
      const wallet = await getWallet(privateKey);
      const client = await getWormchainSigningClient(url, wallet);
      const signers = await wallet.getAccounts();
      const signer = signers[0]!.address;
      const ret = { client, signer };
      clientAndSigner[privateKey] = ret;
      return ret;
    })())
  );
}

const url = process.env["CI"]
  ? "http://localhost:26657" // FG TODO FG revert to "wormchain:26657"
  : "http://localhost:26659";

export async function submitAccountantVAAs(
  vaas: Uint8Array[],
  privateKey: string
) {
  const { client, signer } = await getClientAndSigner(privateKey);
  const msg = client.wasm.msgExecuteContract({
    sender: signer,
    contract:
      "wormhole17p9rzwnnfxcjp32un9ug7yhhzgtkhvl9jfksztgw5uh69wac2pgshdnj3k",
    msg: encoding.bytes.encode(
      JSON.stringify({
        submit_vaas: {
          vaas: vaas.map((vaa) => encoding.b64.encode(vaa)),
        },
      })
    ),
    funds: [],
  });
  const result = await client.signAndBroadcast(signer, [msg], {
    ...ZERO_FEE,
    gas: (BigInt("10000000") * BigInt(vaas.length)).toString(),
  });
  if (result.code !== 0) {
    throw new Error(`Bad result: ${result.rawLog}`);
  }
  console.log(`Accountant tx submitted: ${result.transactionHash}`);
}

export async function registerRelayers(privateKey: string) {
  try {
    await submitAccountantVAAs(
      [
        new Uint8Array(
          Buffer.from(
            "01000000000100a4f34c530ff196c060ff349f2bf7bcb16865771a7165ca84fb5e263f148a01b03592b9af46a410a3760f39097d7380e4e72b6e1da4fa25c2d7b2d00f102d0cae0100000000000000000001000000000000000000000000000000000000000000000000000000000000000400000000001ce9cf010000000000000000000000000000000000576f726d686f6c6552656c617965720100000002000000000000000000000000cc680d088586c09c3e0e099a676fa4b6e42467b4",
            "hex"
          )
        ),
        new Uint8Array(
          Buffer.from(
            "010000000001000fd839cfdbea0f43a35dbb8cc0219b55cd5ec9f59b7e4a7183dbeebd522f7c673c866a218bfa108d8c7606acb5fc6b94a7a4c3be06f10836c242afecdb80da6e00000000000000000000010000000000000000000000000000000000000000000000000000000000000004000000000445fb0b010000000000000000000000000000000000576f726d686f6c6552656c617965720100000004000000000000000000000000cc680d088586c09c3e0e099a676fa4b6e42467b4",
            "hex"
          )
        ),
      ],
      privateKey
    );
  } catch (e) {
    console.log(e);
  }
}
