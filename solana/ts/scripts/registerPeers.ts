
import { BN } from '@coral-xyz/anchor'
import { Keypair, PublicKey } from "@solana/web3.js";
import { ChainName, coalesceChainName, tryNativeToHexString } from "@certusone/wormhole-sdk";

import { connection, getEvmNttDeployments, getProgramAddresses, getSigner } from "./env";
import { NTT } from "../sdk";
import { ledgerSignAndSend } from './helpers';

(async () => {
  const programs = getProgramAddresses();
  const ntt = new NTT(connection, {
    nttId: programs.nttProgramId as any,
    wormholeId: programs.wormholeProgramId as any,
  });

  const signer = await getSigner();
  const signerPk = new PublicKey(await signer.getAddress());

  for (const deployment of getEvmNttDeployments()) {
    const { chainId, transceiverAddress, managerAddress, tokenDecimals, limit } = deployment;
    const chainName = coalesceChainName(deployment.chainId);
    const log = (...args) => console.log(`[${chainId}] `, ...args);

    if (!transceiverAddress || !managerAddress || !tokenDecimals || !chainName || chainName === "unset") {
      console.error(`Invalid deployment configuration for chainId ${chainId}`);
      continue;
    }

    const wormholeMessage = Keypair.generate();

    const normalizedTransceiverAddress = tryNativeToHexString(transceiverAddress, chainName);
    const setTransceiverIxs = await ntt.createSetTransceiverPeerInstructions({
      chain: chainName as ChainName,
      payer: signerPk,
      owner: signerPk,
      address: Buffer.from(normalizedTransceiverAddress, "hex"),
      wormholeMessage,
    });
    log(`Configuring peer address for ${chainId}: ${normalizedTransceiverAddress}`);

    // // Set the evm manager as the manager peer
    const normalizedManagerAddress = tryNativeToHexString(managerAddress, chainName);
    const setPeerIx = await ntt.createSetPeerInstruction({
      payer: signerPk,
      owner: signerPk,
      chain: chainName,
      address: Buffer.from(normalizedManagerAddress, "hex"),
      limit: new BN(limit),
      tokenDecimals: tokenDecimals,
    });
    log(`Configuring manager peer address for ${chainId}: ${normalizedManagerAddress}`);

    try {
      const tx = await ledgerSignAndSend([...setTransceiverIxs, setPeerIx], [wormholeMessage]);
      log(`Transaction ${tx.signature} sent.`);
      await connection.confirmTransaction(tx);
    } catch (error) {
      console.error(`Failed to configure chain ${chainId}. Error: ${error.toString()}`);
      continue;
    }

    console.log("Success.");
  }
})();

