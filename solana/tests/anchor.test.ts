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
import * as testing from "@wormhole-foundation/sdk-definitions/testing";
import {
  SolanaAddress,
  SolanaPlatform,
  getSolanaSignAndSendSigner,
} from "@wormhole-foundation/sdk-solana";
import { SolanaWormholeCore } from "@wormhole-foundation/sdk-solana-core";

import { IdlVersion, NTT } from "../ts/index.js";
import { SolanaNtt } from "../ts/sdk/index.js";
import {
  TestDummyTransferHook,
  TestHelper,
  TestMint,
  assert,
  signSendWait,
} from "./utils/helpers.js";

/**
 * Test Config Constants
 */
const SOLANA_ROOT_DIR = `${__dirname}/../`;
const VERSION: IdlVersion = "3.0.0";
const TOKEN_PROGRAM = spl.TOKEN_2022_PROGRAM_ID;
const GUARDIAN_KEY =
  "cfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0";
const CORE_BRIDGE_ADDRESS = contracts.coreBridge("Mainnet", "Solana");
const NTT_ADDRESS: anchor.web3.PublicKey =
  anchor.workspace.ExampleNativeTokenTransfers.programId;
const WH_TRANSCEIVER_ADDRESS: anchor.web3.PublicKey =
  anchor.workspace.NttTransceiver.programId;
const TEST_SPL_MULTISIG = true; // only matters for VERSION >= 3.x.x

/**
 * Test Helpers
 */
