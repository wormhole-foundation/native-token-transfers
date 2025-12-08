#!/usr/bin/env ts-node

import fs from "fs";
import { ethers } from "ethers";
import { parse } from "dotenv";
import path from "path";
import "dotenv/config";

type Options = {
  emitterChainId: number;
  emitterAddress: string;
  sequence: number;
  payload: string;
  guardianSetIndex: number;
  consistencyLevel: number;
  key?: string;
};

if (!process.env.DEV_GUARDIAN_KEY) {
  console.error("DEV_GUARDIAN_KEY missing. Set it in env or devnet/config/env.example.");
  process.exit(1);
}

const args = process.argv.slice(2);
const opts: Partial<Options> = {};
for (let i = 0; i < args.length; i++) {
  const [key, value] = args[i].split("=");
  switch (key) {
    case "--emitterChainId":
      opts.emitterChainId = Number(value);
      break;
    case "--emitterAddress":
      opts.emitterAddress = value;
      break;
    case "--sequence":
      opts.sequence = Number(value);
      break;
    case "--payload":
      opts.payload = value.startsWith("0x") ? value : `0x${value}`;
      break;
    case "--guardianSetIndex":
      opts.guardianSetIndex = Number(value);
      break;
    case "--consistencyLevel":
      opts.consistencyLevel = Number(value);
      break;
    case "--key":
      opts.key = value;
      break;
  }
}

if (
  opts.emitterChainId === undefined ||
  !opts.emitterAddress ||
  opts.sequence === undefined ||
  !opts.payload
) {
  console.error(
    "Usage: vaa-gen.ts --emitterChainId=2 --emitterAddress=0x... --sequence=1 --payload=0x... [--guardianSetIndex=0] [--consistencyLevel=1]",
  );
  process.exit(1);
}

const guardianKey = (opts.key && opts.key.length > 0 ? opts.key : process.env.DEV_GUARDIAN_KEY)!;
const guardianSetIndex = opts.guardianSetIndex ?? 0;
const consistencyLevel = opts.consistencyLevel ?? 1;

function encodeBody(): Buffer {
  const payloadBytes = Buffer.from(opts.payload!.slice(2), "hex");
  const emitterAddrBytes = Buffer.from(
    opts.emitterAddress!.replace(/^0x/, ""),
    "hex",
  );
  if (emitterAddrBytes.length !== 32) {
    throw new Error("emitterAddress must be 32 bytes (wormhole-format)");
  }
  const bufferArray = [
    Buffer.from([0, 0, 0, 0]), // timestamp placeholder
    Buffer.from([0, 0, 0, 0]), // nonce placeholder
    Buffer.from([(opts.emitterChainId! >> 8) & 0xff, opts.emitterChainId! & 0xff]),
    emitterAddrBytes,
    Buffer.from(
      new Uint8Array([
        (opts.sequence! >> 56) & 0xff,
        (opts.sequence! >> 48) & 0xff,
        (opts.sequence! >> 40) & 0xff,
        (opts.sequence! >> 32) & 0xff,
        (opts.sequence! >> 24) & 0xff,
        (opts.sequence! >> 16) & 0xff,
        (opts.sequence! >> 8) & 0xff,
        opts.sequence! & 0xff,
      ]),
    ),
    Buffer.from([consistencyLevel]),
    payloadBytes,
  ];
  return Buffer.concat(bufferArray);
}

function doubleKeccak(data: Buffer): Buffer {
  // Wormhole Core signs keccak256(keccak256(body))
  return Buffer.from(ethers.keccak256(ethers.keccak256(data)).slice(2), "hex");
}

async function main() {
  const body = encodeBody();
  const bodyHash = doubleKeccak(body);

  // ethers v6 signing (normalize key to 0x-prefixed)
  const normalizedKey = guardianKey.startsWith("0x")
    ? guardianKey
    : (`0x${guardianKey}` as `0x${string}`);
  const sk = new ethers.SigningKey(normalizedKey);
  const sig = sk.sign(ethers.getBytes(bodyHash)); // returns { r, s, recoveryParam }
  const signerAddr = new ethers.Wallet(normalizedKey).address;
  console.error(`signer: ${signerAddr}`);

  const signatureBytes = Buffer.concat([
    Buffer.from([0]), // guardian index
    Buffer.from(sig.r.slice(2), "hex"),
    Buffer.from(sig.s.slice(2), "hex"),
    Buffer.from([sig.recoveryParam ?? 0]), // v = 0 or 1 (Core adds 27)
  ]);

  const header = Buffer.concat([
    Buffer.from([1]), // version
    Buffer.from([
      (guardianSetIndex >> 24) & 0xff,
      (guardianSetIndex >> 16) & 0xff,
      (guardianSetIndex >> 8) & 0xff,
      guardianSetIndex & 0xff,
    ]),
    Buffer.from([1]), // signatures length
  ]);

  const vaa = Buffer.concat([header, signatureBytes, body]);
  console.log(`VAA: 0x${vaa.toString("hex")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
