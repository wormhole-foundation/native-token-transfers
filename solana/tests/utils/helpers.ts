import * as anchor from "@coral-xyz/anchor";
import * as spl from "@solana/spl-token";
import * as fs from "fs";
import {
  Chain,
  ChainAddress,
  ChainContext,
  encoding,
  Signer,
  signSendWait as ssw,
  UniversalAddress,
} from "@wormhole-foundation/sdk";
import { DummyTransferHook } from "../../ts/idl/1_0_0/ts/dummy_transfer_hook.js";
import { type WormholePostMessageShim } from "../../ts/idl/wormhole_shim/ts/wormhole_post_message_shim.js";
import { IDL as WormholePostMessageShimIdl } from "../../ts/idl/wormhole_shim/ts/wormhole_post_message_shim.js";
import { derivePda, eventAuthority } from "../../ts/lib/utils.js";
import { TxHash } from "@wormhole-foundation/sdk-definitions";

export interface ErrorConstructor {
  new (...args: any[]): Error;
}

/**
 * Wormhole Post Message Shim related types
 */
export type PostMessageShimMessageEvent =
  anchor.IdlEvents<WormholePostMessageShim>["messageEvent"];
export interface PostMessageShimInstructionData {
  nonce: number;
  consistencyLevel: { confirmed: {} } | { finalized: {} };
  payload: Buffer;
}
export interface PostMessageShimMessageData
  extends PostMessageShimInstructionData,
    PostMessageShimMessageEvent {}

/**
 * Assertion utility functions
 */
export const assert = {
  /**
   * Asserts BN
   * @param actual BN to compare against
   */
  bn: (actual: anchor.BN) => ({
    /**
     * Asserts `actual` equals `expected`
     * @param expected BN to compare with
     */
    equal: (expected: anchor.BN | number | string | bigint) => {
      expect(
        actual.eq(
          expected instanceof anchor.BN
            ? expected
            : new anchor.BN(expected.toString())
        )
      ).toBeTruthy();
    },
  }),

  /**
   * Asserts mint authority for given `mint`
   * @param connection Connection to use
   * @param mint Mint account
   * @param tokenProgram SPL Token program account
   */
  mintAuthority: (
    connection: anchor.web3.Connection,
    mint: anchor.web3.PublicKey,
    tokenProgram = spl.TOKEN_2022_PROGRAM_ID
  ) => ({
    /**
     * Asserts queried mint authority equals `expectedAuthority`
     * @param expectedAuthority Expected mint authority
     */
    equal: async (expectedAuthority: anchor.web3.PublicKey) => {
      const mintInfo = await spl.getMint(
        connection,
        mint,
        undefined,
        tokenProgram
      );
      expect(mintInfo.mintAuthority).toEqual(expectedAuthority);
    },
  }),

  /**
   * Asserts mint authority for given `testMint`
   * @param testMint `TestMint` object to query to fetch mintAuthority
   */
  testMintAuthority: (testMint: TestMint) => ({
    /**
     * Asserts queried mint authority equals `expectedAuthority`
     * @param expectedAuthority Expected mint authority
     */
    equal: async (expectedAuthority: anchor.web3.PublicKey) => {
      const mintInfo = await testMint.getMint();
      expect(mintInfo.mintAuthority).toEqual(expectedAuthority);
    },
  }),

  /**
   * Asserts native balance for given `publicKey`
   * @param connection Connection to use
   * @param publicKey Account to query to fetch native balance
   */
  nativeBalance: (
    connection: anchor.web3.Connection,
    publicKey: anchor.web3.PublicKey
  ) => ({
    /**
     * Asserts queried native balance equals `expectedBalance`
     * @param expectedBalance Expected lamports balance
     */
    equal: async (expectedBalance: anchor.BN | number | string | bigint) => {
      const balance = await connection.getAccountInfo(publicKey);
      expect(balance?.lamports.toString()).toBe(expectedBalance.toString());
    },
  }),

  /**
   * Asserts token balance for given `tokenAccount`
   * @param connection Connection to use
   * @param tokenAccount Token account to query to fetch token balance
   */
  tokenBalance: (
    connection: anchor.web3.Connection,
    tokenAccount: anchor.web3.PublicKey
  ) => ({
    /**
     * Asserts queried token balance equals `expectedBalance`
     * @param expectedBalance Expected token balance
     */
    equal: async (expectedBalance: anchor.BN | number | string | bigint) => {
      const balance = await connection.getTokenAccountBalance(tokenAccount);
      expect(balance.value.amount).toBe(expectedBalance.toString());
    },
  }),

  /**
   * Asserts promise fails and throws expected error
   * @param prom Promise to execute (intended to fail)
   */
  promise: (prom: Promise<unknown>) => ({
    /**
     * Asserts promise throws error of type `errorType`
     * @param errorType Expected type for thrown error
     */
    fails: async (errorType?: ErrorConstructor) => {
      let result: any;
      try {
        result = await prom;
      } catch (error: any) {
        if (errorType != null) {
          expect(error).toBeInstanceOf(errorType);
        }
        return;
      }
      throw new Error(`Promise did not fail. Result: ${result}`);
    },
    /**
     * Asserts promise throws error containing `message`
     * @param message Expected message contained in thrown error
     */
    failsWith: async (message: string) => {
      let result: any;
      try {
        result = await prom;
      } catch (error: any) {
        const errorStr: string = error.toString();
        if (errorStr.includes(message)) {
          return;
        }
        throw {
          message: "Error does not contain the asked message",
          stack: errorStr,
        };
      }
      throw new Error(`Promise did not fail. Result: ${result}`);
    },
    /**
     * Asserts promise throws Anchor error coreesponding to type `errorType` and `errorCode`
     * @param errorType Expected type for thrown error
     * @param errorCode Expected error code for thrown error
     */
    failsWithAnchorError: async (
      errorType: ErrorConstructor,
      errorCode: typeof anchor.AnchorError.prototype.error.errorCode
    ) => {
      let result: any;
      try {
        result = await prom;
      } catch (error: any) {
        expect(error).toBeInstanceOf(errorType);
        const parsedError = anchor.AnchorError.parse(error.logs ?? []);
        expect(parsedError?.error.errorCode).toEqual(errorCode);
        return;
      }
      throw new Error(`Promise did not fail. Result: ${result}`);
    },
  }),
};

