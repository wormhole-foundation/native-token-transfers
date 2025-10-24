import { web3 } from "@coral-xyz/anchor";
import * as spl from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  Chain,
  ChainAddress,
  ChainContext,
  NativeSigner,
  Platform,
  Signer,
  UniversalAddress,
  VAA,
  Wormhole,
  WormholeMessageId,
  amount,
  chainToPlatform,
  encoding,
  keccak256,
  serialize,
  signAndSendWait,
  signSendWait as ssw,
  toChainId,
  toNative,
} from "@wormhole-foundation/sdk-connect";
import evm from "@wormhole-foundation/sdk/platforms/evm";
import solana from "@wormhole-foundation/sdk/platforms/solana";
import stacks from "@wormhole-foundation/sdk/platforms/stacks";
import "@wormhole-foundation/sdk-definitions-ntt";
import { StacksPlatform, StacksZeroAddress } from "@wormhole-foundation/sdk-stacks";

import { ethers } from "ethers";
import { deserializePayload } from "@wormhole-foundation/sdk";

import { DummyTokenMintAndBurn__factory } from "../../evm/ts/ethers-ci-contracts/factories/DummyToken.sol/DummyTokenMintAndBurn__factory.js";
import { DummyToken__factory } from "../../evm/ts/ethers-ci-contracts/factories/DummyToken.sol/DummyToken__factory.js";
import { ERC1967Proxy__factory } from "../../evm/ts/ethers-ci-contracts/factories/ERC1967Proxy__factory.js";
import { IWormholeRelayer__factory } from "../../evm/ts/ethers-ci-contracts/factories/IWormholeRelayer.sol/IWormholeRelayer__factory.js";
import { NttManager__factory } from "../../evm/ts/ethers-ci-contracts/factories/NttManager__factory.js";
import { TransceiverStructs__factory } from "../../evm/ts/ethers-ci-contracts/factories/TransceiverStructs__factory.js";
import { TrimmedAmountLib__factory } from "../../evm/ts/ethers-ci-contracts/factories/TrimmedAmount.sol/TrimmedAmountLib__factory.js";
import { WormholeTransceiver__factory } from "../../evm/ts/ethers-ci-contracts/factories/WormholeTransceiver__factory.js";

import "../../evm/ts/src/index.js";
import "../../solana/ts/sdk/index.js";
import "../../stacks/ts/src/index.js";

import { NTT } from "../../solana/ts/lib/index.js";
import { SolanaNtt } from "../../solana/ts/sdk/index.js";
import { Ntt } from "../definitions/src/index.js";
import path from "path";
import fs from "fs";
import { broadcastTransaction, Cl, cvToValue, fetchCallReadOnlyFunction, fetchNonce, makeContractCall, makeContractDeploy, PostConditionMode, privateKeyToAddress } from "@stacks/transactions";

// TODO FG TODO change to a valid import
import { StacksWormholeMessageId } from "../../../wormhole-sdk-ts/platforms/stacks/protocols/core/dist/esm/core.js";
import { JsonRpcProvider } from "ethers";
import { universalAddress } from "@wormhole-foundation/sdk-definitions";

// Note: Currently, in order for this to run, the evm bindings with extra contracts must be build
// To do that, at the root, run `npm run generate:test`

export const NETWORK: "Devnet" = "Devnet";

type NativeSdkSigner<P extends Platform> = P extends "Evm"
  ? ethers.Wallet
  : P extends "Solana"
  ? web3.Keypair
  : never;

interface Signers<P extends Platform = Platform> {
  address: ChainAddress;
  signer: Signer;
  nativeSigner: NativeSdkSigner<P>;
}

interface StartingCtx {
  context: ChainContext<typeof NETWORK>;
  mode: Ntt.Mode;
}

export interface Ctx extends StartingCtx {
  signers: Signers;
  contracts?: Ntt.Contracts & { state?: string, tokenOwner?: string };
}

export const wh = new Wormhole(NETWORK, [evm.Platform, solana.Platform, stacks.Platform], {
  ...(process.env["CI"]
    ? {
        chains: {
          Ethereum: {
            contracts: {
              relayer: "0xcC680D088586c09c3E0E099a676FA4b6e42467b4",
            },
          },
          Bsc: {
            contracts: {
              relayer: "0xcC680D088586c09c3E0E099a676FA4b6e42467b4",
            },
          },
        },
      }
    : {
        api: "http://localhost:7071",
        chains: {
          Ethereum: { rpc: "http://localhost:8545" },
          Bsc: { rpc: "http://localhost:8546" },
          Solana: { rpc: "http://localhost:8899" },
          Stacks: { rpc: "http://localhost:3999" },
        },
      }),
});

export async function deploy(
  _ctx: StartingCtx,
  getNativeSigner: (ctx: Partial<Ctx>) => any
): Promise<Ctx> {
  const platform = chainToPlatform(_ctx.context!.chain);
  const ctx = { ..._ctx, signers: await getSigners(_ctx, getNativeSigner) };
  switch (platform) {
    case "Evm":
      return deployEvm(ctx);
    case "Solana":
      return deploySolana(ctx);
    case "Stacks":
      return deployStacks(ctx);
    default:
      throw new Error(
        "Unsupported platform " + platform + " (add it to deploy)"
      );
  }
}

