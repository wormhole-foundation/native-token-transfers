import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, mintTo, createMintToCheckedInstruction, createMintToInstruction } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";

import { connection, getEnv, getProgramAddresses, getSigner } from "./env";
import { ledgerSignAndSend } from "./helpers";


type MintTokensConfig = {
  mintRecipientAddress: string;
  mintAddress: string;
}

(async () => {
  const programs = getProgramAddresses();
  const config: MintTokensConfig = {
    mintRecipientAddress: getEnv("MINT_RECIPIENT_ADDRESS"),
    mintAddress: programs.mintProgramId as any,
  }
  const signer = await getSigner();
  const signerPk = new PublicKey(await signer.getAddress());

  const mintRecipient = new PublicKey(config.mintRecipientAddress);
  const mint = new PublicKey(config.mintAddress);

  const ataAddress = getAssociatedTokenAddressSync(
    mint,
    mintRecipient, 
    false,
  );

  // TODO: check if ata account already exists.

  console.log("Creating ATA at address: ", ataAddress.toBase58());

  const createATAIx = createAssociatedTokenAccountInstruction(
    signerPk,
    ataAddress,
    mintRecipient,
    mint,
  );

  try {
    const tx = await ledgerSignAndSend([createATAIx], []);
    await connection.confirmTransaction(tx);
    console.log("ATA created successfully.");
  } catch (err) {
    console.error("Failed to create ATA");
    throw err;
  }

  const mintToIx = createMintToInstruction(
    mint,
    ataAddress,
    signerPk,
    BigInt(100000000000000),
  );

  try {
    const tx = await ledgerSignAndSend([mintToIx], []);
    await connection.confirmTransaction(tx);
    console.log("Tokens minted successfully.");
  } catch (error) {
    console.error("Failed to mint tokens");
    throw error;
  }
})();

