import { NttQuoter } from "../sdk";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { inspect } from "util";

import { connection, getSigner, getQuoterConfiguration, getProgramAddresses } from "./env";
import { ledgerSignAndSend } from "./helpers";

async function run() {
  const programs = getProgramAddresses();
  const config = getQuoterConfiguration();
  const signer = await getSigner();
  const signerPk = new PublicKey(await signer.getAddress());

  const quoter = new NttQuoter(connection, programs.quoterProgramId);

  for (const managerConfig of config.managerRegistrations) {
    await sleep(1000); // HACK avoid 429 rate limit error

    const nttKey = new PublicKey(managerConfig.programId);
    const registration = await quoter.tryGetRegisteredNtt(nttKey);
    console.log(`Registration for manager ${managerConfig.programId} (${managerConfig.name}):`, registration);
    const needsUpdate =
      registration !== null &&
      (registration.gasCost !== managerConfig.gasCost ||
      registration.wormholeTransceiverIndex !== managerConfig.wormholeTransceiverIndex);
    const instructions = [] as TransactionInstruction[];
    if (registration !== null && (!managerConfig.isSupported || needsUpdate)) {
      console.log(`De-registering manager ${managerConfig.programId}`);
      instructions.push(
        await quoter.createDeregisterNttInstruction(signerPk, nttKey)
      );
    }

    if (managerConfig.isSupported && (registration === null || needsUpdate)) {
      // if (managerConfig.gasCost === 0) {
      //   throw new Error(
      //     `Invalid manager configuration: ${inspect(managerConfig)}`
      //   );
      // }

      console.log(`Registering manager ${managerConfig.programId}`);

      instructions.push(
        await quoter.createRegisterNttInstruction(
          signerPk,
          nttKey,
          managerConfig.gasCost,
          managerConfig.wormholeTransceiverIndex
        )
      );
    }

    if (!instructions.length) {
      console.log("No updates necessary");
      continue;
    }

    try {
      const tx = await ledgerSignAndSend(instructions, []);
      const receipt = await connection.confirmTransaction(tx, "confirmed");
      console.log(`Tx id: ${tx.signature}`);
      if (receipt.value.err !== null) throw new Error(`Register tx failed. Reason: ${inspect(receipt.value.err)}`);
      console.log("Success.");
    } catch (error) {
      console.error(
        `Failed to register or de-register manager ${managerConfig.programId}: ${error}`
      );
    }
  
  
  }
}

run();


async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}