export async function link(chainInfos: Ctx[], accountantPrivateKey: string) {
  console.log("\nStarting linking process");
  console.log("========================");

  // first submit hub init to accountant
  const hub = chainInfos[0]!;
  const hubChain = hub.context.chain;
const emitter = Wormhole.chainAddress(
  hubChain,
  hub.contracts!.transceiver["wormhole"]!
).address.toUniversalAddress()
console.log(`emitter`)
console.log(emitter.toString())
  const msgId: WormholeMessageId = {
    chain: hubChain,
    emitter: emitter,
    sequence: 0n,
  };
  const vaa = await wh.getVaa(msgId, "Ntt:TransceiverInfo");
  const vaas: Uint8Array[] = [serialize(vaa!)];

  // [target, peer, vaa]
  const registrations: [string, string, VAA<"Ntt:TransceiverRegistration">][] =
    [];

  // register each chain in parallel
  await Promise.all(
    chainInfos.map((targetInfo) =>
      (async () => {
        const toRegister = chainInfos.filter(
          (peerInfo) => peerInfo.context.chain !== targetInfo.context.chain
        );

        console.log(
          "Registering peers for ",
          targetInfo.context.chain,
          ": ",
          toRegister.map((x) => x.context.chain)
        );
        console.log(`Looping for ${toRegister.length} peers`)
        for (const peerInfo of toRegister) {
          console.log(`------------!!!!!!! SETUP PEER!!: ${targetInfo.context.chain} to ${peerInfo.context.chain} `)
          const vaa = await setupPeer(targetInfo, peerInfo);
          console.log(`------------[DONE] !!!!!!! SETUP PEER!!: ${targetInfo.context.chain} to ${peerInfo.context.chain} `)
          console.log(vaa)
          if (!vaa) throw new Error("No VAA found");
          // Add to registrations by PEER chain so we can register hub first
          console.log(`Pushing to registrations`, {
            target: targetInfo.context.chain,
            peer: peerInfo.context.chain,
          })
          registrations.push([
            targetInfo.context.chain,
            peerInfo.context.chain,
            vaa,
          ]);
        }
      })()
    )
  );

  console.log(`Registration peers done`)

  // Push Hub to Spoke registrations
  const hubToSpokeRegistrations = registrations.filter(
    ([_, peer]) => peer === hubChain
  );
  console.log(`Hub to spoke registrations: ${hubToSpokeRegistrations.length}`)
  for (const [, , vaa] of hubToSpokeRegistrations) {
    console.log(
      "Pushing hub to spoke registrations: ",
      vaa.emitterChain,
      vaa.payload.chain,
      vaa.payload.transceiver.toString()
    );
    vaas.push(serialize(vaa));
  }

  // Push Spoke to Hub registrations
  const spokeToHubRegistrations = registrations.filter(
    ([target, _]) => target === hubChain
  );
  console.log(`Spoke to hub registrations: ${spokeToHubRegistrations.length}`)
  for (const [, , vaa] of spokeToHubRegistrations) {
    console.log(
      "Pushing spoke to hub registrations: ",
      vaa.emitterChain,
      vaa.payload.chain,
      vaa.payload.transceiver.toString()
    );
    vaas.push(serialize(vaa));
  }

  // Push all other registrations
  const spokeToSpokeRegistrations = registrations.filter(
    ([target, peer]) => target !== hubChain && peer !== hubChain
  );

  console.log(`spokeToSpokeRegistrations: ${spokeToSpokeRegistrations.length}`)
  for (const [, , vaa] of spokeToSpokeRegistrations) {
    console.log(
      "Pushing spoke to spoke registrations: ",
      vaa.emitterChain,
      vaa.payload.chain,
      vaa.payload.transceiver.toString()
    );
    vaas.push(serialize(vaa));
  }
  
  // Submit all registrations at once
  console.log(`Submitting ${vaas.length} registrations`)
  // await submitAccountantVAAs(vaas, accountantPrivateKey); // TODO FG UN COMMENT
}

export async function transferWithChecks(sourceCtx: Ctx, destinationCtx: Ctx) {
  const sendAmt = "0.01";

  const srcAmt = amount.units(
    amount.parse(sendAmt, getNativeTokenDecimals(sourceCtx))
  );
  const dstAmt = amount.units(
    amount.parse(sendAmt, getNativeTokenDecimals(destinationCtx))
  );

  const [managerBalanceBeforeSend, userBalanceBeforeSend] =
    await getManagerAndUserBalance(sourceCtx);
  const [managerBalanceBeforeRecv, userBalanceBeforeRecv] =
    await getManagerAndUserBalance(destinationCtx);

  const { signer: srcSigner } = sourceCtx.signers;
  const { signer: dstSigner } = destinationCtx.signers;

  const sender = Wormhole.chainAddress(srcSigner.chain(), srcSigner.address());
  const receiver = Wormhole.chainAddress(
    dstSigner.chain(),
    dstSigner.address()
  );

  // TODO FG TODO
  // const useRelayer =
  //   chainToPlatform(sourceCtx.context.chain) === "Evm" &&
  //   chainToPlatform(destinationCtx.context.chain) === "Evm";
  const useRelayer = false;

  console.log("Calling transfer on: ", sourceCtx.context.chain, "For receiver: ", receiver.address.toString());
  const srcNtt = await getNtt(sourceCtx);

  if(destinationCtx.context.chain === "Stacks") {
    // TODO FG TODO remove me and use executor smh????
    console.log(`We're transferring TO Stacks, recipient:`, receiver.address.toString())
    const rpcUrl = (await destinationCtx.context.getRpc()).client.baseUrl
    const {signer, nativeSigner: wallet} = destinationCtx.signers as Signers<"Stacks">
    const getWhAddressTx = await makeContractCall({
      contractName: 'wormhole-core-v4',
      contractAddress: privateKeyToAddress(wallet, "devnet"),
      functionName: 'get-wormhole-address',
      functionArgs: [
        Cl.address(receiver.address.toString())
      ],
      senderKey: wallet,
      network: 'devnet',
      client: rpcUrl,
    })
    console.log(`[Txids] get-wormhole-address at ${destinationCtx.context.chain}`, getWhAddressTx)
    const broadcastedWhAddressTx = await broadcastTransaction({
      transaction: getWhAddressTx,
      network: 'devnet',
      client: rpcUrl,
    })
    
    await StacksPlatform.waitForTx(broadcastedWhAddressTx.txid, rpcUrl, true)
    console.log(`Address registered!`)
  }

  const transferTxs = srcNtt.transfer(sender.address, srcAmt, receiver, {
    queue: false,
    automatic: useRelayer,
  });
  const txids = await signSendWait(sourceCtx.context, transferTxs, srcSigner);

  console.log(`[Txids] Transfer from ${sourceCtx.context.chain} to ${destinationCtx.context.chain}`, txids)

  const srcCore = await sourceCtx.context.getWormholeCore();
  const msgId = (
    await srcCore.parseTransaction(txids[txids.length - 1]!.txid)
  )[0]!;

  console.log(`[useRelayer] for ${sourceCtx.context.chain} to ${destinationCtx.context.chain}: ${useRelayer}`)
  if (!useRelayer) await receive(msgId, destinationCtx);
  else await waitForRelay(msgId, destinationCtx);

  const [managerBalanceAfterSend, userBalanceAfterSend] =
    await getManagerAndUserBalance(sourceCtx);
  const [managerBalanceAfterRecv, userBalanceAfterRecv] =
    await getManagerAndUserBalance(destinationCtx);

  console.log(`Checking balances of SOURCE: ${sourceCtx.context.chain}`)
  checkBalances(
    sourceCtx.mode,
    [managerBalanceBeforeSend, managerBalanceAfterSend],
    [userBalanceBeforeSend, userBalanceAfterSend],
    srcAmt
  );

  console.log(`Checking balances of DESTINATION: ${destinationCtx.context.chain}`)
  checkBalances(
    destinationCtx.mode,
    [managerBalanceBeforeRecv, managerBalanceAfterRecv],
    [userBalanceBeforeRecv, userBalanceAfterRecv],
    -dstAmt
  );
}

