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
  deserializePayload,
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
import {
  SolanaWormholeCore,
  utils,
} from "@wormhole-foundation/sdk-solana-core";
import { IdlVersion, NTT, getTransceiverProgram } from "../../ts/index.js";
import {
  SolanaNtt,
  register as registerSolanaNtt,
} from "../../ts/sdk/index.js";
import {
  TestDummyTransferHook,
  TestHelper,
  TestMint,
  TestWormholePostMessageShim,
  assert,
  signSendWait,
} from "./utils/helpers.js";
import { fileURLToPath } from "url";

// v5 NTT SDKs require explicit register() calls; auto-registration on import was removed.
registerDefinitionsNtt();
registerSolanaNtt();

/**
 * Test Config Constants
 *
 * v4 multi-host: the deployed program ID is shared, and each NTT deployment
 * is identified by an `instance` keypair-created account. The instance pubkey
 * is the on-the-wire NTT manager identity (replaces program ID in v3).
 */
// Native ESM (jest useESM) has no __dirname; derive it from import.meta.url.
const __dirname = fileURLToPath(new URL(".", import.meta.url));
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

/**
 * Test Helpers
 */
const $ = new TestHelper("confirmed", TOKEN_PROGRAM);
const testDummyTransferHook = new TestDummyTransferHook(
  anchor.workspace.DummyTransferHook,
  TOKEN_PROGRAM,
  spl.ASSOCIATED_TOKEN_PROGRAM_ID
);
const testWormholePostMessageShim = new TestWormholePostMessageShim(
  $.connection
);
let testMint: TestMint;

/**
 * Wallet Config
 */
const payer = $.keypair.read(`${SOLANA_ROOT_DIR}/keys/test.json`);
const payerAddress = new SolanaAddress(payer.publicKey);

/**
 * Mint Config
 */
const mint = $.keypair.generate();
const mintAuthority = $.keypair.generate();

/**
 * v4 Instance keypair. The pubkey is the on-the-wire NTT manager identity for
 * this deployment, and the seed scope for every per-instance PDA.
 */
const instanceKeypair = $.keypair.generate();

/**
 * Contract Config
 */
const w = new Wormhole("Devnet", [SolanaPlatform], {
  chains: { Solana: { contracts: { coreBridge: CORE_BRIDGE_ADDRESS } } },
});
const ctx: ChainContext<"Devnet", "Solana"> = w
  .getPlatform("Solana")
  .getChain("Solana", $.connection); // make sure we're using the exact same Connection object for rpc
const coreBridge = new SolanaWormholeCore("Devnet", "Solana", $.connection, {
  coreBridge: CORE_BRIDGE_ADDRESS,
});
const remoteMgr: ChainAddress = $.chainAddress.generateFromValue(
  "Ethereum",
  "nttManager"
);
const remoteXcvr: ChainAddress = $.chainAddress.generateFromValue(
  "Ethereum",
  "transceiver"
);
const nttTransceivers = {
  wormhole: getTransceiverProgram(
    $.connection,
    WH_TRANSCEIVER_ADDRESS.toBase58(),
    VERSION,
    !SOLANA_WORMHOLE_SHIMS
  ),
};

