import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { parseVaa } from "@certusone/wormhole-sdk";
import {
  connection,
  getProgramAddresses,
  getGovernanceVaa,
} from "./env_short";
import { postVaaSolana } from "@certusone/wormhole-sdk";
import { NTTGovernance } from "../sdk/governance";
import fs from "fs";

(async () => {
	const { vaa } = getGovernanceVaa();

  const { nttProgramId, wormholeProgramId, governanceProgramId } =
    getProgramAddresses();

	const governance = new NTTGovernance(connection, {
    programId: governanceProgramId as any,
  });

  const payerSecretKey = Uint8Array.from(
    JSON.parse(
      fs.readFileSync(`YOUR_SIGNER_FILE`, {
        encoding: "utf-8",
      })
    )
  );
  const signer = Keypair.fromSecretKey(payerSecretKey);
  // const signer: Keypair = "INSERT_KEYPAIR"; // Derive from file/secret key etc.
  const signerPk = signer.publicKey;

  const vaaBuff = Buffer.from(vaa, "base64"); // replace with "hex" if VAA is in hex
  async function sign(tx: Transaction) {
    tx.partialSign(signer); // partial sign using signer instead of adding ledger signature
    return tx;
  }

  console.log("Posting VAA to Solana...");

  await postVaaSolana(
    connection,
    sign,
    new PublicKey(wormholeProgramId).toBase58(),
    signerPk.toBase58(),
    vaaBuff
  );

  console.log("VAA posted to Solana.");

  const parsedVaa = parseVaa(vaaBuff);

  const governanceIx = await governance.createGovernanceVaaInstruction({
    payer: signerPk,
    vaa: parsedVaa,
    wormholeId: new PublicKey(wormholeProgramId),
  });

  console.log(
    `Governance PDA is claiming ownership of NTT Program ${nttProgramId}.`
  );

  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 1_000_000,
    }),
    governanceIx
  );
  const recentBlockHash = await connection.getLatestBlockhash();

  tx.recentBlockhash = recentBlockHash.blockhash;
  tx.feePayer = signerPk;
  const txSig = await sendAndConfirmTransaction(connection, tx, [signer], {
    skipPreflight: true,
  });

  console.log("success:", txSig);
})();

