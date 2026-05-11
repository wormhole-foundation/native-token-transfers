import * as anchor from "@coral-xyz/anchor";
import * as spl from "@solana/spl-token";
import {
  AccountAddress,
  ChainAddress,
  ChainContext,
  Signer,
  UniversalAddress,
  Wormhole,
  contracts,
  deserialize,
  encoding,
  serialize,
  serializePayload,
} from "@wormhole-foundation/sdk";
import {
  Ntt,
  register as registerDefinitionsNtt,
} from "@wormhole-foundation/sdk-definitions-ntt";
import * as testing from "@wormhole-foundation/sdk-definitions/testing";
import {
  SolanaAddress,
  SolanaPlatform,
  getSolanaSignAndSendSigner,
} from "@wormhole-foundation/sdk-solana";
import { IdlVersion, getTransceiverProgram } from "../../ts/index.js";
import {
  SolanaNtt,
  register as registerSolanaNtt,
} from "../../ts/sdk/index.js";
import { NTT } from "../../ts/index.js";
import { TestHelper, TestMint, assert, signSendWait } from "./utils/helpers.js";

registerDefinitionsNtt();
registerSolanaNtt();

const SOLANA_ROOT_DIR = `${__dirname}/../../`;
const VERSION: IdlVersion = "4.0.0";
const TOKEN_PROGRAM = spl.TOKEN_2022_PROGRAM_ID;
const GUARDIAN_KEY =
  "cfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0";
const CORE_BRIDGE_ADDRESS = contracts.coreBridge("Mainnet", "Solana");
const NTT_ADDRESS: anchor.web3.PublicKey =
  anchor.workspace.ExampleNativeTokenTransfers.programId;
const WH_TRANSCEIVER_ADDRESS: anchor.web3.PublicKey =
  anchor.workspace.NttTransceiver.programId;
const SOLANA_WORMHOLE_SHIMS: Ntt.Contracts["svmShims"] = {};

const $ = new TestHelper("confirmed", TOKEN_PROGRAM);

const payer = $.keypair.read(`${SOLANA_ROOT_DIR}/keys/test.json`);
const payerAddress = new SolanaAddress(payer.publicKey);

const w = new Wormhole("Devnet", [SolanaPlatform], {
  chains: { Solana: { contracts: { coreBridge: CORE_BRIDGE_ADDRESS } } },
});
const ctx: ChainContext<"Devnet", "Solana"> = w
  .getPlatform("Solana")
  .getChain("Solana", $.connection);

const remoteMgr: ChainAddress = $.chainAddress.generateFromValue(
  "Ethereum",
  "nttManager"
);
const remoteXcvr: ChainAddress = $.chainAddress.generateFromValue(
  "Ethereum",
  "transceiver"
);

/**
 * Helper: build a fresh `SolanaNtt` for a given (mint, instance) pair under
 * the shared program. Mirrors the v4 multi-host setup pattern.
 */
function makeNtt(
  mintAddr: anchor.web3.PublicKey,
  instancePubkey: anchor.web3.PublicKey
): SolanaNtt<"Devnet", "Solana"> {
  return new SolanaNtt(
    "Devnet",
    "Solana",
    $.connection,
    {
      ...ctx.config.contracts,
      ntt: {
        token: mintAddr.toBase58(),
        manager: NTT_ADDRESS.toBase58(),
        instance: instancePubkey.toBase58(),
        transceiver: {
          wormhole: WH_TRANSCEIVER_ADDRESS.toBase58(),
        },
        svmShims: SOLANA_WORMHOLE_SHIMS,
      },
    },
    VERSION
  );
}

async function registerRemoteWormholePath(
  ntt: SolanaNtt<"Devnet", "Solana">,
  owner: AccountAddress<"Solana">,
  signer: Signer
) {
  await signSendWait(
    ctx,
    ntt.registerWormholeTransceiver({
      payer: owner,
      owner,
    }),
    signer
  );
  await signSendWait(
    ctx,
    ntt.setWormholeTransceiverPeer(remoteXcvr, owner),
    signer
  );
  await signSendWait(
    ctx,
    ntt.setPeer(remoteMgr, 18, 1_000_000n, owner),
    signer
  );
}

