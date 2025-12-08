#!/usr/bin/env ts-node

import "dotenv/config";
import fs from "fs";
import path from "path";
import { ethers } from "ethers";

type ChainName = "chainA" | "chainB";

type Cli = {
  source: ChainName;
  dest: ChainName;
  token: string;
  amount: string;                 // in wei (string to avoid JS bigint literals in CLI)
  recipient?: string;             // EVM address; converted to bytes32
  deployerKey?: string;
  guardianKey?: string;
  guardianSetIndex?: number;
  wrap?: boolean;                 // if true and balance < amount, call deposit() with missing wei
  checkBalances?: boolean;        // log balances before/after on destination
  assertBalances?: boolean;       // fail if before != 0 or after <= before
  r?: string;
  s?: string;
  v?: string;                     // accepts 0/1/27/28 or hex byte
  noSend?: boolean;               // build-only
};

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseArgs(): Cli {
  const argEntries = process.argv.slice(2).map((a) => {
    const [key, value] = a.split("=");
    const k = (key ?? "").replace(/^--/, "");
    const v = value ?? "";
    return [k, v];
  });
  const args = Object.fromEntries(argEntries) as Record<string, string>;
  const source = ((args["source"] as any) as ChainName) || "chainA";
  const dest = ((args["dest"] as any) as ChainName) || (source === "chainA" ? "chainB" : "chainA");
  const token = args["token"] || "";
  const amount = args["amount"] || "1000000000000000000";
  const recipient = args["recipient"] || process.env["DEPLOYER_ADDR"];
  if (!token) fail("Missing --token=<address> on source chain");
  if (!recipient) fail("Missing --recipient=<evm address> and DEPLOYER_ADDR not set");
  const deployerKey = args["deployerKey"] || process.env["DEPLOYER_KEY"];
  const guardianKey = args["guardianKey"] || process.env["DEV_GUARDIAN_KEY"];
  const guardianSetIndex = args["guardianSetIndex"] ? Number(args["guardianSetIndex"]) : undefined;
  const wrap = args["wrap"] === "true" || args["wrap"] === "1";
  const checkBalances = args["checkBalances"] === undefined ? true : (args["checkBalances"] === "true" || args["checkBalances"] === "1");
  const assertBalances = args["assertBalances"] === "true" || args["assertBalances"] === "1";
  const r = args["r"];
  const s = args["s"];
  const v = args["v"];
  const noSend = args["noSend"] === "true" || args["noSend"] === "1";
  return { source, dest, token, amount, recipient, deployerKey, guardianKey, guardianSetIndex, wrap, checkBalances, assertBalances, r, s, v, noSend };
}

function loadChainEnv(chain: ChainName) {
  const envPath = path.join("devnet", "chains", `${chain}.env`);
  if (!fs.existsSync(envPath)) fail(`Missing ${envPath}. Start local nets first.`);
  const cfg = parseSimpleEnv(fs.readFileSync(envPath, "utf8"));
  const RPC_URL = cfg["RPC_URL"];
  const WORMHOLE_CHAIN_ID = Number(cfg["WORMHOLE_CHAIN_ID"]);
  if (!RPC_URL) fail(`RPC_URL missing in ${envPath}`);
  if (!WORMHOLE_CHAIN_ID) fail(`WORMHOLE_CHAIN_ID missing/invalid in ${envPath}`);
  return { RPC_URL, WORMHOLE_CHAIN_ID };
}

function parseSimpleEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadDeployment() {
  const p = path.join("devnet", "config", "deployment.local.json");
  if (!fs.existsSync(p)) fail("deployment.local.json not found. Run deploy scripts first.");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function beUint32(n: number): Buffer {
  return Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
function beUint64(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
}
function hexToBuf(hex: string): Buffer {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}
function normalizeV(input: string | number | undefined): number | undefined {
  if (input === undefined) return undefined;
  let vNum: number;
  if (typeof input === "string") {
    if (input.startsWith("0x")) {
      vNum = parseInt(input, 16);
    } else {
      vNum = Number(input);
    }
  } else {
    vNum = input;
  }
  if (vNum >= 27) vNum = vNum - 27;
  if (vNum !== 0 && vNum !== 1) fail("v must normalize to 0 or 1");
  return vNum;
}

async function main() {
  const cli = parseArgs();
  const deployment = loadDeployment();

  const src = cli.source;
  const dst = cli.dest;
  const srcEnv = loadChainEnv(src);
  const dstEnv = loadChainEnv(dst);

  const coreSrc: string | undefined = deployment.chains?.[src]?.core;
  const bridgeSrc: string | undefined = deployment.chains?.[src]?.bridge;
  const coreDst: string | undefined = deployment.chains?.[dst]?.core;
  const bridgeDst: string | undefined = deployment.chains?.[dst]?.bridge;
  if (!coreSrc || !bridgeSrc || !coreDst || !bridgeDst) {
    fail(`Missing Core/Bridge addresses in deployment.local.json for ${src} or ${dst}`);
  }

  const providerSrc = new ethers.JsonRpcProvider(srcEnv.RPC_URL);
  const providerDst = new ethers.JsonRpcProvider(dstEnv.RPC_URL);

  const deployerKey = cli.deployerKey;
  if (!deployerKey) fail("Missing deployer key. Provide --deployerKey or DEPLOYER_KEY env.");
  const deployerSrc = new ethers.Wallet(deployerKey, providerSrc);
  const deployerDst = new ethers.Wallet(deployerKey, providerDst);

  // Interfaces
  const coreIface = new ethers.Interface([
    "function messageFee() view returns (uint256)",
  ]);
  const erc20Iface = new ethers.Interface([
    "function approve(address spender, uint256 value) returns (bool)"
  ]);
  const erc20ReadIface = new ethers.Interface([
    "function balanceOf(address owner) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function name() view returns (string)"
  ]);
  const wethIface = new ethers.Interface([
    "function deposit() payable"
  ]);
  const bridgeIfaceSrc = new ethers.Interface([
    "function transferTokens(address token, uint256 amount, uint16 recipientChain, bytes32 recipient, uint256 arbiterFee, uint32 nonce)"
  ]);
  const bridgeReadIface = new ethers.Interface([
    "function wrappedAsset(uint16 chainId, bytes32 tokenAddress) view returns (address)"
  ]);
  const coreEventIface = new ethers.Interface([
    "event LogMessagePublished(address indexed sender, uint64 sequence, uint32 nonce, bytes payload, uint8 consistencyLevel)"
  ]);

  // 1) Approve + transfer on source
  const coreSrcC: any = new ethers.Contract(coreSrc, coreIface, providerSrc);
  const messageFee: bigint = await coreSrcC["messageFee"]();
  const tokenSrc: any = new ethers.Contract(cli.token, erc20Iface, deployerSrc) as any;
  const tokenRead: any = new ethers.Contract(cli.token, erc20ReadIface, providerSrc) as any;

  // Ensure balance; optionally wrap ETH into WETH if requested
  const need = BigInt(cli.amount);
  const currentBal: bigint = await tokenRead["balanceOf"](deployerSrc.address);
  if (currentBal < need) {
    if (cli.wrap) {
      const missing = need - currentBal;
      console.log(`balance low: ${currentBal.toString()} < ${need.toString()} — wrapping ${missing.toString()} wei via deposit()`);
      const weth: any = new ethers.Contract(cli.token, wethIface, deployerSrc);
      const depTx = await weth["deposit"]({ value: missing });
      await depTx.wait();
    } else {
      fail(`Insufficient token balance (${currentBal.toString()}); rerun with --wrap=true or lower --amount`);
    }
  }

  // Ensure allowance (approve full amount)
  await (await tokenSrc["approve"](bridgeSrc, cli.amount)).wait();

  const recip32 = ethers.hexlify(ethers.zeroPadValue(cli.recipient!, 32));
  const bridgeSrcC: any = new ethers.Contract(bridgeSrc, bridgeIfaceSrc, deployerSrc);
  const tx = await bridgeSrcC["transferTokens"](
    cli.token,
    cli.amount,
    srcEnv.WORMHOLE_CHAIN_ID === dstEnv.WORMHOLE_CHAIN_ID ? 0 : dstEnv.WORMHOLE_CHAIN_ID,
    recip32,
    0,
    0,
    { value: messageFee }
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) fail("transferTokens tx failed");

  // 2) Extract Core message from receipt
  const topic0 = coreEventIface.getEvent("LogMessagePublished")!.topicHash;
  const coreLogs = receipt.logs.filter((l: any) => l.topics[0] === topic0 && l.address.toLowerCase() === coreSrc.toLowerCase());
  if (coreLogs.length === 0) fail("No LogMessagePublished found for Core in transfer tx");
  const decodedAny: any = coreEventIface.decodeEventLog("LogMessagePublished", coreLogs[0].data, coreLogs[0].topics);
  const sender = decodedAny["sender"] as string;
  const sequence = decodedAny["sequence"] as bigint;
  const payload = decodedAny["payload"] as string;
  const consistencyLevel = Number(decodedAny["consistencyLevel"]);
  const emitterAddress32 = ethers.hexlify(ethers.zeroPadValue(sender, 32));

  console.log("transfer.tx:", tx.hash);
  console.log("emitter:", sender);
  console.log("sequence:", sequence.toString());
  console.log("payload:", payload);
  console.log("consistencyLevel:", consistencyLevel);

  // 3) Guardian set index on destination
  const coreDstIface = new ethers.Interface([
    "function getCurrentGuardianSetIndex() view returns (uint32)"
  ]);
  let guardianSetIndex: number;
  if (cli.guardianSetIndex !== undefined) {
    guardianSetIndex = cli.guardianSetIndex;
  } else {
    const coreDstC: any = new ethers.Contract(coreDst, coreDstIface, providerDst);
    const gsi = await coreDstC["getCurrentGuardianSetIndex"]();
    guardianSetIndex = Number(gsi);
  }

  // 4) Build body and digest (double keccak)
  const body = Buffer.concat([
    Buffer.from([0,0,0,0]),
    Buffer.from([0,0,0,0]),
    Buffer.from([(srcEnv.WORMHOLE_CHAIN_ID >> 8) & 0xff, srcEnv.WORMHOLE_CHAIN_ID & 0xff]),
    hexToBuf(emitterAddress32),
    beUint64(sequence),
    Buffer.from([consistencyLevel & 0xff]),
    hexToBuf(payload),
  ]);
  const bodyDigest = Buffer.from(ethers.keccak256(ethers.keccak256(body)).slice(2), "hex");

  // 5) r/s/v: sign with guardian key or accept provided
  let r = cli.r;
  let s = cli.s;
  let vNorm = normalizeV(cli.v);
  if (!r || !s || vNorm === undefined) {
    const guardianKey = cli.guardianKey;
    if (!guardianKey) fail("Missing guardian signature and guardianKey. Provide --r/--s/--v or --guardianKey/DEV_GUARDIAN_KEY.");
    const wallet = new ethers.Wallet(guardianKey);
    console.log("guardian:", wallet.address);
    const sig = wallet.signingKey.sign(bodyDigest);
    r = sig.r;
    s = sig.s;
    const anySig: any = sig;
    vNorm = anySig.recoveryParam ?? (typeof sig.v === "number" ? (sig.v >= 27 ? sig.v - 27 : sig.v) : undefined);
    if (vNorm === undefined) fail("Unable to compute v from signature");
  }
  if (!r!.startsWith("0x")) r = "0x"+r;
  if (!s!.startsWith("0x")) s = "0x"+s;
  if (vNorm !== 0 && vNorm !== 1) fail("v must be 0 or 1 after normalization");

  // 6) Pack VAA
  const header = Buffer.concat([
    Buffer.from([1]),
    beUint32(guardianSetIndex),
    Buffer.from([1]), // nSigs
  ]);
  const sigBytes = Buffer.concat([
    Buffer.from([0]), // guardian index
    hexToBuf(r!),
    hexToBuf(s!),
    Buffer.from([vNorm]),
  ]);
  const vaa = Buffer.concat([header, sigBytes, body]);
  const VAA_HEX = "0x" + vaa.toString("hex");

  console.log("bodyDigest:", "0x"+bodyDigest.toString("hex"));
  console.log("r:", r);
  console.log("s:", s);
  console.log("v:", vNorm);
  console.log("VAA:", VAA_HEX);

  if (cli.noSend) {
    console.log("noSend=true; skipping completeTransfer submission");
    return;
  }

  // Optional: destination balance checks before submit
  let beforeBal: bigint | undefined;
  let beforeKnown = false;
  let wrappedAddr: string | undefined;
  if (cli.checkBalances) {
    try {
      const bridgeDstRead: any = new ethers.Contract(bridgeDst, bridgeReadIface, providerDst);
      const token32 = ethers.zeroPadValue(cli.token, 32);
      wrappedAddr = await bridgeDstRead["wrappedAsset"](srcEnv.WORMHOLE_CHAIN_ID, token32);
      if (wrappedAddr && wrappedAddr !== ethers.ZeroAddress) {
        const wrappedRead: any = new ethers.Contract(wrappedAddr, erc20ReadIface, providerDst);
        beforeBal = await wrappedRead["balanceOf"](cli.recipient);
        beforeKnown = true;
        const before = beforeBal ?? 0n;
        console.log("dest.beforeBalance:", before.toString());
        if (cli.assertBalances && beforeKnown && before !== 0n) {
          fail(`Assertion failed: before balance expected 0, got ${before.toString()}`);
        }
      } else {
        console.log("wrapped asset not found on destination (attest/createWrapped first); skipping balance check");
      }
    } catch (e: any) {
      console.log("warning: pre-check failed:", e?.reason || e?.message || e);
    }
  }

  // 7) Submit completeTransfer on destination Bridge
  const bridgeDstIface = new ethers.Interface([
    "function completeTransfer(bytes encodedVm)"
  ]);
  const bridgeDstC: any = new ethers.Contract(bridgeDst, bridgeDstIface, deployerDst);
  try {
    const tx2 = await bridgeDstC["completeTransfer"](VAA_HEX);
    const rc2 = await tx2.wait();
    console.log("completeTransfer.tx:", tx2.hash);
    console.log("status:", rc2?.status);

    // Optional: destination balance check after submit
    if (cli.checkBalances && wrappedAddr && wrappedAddr !== ethers.ZeroAddress) {
      try {
        const wrappedRead: any = new ethers.Contract(wrappedAddr, erc20ReadIface, providerDst);
        const afterBal: bigint = await wrappedRead["balanceOf"](cli.recipient);
        console.log("dest.afterBalance:", afterBal.toString());
        if (cli.assertBalances) {
          if (beforeKnown && beforeBal !== undefined && afterBal <= beforeBal) {
            fail(`Assertion failed: after balance ${afterBal.toString()} <= before balance ${beforeBal.toString()}`);
          }
          if (afterBal === 0n) {
            fail("Assertion failed: after balance expected > 0, got 0");
          }
        }
      } catch (e: any) {
        console.log("warning: post-check failed:", e?.reason || e?.message || e);
      }
    }
  } catch (e: any) {
    console.error("completeTransfer reverted:", e?.reason || e?.message || e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