/**
 * General test utility class
 */
export class TestHelper {
  static readonly LOCALHOST = "http://localhost:8899";
  readonly connection: anchor.web3.Connection;

  constructor(
    readonly finality: anchor.web3.Finality = "confirmed",
    readonly tokenProgram: anchor.web3.PublicKey = spl.TOKEN_2022_PROGRAM_ID
  ) {
    this.connection = new anchor.web3.Connection(
      TestHelper.LOCALHOST,
      finality
    );
  }

  /**
   * `Keypair` utility functions
   */
  keypair = {
    /**
     * Wrapper around `Keypair.generate()`
     * @returns Generated `Keypair`
     */
    generate: () => anchor.web3.Keypair.generate(),
    /**
     * Reads secret key file and returns `Keypair` it corresponds to
     * @param path File path containing secret key
     * @returns Corresponding `Keypair`
     */
    read: (path: string) =>
      this.keypair.from(
        JSON.parse(fs.readFileSync(path, { encoding: "utf8" }))
      ),
    /**
     * Wrapper around `Keypair.fromSecretKey` for number array-like
     * @param bytes Number array-like corresponding to a secret key
     * @returns Corresponding `Keypair`
     */
    from: (bytes: number[]) =>
      anchor.web3.Keypair.fromSecretKey(Uint8Array.from(bytes)),
  };

  /**
   * `ChainAddress` utility functions
   */
  chainAddress = {
    /**
     * Generates a `ChainAddress` by encoding value to pass off as `UniversalAddress`
     * @param chain `Chain` to generate `ChainAddress` for
     * @param value String to use for generating `UniversalAddress`
     * @returns Generated `ChainAddress`
     */
    generateFromValue: (chain: Chain, value: string): ChainAddress => ({
      chain,
      address: new UniversalAddress(
        encoding.bytes.encode(value.padStart(32, "\0"))
      ),
    }),
  };

