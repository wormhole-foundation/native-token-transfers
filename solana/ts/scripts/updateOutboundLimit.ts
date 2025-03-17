import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

import { connection, getSigner, getNttConfiguration, getProgramAddresses } from "./env";
import { NTT } from "../sdk";
import { ledgerSignAndSend } from "./helpers";

(async () => {
  const programs = getProgramAddresses();
  const nttConfig = getNttConfiguration();
  const ntt = new NTT(connection, {
    nttId: programs.nttProgramId as any,
    wormholeId: programs.wormholeProgramId as any,
  });

  const signer = await getSigner();
  const signerPk = new PublicKey(await signer.getAddress());

  const setOutboundLimitIx = await ntt.createSetoutboundLimitInstruction({
    owner: signerPk,
    limit: new BN(nttConfig.outboundLimit),
  });

  const setComputePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 1_000_000,
  });

  const tx = await ledgerSignAndSend([setComputePriceIx, setOutboundLimitIx], []);

  console.log(`Outbound limit set to ${nttConfig.outboundLimit} with tx ${tx.signature}`);
  await connection.confirmTransaction(tx);
  console.log("Success.");
})();

