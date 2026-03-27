import {
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { parseVaa } from "@certusone/wormhole-sdk";
import {
  connection,
  getSigner,
  getProgramAddresses,
  getGovernanceVaa,
} from "./env";
import { addLedgerSignature, ledgerSignAndSend } from "./helpers";
import { postVaaSolana } from "@certusone/wormhole-sdk";
import { NTTGovernance } from "../sdk/governance";

(async () => {
  const { vaa } = getGovernanceVaa();

  const { nttProgramId, wormholeProgramId, governanceProgramId } =
    getProgramAddresses();

  const governance = new NTTGovernance(connection, {
    programId: governanceProgramId as any,
  });

  const signer = await getSigner();
  const signerPk = new PublicKey(await signer.getAddress());

  const vaaBuff = Buffer.from(vaa, "hex");
  async function sign(tx: Transaction) {
    await addLedgerSignature(tx, signer, signerPk);
    return tx;
  }

  console.log("Posting VAA to Solana...");

  await postVaaSolana(
    connection,
    sign,
    new PublicKey(wormholeProgramId),
    signerPk,
    vaaBuff,
  );

  console.log("VAA posted to Solana.");

  const parsedVaa = parseVaa(vaaBuff);

  const governanceIx = await governance.createGovernanceVaaInstruction({
    payer: signerPk,
    vaa: parsedVaa,
    wormholeId: new PublicKey(wormholeProgramId),
  });

  console.log(`Account ${signerPk.toBase58()} is claiming ownership of NTT Program ${nttProgramId}.`);

  const tx = await ledgerSignAndSend([governanceIx], []);

  console.log("Waiting for confirmation... Signature: ", tx.signature);

  await connection.confirmTransaction(tx);

  console.log("success.");
})();
