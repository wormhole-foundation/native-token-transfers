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
  signSendWait as ssw,
} from "@wormhole-foundation/sdk";
import * as testing from "@wormhole-foundation/sdk-definitions/testing";
import {
  SolanaAddress,
  SolanaPlatform,
  getSolanaSignAndSendSigner,
} from "@wormhole-foundation/sdk-solana";
import { SolanaWormholeCore } from "@wormhole-foundation/sdk-solana-core";
import * as fs from "fs";

import {
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { DummyTransferHook } from "../ts/idl/1_0_0/ts/dummy_transfer_hook.js";
import { getTransceiverProgram, IdlVersion, NTT } from "../ts/index.js";
import { derivePda } from "../ts/lib/utils.js";
import { SolanaNtt } from "../ts/sdk/index.js";

const solanaRootDir = `${__dirname}/../`;

const VERSION: IdlVersion = "3.0.0";
const GUARDIAN_KEY =
  "cfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0";
const CORE_BRIDGE_ADDRESS = contracts.coreBridge("Mainnet", "Solana");
const NTT_ADDRESS: PublicKey =
  anchor.workspace.ExampleNativeTokenTransfers.programId;
const WH_TRANSCEIVER_ADDRESS: PublicKey =
  anchor.workspace.NttTransceiver.programId;

async function signSendWait(
  chain: ChainContext<any, any, any>,
  txs: AsyncGenerator<any>,
  signer: Signer
) {
  try {
    await ssw(chain, txs, signer);
  } catch (e) {
    console.error(e);
  }
}

const w = new Wormhole("Devnet", [SolanaPlatform], {
  chains: { Solana: { contracts: { coreBridge: CORE_BRIDGE_ADDRESS } } },
});

const remoteXcvr: ChainAddress = {
  chain: "Ethereum",
  address: new UniversalAddress(
    encoding.bytes.encode("transceiver".padStart(32, "\0"))
  ),
};
const remoteMgr: ChainAddress = {
  chain: "Ethereum",
  address: new UniversalAddress(
    encoding.bytes.encode("nttManager".padStart(32, "\0"))
  ),
};

const payerSecretKey = Uint8Array.from(
  JSON.parse(
    fs.readFileSync(`${solanaRootDir}/keys/test.json`, {
      encoding: "utf-8",
    })
  )
);
const payer = anchor.web3.Keypair.fromSecretKey(payerSecretKey);

const owner = anchor.web3.Keypair.generate();
const connection = new anchor.web3.Connection(
  "http://localhost:8899",
  "confirmed"
);

// Make sure we're using the exact same Connection obj for rpc
const ctx: ChainContext<"Devnet", "Solana"> = w
  .getPlatform("Solana")
  .getChain("Solana", connection);

let tokenAccount: anchor.web3.PublicKey;

const mint = anchor.web3.Keypair.generate();

const dummyTransferHook = anchor.workspace
  .DummyTransferHook as anchor.Program<DummyTransferHook>;

const [extraAccountMetaListPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("extra-account-metas"), mint.publicKey.toBuffer()],
  dummyTransferHook.programId
);

const [counterPDA] = PublicKey.findProgramAddressSync(
  [Buffer.from("counter")],
  dummyTransferHook.programId
);

async function counterValue(): Promise<anchor.BN> {
  const counter = await dummyTransferHook.account.counter.fetch(counterPDA);
  return counter.count;
}

const coreBridge = new SolanaWormholeCore("Devnet", "Solana", connection, {
  coreBridge: CORE_BRIDGE_ADDRESS,
});

const nttTransceivers = {
  wormhole: getTransceiverProgram(
    connection,
    WH_TRANSCEIVER_ADDRESS.toBase58(),
    VERSION
  ),
};

const TOKEN_PROGRAM = spl.TOKEN_2022_PROGRAM_ID;

