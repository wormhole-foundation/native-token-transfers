#!/usr/bin/env ts-node

import { ethers } from "ethers";

/*
Sign a 32-byte digest with a provided private key and print (r,s,v) and recovered address.
Usage:
  DEV_PRIV=0x... npx tsx devnet/tools/sign-digest.ts --digest=0x...
*/

const digestArg = process.argv.find((a) => a.startsWith("--digest="));
if (!digestArg) {
  console.error("Usage: DEV_PRIV=0x... sign-digest.ts --digest=0x...");
  process.exit(1);
}
const digest = digestArg.split("=")[1];
const key = process.env.DEV_PRIV || "";
if (!key || !key.startsWith("0x")) {
  console.error("Set DEV_PRIV=0x<private_key>");
  process.exit(1);
}

const signer = new ethers.SigningKey(key);
const bytes = ethers.getBytes(digest as `0x${string}`);
const sig = signer.sign(bytes);
const recovered = ethers.recoverAddress(digest, { r: sig.r, s: sig.s, v: sig.recoveryParam ?? 0 });

console.log(JSON.stringify({
  signer: new ethers.Wallet(key).address,
  digest,
  signature: { r: sig.r, s: sig.s, v: sig.recoveryParam ?? 0 },
  recovered
}, null, 2));