async function waitForRelay(
  msgId: WormholeMessageId,
  dst: Ctx,
  retryTime: number = 2000
) {
  const vaa = await wh.getVaa(msgId, "Uint8Array");
  const deliveryHash = keccak256(vaa!.hash);
  const rpc = dst.context?.chain === "Bsc" ? new JsonRpcProvider('http://localhost:8546'): await dst.context?.getRpc();

  const wormholeRelayer = IWormholeRelayer__factory.connect(
    dst.context.config.contracts.relayer!,
    rpc
  );

  let success = false;
  while (!success) {
    try {
      const successBlock = await wormholeRelayer.deliverySuccessBlock(
        deliveryHash
      );
      if (successBlock > 0) success = true;
      console.log(`[Dst chain: ${dst.context.chain} Relayer delivery: `, success);
    } catch (e) {
      console.error(e);
    }
    await new Promise((resolve) => setTimeout(resolve, retryTime));
  }
}

// Wrap signSendWait from sdk to provide full error message
async function signSendWait(
  ctx: ChainContext<typeof NETWORK>,
  txs: any,
  signer: Signer
) {
  try {
    return await ssw(ctx, txs, signer);
  } catch (e) {
    console.error(e);
    throw e;
  }
}

async function getNtt(
  ctx: Ctx
): Promise<Ntt<typeof NETWORK, typeof ctx.context.chain>> {
  return ctx.context.getProtocol("Ntt", { ntt: ctx.contracts });
}

async function getSigners(
  ctx: Partial<Ctx>,
  getNativeSigner: (ctx: Partial<Ctx>) => any
): Promise<Signers> {
  const platform = chainToPlatform(ctx.context!.chain);
  let nativeSigner = getNativeSigner(ctx);
  // TODO FG TODO
  const rpc = ctx.context?.chain === "Bsc" ? new JsonRpcProvider('http://localhost:8546'): await ctx.context?.getRpc();
  let signer: Signer;
  switch (platform) {
    case "Evm":
      signer = await evm.getSigner(rpc, nativeSigner);
      nativeSigner = (signer as NativeSigner).unwrap();
      break;
    case "Solana":
      signer = await solana.getSigner(rpc, nativeSigner);
      break;
    case "Stacks":
      signer = await stacks.getSigner(rpc, nativeSigner);
      break;
    default:
      throw new Error(
        "Unsupported platform " + platform + " (add it to getSigner)"
      );
  }

  return {
    nativeSigner: nativeSigner,
    signer: signer,
    address: Wormhole.chainAddress(signer.chain(), signer.address()),
  };
}

