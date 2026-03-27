import {
  Transaction,
  TransactionInstruction,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
} from "@solana/web3.js";

import { SolanaLedgerSigner } from "@xlabs-xyz/ledger-signer-solana";
import { connection, getSigner } from "./env";

export async function ledgerSignAndSend(instructions: TransactionInstruction[], signers: Keypair[]) {
  const deployerSigner = await getSigner();
  const deployerPk = new PublicKey(await deployerSigner.getAddress());

  const tx = new Transaction();

  const setComputePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 1_000_000,
  });

  tx.add(setComputePriceIx);

  tx.add(...instructions);

  const recentBlockHash = await connection.getLatestBlockhash();

  tx.recentBlockhash = recentBlockHash.blockhash;
  tx.feePayer = deployerPk;
  
  signers.forEach((signer) => tx.partialSign(signer));

  await addLedgerSignature(tx, deployerSigner, deployerPk);

  const txSignature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });

  return {
    signature: txSignature,
    ...recentBlockHash,
  }
}

export async function addLedgerSignature(tx: Transaction, signer: SolanaLedgerSigner, signerPk: PublicKey) {
  const signedByPayer = await signer.signTransaction(tx.compileMessage().serialize());
  tx.addSignature(signerPk, signedByPayer);
}