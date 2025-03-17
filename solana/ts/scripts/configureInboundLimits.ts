import { BN } from '@coral-xyz/anchor'
import { PublicKey } from "@solana/web3.js";
import { coalesceChainName } from "@certusone/wormhole-sdk";

import { connection, getEvmNttDeployments, getSigner, getProgramAddresses } from "./env";
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
    const { chainId, limit } = deployment;
    const chainName = coalesceChainName(deployment.chainId);
    const log = (...args) => console.log(`[${chainId}] `, ...args);

    if (!limit && limit !== 0) {
      console.error(`Invalid deployment configuration for chainId ${chainId}`);
      continue;
    }

    const ix = await ntt.createSetInboundLimitInstruction({
      owner: signerPk,
      limit: new BN(limit),
      chain: chainName,
    });

    log(`Configuring inbound limit to: ${limit}`);

    try {
      const tx = await ledgerSignAndSend([ix], []);
      log(`Transaction ${tx.signature} sent.`);
      await connection.confirmTransaction(tx);
    } catch (error) {
      console.error(`Failed to configure chain ${chainId}. Error: ${error.toString()}`);
      continue;
    }

    console.log("Success.");
  }
})();