describe("example-native-token-transfers", () => {
  let ntt: SolanaNtt<"Devnet", "Solana">;
  let signer: Signer;
  let sender: AccountAddress<"Solana">;
  let tokenAccount: anchor.web3.PublicKey;

  beforeAll(async () => {
    signer = await getSolanaSignAndSendSigner($.connection, payer, {
      //debug: true,
    });
    sender = Wormhole.parseAddress("Solana", signer.address());

    testMint = await TestMint.createWithTokenExtensions(
      $.connection,
      payer,
      mint,
      mintAuthority,
      9,
      TOKEN_PROGRAM,
      spl.ASSOCIATED_TOKEN_PROGRAM_ID,
      {
        extensions: [spl.ExtensionType.TransferHook],
        preMintInitIxs: [
          spl.createInitializeTransferHookInstruction(
            mint.publicKey,
            mintAuthority.publicKey,
            testDummyTransferHook.program.programId,
            TOKEN_PROGRAM
          ),
        ],
      }
    );

    tokenAccount = await testMint.mint(
      payer,
      payer.publicKey,
      10_000_000n,
      mintAuthority
    );

    // create our contract client. v4: pass the instance pubkey in contracts.ntt;
    // it's the per-deployment scope used to derive all PDAs and serves as the
    // on-the-wire manager identity.
    ntt = new SolanaNtt(
      "Devnet",
      "Solana",
      $.connection,
      {
        ...ctx.config.contracts,
        ntt: {
          token: testMint.address.toBase58(),
          manager: NTT_ADDRESS.toBase58(),
          instance: instanceKeypair.publicKey.toBase58(),
          transceiver: {
            wormhole: nttTransceivers["wormhole"].programId.toBase58(),
          },
          svmShims: SOLANA_WORMHOLE_SHIMS,
        },
      },
      VERSION
    );
  });

  describe("Burning", () => {
    let multisigTokenAuthority: anchor.web3.PublicKey;

    beforeAll(async () => {
      // set multisigTokenAuthority as mint authority. The token authority is
      // per-instance in v4 — `ntt.pdas.tokenAuthority()` returns the
      // instance-scoped PDA because the SDK was constructed with `instance`.
      multisigTokenAuthority = await $.multisig.create(payer, 1, [
        mintAuthority.publicKey,
        ntt.pdas.tokenAuthority(),
      ]);
      await testMint.setMintAuthority(
        payer,
        multisigTokenAuthority,
        mintAuthority
      );

      // init. v4 takes the instance keypair as an additional signer; the
      // Anchor `init` allocates the Instance account at that pubkey.
      const initTxs = ntt.initialize(sender, {
        mint: testMint.address,
        outboundLimit: 1_000_000n,
        mode: "burning",
        multisigTokenAuthority,
        instance: instanceKeypair,
      });
      await signSendWait(ctx, initTxs, signer);

      // register Wormhole xcvr
      const registerTxs = ntt.registerWormholeTransceiver({
        payer: payerAddress,
        owner: payerAddress,
      });
      await signSendWait(ctx, registerTxs, signer);

      // set Wormhole xcvr peer
      const setXcvrPeerTxs = ntt.setWormholeTransceiverPeer(remoteXcvr, sender);
      await signSendWait(ctx, setXcvrPeerTxs, signer);

      // set manager peer
      const setPeerTxs = ntt.setPeer(remoteMgr, 18, 1_000_000n, sender);
      await signSendWait(ctx, setPeerTxs, signer);
    });

    it("Create ExtraAccountMetaList Account", async () => {
      await testDummyTransferHook.extraAccountMetaList.initialize(
        $.connection,
        payer,
        testMint.address
      );
    });

    it("Can send tokens", async () => {
      const amount = 100_000n;
      const receiver = testing.utils.makeUniversalChainAddress("Ethereum");

      const wormholeXcvr = await ntt.getWormholeTransceiver();
      expect(wormholeXcvr).toBeTruthy();
      const sequenceTracker = await utils.getSequenceTracker(
        $.connection,
        wormholeXcvr!.pdas.emitterAccount(),
        coreBridge.address
      );
      const expectedSequence = sequenceTracker.sequence;

      // TODO: keep or remove the `outboxItem` param?
      // added as a way to keep tests the same but it technically breaks the Ntt interface
      const outboxItem = $.keypair.generate();
      const wrapNative = false;
      const xferTxs = ntt.transfer(
        sender,
        amount,
        receiver,
        { queue: false, automatic: false, wrapNative },
        outboxItem
      );
      const txIds = await signSendWait(ctx, xferTxs, signer);
      expect(txIds).toBeTruthy();
      expect(txIds!.length).toEqual(1 + Number(wrapNative));
      const txId = txIds![Number(wrapNative)]!;

      // assert that released bitmap has transceiver bits set
      const outboxItemInfo = await ntt.program.account.outboxItem!.fetch(
        outboxItem.publicKey
      );
      assert
        .bn(outboxItemInfo.released.map)
        .setBits(Object.keys(nttTransceivers).length);

      // v4: outbox item is bound to its source instance
      expect(outboxItemInfo.manager.toBase58()).toEqual(
        instanceKeypair.publicKey.toBase58()
      );

      // parse event and instruction data to re-build message
      const [data] = await testWormholePostMessageShim.getMessageData(txId);

      // assert that the event is correctly emitted
      expect(data!.emitter).toMatchObject(wormholeXcvr!.pdas.emitterAccount());
      assert.bn(data!.sequence).equal(expectedSequence);
      expect(data!.submissionTime).toEqual(await $.currentTime());

      // assert instruction data is correct
      expect(data!.nonce).toBe(0); // hardcoded in `post_message`
      expect(JSON.stringify(data!.consistencyLevel)).toEqual(
        JSON.stringify({ finalized: {} }) // hardcoded in `post_message`
      );

      const transceiverMessage = deserializePayload(
        "Ntt:WormholeTransfer",
        data!.payload
      );

      // v4: source manager identity over the wire is the instance pubkey,
      // not the program ID.
      expect(transceiverMessage.sourceNttManager.toUint8Array()).toEqual(
        instanceKeypair.publicKey.toBytes()
      );

      // assert that amount is what we expect
      expect(
        transceiverMessage.nttManagerPayload.payload.trimmedAmount
      ).toMatchObject({ amount: 10_000n, decimals: 8 });

      // get from balance
      await assert.tokenBalance($.connection, tokenAccount).equal(9_900_000);
    });

    describe("Can transfer mint authority to-and-from NTT manager", () => {
      const newAuthority = $.keypair.generate();
      let newMultisigAuthority: anchor.web3.PublicKey;
      const nttOwner = payer.publicKey;

      beforeAll(async () => {
        newMultisigAuthority = await $.multisig.create(payer, 2, [
          mintAuthority.publicKey,
          newAuthority.publicKey,
        ]);
      });

      it("Fails when contract is not paused", async () => {
        await assert
          .promise(
            $.sendAndConfirm(
              await NTT.createSetTokenAuthorityOneStepUncheckedInstruction(
                ntt.program,
                await ntt.getConfig(),
                {
                  owner: nttOwner,
                  newAuthority: newAuthority.publicKey,
                  multisigTokenAuthority,
                },
                ntt.pdas
              ),
              payer
            )
          )
          .failsWithAnchorError(anchor.web3.SendTransactionError, {
            code: "NotPaused",
            number: 6024,
          });

        await assert.testMintAuthority(testMint).equal(multisigTokenAuthority);
      });

      test("Multisig(owner, TA) -> newAuthority", async () => {
        // retry after pausing contract
        const pauseTxs = ntt.pause(payerAddress);
        await signSendWait(ctx, pauseTxs, signer);

        await $.sendAndConfirm(
          await NTT.createSetTokenAuthorityOneStepUncheckedInstruction(
            ntt.program,
            await ntt.getConfig(),
            {
              owner: nttOwner,
              newAuthority: newAuthority.publicKey,
              multisigTokenAuthority,
            },
            ntt.pdas
          ),
          payer
        );

        await assert.testMintAuthority(testMint).equal(newAuthority.publicKey);
      });

      test("newAuthority -> TA", async () => {
        await $.sendAndConfirm(
          await NTT.createAcceptTokenAuthorityInstruction(
            ntt.program,
            await ntt.getConfig(),
            {
              currentAuthority: newAuthority.publicKey,
            },
            ntt.pdas
          ),
          payer,
          newAuthority
        );

        await assert
          .testMintAuthority(testMint)
          .equal(ntt.pdas.tokenAuthority());
      });

      test("TA -> Multisig(owner, newAuthority)", async () => {
        // set token authority: TA -> newMultisigAuthority
        await $.sendAndConfirm(
          await NTT.createSetTokenAuthorityInstruction(
            ntt.program,
            await ntt.getConfig(),
            {
              rentPayer: nttOwner,
              owner: nttOwner,
              newAuthority: newMultisigAuthority,
            },
            ntt.pdas
          ),
          payer
        );

        // claim token authority: newMultisigAuthority <- TA
        await $.sendAndConfirm(
          await NTT.createClaimTokenAuthorityToMultisigInstruction(
            ntt.program,
            await ntt.getConfig(),
            {
              rentPayer: nttOwner,
              newMultisigAuthority,
              additionalSigners: [
                newAuthority.publicKey,
                mintAuthority.publicKey,
              ],
            },
            ntt.pdas
          ),
          payer,
          newAuthority,
          mintAuthority
        );

        await assert.testMintAuthority(testMint).equal(newMultisigAuthority);
      });

      test("Multisig(owner, newAuthority) -> Multisig(owner, TA)", async () => {
        await $.sendAndConfirm(
          await NTT.createAcceptTokenAuthorityFromMultisigInstruction(
            ntt.program,
            await ntt.getConfig(),
            {
              currentMultisigAuthority: newMultisigAuthority,
              additionalSigners: [
                newAuthority.publicKey,
                mintAuthority.publicKey,
              ],
              multisigTokenAuthority,
            },
            ntt.pdas
          ),
          payer,
          newAuthority,
          mintAuthority
        );

        await assert.testMintAuthority(testMint).equal(multisigTokenAuthority);
      });

      it("Fails on claim after revert", async () => {
        // fund newAuthority for it to be rent payer
        await $.airdrop(newAuthority.publicKey, anchor.web3.LAMPORTS_PER_SOL);
        await assert
          .nativeBalance($.connection, newAuthority.publicKey)
          .equal(anchor.web3.LAMPORTS_PER_SOL);

        // set token authority: multisigTokenAuthority -> newAuthority
        await $.sendAndConfirm(
          await NTT.createSetTokenAuthorityInstruction(
            ntt.program,
            await ntt.getConfig(),
            {
              rentPayer: newAuthority.publicKey,
              owner: nttOwner,
              newAuthority: newAuthority.publicKey,
              multisigTokenAuthority,
            },
            ntt.pdas
          ),
          payer,
          newAuthority
        );
        const pendingTokenAuthorityRentExemptAmount =
          await $.connection.getMinimumBalanceForRentExemption(
            ntt.program.account.pendingTokenAuthority!.size
          );
        await assert
          .nativeBalance($.connection, newAuthority.publicKey)
          .equal(
            anchor.web3.LAMPORTS_PER_SOL - pendingTokenAuthorityRentExemptAmount
          );

        // revert token authority: multisigTokenAuthority
        await $.sendAndConfirm(
          await NTT.createRevertTokenAuthorityInstruction(
            ntt.program,
            await ntt.getConfig(),
            {
              rentPayer: newAuthority.publicKey,
              owner: nttOwner,
              multisigTokenAuthority,
            },
            ntt.pdas
          ),
          payer
        );
        await assert
          .nativeBalance($.connection, newAuthority.publicKey)
          .equal(anchor.web3.LAMPORTS_PER_SOL);

        // claim token authority: newAuthority <- multisigTokenAuthority
        await assert
          .promise(
            $.sendAndConfirm(
              await NTT.createClaimTokenAuthorityInstruction(
                ntt.program,
                await ntt.getConfig(),
                {
                  rentPayer: newAuthority.publicKey,
                  newAuthority: newAuthority.publicKey,
                  multisigTokenAuthority,
                },
                ntt.pdas
              ),
              payer,
              newAuthority
            )
          )
          .failsWithAnchorError(anchor.web3.SendTransactionError, {
            code: "AccountNotInitialized",
            number: 3012,
          });

        await assert.testMintAuthority(testMint).equal(multisigTokenAuthority);
      });

      afterAll(async () => {
        // unpause
        const unpauseTxs = ntt.unpause(payerAddress);
        await signSendWait(ctx, unpauseTxs, signer);
      });
    });

    it("Can receive tokens", async () => {
      const emitter = new testing.mocks.MockEmitter(
        remoteXcvr.address as UniversalAddress,
        "Ethereum",
        0n
      );

      const guardians = new testing.mocks.MockGuardians(0, [GUARDIAN_KEY]);

      // v4: recipientNttManager is the instance pubkey, not the program ID.
      const sendingTransceiverMessage = {
        sourceNttManager: remoteMgr.address as UniversalAddress,
        recipientNttManager: new UniversalAddress(
          instanceKeypair.publicKey.toBytes()
        ),
        nttManagerPayload: {
          id: encoding.bytes.encode("sequence1".padEnd(32, "0")),
          sender: new UniversalAddress("FACE".padStart(64, "0")),
          payload: {
            trimmedAmount: {
              amount: 10_000n,
              decimals: 8,
            },
            sourceToken: new UniversalAddress("FAFA".padStart(64, "0")),
            recipientAddress: new UniversalAddress(payer.publicKey.toBytes()),
            recipientChain: "Solana",
            additionalPayload: new Uint8Array(),
          },
        },
        transceiverPayload: new Uint8Array(),
      } as const;

      const serialized = serializePayload(
        "Ntt:WormholeTransfer",
        sendingTransceiverMessage
      );
      const published = emitter.publishMessage(0, serialized, 200);
      const rawVaa = guardians.addSignatures(published, [0]);
      const vaa = deserialize("Ntt:WormholeTransfer", serialize(rawVaa));
      const redeemTxs = ntt.redeem([vaa], sender);
      await signSendWait(ctx, redeemTxs, signer);

      assert.bn(await testDummyTransferHook.counter.value()).equal(2);
    });

    it("Can mint independently", async () => {
      const temp = await testMint.mint(
        payer,
        $.keypair.generate().publicKey,
        1,
        multisigTokenAuthority,
        mintAuthority
      );
      await assert.tokenBalance($.connection, temp).equal(1);
    });
  });

  describe("Static Checks", () => {
    const wh = new Wormhole("Devnet", [SolanaPlatform]);
    const ctx = wh.getChain("Solana");
    const overrides = {
      Solana: {
        token: mint.publicKey.toBase58(),
        manager: NTT_ADDRESS.toBase58(),
        instance: instanceKeypair.publicKey.toBase58(),
        transceiver: {
          wormhole: nttTransceivers["wormhole"].programId.toBase58(),
        },
        svmShims: SOLANA_WORMHOLE_SHIMS,
      },
    };

    describe("ABI Versions Test", () => {
      test("It initializes from Rpc", async () => {
        const ntt = await SolanaNtt.fromRpc($.connection, {
          Solana: {
            ...ctx.config,
            contracts: {
              ...ctx.config.contracts,
              ntt: overrides["Solana"],
            },
          },
        });
        expect(ntt).toBeTruthy();
      });

      test("It initializes from constructor", async () => {
        const ntt = new SolanaNtt(
          "Devnet",
          "Solana",
          $.connection,
          {
            ...ctx.config.contracts,
            ...{ ntt: overrides["Solana"] },
          },
          VERSION
        );
        expect(ntt).toBeTruthy();
      });

      test("It gets the correct version", async () => {
        const version = await SolanaNtt.getVersion(
          $.connection,
          { ntt: overrides["Solana"] },
          payerAddress
        );
        expect(version).toBe("4.0.0");
      });

      test("It initializes using `emitterAccount` as transceiver address", async () => {
        const overrideEmitter: (typeof overrides)["Solana"] = JSON.parse(
          JSON.stringify(overrides["Solana"])
        );
        // v4: the emitter is scoped by the instance pubkey, so derive
        // accordingly.
        overrideEmitter.transceiver.wormhole = NTT.transceiverPdas(
          NTT_ADDRESS,
          instanceKeypair.publicKey
        )
          .emitterAccount()
          .toBase58();

        const ntt = new SolanaNtt(
          "Devnet",
          "Solana",
          $.connection,
          {
            ...ctx.config.contracts,
            ...{ ntt: overrideEmitter },
          },
          VERSION
        );
        expect(ntt).toBeTruthy();
      });

      test("It gets the correct transceiver type", async () => {
        const ntt = new SolanaNtt(
          "Devnet",
          "Solana",
          $.connection,
          {
            ...ctx.config.contracts,
            ...{ ntt: overrides["Solana"] },
          },
          VERSION
        );
        const whTransceiver = await ntt.getWormholeTransceiver();
        expect(whTransceiver).toBeTruthy();
        const transceiverType =
          await whTransceiver!.getTransceiverType(payerAddress);
        expect(transceiverType).toBe("wormhole");
      });
    });
  });
});
