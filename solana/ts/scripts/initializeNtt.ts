import { TOKEN_PROGRAM_ID, createSetAuthorityInstruction } from '@solana/spl-token';
import { BN } from '@coral-xyz/anchor'
import { Keypair, PublicKey } from "@solana/web3.js";

import { NTT } from "../sdk";
import { connection, getSigner, getNttConfiguration, getProgramAddresses } from './env';
import { ledgerSignAndSend } from './helpers';

(async () => {
  const programs = getProgramAddresses();
  const config = getNttConfiguration();

  const signer = await getSigner();
  const signerPk = new PublicKey(await signer.getAddress());

  const mint = new PublicKey(programs.mintProgramId);

  const ntt = new NTT(connection, {
    nttId: programs.nttProgramId as any,
    wormholeId: programs.wormholeProgramId as any,
  });

  const nttManagerPk = ntt.tokenAuthorityAddress();

  // this is needed on testnet, but not on mainnet
  // const setAuthorityInstruction = createSetAuthorityInstruction(
  //   mint,
  //   signerPk,
  //   0,
  //   nttManagerPk,
  //   undefined, // for multi-sig
  //   TOKEN_PROGRAM_ID, // might also be TOKEN_2022_PROGRAM_ID
  // );

  // let tx = await ledgerSignAndSend([setAuthorityInstruction], [])
  // await connection.confirmTransaction(tx);

  // console.log(`Authority set to ${nttManagerPk.toBase58()}`);
  
  const emitterAddress = ntt.emitterAccountAddress().toBase58();
  console.log("Manager Emitter Address:", emitterAddress);

  const initializeNttIx = await ntt.createInitializeInstruction({
    payer: signerPk,
    owner: signerPk,
    chain: "solana",
    mint,
    outboundLimit: new BN(config.outboundLimit),
    mode: config.mode,
  });

  let tx = await ledgerSignAndSend([initializeNttIx], []);
  await connection.confirmTransaction(tx);

  console.log("NTT initialized succesfully!");

  await new Promise(resolve => setTimeout(resolve, 5000));

  const wormholeMessageKeys = Keypair.generate();

  const registerTransceiverIxs = await ntt.createRegisterTransceiverInstructions({
    payer: signerPk,
    owner: signerPk,
    wormholeMessage: wormholeMessageKeys.publicKey,
    transceiver: new PublicKey(ntt.program.programId),
  });

  tx = await ledgerSignAndSend(registerTransceiverIxs, [wormholeMessageKeys]);
  await connection.confirmTransaction(tx);
  
  console.log(`Transceiver program registered: ${ntt.program.programId}`);

  console.log(`Emitter account address: ${emitterAddress}`);
})();