async function deployEvm(ctx: Ctx): Promise<Ctx> {
  const { signer, nativeSigner: wallet } = ctx.signers as Signers<"Evm">;


  // Deploy libraries used by various things
  console.log(`[${ctx.context.chain}] Deploying transceiverStructs`);
  const transceiverStructsFactory = new TransceiverStructs__factory(wallet);
  console.log(`[${ctx.context.chain}] 1`)
  const transceiverStructsContract = await transceiverStructsFactory.deploy();
  console.log(`[${ctx.context.chain}] 2 tx `, transceiverStructsContract.deploymentTransaction()?.hash)
  await transceiverStructsContract.deploymentTransaction()?.wait(1);
  console.log("3")

  console.log("Deploying trimmed amount");
  const trimmedAmountFactory = new TrimmedAmountLib__factory(wallet);
  const trimmedAmountContract = await trimmedAmountFactory.deploy();
  await trimmedAmountContract.deploymentTransaction()?.wait(1);

  console.log("Deploying dummy token");
  // Deploy the NTT token
  const NTTAddress = await new (ctx.mode === "locking"
    ? DummyToken__factory
    : DummyTokenMintAndBurn__factory)(wallet).deploy();
  await NTTAddress.deploymentTransaction()?.wait(1);

  if (ctx.mode === "locking") {
    await tryAndWaitThrice(() =>
      NTTAddress.mintDummy(
        signer.address(),
        amount.units(amount.parse("100", 18))
      )
    );
  }

  const transceiverStructsAddress =
    await transceiverStructsContract.getAddress();
  const trimmedAmountAddress = await trimmedAmountContract.getAddress();
  const ERC20NTTAddress = await NTTAddress.getAddress();

  const myObj = {
    "src/libraries/TransceiverStructs.sol:TransceiverStructs":
      transceiverStructsAddress,
    "src/libraries/TrimmedAmount.sol:TrimmedAmountLib": trimmedAmountAddress,
  };

  const chainId = toChainId(ctx.context.chain);

  // https://github.com/search?q=repo%3Awormhole-foundation%2Fwormhole-connect%20__factory&type=code
  // https://github.com/wormhole-foundation/wormhole/blob/00f504ef452ae2d94fa0024c026be2d8cf903ad5/clients/js/src/evm.ts#L335

  console.log("Deploying manager implementation", {
    erc20Address: ERC20NTTAddress,
    chainId,
    mode: ctx.mode,
    lockingTime: 0,
    isLocking: ctx.mode === "locking",
  });
  const wormholeManager = new NttManager__factory(myObj, wallet);
  const bytecodeLengthInBytes = NttManager__factory.bytecode.length;
  console.log("Bytecode length in bytes: ", bytecodeLengthInBytes / 2);
  const managerAddress = await wormholeManager.deploy(
    ERC20NTTAddress, // Token address
    ctx.mode === "locking" ? 0 : 1, // Lock
    chainId, // chain id
    0, // Locking time
    true
  );
  console.log(`Manager deployment tx hash: ${managerAddress.deploymentTransaction()?.hash}`)
  await managerAddress.deploymentTransaction()?.wait(1);

  console.log("Deploying manager proxy");
  const ERC1967ProxyFactory = new ERC1967Proxy__factory(wallet);
  const managerProxyAddress = await ERC1967ProxyFactory.deploy(
    await managerAddress.getAddress(),
    "0x"
  );
  await managerProxyAddress.deploymentTransaction()?.wait(1);

  // After we've deployed the proxy AND the manager then connect to the proxy with the interface of the manager.
  const manager = NttManager__factory.connect(
    await managerProxyAddress.getAddress(),
    wallet
  );

  console.log("Deploy transceiver implementation");
  const WormholeTransceiverFactory = new WormholeTransceiver__factory(
    myObj,
    wallet
  );
  const WormholeTransceiverAddress = await WormholeTransceiverFactory.deploy(
    // List of useful wormhole contracts - https://github.com/wormhole-foundation/wormhole/blob/00f504ef452ae2d94fa0024c026be2d8cf903ad5/ethereum/ts-scripts/relayer/config/ci/contracts.json
    await manager.getAddress(),
    ctx.context.config.contracts.coreBridge!, // Core wormhole contract - https://docs.wormhole.com/wormhole/blockchain-environments/evm#local-network-contract -- may need to be changed to support other chains
    ctx.context.config.contracts.relayer!, // Relayer contract -- double check these...https://github.com/wormhole-foundation/wormhole/blob/main/sdk/js/src/relayer/__tests__/wormhole_relayer.ts
    "0x0000000000000000000000000000000000000000", // TODO - Specialized relayer??????
    200, // Consistency level
    500000n // Gas limit
  );
  await WormholeTransceiverAddress.deploymentTransaction()?.wait(1);

  // Setup with the proxy
  console.log("Deploy transceiver proxy");
  const transceiverProxyFactory = new ERC1967Proxy__factory(wallet);
  const transceiverProxyDeployment = await transceiverProxyFactory.deploy(
    await WormholeTransceiverAddress.getAddress(),
    "0x"
  );
  await transceiverProxyDeployment.deploymentTransaction()?.wait(1);

  const transceiverProxyAddress = await transceiverProxyDeployment.getAddress();
  console.log(`Transceiver proxy address: ${transceiverProxyAddress}`)
  const transceiver = WormholeTransceiver__factory.connect(
    transceiverProxyAddress,
    wallet
  );

  // initialize() on both the manager and transceiver
  console.log("Initialize the manager");
  await tryAndWaitThrice(() => manager.initialize());
  console.log("Initialize the transceiver");
  const coreFee = await (await ctx.context.getWormholeCore()).getMessageFee()
  await tryAndWaitThrice(() => transceiver.initialize({
    value: coreFee
  }));

  // Setup the initial calls, like transceivers for the manager
  console.log("Set transceiver for manager");
  await tryAndWaitThrice(() => manager.setTransceiver(transceiverProxyAddress));

  console.log("Set outbound limit for manager");
  await tryAndWaitThrice(() =>
    manager.setOutboundLimit(amount.units(amount.parse("10000", 18)))
  );

  return {
    ...ctx,
    contracts: {
      transceiver: {
        wormhole: transceiverProxyAddress,
      },
      manager: await managerProxyAddress.getAddress(),
      token: ERC20NTTAddress,
    },
  };
}

async function deploySolana(ctx: Ctx): Promise<Ctx> {
  const { signer, nativeSigner: keypair } = ctx.signers as Signers<"Solana">;
  const connection = (await ctx.context.getRpc()) as Connection;
  const sender = Wormhole.chainAddress("Solana", signer.address());
  const address = sender.address.toNative("Solana").unwrap();
  console.log(`Using public key: ${address}`);

  const signature = await connection.requestAirdrop(address, 1000000000000);
  await connection.confirmTransaction(signature);
  console.log(`Airdropped 1000 SOL`);

  const mint = await spl.createMint(connection, keypair, address, null, 9);
  console.log("Created mint", mint.toString());

  const tokenAccount = await spl.createAssociatedTokenAccount(
    connection,
    keypair,
    mint,
    address
  );
  console.log("Created token account", tokenAccount.toString());

  if (ctx.mode === "locking") {
    const amt = amount.units(amount.parse("100", 9));
    await spl.mintTo(connection, keypair, mint, tokenAccount, keypair, amt);
    console.log(`Minted ${amt} tokens`);
  }

  const managerProgramId =
    ctx.mode === "locking"
      ? "NTTManager222222222222222222222222222222222"
      : "NTTManager111111111111111111111111111111111";

  ctx.contracts = {
    token: mint.toBase58(),
    manager: managerProgramId,
    transceiver: {
      wormhole: NTT.transceiverPdas(managerProgramId)
        .emitterAccount()
        .toString(),
    },
  };

  const manager = (await getNtt(ctx)) as SolanaNtt<typeof NETWORK, "Solana">;

  // Check to see if already deployed, dirty env
  const mgrProgram = await connection.getAccountInfo(
    new PublicKey(manager.pdas.configAccount())
  );
  if (!mgrProgram || mgrProgram.data.length === 0) {
    await spl.setAuthority(
      connection,
      keypair,
      mint,
      keypair,
      0,
      manager.pdas.tokenAuthority()
    );
    console.log(
      "Set token authority to",
      manager.pdas.tokenAuthority().toString()
    );

    const initTxs = manager.initialize(sender.address, {
      mint,
      outboundLimit: 1000000000n,
      mode: ctx.mode,
    });
    await signSendWait(ctx.context, initTxs, signer);
    console.log("Initialized ntt at", manager.program.programId.toString());

    // NOTE: this is a hack. The next instruction will fail if we don't wait
    // here, because the address lookup table is not yet available, despite
    // the transaction having been confirmed.
    // Looks like a bug, but I haven't investigated further. In practice, this
    // won't be an issue, becase the address lookup table will have been
    // created well before anyone is trying to use it, but we might want to be
    // mindful in the deploy script too.
    await new Promise((resolve) => setTimeout(resolve, 400));

    const registrTxs = manager.registerWormholeTransceiver({
      payer: Wormhole.chainAddress("Solana", keypair.publicKey.toBase58())
        .address,
      owner: Wormhole.chainAddress("Solana", keypair.publicKey.toBase58())
        .address,
    });
    await signSendWait(ctx.context, registrTxs, signer);
    console.log("Registered transceiver with self");
  }

  return {
    ...ctx,
    contracts: {
      transceiver: {
        wormhole: NTT.transceiverPdas(manager.program.programId)
          .emitterAccount()
          .toString(),
      },
      manager: manager.program.programId.toString(),
      token: mint.toString(),
    },
  };
}