const $ = new TestHelper("confirmed", TOKEN_PROGRAM);
const testDummyTransferHook = new TestDummyTransferHook(
  anchor.workspace.DummyTransferHook,
  TOKEN_PROGRAM,
  spl.ASSOCIATED_TOKEN_PROGRAM_ID
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
  wormhole: WH_TRANSCEIVER_ADDRESS,
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

    // create our contract client
    ntt = new SolanaNtt(
      "Devnet",
      "Solana",
      $.connection,
      {
        ...ctx.config.contracts,
        ntt: {
          token: testMint.address.toBase58(),
          manager: NTT_ADDRESS.toBase58(),
          transceiver: {
            wormhole: nttTransceivers["wormhole"].toBase58(),
          },
        },
      },
      VERSION
    );
  });

  describe("Burning", () => {
    let multisigTokenAuthority: anchor.web3.PublicKey;

    beforeAll(async () => {
      // set multisigTokenAuthority as mint authority
      multisigTokenAuthority = await $.multisig.create(payer, 1, [
        mintAuthority.publicKey,
        ntt.pdas.tokenAuthority(),
      ]);
      await testMint.setMintAuthority(
        payer,
        TEST_SPL_MULTISIG ? multisigTokenAuthority : ntt.pdas.tokenAuthority(),
        mintAuthority
      );

      // init
      const initTxs = ntt.initialize(sender, {
        mint: testMint.address,
        outboundLimit: 1_000_000n,
        mode: "burning",
        multisigTokenAuthority: TEST_SPL_MULTISIG
          ? multisigTokenAuthority
          : undefined,
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

      // TODO: keep or remove the `outboxItem` param?
      // added as a way to keep tests the same but it technically breaks the Ntt interface
      const outboxItem = $.keypair.generate();
      const xferTxs = ntt.transfer(
        sender,
        amount,
        receiver,
        { queue: false, automatic: false, gasDropoff: 0n },
        outboxItem
      );
      await signSendWait(ctx, xferTxs, signer);

      // assert that released bitmap has transceiver bits set
      const outboxItemInfo = await ntt.program.account.outboxItem.fetch(
        outboxItem.publicKey
      );
      expect(outboxItemInfo.released.map.bitLength()).toBe(
        Object.keys(nttTransceivers).length
      );

      const wormholeXcvr = await ntt.getWormholeTransceiver();
      expect(wormholeXcvr).toBeTruthy();
      const wormholeMessage = wormholeXcvr!.pdas.wormholeMessageAccount(
        outboxItem.publicKey
      );
      const unsignedVaa = await coreBridge.parsePostMessageAccount(
        wormholeMessage
      );

      const transceiverMessage = deserializePayload(
        "Ntt:WormholeTransfer",
        unsignedVaa.payload
      );

      // assert that amount is what we expect
      expect(
        transceiverMessage.nttManagerPayload.payload.trimmedAmount
      ).toMatchObject({ amount: 10_000n, decimals: 8 });

      // get from balance
      await assert.tokenBalance($.connection, tokenAccount).equal(9_900_000);
    });

    $.jest.describeIf(
      TEST_SPL_MULTISIG,
      "Can transfer mint authority to-and-from NTT manager",
      () => {
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
                  }
                ),
                payer
              )
            )
            .failsWithAnchorError(anchor.web3.SendTransactionError, {
              code: "NotPaused",
              number: 6024,
            });

          await assert
            .testMintAuthority(testMint)
            .equal(multisigTokenAuthority);
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
              }
            ),
            payer
          );

          await assert
            .testMintAuthority(testMint)
            .equal(newAuthority.publicKey);
        });

        test("newAuthority -> TA", async () => {
          await $.sendAndConfirm(
            await NTT.createAcceptTokenAuthorityInstruction(
              ntt.program,
              await ntt.getConfig(),
              {
                currentAuthority: newAuthority.publicKey,
              }
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
              }
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
              }
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
              }
            ),
            payer,
            newAuthority,
            mintAuthority
          );

          await assert
            .testMintAuthority(testMint)
            .equal(multisigTokenAuthority);
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
              }
            ),
            payer,
            newAuthority
          );
          const pendingTokenAuthorityRentExemptAmount =
            await $.connection.getMinimumBalanceForRentExemption(
              ntt.program.account.pendingTokenAuthority.size
            );
          await assert
            .nativeBalance($.connection, newAuthority.publicKey)
            .equal(
              anchor.web3.LAMPORTS_PER_SOL -
                pendingTokenAuthorityRentExemptAmount
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
              }
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
                  }
                ),
                payer,
                newAuthority
              )
            )
            .failsWithAnchorError(anchor.web3.SendTransactionError, {
              code: "AccountNotInitialized",
              number: 3012,
            });

          await assert
            .testMintAuthority(testMint)
            .equal(multisigTokenAuthority);
        });

        afterAll(async () => {
          // unpause
          const unpauseTxs = ntt.unpause(payerAddress);
          await signSendWait(ctx, unpauseTxs, signer);
        });
      }
    );

    it("Can receive tokens", async () => {
      const emitter = new testing.mocks.MockEmitter(
        remoteXcvr.address as UniversalAddress,
        "Ethereum",
        0n
      );

      const guardians = new testing.mocks.MockGuardians(0, [GUARDIAN_KEY]);

      const sendingTransceiverMessage = {
        sourceNttManager: remoteMgr.address as UniversalAddress,
        recipientNttManager: new UniversalAddress(
          ntt.program.programId.toBytes()
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

    $.jest.itIf(TEST_SPL_MULTISIG, "Can mint independently", async () => {
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
        transceiver: {
          wormhole: nttTransceivers["wormhole"].toBase58(),
        },
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
        const ntt = new SolanaNtt("Devnet", "Solana", $.connection, {
          ...ctx.config.contracts,
          ...{ ntt: overrides["Solana"] },
        });
        expect(ntt).toBeTruthy();
      });

      test("It gets the correct version", async () => {
        const version = await SolanaNtt.getVersion(
          $.connection,
          { ntt: overrides["Solana"] },
          payerAddress
        );
        expect(version).toBe("3.0.0");
      });

      test("It gets the correct transceiver type", async () => {
        const ntt = new SolanaNtt("Devnet", "Solana", $.connection, {
          ...ctx.config.contracts,
          ...{ ntt: overrides["Solana"] },
        });
        const whTransceiver = await ntt.getWormholeTransceiver();
        expect(whTransceiver).toBeTruthy();
        const transceiverType = await whTransceiver!.getTransceiverType(
          payerAddress
        );
        expect(transceiverType).toBe("wormhole");
      });
    });
  });
});
