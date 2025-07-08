import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Wormhole, signSendWait } from "@wormhole-foundation/sdk";
import {
  SolanaPlatform,
  getSolanaSignAndSendSigner,
} from "@wormhole-foundation/sdk-solana";
import "dotenv/config";
import { SolanaNtt } from "../sdk/ntt.js";

// eslint-disable-next-line @typescript-eslint/no-floating-promises
(async function () {
  if (process.env["SOLANA_PRIVATE_KEY"] === undefined) {
    throw new Error("SOLANA_PRIVATE_KEY is not set");
  }

  if (process.env["MINT"] === undefined) {
    throw new Error("MINT is not set");
  }

  if (process.env["MANAGER"] === undefined) {
    throw new Error("MANAGER is not set");
  }

  if (process.env["WH_TRANSCEIVER"] === undefined) {
    throw new Error("WH_TRANSCEIVER is not set");
  }

  const payer = Keypair.fromSecretKey(
    Buffer.from(process.env["SOLANA_PRIVATE_KEY"], "base64")
  );
  const mint = new PublicKey(process.env["MINT"]);
  const manager = new PublicKey(process.env["MANAGER"]);
  const whTransceiver = new PublicKey(process.env["WH_TRANSCEIVER"]);

  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );

  const signer = await getSolanaSignAndSendSigner(connection, payer, {});
  const sender = Wormhole.parseAddress("Solana", signer.address());

  const w = new Wormhole("Testnet", [SolanaPlatform]);
  const ctx = w.getPlatform("Solana").getChain("Solana", connection);

  const ntt = new SolanaNtt(
    "Testnet",
    "Solana",
    connection,
    {
      ...ctx.config.contracts,
      ntt: {
        token: mint.toBase58(),
        manager: manager.toBase58(),
        transceiver: {
          wormhole: whTransceiver.toBase58(),
        },
      },
    },
    "3.0.0"
  );

  const initTxs = ntt.initialize(sender, {
    mint,
    outboundLimit: 100n,
    mode: "locking",
    multisigTokenAuthority: undefined,
  });
  await signSendWait(ctx, initTxs, signer);
})();