async function deployStacks(ctx: Ctx): Promise<Ctx> {
  console.log(`Deploying Stacks in mode: ${ctx.mode}`)
  const {signer, nativeSigner: wallet} = ctx.signers as Signers<"Stacks">;
  const contractsDirectory = `${__dirname}/../../stacks/src/contracts`
  const requirementsDirectory = `${__dirname}/../../stacks/test/requirements`
  const deployerAddress = privateKeyToAddress(wallet, "devnet")

  const sbtcTokenContractName = "sbtc-token"
  const nttStateContractName = "ntt-manager-state"
  const nttManagerContractName = "ntt-manager-v1"
  const wormholeTransceiverContractName = "wormhole-transceiver-v1"
  const nttManagerProxyContractName = "ntt-manager-proxy-v1"
  const tokenManagerContractName = "token-manager"
  const bridgedTokenContractName = "bridged-token"

  const nttContractNamesSuffix = `-${Date.now().toString().slice(-4)}`
  console.log(`Using suffix: ${nttContractNamesSuffix}`)

  const requirementsNames = [
    requirementsDirectory + "/sip-010-trait-ft-standard",
    requirementsDirectory + "/sbtc-registry",
    requirementsDirectory + "/sbtc-token",
    requirementsDirectory + "/sbtc-deposit",
    // contractsDirectory + "/transceiver-trait-v1",
    // contractsDirectory + "/wormhole-transceiver-xfer-trait-v1",
    // contractsDirectory + "/ntt-manager-xfer-trait-v1",
    // contractsDirectory + "/ntt-manager-trait-v1",
  ]

  const contractNames = [
    nttStateContractName,
    "wormhole-transceiver-state",
    bridgedTokenContractName,
    tokenManagerContractName,
    nttManagerContractName,
    wormholeTransceiverContractName,
    nttManagerProxyContractName,
  ]

  const requirementsPath = requirementsNames.map(c=> {
    return `${c}.clar`
  })

  const contractsPath = contractNames.map(c=> {
    return path.join(contractsDirectory, `${c}.clar`)
  })

  const replaceAddresses = (code: string) : string => {
    return code
      .replaceAll("SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE", deployerAddress)
      .replaceAll("SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4", deployerAddress)
      .replaceAll("ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM", deployerAddress)
  }

  const requirements = requirementsPath.map( c => ({
    name: path.basename(c).replace(".clar", ""),
    code: replaceAddresses(fs.readFileSync(c, "utf-8"))
  }))



  const contracts = contractsPath.map( c => {
    const name = path.basename(c).replace(".clar", "") + nttContractNamesSuffix
    let code = replaceAddresses(fs.readFileSync(c, "utf-8"))
    
    contractNames.forEach(cn => {
      code = code.replaceAll(` .${cn}`, ` .${cn}${nttContractNamesSuffix}`)
    })
    // if(path.basename(c).replace(".clar", "") === nttManagerContractName) {
    //   console.log(`==================`)
    //   console.log(code)
    //   console.log(`==================`)
    // }
    return {
      name,
      code
    }
  })

  const clientBaseUrl = (await ctx.context.getRpc()).client.baseUrl

  let nonce = await fetchNonce({
    address: deployerAddress,
    client: { baseUrl: clientBaseUrl },
  });
  console.log(`About to deploy with nonce: ${nonce} , address: ${deployerAddress}`)

  for(const contract of [...requirements, ...contracts]) {
    console.log(`⏳ Deploying ${contract.name}`)
    const transaction = await makeContractDeploy({
      contractName: contract.name,
      codeBody: contract.code,
      clarityVersion: 3,
      senderKey: wallet,
      nonce,
      network: "devnet",
      client: { baseUrl: clientBaseUrl },
      postConditionMode: PostConditionMode.Allow,
    })

    const response = await broadcastTransaction({
      transaction,
      network: "devnet",
      client: { baseUrl: clientBaseUrl },
    })

    if ("error" in response && response.reason === "ContractAlreadyExists") {
      if(contracts.includes(contract)) {
        throw new Error(`Contract ${contract.name} already exists, new deployment required`)
      }
      console.log(`✅ Contract already exists`);
    } else {
      console.log(`${JSON.stringify(response)}`);
      nonce += 1n;
      await StacksPlatform.waitForTx(response.txid, clientBaseUrl, true)
      console.log(`✅ Deployed ${contract.name}`)
    }
  }

  console.log(`All contracts deployed`)

  console.log(`sBTC mint...`)

  const mintSbtcTx = await makeContractCall({
    contractName: sbtcTokenContractName,
    contractAddress: deployerAddress,
    functionName: 'protocol-mint',
    functionArgs: [
      Cl.uint(1000n**8n),
      Cl.principal(deployerAddress),
      Cl.buffer(new Uint8Array([1]))
    ],
    senderKey: wallet,
    network: "devnet",
    client: { baseUrl: clientBaseUrl },
    postConditionMode: PostConditionMode.Allow,
  })

  const mintSbtcTxHash = await broadcastTransaction({
    transaction: mintSbtcTx,
    network: "devnet",
    client: { baseUrl: clientBaseUrl },
  })

  console.log(mintSbtcTxHash)

  await StacksPlatform.waitForTx(mintSbtcTxHash.txid, clientBaseUrl, true)

  console.log(`Initialize ntt manager with mode: ${ctx.mode}`)
  const isLocking = ctx.mode === "locking"
  const initializeFunction = isLocking ? "initialize-locking-mode" : "initialize-burning-mode"
  const args = isLocking ? [Cl.principal(`${deployerAddress}.${sbtcTokenContractName}`)] : [
    Cl.stringAscii("TokenName"),
    Cl.stringAscii("TokenSymbol"),
    Cl.uint(8),
    Cl.none()
  ]

  const initializeTx = await makeContractCall({
    contractName: nttManagerContractName + nttContractNamesSuffix,
    contractAddress: deployerAddress,
    functionName: initializeFunction,
    functionArgs: args,
    senderKey: wallet,
    network: "devnet",
    client: { baseUrl: clientBaseUrl },
    postConditionMode: PostConditionMode.Allow,
  })

  const initializeTxHash = await broadcastTransaction({
    transaction: initializeTx,
    network: "devnet",
    client: { baseUrl: clientBaseUrl },
  })

  console.log(initializeTxHash)

  await StacksPlatform.waitForTx(initializeTxHash.txid, clientBaseUrl, true)
  
  console.log(`Transceiver init...`)
  const isInitialized = cvToValue(await fetchCallReadOnlyFunction({
    contractName: wormholeTransceiverContractName + nttContractNamesSuffix,
    contractAddress: deployerAddress,
    functionName: 'is-initialized',
    functionArgs: [],
    client: { baseUrl: clientBaseUrl },
    senderAddress: StacksZeroAddress
  }))

  if(!isInitialized) {
    console.log(`Initializing transceiver with ${nttManagerContractName + nttContractNamesSuffix}`)
    const transceiverInitTx = await makeContractCall({
      contractName: wormholeTransceiverContractName + nttContractNamesSuffix,
      contractAddress: deployerAddress,
      functionName: 'initialize',
      functionArgs: [
        Cl.principal(`${deployerAddress}.${nttManagerContractName + nttContractNamesSuffix}`),
        ctx.mode === "locking" ? Cl.principal(`${deployerAddress}.${sbtcTokenContractName}`) : Cl.principal(`${deployerAddress}.${bridgedTokenContractName}`),
        Cl.none()
      ],
      senderKey: wallet,
      network: 'devnet',
      postConditionMode: PostConditionMode.Allow,
    })

    const transceiverInitTxHash = await broadcastTransaction({
    transaction: transceiverInitTx,
    network: 'devnet',
    client: { baseUrl: clientBaseUrl },
    })

    console.log(transceiverInitTxHash)

    await StacksPlatform.waitForTx(transceiverInitTxHash.txid, clientBaseUrl, true)

    console.log(`✅ Transceiver init`)
  } else {
    console.log(`✅ Transceiver already initialized`)
  }

  console.log(`Setting transceiver...`)
  const addTransceiverTx = await makeContractCall({
    contractName: nttManagerContractName + nttContractNamesSuffix,
    contractAddress: deployerAddress,
    functionName: 'add-transceiver',
    functionArgs: [
      Cl.address(`${deployerAddress}.${wormholeTransceiverContractName}${nttContractNamesSuffix}`)
    ],
    senderKey: wallet,
    network: 'devnet',
    postConditionMode: PostConditionMode.Allow,
  })

  const addTransceiverTxHash = await broadcastTransaction({
    transaction: addTransceiverTx,
    client: { baseUrl: clientBaseUrl },
  })
  console.log(addTransceiverTxHash)

  await StacksPlatform.waitForTx(addTransceiverTxHash.txid, clientBaseUrl, true)

  console.log(`✅ Added transceiver`)
  console.log(`Setting up peer`)

  return {
    ...ctx,
    contracts: {
      transceiver: {
        wormhole: `${deployerAddress}.${wormholeTransceiverContractName}${nttContractNamesSuffix}`
      },
      manager: `${deployerAddress}.${nttStateContractName}${nttContractNamesSuffix}`,
      state: `${deployerAddress}.${nttStateContractName}${nttContractNamesSuffix}`,
      token: ctx.mode === "burning" ? `${deployerAddress}.${bridgedTokenContractName}${nttContractNamesSuffix}` : `${deployerAddress}.${sbtcTokenContractName}`,
      tokenOwner: `${deployerAddress}.${tokenManagerContractName}${nttContractNamesSuffix}`,
    }
  }
}

