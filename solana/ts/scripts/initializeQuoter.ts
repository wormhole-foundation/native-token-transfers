import { NttQuoter } from "../sdk";
import { PublicKey } from "@solana/web3.js";

import { connection, getProgramAddresses, getQuoterConfiguration } from "./env";
import { ledgerSignAndSend } from "./helpers";

async function run() {
  const programs = getProgramAddresses();
  const config = getQuoterConfiguration();

  console.log(`Initializing program id: ${programs.quoterProgramId}`);

  const feeRecipient = new PublicKey(config.feeRecipient);

  const quoter = new NttQuoter(connection, programs.quoterProgramId);

  const initInstruction = await quoter.createInitializeInstruction(feeRecipient);

  const tx = await ledgerSignAndSend([initInstruction], []);
  console.log("Transaction sent. Signature: ", tx.signature);
  await connection.confirmTransaction(tx);
  console.log("Sucess. Signature: ", tx.signature);
}

run();