  /**
   * SPL Multisig utility functions
   */
  multisig = {
    /**
     * Wrapper around `spl.createMultisig`
     * @param payer Payer of the transaction and initialization fees
     * @param m Number of required signatures
     * @param signers Full set of signers
     * @returns Address of the new multisig
     */
    create: async (
      payer: anchor.web3.Signer,
      m: number,
      signers: anchor.web3.PublicKey[]
    ) => {
      return spl.createMultisig(
        this.connection,
        payer,
        signers,
        m,
        this.keypair.generate(),
        undefined,
        this.tokenProgram
      );
    },
  };

  /**
   * Wrapper around `confirmTransaction`
   * @param signature Signature of transaction to confirm
   * @returns Result of signature confirmation
   */
  confirm = async (signature: anchor.web3.TransactionSignature) => {
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash();
    return this.connection.confirmTransaction({
      blockhash,
      lastValidBlockHeight,
      signature,
    });
  };

  /**
   * Wrapper around `sendAndConfirm` for `this.connection`
   * @param ixs Instruction(s)/transaction used to create the transaction
   * @param payer Payer of the transaction fees
   * @param signers Signing accounts required by the transaction
   * @returns Signature of the confirmed transaction
   */
  sendAndConfirm = async (
    ixs:
      | anchor.web3.TransactionInstruction
      | anchor.web3.Transaction
      | Array<anchor.web3.TransactionInstruction>,
    payer: anchor.web3.Signer,
    ...signers: anchor.web3.Signer[]
  ): Promise<anchor.web3.TransactionSignature> => {
    return sendAndConfirm(this.connection, ixs, payer, ...signers);
  };

  /**
   * Wrapper around `requestAirdrop()`
   * @param to Recipient account for airdrop
   * @param lamports Amount in lamports to airdrop
   * @returns Signature of the confirmed transaction
   */
  airdrop = async (to: anchor.web3.PublicKey, lamports: number) => {
    return this.confirm(await this.connection.requestAirdrop(to, lamports));
  };

  /**
   * Fetches the estimated production time of the current block
   * @returns Time of current block
   */
  currentTime = async () => {
    const slot = await this.connection.getSlot();
    const timestamp = await this.connection.getBlockTime(slot);
    return timestamp;
  };
}

/**
 * Mint-related test utility class
 */
export class TestMint {
  private constructor(
    readonly connection: anchor.web3.Connection,
    readonly address: anchor.web3.PublicKey,
    readonly decimals: number,
    readonly tokenProgram: anchor.web3.PublicKey = spl.TOKEN_2022_PROGRAM_ID,
    readonly associatedTokenProgram: anchor.web3.PublicKey = spl.ASSOCIATED_TOKEN_PROGRAM_ID
  ) {}

  /**
   * Creates and initializes a new mint
   * @param connection Connection to use
   * @param payer Payer of the transaction and initialization fees
   * @param authority Account that will control minting
   * @param decimals Location of the decimal place
   * @param tokenProgram SPL Token program account
   * @param associatedTokenProgram SPL Associated Token program account
   * @returns new `TestMint` object initialized with the created mint
   */
  static create = async (
    connection: anchor.web3.Connection,
    payer: anchor.web3.Signer,
    authority: anchor.web3.Signer,
    decimals: number,
    tokenProgram: anchor.web3.PublicKey = spl.TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: anchor.web3.PublicKey = spl.ASSOCIATED_TOKEN_PROGRAM_ID
  ) => {
    return new TestMint(
      connection,
      await spl.createMint(
        connection,
        payer,
        authority.publicKey,
        null,
        decimals,
        undefined,
        undefined,
        tokenProgram
      ),
      decimals,
      tokenProgram,
      associatedTokenProgram
    );
  };

