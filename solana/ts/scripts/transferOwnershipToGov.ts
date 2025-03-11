import { PublicKey } from "@solana/web3.js";

import { connection, getSigner, getProgramAddresses } from "./env";
import { NTT } from "../sdk";
import { ledgerSignAndSend } from "./helpers";
import { NTTGovernance } from "../sdk/governance";

(async () => {
  const { nttProgramId, wormholeProgramId, governanceProgramId } = getProgramAddresses();

  const ntt = new NTT(connection, {
    nttId: nttProgramId as any,
    wormholeId: wormholeProgramId as any,
  });

  const governance = new NTTGovernance(connection, {
    programId: governanceProgramId as any,
  });

  const signer = await getSigner();
  const signerPk = new PublicKey(await signer.getAddress());
  
  const governancePda = governance.governanceAccountAddress();

  const transferOwnershipIx = await ntt.createTransferOwnershipInstruction({
    owner: signerPk,
    newOwner: governancePda,
  });

  console.log(`Transferring NTT Program ${nttProgramId} ownership to ${governancePda.toBase58()} derived from(${governanceProgramId}).`);

  const tx = await ledgerSignAndSend([transferOwnershipIx], []);

  console.log("Waiting for confirmation... Signature: ", tx.signature);
  await connection.confirmTransaction(tx);
  console.log("Success.");
})();

