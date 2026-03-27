import {
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { parseVaa } from "@certusone/wormhole-sdk";
import {
  connection,
  getSigner,
  getProgramAddresses,
  loadScriptConfig,
} from "./env";
import { addLedgerSignature, ledgerSignAndSend } from "./helpers";
import { postVaaSolana } from "@certusone/wormhole-sdk";
import { NTTGovernance } from "../sdk/governance";

const governanceVaasFileName = process.env.GOVERNANCE_VAAS_FILE_PATH;
if (!governanceVaasFileName) {
  throw new Error("GOVERNANCE_VAAS_FILE_NAME is required.");
}

(async () => {

  const vaas: { id: string, vaa: string }[] = loadScriptConfig(governanceVaasFileName);
  const { wormholeProgramId, governanceProgramId } =
    getProgramAddresses();

  const governance = new NTTGovernance(connection, {
    programId: governanceProgramId as any,
  });

  const signer = await getSigner();
  const signerPk = new PublicKey(await signer.getAddress());

  async function sign(tx: Transaction) {
    await addLedgerSignature(tx, signer, signerPk);
    return tx;
  }

  const instructions: TransactionInstruction[] = [];
  for (const vaa of vaas) {
    const vaaBuff = Buffer.from(vaa.vaa, "base64");

    console.log(`Posting VAA ${vaa.id} to Solana...`);
    console.log(`Vaa: ${vaa.vaa}`);
  
    await postVaaSolana(
      connection,
      sign,
      new PublicKey(wormholeProgramId),
      signerPk,
      vaaBuff,
    );

    console.log("VAA post succeeded");

    const parsedVaa = parseVaa(vaaBuff);

    const governanceIx = await governance.createGovernanceVaaInstruction({
      payer: signerPk,
      vaa: parsedVaa,
      wormholeId: new PublicKey(wormholeProgramId),
    });

    console.log("Parsed VAA Payload", parsedVaa.payload.toString("hex"));
    instructions.push(governanceIx)
  }

  console.log(`Executing governance instructions.`, instructions);

  const tx = await ledgerSignAndSend(instructions, []);

  console.log("Waiting for confirmation... Signature: ", tx.signature);

  await connection.confirmTransaction(tx);

  console.log("success.");
})();