  /**
   * Creates and initializes a new mint with Token Extensions
   * @param connection Connection to use
   * @param payer Payer of the transaction and initialization fees
   * @param mint Keypair of mint to be created
   * @param authority Account that will control minting
   * @param decimals Location of the decimal place
   * @param tokenProgram SPL Token program account
   * @param associatedTokenProgram SPL Associated Token program account
   * @param extensionArgs.extensions Token extensions mint is to be initialized with
   * @param extensionArgs.additionalDataLength Additional space to allocate for extension
   * @param extensionArgs.preMintInitIxs Instructions to execute before `InitializeMint` instruction
   * @param extensionArgs.postMintInitIxs Instructions to execute after `InitializeMint` instruction
   * @returns new `TestMint` object initialized with the created mint
   */
  static createWithTokenExtensions = async (
    connection: anchor.web3.Connection,
    payer: anchor.web3.Signer,
    mint: anchor.web3.Keypair,
    authority: anchor.web3.Signer,
    decimals: number,
    tokenProgram: anchor.web3.PublicKey = spl.TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: anchor.web3.PublicKey = spl.ASSOCIATED_TOKEN_PROGRAM_ID,
    extensionArgs: {
      extensions: spl.ExtensionType[];
      additionalDataLength?: number;
      preMintInitIxs?: anchor.web3.TransactionInstruction[];
      postMintInitIxs?: anchor.web3.TransactionInstruction[];
    }
  ) => {
    const mintLen = spl.getMintLen(extensionArgs.extensions);
    const additionalDataLength = extensionArgs.additionalDataLength ?? 0;
    const lamports = await connection.getMinimumBalanceForRentExemption(
      mintLen + additionalDataLength
    );
    await sendAndConfirm(
      connection,
      [
        anchor.web3.SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          space: mintLen,
          lamports,
          programId: tokenProgram,
        }),
        ...(extensionArgs.preMintInitIxs ?? []),
        spl.createInitializeMintInstruction(
          mint.publicKey,
          decimals,
          authority.publicKey,
          null,
          tokenProgram
        ),
        ...(extensionArgs.postMintInitIxs ?? []),
      ],
      payer,
      mint
    );

    return new TestMint(
      connection,
      mint.publicKey,
      decimals,
      tokenProgram,
      associatedTokenProgram
    );
  };

  /**
   * Wrapper around `spl.getMint`
   * @returns Mint information
   */
  getMint = async () => {
    return spl.getMint(
      this.connection,
      this.address,
      undefined,
      this.tokenProgram
    );
  };

  /**
   * Creates ATA for `accountOwner` and mints `amount` tokens to it
   * @param payer Payer of the transaction and initialization fees
   * @param accountOwner Owner of token account
   * @param amount Amount to mint
   * @param mintAuthority Minting authority
   * @param multiSigners Signing accounts if `mintAuthority` is a multisig
   * @returns Address of ATA
   */
  mint = async (
    payer: anchor.web3.Signer,
    accountOwner: anchor.web3.PublicKey,
    amount: number | bigint,
    mintAuthority: anchor.web3.Signer | anchor.web3.PublicKey,
    ...multiSigners: anchor.web3.Signer[]
  ) => {
    const tokenAccount = await spl.getOrCreateAssociatedTokenAccount(
      this.connection,
      payer,
      this.address,
      accountOwner,
      false,
      undefined,
      undefined,
      this.tokenProgram,
      this.associatedTokenProgram
    );

    await spl.mintTo(
      this.connection,
      payer,
      this.address,
      tokenAccount.address,
      mintAuthority,
      amount,
      multiSigners,
      undefined,
      this.tokenProgram
    );

    return tokenAccount.address;
  };

  /**
   * Wrapper around `spl.setAuthority` for `spl.AuthorityType.MintTokens`
   * @param payer Payer of the transaction fees
   * @param newAuthority New mint authority
   * @param currentAuthority Current mint authority
   * @param multiSigners Signing accounts if `currentAuthority` is a multisig
   * @returns Signature of the confirmed transaction
   */
  setMintAuthority = async (
    payer: anchor.web3.Signer,
    newAuthority: anchor.web3.PublicKey,
    currentAuthority: anchor.web3.Signer | anchor.web3.PublicKey,
    ...multiSigners: anchor.web3.Signer[]
  ) => {
    return spl.setAuthority(
      this.connection,
      payer,
      this.address,
      currentAuthority,
      spl.AuthorityType.MintTokens,
      newAuthority,
      multiSigners,
      undefined,
      this.tokenProgram
    );
  };
}

/**
 * Dummy Transfer Hook program related test utility class
 */
export class TestDummyTransferHook {
  constructor(
    readonly program: anchor.Program<DummyTransferHook>,
    readonly tokenProgram = spl.TOKEN_2022_PROGRAM_ID,
    readonly associatedTokenProgram = spl.ASSOCIATED_TOKEN_PROGRAM_ID
  ) {}

