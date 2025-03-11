import { Chain, isChain } from "@wormhole-foundation/sdk-base";
import { NttQuoter } from "../sdk";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

import { connection, getSigner, QuoterPeerQuote, getQuoterConfiguration, getProgramAddresses } from "./env";
import { ledgerSignAndSend } from "./helpers";

async function run() {
  const signer = await getSigner();
  const signerPk = new PublicKey(await signer.getAddress());
  const programs = getProgramAddresses();
  const quoterConfig = getQuoterConfiguration();

  const feeRecipient = new PublicKey(quoterConfig.feeRecipient);
  const assistant = new PublicKey(quoterConfig.assistant);

  const quoter = new NttQuoter(connection, programs.quoterProgramId);

  let instanceState = await quoter.tryGetInstance();

  if (instanceState === null) {
    throw new Error("Can't configure a quoter un-initialized.");
  }

  const configurationInstructions: TransactionInstruction[] = [];

  if (!instanceState.feeRecipient.equals(feeRecipient)) {
    const feeRecipientInstruction = await quoter.createSetFeeRecipientInstruction(instanceState, feeRecipient);
    configurationInstructions.push(feeRecipientInstruction);
    console.log("Updating fee recipient to: ", quoterConfig.feeRecipient);
  }

  if (!instanceState.assistant.equals(assistant)) {
    const assistantInstruction = await quoter.createSetAssistantInstruction(instanceState, assistant);
    configurationInstructions.push(assistantInstruction);
    console.log("Updating assistant to: ", quoterConfig.assistant);
  }

  if (instanceState.solPriceUsd !== quoterConfig.solPriceUsd) {
    const solPriceInstruction = await quoter.createUpdateSolPriceInstruction(signerPk, quoterConfig.solPriceUsd);
    configurationInstructions.push(solPriceInstruction);
    console.log("Updating sol price to: ", quoterConfig.solPriceUsd);
  }

  // add any other global configs here...

  try {
    if (configurationInstructions.length){
      const tx = await ledgerSignAndSend(configurationInstructions, []);
      console.log("Global config success. Tx=", tx.signature);
      await connection.confirmTransaction(tx);
    }
  } catch (error) {
    console.error("Failed to configure quoter contract:", error);
    return;
  }

  for (const [chain, peer] of Object.entries(quoterConfig.peerQuotes)) {
    if (!isChain(chain)) {
      throw new Error(`Invalid chain name: ${chain}`);
    }

    try {
      console.log("Configuring peer chain: ", chain);
      await configurePeer(quoter, chain, peer, signerPk);
    } catch (error) {
      console.error(`Failed to configure ${chain} peer. Error: `, error);
    }
  }
}

async function configurePeer(quoter: NttQuoter, chain: Chain, peer: QuoterPeerQuote, signerPk: PublicKey) {
  const instructions: TransactionInstruction[] = [];
  let registeredChainInfo = await quoter.tryGetRegisteredChain(chain);
  if (registeredChainInfo === null) {
    instructions.push(await quoter.createRegisterChainInstruction(signerPk, chain));
  }

  if (registeredChainInfo === null ||
      registeredChainInfo.maxGasDropoffEth !== Number(peer.maxGasDropoffEth) ||
      registeredChainInfo.basePriceUsd !== Number(peer.basePriceUsd)) {
    instructions.push(await quoter.createUpdateChainParamsInstruction(signerPk, chain, Number(peer.maxGasDropoffEth), Number(peer.basePriceUsd)));
  }

  if (registeredChainInfo === null ||
      registeredChainInfo.nativePriceUsd !== Number(peer.nativePriceUsd) ||
      registeredChainInfo.gasPriceGwei !== Number(peer.gasPriceGwei)) {
    instructions.push(await quoter.createUpdateChainPricesInstruction(signerPk, chain, Number(peer.nativePriceUsd), Number(peer.gasPriceGwei)));
  }

  if (instructions.length === 0) {
    console.log("No updates needed for chain: ", chain);
    return;
  }
  
  const tx = await ledgerSignAndSend(instructions, []);

  console.log("Chain config success. Tx=", tx.signature);
  await connection.confirmTransaction(tx);
}

run();