/**
 * Multi-instance v4 isolation tests. Two independent NTT deployments coexist
 * under the same Solana program ID, distinguished only by their `instance`
 * keypair. Each has its own owner, mint, custody, peers, and rate limits.
 */
describe("multi-instance", () => {
  let signer: Signer;
  let sender: AccountAddress<"Solana">;

  // Instance A
  const mintAuthorityA = $.keypair.generate();
  const instanceA = $.keypair.generate();
  let testMintA: TestMint;
  let nttA: SolanaNtt<"Devnet", "Solana">;
  let multisigTokenAuthorityA: anchor.web3.PublicKey;

  // Instance B
  const mintAuthorityB = $.keypair.generate();
  const instanceB = $.keypair.generate();
  let testMintB: TestMint;
  let nttB: SolanaNtt<"Devnet", "Solana">;
  let multisigTokenAuthorityB: anchor.web3.PublicKey;

  beforeAll(async () => {
    signer = await getSolanaSignAndSendSigner($.connection, payer);
    sender = Wormhole.parseAddress("Solana", signer.address());

    // Stand up two independent v4 instances under the same program.
    testMintA = await TestMint.create(
      $.connection,
      payer,
      mintAuthorityA,
      9,
      TOKEN_PROGRAM,
      spl.ASSOCIATED_TOKEN_PROGRAM_ID
    );
    testMintB = await TestMint.create(
      $.connection,
      payer,
      mintAuthorityB,
      9,
      TOKEN_PROGRAM,
      spl.ASSOCIATED_TOKEN_PROGRAM_ID
    );

    nttA = makeNtt(testMintA.address, instanceA.publicKey);
    nttB = makeNtt(testMintB.address, instanceB.publicKey);

    multisigTokenAuthorityA = await $.multisig.create(payer, 1, [
      mintAuthorityA.publicKey,
      nttA.pdas.tokenAuthority(),
    ]);
    await testMintA.setMintAuthority(
      payer,
      multisigTokenAuthorityA,
      mintAuthorityA
    );

    multisigTokenAuthorityB = await $.multisig.create(payer, 1, [
      mintAuthorityB.publicKey,
      nttB.pdas.tokenAuthority(),
    ]);
    await testMintB.setMintAuthority(
      payer,
      multisigTokenAuthorityB,
      mintAuthorityB
    );

    await signSendWait(
      ctx,
      nttA.initialize(sender, {
        mint: testMintA.address,
        outboundLimit: 1_000_000n,
        mode: "burning",
        multisigTokenAuthority: multisigTokenAuthorityA,
        instance: instanceA,
      }),
      signer
    );

    await signSendWait(
      ctx,
      nttB.initialize(sender, {
        mint: testMintB.address,
        outboundLimit: 1_000_000n,
        mode: "burning",
        multisigTokenAuthority: multisigTokenAuthorityB,
        instance: instanceB,
      }),
      signer
    );
  });

  it("derives distinct PDAs for each instance", () => {
    const sampleTransfer = NTT.transferArgs(123n, remoteMgr, false);

    // Sanity-check the seed-scoping: every per-instance PDA differs between A and B.
    expect(nttA.pdas.configAccount().toBase58()).not.toEqual(
      nttB.pdas.configAccount().toBase58()
    );
    expect(nttA.pdas.tokenAuthority().toBase58()).not.toEqual(
      nttB.pdas.tokenAuthority().toBase58()
    );
    expect(nttA.pdas.outboxRateLimitAccount().toBase58()).not.toEqual(
      nttB.pdas.outboxRateLimitAccount().toBase58()
    );
    expect(nttA.pdas.lutAccount().toBase58()).not.toEqual(
      nttB.pdas.lutAccount().toBase58()
    );
    expect(
      nttA.pdas.sessionAuthority(payer.publicKey, sampleTransfer).toBase58()
    ).not.toEqual(
      nttB.pdas.sessionAuthority(payer.publicKey, sampleTransfer).toBase58()
    );

    // configAccount() in v4 just returns the instance pubkey.
    expect(nttA.pdas.configAccount().toBase58()).toEqual(
      instanceA.publicKey.toBase58()
    );
    expect(nttB.pdas.configAccount().toBase58()).toEqual(
      instanceB.publicKey.toBase58()
    );
  });

  it("isolates owner state per instance (A pause does not pause B)", async () => {
    await signSendWait(ctx, nttA.pause(payerAddress), signer);
    expect(await nttA.isPaused()).toBe(true);
    expect(await nttB.isPaused()).toBe(false);
    await signSendWait(ctx, nttA.unpause(payerAddress), signer);
    expect(await nttA.isPaused()).toBe(false);
  });

  it("rejects cross-instance VAA replay (recipient_ntt_manager check)", async () => {
    // Register peers for both instances so the redeem path can validate them.
    await registerRemoteWormholePath(nttA, payerAddress, signer);
    await registerRemoteWormholePath(nttB, payerAddress, signer);

    // Build a VAA targeting instance A's pubkey as the recipient manager.
    const emitter = new testing.mocks.MockEmitter(
      remoteXcvr.address as UniversalAddress,
      "Ethereum",
      0n
    );
    const guardians = new testing.mocks.MockGuardians(0, [GUARDIAN_KEY]);

    const sendingMessage = {
      sourceNttManager: remoteMgr.address as UniversalAddress,
      recipientNttManager: new UniversalAddress(instanceA.publicKey.toBytes()),
      nttManagerPayload: {
        id: encoding.bytes.encode("xinst-replay-1".padEnd(32, "0")),
        sender: new UniversalAddress("FACE".padStart(64, "0")),
        payload: {
          trimmedAmount: { amount: 10_000n, decimals: 8 },
          sourceToken: new UniversalAddress("FAFA".padStart(64, "0")),
          recipientAddress: new UniversalAddress(payer.publicKey.toBytes()),
          recipientChain: "Solana",
          additionalPayload: new Uint8Array(),
        },
      },
      transceiverPayload: new Uint8Array(),
    } as const;

    const serialized = serializePayload("Ntt:WormholeTransfer", sendingMessage);
    const published = emitter.publishMessage(0, serialized, 200);
    const rawVaa = guardians.addSignatures(published, [0]);
    const vaa = deserialize("Ntt:WormholeTransfer", serialize(rawVaa));

    // Redeeming against instance B must fail — its
    // `recipient_ntt_manager == config.key()` constraint compares against
    // `instanceB.publicKey`, which doesn't match the VAA's `instanceA`.
    let redeemErr: any = undefined;
    try {
      await signSendWait(ctx, nttB.redeem([vaa], sender), signer);
    } catch (e: any) {
      redeemErr = e;
    }
    expect(redeemErr).toBeDefined();
  });

  it("rejects cross-instance approval reuse for the same mint", async () => {
    const sharedMintAuthority = $.keypair.generate();
    const sharedInstanceA = $.keypair.generate();
    const sharedInstanceB = $.keypair.generate();
    const sharedMint = await TestMint.create(
      $.connection,
      payer,
      sharedMintAuthority,
      9,
      TOKEN_PROGRAM,
      spl.ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const sharedNttA = makeNtt(sharedMint.address, sharedInstanceA.publicKey);
    const sharedNttB = makeNtt(sharedMint.address, sharedInstanceB.publicKey);

    const holderTokenAccount = await sharedMint.mint(
      payer,
      payer.publicKey,
      10_000n,
      sharedMintAuthority
    );

    const sharedMultisigTokenAuthority = await $.multisig.create(payer, 1, [
      sharedMintAuthority.publicKey,
      sharedNttA.pdas.tokenAuthority(),
      sharedNttB.pdas.tokenAuthority(),
    ]);
    await sharedMint.setMintAuthority(
      payer,
      sharedMultisigTokenAuthority,
      sharedMintAuthority
    );

    await signSendWait(
      ctx,
      sharedNttA.initialize(sender, {
        mint: sharedMint.address,
        outboundLimit: 1_000_000n,
        mode: "burning",
        multisigTokenAuthority: sharedMultisigTokenAuthority,
        instance: sharedInstanceA,
      }),
      signer
    );
    await signSendWait(
      ctx,
      sharedNttB.initialize(sender, {
        mint: sharedMint.address,
        outboundLimit: 1_000_000n,
        mode: "burning",
        multisigTokenAuthority: sharedMultisigTokenAuthority,
        instance: sharedInstanceB,
      }),
      signer
    );
    await registerRemoteWormholePath(sharedNttB, payerAddress, signer);

    const transferArgs = NTT.transferArgs(1_000n, remoteMgr, false);
    await $.sendAndConfirm(
      spl.createApproveInstruction(
        holderTokenAccount,
        sharedNttA.pdas.sessionAuthority(payer.publicKey, transferArgs),
        payer.publicKey,
        1_000n,
        [],
        TOKEN_PROGRAM
      ),
      payer
    );

    const outboxItem = $.keypair.generate();
    const xfer = NTT.createTransferBurnInstruction(
      sharedNttB.program,
      await sharedNttB.getConfig(),
      {
        payer: payer.publicKey,
        from: holderTokenAccount,
        fromAuthority: payer.publicKey,
        transferArgs,
        outboxItem: outboxItem.publicKey,
      },
      sharedNttB.pdas
    );

    await assert
      .promise($.sendAndConfirm(await xfer, payer, outboxItem))
      .fails();
  });

  it("uses instance-scoped inbox lookups in v4 helpers", async () => {
    const inboundMintAuthority = $.keypair.generate();
    const inboundInstance = $.keypair.generate();
    const inboundMint = await TestMint.create(
      $.connection,
      payer,
      inboundMintAuthority,
      9,
      TOKEN_PROGRAM,
      spl.ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const inboundNtt = makeNtt(inboundMint.address, inboundInstance.publicKey);
    const inboundMultisigTokenAuthority = await $.multisig.create(payer, 1, [
      inboundMintAuthority.publicKey,
      inboundNtt.pdas.tokenAuthority(),
    ]);
    await inboundMint.setMintAuthority(
      payer,
      inboundMultisigTokenAuthority,
      inboundMintAuthority
    );

    await signSendWait(
      ctx,
      inboundNtt.initialize(sender, {
        mint: inboundMint.address,
        outboundLimit: 1_000_000n,
        mode: "burning",
        multisigTokenAuthority: inboundMultisigTokenAuthority,
        instance: inboundInstance,
      }),
      signer
    );
    await registerRemoteWormholePath(inboundNtt, payerAddress, signer);

    const emitter = new testing.mocks.MockEmitter(
      remoteXcvr.address as UniversalAddress,
      "Ethereum",
      0n
    );
    const guardians = new testing.mocks.MockGuardians(0, [GUARDIAN_KEY]);
    const inboundMessage = {
      sourceNttManager: remoteMgr.address as UniversalAddress,
      recipientNttManager: new UniversalAddress(
        inboundInstance.publicKey.toBytes()
      ),
      nttManagerPayload: {
        id: encoding.bytes.encode("scoped-inbox-lookup".padEnd(32, "0")),
        sender: new UniversalAddress("BEEF".padStart(64, "0")),
        payload: {
          trimmedAmount: { amount: 25_000n, decimals: 8 },
          sourceToken: new UniversalAddress("ABCD".padStart(64, "0")),
          recipientAddress: new UniversalAddress(payer.publicKey.toBytes()),
          recipientChain: "Solana",
          additionalPayload: new Uint8Array(),
        },
      },
      transceiverPayload: new Uint8Array(),
    } as const;

    const published = emitter.publishMessage(
      0,
      serializePayload("Ntt:WormholeTransfer", inboundMessage),
      200
    );
    const rawVaa = guardians.addSignatures(published, [0]);
    const vaa = deserialize("Ntt:WormholeTransfer", serialize(rawVaa));

    await signSendWait(ctx, inboundNtt.redeem([vaa], sender), signer);

    const inboxItem = await NTT.getInboxItem(
      inboundNtt.program,
      "Ethereum",
      vaa.payload.nttManagerPayload,
      inboundNtt.pdas
    );
    expect(inboxItem.recipientAddress.toBase58()).toEqual(
      payer.publicKey.toBase58()
    );

    const releaseIx = await NTT.createReleaseInboundMintInstruction(
      inboundNtt.program,
      await inboundNtt.getConfig(),
      {
        payer: payer.publicKey,
        chain: "Ethereum",
        nttMessage: vaa.payload.nttManagerPayload,
        revertWhenNotReady: false,
      },
      inboundNtt.pdas
    );
    expect(releaseIx).toBeDefined();
  });
});