  /**
   * Counter utility functions
   */
  counter = {
    /**
     * @returns Counter PDA
     */
    pda: () => derivePda("counter", this.program.programId),

    /**
     * Queries counter and returns counter count
     * @returns Queried counter value
     */
    value: async () => {
      const counter = await this.program.account.counter.fetch(
        this.counter.pda()
      );
      return counter.count;
    },
  };

  /**
   * Extra Account Meta List utility functions
   */
  extraAccountMetaList = {
    /**
     * @param mint Mint account
     * @returns Extra Account Meta List PDA
     */
    pda: (mint: anchor.web3.PublicKey) =>
      derivePda(
        ["extra-account-metas", mint.toBytes()],
        this.program.programId
      ),
    /**
     * Initializes Extra Account Meta List account
     * @param connection Connection to use
     * @param payer Payer of the transaction fees
     * @param mint Mint account
     * @returns Signature of the confirmed transaction
     */
    initialize: async (
      connection: anchor.web3.Connection,
      payer: anchor.web3.Signer,
      mint: anchor.web3.PublicKey
    ) => {
      return sendAndConfirm(
        connection,
        await this.program.methods
          .initializeExtraAccountMetaList()
          .accountsStrict({
            payer: payer.publicKey,
            mint,
            counter: this.counter.pda(),
            extraAccountMetaList: this.extraAccountMetaList.pda(mint),
            tokenProgram: this.tokenProgram,
            associatedTokenProgram: this.associatedTokenProgram,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .instruction(),
        payer
      );
    },
  };
}

/**
 * Wormhole Post Message Shim program related test utility class
 */
export class TestWormholePostMessageShim {
  program: anchor.Program<WormholePostMessageShim>;
  borshInstructionCoder = new anchor.BorshInstructionCoder(
    WormholePostMessageShimIdl
  );

  constructor(
    readonly connection: anchor.web3.Connection,
    readonly programId = new anchor.web3.PublicKey(
      "EtZMZM22ViKMo4r5y4Anovs3wKQ2owUmDpjygnMMcdEX"
    )
  ) {
    this.program = new anchor.Program(WormholePostMessageShimIdl, programId, {
      connection,
    });
  }

  /**
   * @returns Event Authority PDA
   */
  eventAuthority = () => eventAuthority(this.programId);

  /**
   * Busy-waits on the transaction and parses the data necessary to re-build the message from the
   * Post Message Shim program input instruction data and the self-CPI `MessageEvent`
   * @param tx Transaction hash to poll
   * @returns Parsed `PostMessageShimMessageData`
   */
  getMessageData = async (
    tx: string
  ): Promise<PostMessageShimMessageData[]> => {
    const postMessageShimIxs = await this.getInstructions(tx);

    const parsedShimMessages = [];

    // NOTE: `getTransaction` flattens all nested `innerInstructions`.
    // This means the Post Message Shim instructions would show up in `innerInstructions` in groups of 2:
    // 1) outer CPI call from xcvr to the `postMessage` instruction
    // 2) inner self-CPI to emit the `MessageEvent`
    const n = postMessageShimIxs.length;
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n % 2).toBe(0);
    for (let i = 0; i < n; i += 2) {
      // Parse instruction data for `nonce`, `consistency_level`, `payload`
      const { nonce, consistencyLevel, payload } = this.parseInstructionData(
        postMessageShimIxs[i]!.data
      );
      // Parse CPI event for `emitter`, `sequence`, `submission_time`
      const { emitter, sequence, submissionTime } = this.parseMessageEvent(
        postMessageShimIxs[i + 1]!.data
      );

      parsedShimMessages.push({
        nonce,
        consistencyLevel,
        payload,
        emitter,
        sequence,
        submissionTime,
      });
    }

    return parsedShimMessages;
  };

  /**
   * Decodes and parses the program input data to extract the `nonce`, `consistency_level`, and `payload`
   * @param data The Post Message Shim program input data encoded as base 58
   * @returns Parsed `PostMessageShimInstructionData`
   */
  parseInstructionData = (data: string): PostMessageShimInstructionData => {
    const decodedData = anchor.utils.bytes.bs58.decode(data);
    const ixData = this.borshInstructionCoder.decode(decodedData)
      ?.data as PostMessageShimInstructionData;
    expect(ixData).toBeTruthy();
    const { nonce, consistencyLevel, payload } = ixData;
    return {
      nonce,
      consistencyLevel,
      payload,
    };
  };

  /**
   * Decodes and parses the program input data to extract the `MessageEvent`
   * @param data The Post Message Shim program input data encoded as base 58
   * @returns Parsed `PostMessageShimMessageEvent`
   */
  parseMessageEvent = (data: string): PostMessageShimMessageEvent => {
    const decodedData = anchor.utils.bytes.bs58.decode(data);
    // TODO: BorshEventCoder, BorshCoder, etc. failed to decode
    // So we manually extract the event fields and return
    const emitter = new anchor.web3.PublicKey(decodedData.subarray(16, 48));
    const sequence = new anchor.BN(decodedData.subarray(48, 56), "le");
    const submissionTime = new anchor.BN(
      decodedData.subarray(56, 60),
      "le"
    ).toNumber();
    return {
      emitter,
      sequence,
      submissionTime,
    };
  };

  /**
   * Busy-waits on the transaction and filters the `innerInstructions` to return only the Post Message Shim instructions
   * @param tx Transaction hash to poll
   * @returns Post Message Shim instructions
   */
  getInstructions = async (tx: string) => {
    const txDetails = await getTransactionDetails(this.connection, tx);

    expect(txDetails.meta).toBeTruthy();
    const txMeta = txDetails.meta!;
    expect(txMeta.innerInstructions).toBeTruthy();
    const txInnerIxs = txMeta.innerInstructions!;
    expect(txInnerIxs.length).toBeGreaterThanOrEqual(1);
    const innerIxs = txInnerIxs[txInnerIxs.length - 1]!.instructions;

    // filter to include only Post Message Shim instructions
    const staticAccountKeys = txDetails.transaction.message.staticAccountKeys;
    const postMessageShimAccountIdx = staticAccountKeys.findIndex((key) =>
      key.equals(this.programId)
    );
    const postMessageShimIxs = innerIxs.filter(
      (innerIx) => innerIx.programIdIndex === postMessageShimAccountIdx
    );

    return postMessageShimIxs;
  };
}

/**
 * Try-catch wrapper around `signSendWait`
 * @param chain Chain to execute transaction on
 * @param txs Generator of unsigned transactions
 * @param signer Signing account required by the transactions
 * @returns Signatures of the confirmed transactions
 */
export const signSendWait = async (
  chain: ChainContext<any, any, any>,
  txs: AsyncGenerator<any>,
  signer: Signer
): Promise<TxHash[] | undefined> => {
  try {
    const txIds = await ssw(chain, txs, signer);
    return txIds.map(({ txid }) => txid);
  } catch (e) {
    console.error(e);
  }
};

/**
 * Wrapper around `sendAndConfirmTransaction`
 * @param connection Connection to use
 * @param ixs Instruction(s)/transaction used to create the transaction
 * @param payer Payer of the transaction fees
 * @param signers Signing accounts required by the transaction
 * @returns Signature of the confirmed transaction
 */
export const sendAndConfirm = async (
  connection: anchor.web3.Connection,
  ixs:
    | anchor.web3.TransactionInstruction
    | anchor.web3.Transaction
    | Array<anchor.web3.TransactionInstruction>,
  payer: anchor.web3.Signer,
  ...signers: anchor.web3.Signer[]
): Promise<anchor.web3.TransactionSignature> => {
  const { value } = await connection.getLatestBlockhashAndContext();
  const tx = new anchor.web3.Transaction({
    ...value,
    feePayer: payer.publicKey,
  }).add(...(Array.isArray(ixs) ? ixs : [ixs]));

  return anchor.web3.sendAndConfirmTransaction(
    connection,
    tx,
    [payer, ...signers],
    {}
  );
};

/**
 * Busy-wait wrapper around `getTransaction`
 * @param connection Connection to use
 * @param tx Transaction hash to poll
 * @returns Confirmed transaction from the cluster
 */
export const getTransactionDetails = async (
  connection: anchor.web3.Connection,
  tx: string
): Promise<anchor.web3.VersionedTransactionResponse> => {
  let txDetails: anchor.web3.VersionedTransactionResponse | null = null;
  while (!txDetails) {
    txDetails = await connection.getTransaction(tx, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  }
  return txDetails;
};