async function setupPeer(targetCtx: Ctx, peerCtx: Ctx) {
  const target = targetCtx.context;
  console.log(`[${target.chain}] Setting up peer for`, peerCtx.contracts)
  const peer = peerCtx.context;
  const {
    manager,
    transceiver: { wormhole: transceiver },
  } = peerCtx.contracts!;
  const managerAddress = peerCtx.context.chain === "Stacks" ? peerCtx.contracts!.state! : manager;
  const peerManager = Wormhole.chainAddress(peer.chain, managerAddress);
  const peerTransceiver = Wormhole.chainAddress(peer.chain, transceiver!);

  const tokenDecimals = getNativeTokenDecimals(targetCtx) // TODO FG TODO double check this is correct - it seems wrong for stacks, showing 18 decimals
  console.log(`[${targetCtx.context.chain}] Token decimals for ${peer.chain} is ${tokenDecimals}`)
  const inboundLimit = amount.units(amount.parse("1000", tokenDecimals));

  const { signer, address: sender } = targetCtx.signers;

  const nttManager = await getNtt(targetCtx);
  console.log(`[!!] Setting peer for manager in chain: ${target.chain} with value: ${peerManager.address.toString()} (exactly: ${universalAddress(peerManager)}) for chain: ${peer.chain}`)
  const setPeerTxs = nttManager.setPeer(
    peerManager,
    tokenDecimals,
    inboundLimit,
    sender.address
  );
  await signSendWait(target, setPeerTxs, signer);

  const setXcvrPeerTxs = nttManager.setTransceiverPeer(
    0, // 0 = Wormhole
    peerTransceiver,
    sender.address
  );
  console.log(`Setting transceiver peer for: ${target.chain} to ${peer.chain} ...`);
  const xcvrPeerTxids = await signSendWait(target, setXcvrPeerTxs, signer);
  console.log(`Set transceiver peer for: ${target.chain} to ${peer.chain} ${xcvrPeerTxids[0]!.txid}`);
  console.log(`Getting VAA for Ntt:TransceiverRegistration for ${target.chain} to ${peer.chain}`)
  const [whm] = await target.parseTransaction(xcvrPeerTxids[0]!.txid);
  console.log(`Got VAA for Ntt:TransceiverRegistration for ${target.chain} to ${peer.chain}`, whm)
  console.log("Set peers for: ", target.chain, peer.chain);

  if (
    chainToPlatform(target.chain) === "Evm" &&
    chainToPlatform(peer.chain) === "Evm"
  ) {
    const nativeSigner = (signer as NativeSigner).unwrap();
    const xcvr = WormholeTransceiver__factory.connect(
      targetCtx.contracts!.transceiver["wormhole"]!,
      nativeSigner.signer
    );
    const peerChainId = toChainId(peer.chain);

    console.log("Setting isEvmChain for: ", peer.chain);
    await tryAndWaitThrice(() =>
      xcvr.setIsWormholeEvmChain.send(peerChainId, true)
    );

    console.log("Setting wormhole relaying for: ", peer.chain);
    await tryAndWaitThrice(() =>
      xcvr.setIsWormholeRelayingEnabled.send(peerChainId, true)
    );
  }
  console.log(`Getting VAA for Ntt:TransceiverRegistration for ${target.chain} to ${peer.chain}`, whm, xcvrPeerTxids[0]!.txid)
  const vaa = await wh.getVaa(whm!, "Ntt:TransceiverRegistration");
  console.log(`Got VAA for Ntt:TransceiverRegistration for ${target.chain} to ${peer.chain}`, vaa)
  return vaa;
}

