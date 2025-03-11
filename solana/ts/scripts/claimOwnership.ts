import { PublicKey } from "@solana/web3.js";

import { connection, getSigner, getProgramAddresses } from "./env";
import { NTT } from "../sdk";
import { ledgerSignAndSend } from "./helpers";

(async () => {
  const { nttProgramId, wormholeProgramId } = getProgramAddresses();

  const signer = await getSigner();
  const signerPk = new PublicKey(await signer.getAddress());

  const ntt = new NTT(connection, {
    nttId: nttProgramId as any,
    wormholeId: wormholeProgramId as any,
  });

  const claimOwnershipIx = await ntt.createClaimOwnershipInstruction({
    owner: signerPk,
  });

  console.log(`Account ${signerPk.toBase58()} is claiming ownership of NTT Program ${nttProgramId}.`);

  const tx = await ledgerSignAndSend([claimOwnershipIx], []);

  await connection.confirmTransaction(tx);
  console.log("Success.");
})();

