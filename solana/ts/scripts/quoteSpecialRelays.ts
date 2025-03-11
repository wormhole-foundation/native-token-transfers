import { NttQuoter } from "../sdk";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

import { connection, getProgramAddresses } from "./env";

async function run() {
  const programs = getProgramAddresses();

  const quoter = new NttQuoter(connection, programs.quoterProgramId);

  let instanceState = await quoter.tryGetInstance();

  if (instanceState === null) {
    throw new Error("Quoter un-initialized.");
  }

  const ixs: TransactionInstruction[] = [];

  ["Arbitrum", "Base", "Optimism", "Ethereum"].forEach(async (chain) => {
    const result = await quoter.calcRelayCostInSol(new PublicKey(programs.nttProgramId), chain as any, 0);

    console.log(chain, "Relay cost in SOL: ", result);
  });
}

run();