async function receive(msgId: WormholeMessageId, destination: Ctx) {
  console.log(`Receive`, msgId)
  const { signer, address: sender } = destination.signers;
  console.log(
    `Fetching VAA ${toChainId(msgId.chain)}/${encoding.hex.encode(
      msgId.emitter.toUint8Array(),
      false
    )}/${msgId.sequence}`
  );
  const _vaa = await wh.getVaa(msgId, "Ntt:WormholeTransfer");

  console.log("Calling redeem on: ", destination.context.chain);
  console.log(`VAA`, Buffer.from(serialize(_vaa!)).toString('hex'))
  const ntt = await getNtt(destination);
  const redeemTxs = ntt.redeem([_vaa!], sender.address);
  const txIds = await signSendWait(destination.context, redeemTxs, signer);
  console.log(`[Txids] Redeem on ${destination.context.chain}`, txIds)
  if(destination.context.chain === "Stacks") {
    await StacksPlatform.waitForTx(txIds[0]!.txid, (await destination.context.getRpc()).client.baseUrl, true)
  }
  return txIds;
}

async function getManagerAndUserBalance(ctx: Ctx): Promise<[bigint, bigint]> {
  const chain = ctx.context;
  const contracts = ctx.contracts!;
  const tokenAddress = Wormhole.parseAddress(chain.chain, contracts.token);

  const ntt = await getNtt(ctx);
  const managerAddress = await ntt.getCustodyAddress();

  const { address } = ctx.signers;
  const accountAddress = address.address.toString();

  const [mbal, abal] = await Promise.all([
    chain.getBalance(managerAddress, tokenAddress),
    chain.getBalance(accountAddress, tokenAddress),
  ]);

  console.log(`[%%] Get balance of chain: ${chain.chain}, manager: ${managerAddress}, account: ${accountAddress}, token: ${tokenAddress}`, mbal, abal)
  return [mbal ?? 0n, abal ?? 0n];
}

function checkBalances(
  mode: Ntt.Mode,
  managerBalances: [bigint, bigint],
  userBalances: [bigint, bigint],
  check: bigint
) {
  console.log(mode, managerBalances, userBalances, check);

  const [managerBefore, managerAfter] = managerBalances;
  if (
    mode === "burning"
      ? !(managerAfter === 0n)
      : !(managerAfter == managerBefore + check)
  ) {
    throw new Error(
      `Source manager amount incorrect: before ${managerBefore.toString()}, after ${managerAfter.toString()} , check: ${check.toString()}`
    );
  }

  const [userBefore, userAfter] = userBalances;
  if (!(userAfter == userBefore - check)) {
    throw new Error(
      `Source user amount incorrect: before ${userBefore.toString()}, after ${userAfter.toString()}`
    );
  }
}

async function tryAndWaitThrice(
  txGen: () => Promise<ethers.ContractTransactionResponse>
): Promise<ethers.ContractTransactionReceipt | null> {
  // these tests have some issue with getting a nonce mismatch despite everything being awaited
  let attempts = 0;
  while (attempts < 3) {
    try {
      return await (await txGen()).wait();
    } catch (e) {
      console.error(e);
      attempts++;
      if (attempts < 3) {
        console.log(`retry ${attempts}...`);
      } else {
        throw e;
      }
    }
  }
  return null;
}

function getNativeTokenDecimals(context: Ctx) {
  if(context.context.chain === "Stacks") {
    return 8
  }
  return context.context.config.nativeTokenDecimals
}

export async function setMessageFee(chains: Chain[], fee: bigint) {
  console.log(`Setting message fee for ${chains} to ${fee}`)
  for (const chain of chains) {
    const chainCtx = wh.getChain(chain)
    const core = await chainCtx.getWormholeCore()
    const coreAddress = chainCtx.config.contracts.coreBridge
    const existingFee = await core.getMessageFee()
    console.log(`Existing core bridge fee for ${chain}: ${existingFee}`)
    const rpc = await chainCtx.getRpc()
    await rpc.send("anvil_setStorageAt", [
      coreAddress,
      7, // messageFee storage slot
      ethers.zeroPadValue(ethers.toBeHex(fee), 32)
    ]);
  
    const newFee = await core.getMessageFee()
    console.log(`New core bridge fee for ${chain}: ${newFee}`)
  }
}