describe("example-native-token-transfers", () => {
  let ntt: SolanaNtt<"Devnet", "Solana">;
  let signer: Signer;
  let sender: AccountAddress<"Solana">;
  let tokenAddress: string;

  beforeAll(async () => {
    try {
      signer = await getSolanaSignAndSendSigner(connection, payer, {
        //debug: true,
      });
      sender = Wormhole.parseAddress("Solana", signer.address());

      const extensions = [spl.ExtensionType.TransferHook];
      const mintLen = spl.getMintLen(extensions);
      const lamports = await connection.getMinimumBalanceForRentExemption(
        mintLen
      );

      const transaction = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          space: mintLen,
          lamports,
          programId: TOKEN_PROGRAM,
        }),
        spl.createInitializeTransferHookInstruction(
          mint.publicKey,
          owner.publicKey,
          dummyTransferHook.programId,
          TOKEN_PROGRAM
        ),
        spl.createInitializeMintInstruction(
          mint.publicKey,
          9,
          owner.publicKey,
          null,
          TOKEN_PROGRAM
        )
      );

      const { blockhash } = await connection.getLatestBlockhash();

      transaction.feePayer = payer.publicKey;
      transaction.recentBlockhash = blockhash;

      await sendAndConfirmTransaction(connection, transaction, [payer, mint], {
        commitment: "confirmed",
      });

      tokenAccount = await spl.createAssociatedTokenAccount(
        connection,
        payer,
        mint.publicKey,
        payer.publicKey,
        undefined,
        TOKEN_PROGRAM,
        spl.ASSOCIATED_TOKEN_PROGRAM_ID
      );

      await spl.mintTo(
        connection,
        payer,
        mint.publicKey,
        tokenAccount,
        owner,
        10_000_000n,
        undefined,
        undefined,
        TOKEN_PROGRAM
      );

      tokenAddress = mint.publicKey.toBase58();
      // Create our contract client
      ntt = new SolanaNtt(
        "Devnet",
        "Solana",
        connection,
        {
          ...ctx.config.contracts,
          ntt: {
            token: tokenAddress,
            manager: NTT_ADDRESS.toBase58(),
            transceiver: {
              wormhole: nttTransceivers["wormhole"].programId.toBase58(),
            },
          },
        },
        VERSION
      );
    } catch (e) {
      console.error("Failed to setup solana token: ", e);
      throw e;
    }
  });

  describe("Burning", () => {
    beforeAll(async () => {
      try {
        await spl.setAuthority(
          connection,
          payer,
          mint.publicKey,
          owner,
          spl.AuthorityType.MintTokens,
          ntt.pdas.tokenAuthority(),
          [],
          undefined,
          TOKEN_PROGRAM
        );

        // init
        const initTxs = ntt.initialize(sender, {
          mint: mint.publicKey,
          outboundLimit: 1000000n,
          mode: "burning",
        });
        await signSendWait(ctx, initTxs, signer);

        // register
        const registerTxs = ntt.registerWormholeTransceiver({
          payer: new SolanaAddress(payer.publicKey),
          owner: new SolanaAddress(payer.publicKey),
        });
        await signSendWait(ctx, registerTxs, signer);

        // Set Wormhole xcvr peer
        const setXcvrPeerTxs = ntt.setWormholeTransceiverPeer(
          remoteXcvr,
          sender
        );
        await signSendWait(ctx, setXcvrPeerTxs, signer);

        // Set manager peer
        const setPeerTxs = ntt.setPeer(remoteMgr, 18, 1n, 1000000n, sender);
        await signSendWait(ctx, setPeerTxs, signer);
      } catch (e) {
        console.error("Failed to setup peer: ", e);
        throw e;
      }
    });

    it("Create ExtraAccountMetaList Account", async () => {
      const initializeExtraAccountMetaListInstruction =
        await dummyTransferHook.methods
          .initializeExtraAccountMetaList()
          .accountsStrict({
            payer: payer.publicKey,
            mint: mint.publicKey,
            counter: counterPDA,
            extraAccountMetaList: extraAccountMetaListPDA,
            tokenProgram: TOKEN_PROGRAM,
            associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction();

      const transaction = new Transaction().add(
        initializeExtraAccountMetaListInstruction
      );
      transaction.feePayer = payer.publicKey;
      const { blockhash } = await connection.getLatestBlockhash();
      transaction.recentBlockhash = blockhash;

      transaction.sign(payer);
      await sendAndConfirmTransaction(connection, transaction, [payer], {
        commitment: "confirmed",
      });
    });

    test("Can send tokens", async () => {
      const amount = 100000n;
      const sender = Wormhole.parseAddress("Solana", signer.address());

      const receiver = testing.utils.makeUniversalChainAddress("Ethereum");

      // TODO: keep or remove the `outboxItem` param?
      // added as a way to keep tests the same but it technically breaks the Ntt interface
      const outboxItem = anchor.web3.Keypair.generate();
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

      const wormholeMessage = derivePda(
        ["message", outboxItem.publicKey.toBytes()],
        nttTransceivers["wormhole"].programId
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
      ).toMatchObject({ amount: 10000n, decimals: 8 });

      // get from balance
      const balance = await connection.getTokenAccountBalance(tokenAccount);
      expect(balance.value.amount).toBe("9900000");
    });

    it("Can receive tokens", async () => {
      const emitter = new testing.mocks.MockEmitter(
        remoteXcvr.address as UniversalAddress,
        "Ethereum",
        0n
      );

      const guardians = new testing.mocks.MockGuardians(0, [GUARDIAN_KEY]);
      const sender = Wormhole.parseAddress("Solana", signer.address());

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
              amount: 10000n,
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
      try {
        await signSendWait(ctx, redeemTxs, signer);
      } catch (e) {
        console.error(e);
        throw e;
      }

      expect((await counterValue()).toString()).toEqual("2");
    });
  });

  describe("Static Checks", () => {
    const wh = new Wormhole("Devnet", [SolanaPlatform]);
    const ctx = wh.getChain("Solana");
    const overrides = {
      Solana: {
        token: tokenAddress,
        manager: NTT_ADDRESS.toBase58(),
        transceiver: {
          wormhole: nttTransceivers["wormhole"].programId.toBase58(),
        },
      },
    };

    describe("ABI Versions Test", function () {
      test("It initializes from Rpc", async function () {
        const ntt = await SolanaNtt.fromRpc(connection, {
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

      test("It initializes from constructor", async function () {
        const ntt = new SolanaNtt("Devnet", "Solana", connection, {
          ...ctx.config.contracts,
          ...{ ntt: overrides["Solana"] },
        });
        expect(ntt).toBeTruthy();
      });

      test("It gets the correct version", async function () {
        const version = await SolanaNtt.getVersion(
          connection,
          { ntt: overrides["Solana"] },
          new SolanaAddress(payer.publicKey.toBase58())
        );
        expect(version).toBe("3.0.0");
      });

      test("It initializes using `emitterAccount` as transceiver address", async function () {
        const overrideEmitter: (typeof overrides)["Solana"] = JSON.parse(
          JSON.stringify(overrides["Solana"])
        );
        overrideEmitter.transceiver.wormhole = NTT.transceiverPdas(NTT_ADDRESS)
          .emitterAccount()
          .toBase58();

        const ntt = new SolanaNtt("Devnet", "Solana", connection, {
          ...ctx.config.contracts,
          ...{ ntt: overrideEmitter },
        });
        expect(ntt).toBeTruthy();
      });

      test("It gets the correct transceiver type", async function () {
        const ntt = new SolanaNtt("Devnet", "Solana", connection, {
          ...ctx.config.contracts,
          ...{ ntt: overrides["Solana"] },
        });
        const whTransceiver = await ntt.getWormholeTransceiver();
        const transceiverType = await whTransceiver!.getTransceiverType(
          new SolanaAddress(payer.publicKey.toBase58())
        );
        expect(transceiverType).toBe("wormhole");
      });
    });
  });
});
