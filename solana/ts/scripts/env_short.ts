import { Commitment, Connection } from "@solana/web3.js";
import fs from "fs";

const env = "mainnet"; // Or devnet

export function getEnv(key: string): string {
  if (!process.env[key]) {
    throw new Error(`${key} not found on environment`);
  }

  return process.env[key]!;
}

export const rpcUrl =
  process.env.SOLANA_RPC_URL || "INSERT_RPC_URL";

export const connectionCommitmentLevel = (process.env.SOLANA_COMMITMENT ||
  "confirmed") as Commitment;

export const connection = new Connection(rpcUrl, connectionCommitmentLevel);

export type Programs = {
  mintProgramId: string;
  nttProgramId: string;
  wormholeProgramId: string;
  quoterProgramId: string;
  governanceProgramId: string;
}

export type GovernanceVaa = {
  vaa: string;
}

export function getProgramAddresses(): Programs {
  return loadScriptConfig("programs");
}

export function getGovernanceVaa(): GovernanceVaa {
  return loadScriptConfig("governance-vaa");
}

export function loadScriptConfig(filename: string): any {
  const configFile = fs.readFileSync(
    `./ts/scripts/config/${env}/${filename}.json`
  );
  const config = JSON.parse(configFile.toString());
  if (!config) {
    throw Error("Failed to pull config file!");
  }
  return config;
}