export async function testPausing(
  chain: Chain,
  getNativeSigner: (ctx: Partial<Ctx>) => any,
) {
  const hub = await deploy({ context: wh.getChain(chain), mode: "locking" }, getNativeSigner)
  const signers = await getSigners(hub, getNativeSigner)

  const ntt = await getNtt(hub)

  const isPausedBefore = await ntt.isPaused()
  const pauseTx = ntt.pause()
  const txsPause = await signSendWait(hub.context, pauseTx, signers.signer)
  await StacksPlatform.waitForTx(txsPause[0]?.txid, (await hub.context.getRpc()).client.baseUrl, true)

  const isPausedAfter = await ntt.isPaused()

  const unpauseTx = ntt.unpause()
  const txsUnpause = await signSendWait(hub.context, unpauseTx, signers.signer)
  await StacksPlatform.waitForTx(txsUnpause[0]?.txid, (await hub.context.getRpc()).client.baseUrl, true)

  const isPausedAfterUnpause = await ntt.isPaused()

  const pauser = await ntt.getPauser()

  expect(isPausedBefore).toBe(false)
  expect(isPausedAfter).toBe(true)
  expect(isPausedAfterUnpause).toBe(false)
  expect(pauser).toBe(signers.signer.address())
}

export async function testTempStacksHub(
  source: Chain,
  destinationA: Chain,
  destinationB: Chain,
  getNativeSigner: (ctx: Partial<Ctx>) => any,
  accountantPrivateKey: string
) {
  const [hub] = await Promise.all([
    deploy({ context: wh.getChain(source), mode: "locking" }, getNativeSigner),
  ])

  const core = await hub.context.getWormholeCore()
  const signers = await getSigners(hub, getNativeSigner)

  console.log(`Setting NTTManager peer`)
  const ntt = await getNtt(hub)
  const setPeerTx = ntt.setPeer(
    {
      chain: 'Ethereum',
      address: new UniversalAddress('0x0000000000000000000000000000000000000002')
    },
    18,
    0n
  )
  
  const txHashes = await signAndSendWait(setPeerTx, signers.signer as any)
  await StacksPlatform.waitForTx(txHashes[0]?.txid, (await hub.context.getRpc()).client.baseUrl, true)
  console.log(`Peer set`)

  console.log(`Minting to: ${signers.signer.address()}`)
  // minting sbtc
  const mintSbtcTx = await makeContractCall({
    contractName: "sbtc-token",
    contractAddress: signers.signer.address(),
    functionName: "protocol-mint",
    functionArgs: [
      Cl.uint(69n),
      Cl.principal(signers.signer.address()),
      Cl.buffer(new Uint8Array([1]))
    ],
    senderKey: signers.nativeSigner as any,
    network: "devnet"
  })

  const tx = await broadcastTransaction({
    transaction: mintSbtcTx,
    client: {
      baseUrl: (await hub.context.getRpc()).client.baseUrl,
    }
  })

  console.log(tx)
  await StacksPlatform.waitForTx(tx.txid, (await hub.context.getRpc()).client.baseUrl, true)

  const transferTxs = ntt.transfer(
    toNative(hub.context.chain, signers.signer.address()),
    69n,
    {
      chain: 'Ethereum',
      address: new UniversalAddress('0x0000000000000000000000000000000000000006')
    },
    {
      queue: false
    }
  )
  const transferTxHashes = await signAndSendWait(transferTxs, signers.signer as any)
  const txId = transferTxHashes[0]?.txid
  await StacksPlatform.waitForTx(txId!, (await hub.context.getRpc()).client.baseUrl, true)

  const parsedTransaction: StacksWormholeMessageId[] = await core.parseTransaction(txId!) as StacksWormholeMessageId[]
  console.log(`Transferred!`)

  const payload = parsedTransaction[0]?.payload
  console.log(payload)
  const deserializedPayload = deserializePayload("Ntt:WormholeTransfer", payload!)
  console.log(deserializedPayload)
}

export async function testHub(
  source: Chain,
  destinationA: Chain,
  destinationB: Chain,
  getNativeSigner: (ctx: Partial<Ctx>) => any,
  accountantPrivateKey: string
) {
  // Get chain context objects
  const hubChain = wh.getChain(source);

  const spokeChainA = wh.getChain(destinationA);
  const spokeChainB = wh.getChain(destinationB);

  console.log(`Spoke A: ${spokeChainA.chain} - ${await (await (spokeChainA.getRpc() as any).getNetwork()).chainId}`)
  console.log(`Spoke B: ${spokeChainB.chain} - ${await (await (spokeChainB.getRpc() as any).getNetwork()).chainId}`)

  // Deploy contracts for hub chain
  console.log("Deploying contracts");
  const [hub, spokeA, spokeB] = await Promise.all([
    deploy({ context: hubChain, mode: "locking" }, getNativeSigner),
    deploy({ context: spokeChainA, mode: "burning" }, getNativeSigner),
    deploy({ context: spokeChainB, mode: "burning" }, getNativeSigner),
  ]);

  console.log("Deployed: ", {
    [hub.context.chain]: hub.contracts,
    [spokeA.context.chain]: spokeA.contracts,
    [spokeB.context.chain]: spokeB.contracts,
  });

  // Link contracts
  console.log("Linking Peers");
  await link([hub, spokeA, spokeB], accountantPrivateKey);

  // Transfer tokens from hub to spoke and check balances
  console.log("Transfer hub to spoke A");
  await transferWithChecks(hub, spokeA);

  // Transfer between spokes and check balances
  console.log("Transfer spoke A to spoke B");
  await transferWithChecks(spokeA, spokeB);

  // Transfer back to hub and check balances
  console.log("Transfer spoke B to hub");
  await transferWithChecks(spokeB, hub);
}
