import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import "dotenv/config";
import { NTT } from "../lib";
import { BN } from "@coral-xyz/anchor";

main();

async function main() {
  if (process.env.SOLANA_PRIVATE_KEY === undefined) {
    throw new Error("SOLANA_PRIVATE_KEY is not set");
  }

  if (process.env.MINT === undefined) {
    throw new Error("MINT is not set");
  }

  const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed"
  );
  const ntt = new NTT(connection, {
    nttId: "nttiK1SepaQt6sZ4WGW5whvc9tEnGXGxuKeptcQPCcS",
    wormholeId: "3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5",
  });

  const payer = Keypair.fromSecretKey(
    Buffer.from(process.env.SOLANA_PRIVATE_KEY, "base64")
  );
  const owner = payer;
  const mint = new PublicKey(process.env.MINT);

  await ntt.initialize({
    payer,
    owner,
    chain: "solana",
    mint,
    outboundLimit: new BN(100),
    mode: "locking",
  });
}
