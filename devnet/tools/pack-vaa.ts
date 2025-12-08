#!/usr/bin/env ts-node

import { ethers } from "ethers";

/*
Build a VAA from fields + a provided signature (r,s,v).
Usage:
  npx tsx devnet/tools/pack-vaa.ts \
    --emitterChainId=1 \
    --emitterAddress=0x...32bytes \
    --sequence=1 \
    --payload=0x... \
    --consistencyLevel=1 \
    --guardianSetIndex=0 \
    --r=0x... --s=0x... --v=27
Prints:
  bodyDigest (keccak256(keccak256(body))) and VAA bytes
*/

type Opts = {
  emitterChainId: number;
  emitterAddress: string;
  sequence: number;
  payload: string;
  guardianSetIndex: number;
  consistencyLevel: number;
  r: string;
  s: string;
  v: number;
};

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.split("=");
  return [k.replace(/^--/, ""), v];
}));

function hexToBuf(hex: string): Buffer {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

const opts: Partial<Opts> = {
  emitterChainId: args["emitterChainId"] ? Number(args["emitterChainId"]) : undefined,
  emitterAddress: args["emitterAddress"],
  sequence: args["sequence"] ? Number(args["sequence"]) : undefined,
  payload: args["payload"],
  guardianSetIndex: args["guardianSetIndex"] ? Number(args["guardianSetIndex"]) : undefined,
  consistencyLevel: args["consistencyLevel"] ? Number(args["consistencyLevel"]) : undefined,
  r: args["r"],
  s: args["s"],
  v: args["v"] ? Number(args["v"]) : undefined,
};

for (const k of ["emitterChainId","emitterAddress","sequence","payload","guardianSetIndex","consistencyLevel","r","s","v"] as const) {
  if ((opts as any)[k] === undefined || (opts as any)[k] === null) fail(`Missing --${k}`);
}

const emitterAddr = hexToBuf(opts.emitterAddress!);
if (emitterAddr.length !== 32) fail("emitterAddress must be 32 bytes");
const payload = hexToBuf(opts.payload!);

const bodyParts = [
  Buffer.from([0,0,0,0]), // timestamp
  Buffer.from([0,0,0,0]), // nonce
  Buffer.from([(opts.emitterChainId! >> 8) & 0xff, opts.emitterChainId! & 0xff]),
  emitterAddr,
  Buffer.from(new Uint8Array([
    (opts.sequence! >> 56) & 0xff,
    (opts.sequence! >> 48) & 0xff,
    (opts.sequence! >> 40) & 0xff,
    (opts.sequence! >> 32) & 0xff,
    (opts.sequence! >> 24) & 0xff,
    (opts.sequence! >> 16) & 0xff,
    (opts.sequence! >> 8) & 0xff,
    opts.sequence! & 0xff,
  ])),
  Buffer.from([opts.consistencyLevel! & 0xff]),
  payload,
];
const body = Buffer.concat(bodyParts);
const digest = Buffer.from(ethers.keccak256(ethers.keccak256(body)).slice(2), "hex");

// Normalize v to 0/1 byte for VAA (Core adds 27)
let vNorm = opts.v!;
if (vNorm >= 27) vNorm = vNorm - 27;
if (vNorm !== 0 && vNorm !== 1) fail("v must normalize to 0 or 1");

const sigBytes = Buffer.concat([
  Buffer.from([0]), // guardianIndex
  hexToBuf(opts.r!),
  hexToBuf(opts.s!),
  Buffer.from([vNorm]),
]);

const header = Buffer.concat([
  Buffer.from([1]), // version
  Buffer.from([
    (opts.guardianSetIndex! >> 24) & 0xff,
    (opts.guardianSetIndex! >> 16) & 0xff,
    (opts.guardianSetIndex! >> 8) & 0xff,
    opts.guardianSetIndex! & 0xff,
  ]),
  Buffer.from([1]), // nSigs
]);

const vaa = Buffer.concat([header, sigBytes, body]);

console.log(JSON.stringify({
  bodyDigest: "0x"+digest.toString("hex"),
  vaa: "0x"+vaa.toString("hex"),
}, null, 2));


