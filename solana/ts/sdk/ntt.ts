import {
  type ChainName,
  toChainId,
  coalesceChainId,
  type ChainId,
  type SignedVaa,
} from "@certusone/wormhole-sdk";
import {
  serializeLayout,
  toChainId as SDKv2toChainId,
} from "@wormhole-foundation/sdk-base";
import { deserialize } from "@wormhole-foundation/sdk-definitions";

import {
  type NttManagerMessage,
  nttManagerMessageLayout,
  nativeTokenTransferLayout,
} from "./nttLayout";
import {
  derivePostedVaaKey,
  getWormholeDerivedAccounts,
} from "@certusone/wormhole-sdk/lib/cjs/solana/wormhole";
import {
  BN,
  translateError,
  type IdlAccounts,
  Program,
} from "@coral-xyz/anchor";
import { associatedAddress } from "@coral-xyz/anchor/dist/cjs/utils/token";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  PublicKey,
  Keypair,
  type TransactionInstruction,
  Transaction,
  sendAndConfirmTransaction,
  type TransactionSignature,
  type Connection,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { Keccak } from "sha3";
import { type ExampleNativeTokenTransfers as RawExampleNativeTokenTransfers } from "../../target/types/example_native_token_transfers";
import {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  programDataAddress,
  chainIdToBeBytes,
  derivePda,
} from "./utils";
import * as splToken from "@solana/spl-token";
import IDL from "../../target/idl/example_native_token_transfers.json";

export * from "./utils/wormhole";

export const nttMessageLayout = nttManagerMessageLayout(
  nativeTokenTransferLayout
);
export type NttMessage = NttManagerMessage<typeof nativeTokenTransferLayout>;

// This is a workaround for the fact that the anchor idl doesn't support generics
// yet. This type is used to remove the generics from the idl types.
type OmitGenerics<T> = {
  [P in keyof T]: T[P] extends Record<"generics", any>
    ? never
    : T[P] extends object
    ? OmitGenerics<T[P]>
    : T[P];
};

export type ExampleNativeTokenTransfers =
  OmitGenerics<RawExampleNativeTokenTransfers>;

export type Config = IdlAccounts<ExampleNativeTokenTransfers>["config"];
export type InboxItem = IdlAccounts<ExampleNativeTokenTransfers>["inboxItem"];

export interface TransferArgs {
  amount: BN;
  recipientChain: { id: ChainId };
  recipientAddress: number[];
  shouldQueue: boolean;
}

export const NTT_PROGRAM_IDS = [
  "NTTManager111111111111111111111111111111111",
  "NTtAaoDJhkeHeaVUHnyhwbPNAN6WgBpHkHBTc6d7vLK",
  "NTTManager222222222222222222222222222222222",
] as const;

export const WORMHOLE_PROGRAM_IDS = [
  "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth", // mainnet
  "3u8hJUVTA4jH1wYAyUur7FFZVQ8H635K3tSHHF4ssjQ5", // testnet
  "Bridge1p5gheXUvJ6jGWGeCsgPKgnE3YgdGKRVCMY9o", // tilt
] as const;

export type NttProgramId = (typeof NTT_PROGRAM_IDS)[number];
export type WormholeProgramId = (typeof WORMHOLE_PROGRAM_IDS)[number];

export class NTT {
  readonly program: Program<ExampleNativeTokenTransfers>;
  readonly wormholeId: PublicKey;
  // mapping from error code to error message. Used for prettifying error messages
  private readonly errors: Map<number, string>;

  constructor(
    connection: Connection,
    args: { nttId: NttProgramId; wormholeId: WormholeProgramId }
  ) {
    // TODO: initialise a new Program here with a passed in Connection
    this.program = new Program(IDL as any, new PublicKey(args.nttId), {
      connection,
    });
    this.wormholeId = new PublicKey(args.wormholeId);
    this.errors = this.processErrors();
  }

  // The `translateError` function expects this format, but the idl gives us a
  // different one, so we preprocess the idl and store the expected format.
  // NOTE: I'm sure there's a function within anchor that does this, but I
  // couldn't find it.
  private processErrors(): Map<number, string> {
    const errors = this.program.idl.errors;
    const result: Map<number, string> = new Map<number, string>();
    errors.forEach((entry) => result.set(entry.code, entry.msg));
    return result;
  }

  // Account addresses

  private derivePda(seeds: Parameters<typeof derivePda>[0]): PublicKey {
    return derivePda(seeds, this.program.programId);
  }

  configAccountAddress(): PublicKey {
    return this.derivePda("config");
  }

  outboxRateLimitAccountAddress(): PublicKey {
    return this.derivePda("outbox_rate_limit");
  }

  inboxRateLimitAccountAddress(chain: ChainName | ChainId): PublicKey {
    const chainId = coalesceChainId(chain);
    return this.derivePda(["inbox_rate_limit", chainIdToBeBytes(chainId)]);
  }

  inboxItemAccountAddress(
    chain: ChainName | ChainId,
    nttMessage: NttMessage
  ): PublicKey {
    const chainId = coalesceChainId(chain);
    const serialized = Buffer.from(
      serializeLayout(
        nttManagerMessageLayout(nativeTokenTransferLayout),
        nttMessage
      )
    );
    const hasher = new Keccak(256); //TODO replace with keccak256 from SDKv2
    hasher.update(Buffer.from(chainIdToBeBytes(chainId)));
    hasher.update(serialized);
    return this.derivePda(["inbox_item", hasher.digest()]);
  }

  sessionAuthorityAddress(sender: PublicKey, args: TransferArgs): PublicKey {
    const { amount, recipientChain, recipientAddress, shouldQueue } = args;
    const serialized = Buffer.concat([
      amount.toArrayLike(Buffer, "be", 8),
      Buffer.from(new BN(recipientChain.id).toArrayLike(Buffer, "be", 2)),
      Buffer.from(new Uint8Array(recipientAddress)),
      Buffer.from([shouldQueue ? 1 : 0]),
    ]);
    const hasher = new Keccak(256);
    hasher.update(serialized);
    return this.derivePda([
      "session_authority",
      sender.toBytes(),
      hasher.digest(),
    ]);
  }

  tokenAuthorityAddress(): PublicKey {
    return this.derivePda("token_authority");
  }

  emitterAccountAddress(): PublicKey {
    return this.derivePda("emitter");
  }

  wormholeMessageAccountAddress(outboxItem: PublicKey): PublicKey {
    return this.derivePda(["message", outboxItem.toBytes()]);
  }

  peerAccountAddress(chain: ChainName | ChainId): PublicKey {
    const chainId = coalesceChainId(chain);
    return this.derivePda(["peer", chainIdToBeBytes(chainId)]);
  }

  transceiverPeerAccountAddress(chain: ChainName | ChainId): PublicKey {
    const chainId = coalesceChainId(chain);
    return this.derivePda(["transceiver_peer", chainIdToBeBytes(chainId)]);
  }

  upgradeLockAccountAddress(): PublicKey {
    return this.derivePda("upgrade_lock");
  }

  transceiverMessageAccountAddress(
    chain: ChainName | ChainId,
    id: Uint8Array
  ): PublicKey {
    const chainId = coalesceChainId(chain);
    if (id.length != 32) {
      throw new Error("id must be 32 bytes");
    }
    return this.derivePda([
      "transceiver_message",
      chainIdToBeBytes(chainId),
      id,
    ]);
  }

  registeredTransceiverAddress(transceiver: PublicKey): PublicKey {
    return this.derivePda(["registered_transceiver", transceiver.toBytes()]);
  }

  // View functions

  async version(pubkey: PublicKey): Promise<string> {
    // the anchor library has a built-in method to read view functions. However,
    // it requires a signer, which would trigger a wallet prompt on the frontend.
    // Instead, we manually construct a versioned transaction and call the
    // simulate function with sigVerify: false below.
    //
    // This way, the simulation won't require a signer, but it still requires
    // the pubkey of an account that has some lamports in it (since the
    // simulation checks if the account has enough money to pay for the transaction).
    //
    // It's a little unfortunate but it's the best we can do.
    const ix = await this.program.methods
      .version()
      .accountsStrict({})
      .instruction();
    const latestBlockHash =
      await this.program.provider.connection.getLatestBlockhash();

    const msg = new TransactionMessage({
      payerKey: pubkey,
      recentBlockhash: latestBlockHash.blockhash,
      instructions: [ix],
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);

    const txSimulation =
      await this.program.provider.connection.simulateTransaction(tx, {
        sigVerify: false,
      });

    // the return buffer is in base64 and it encodes the string with a 32 bit
    // little endian length prefix.
    const returnData = txSimulation.value.returnData?.data[0];
    if (returnData === undefined) throw new Error("Didn't get any data when querying version");
    const buffer = Buffer.from(returnData, "base64");
    const len = buffer.readUInt32LE(0);
    return buffer.slice(4, len + 4).toString();
  }

  // Instructions

  async createInitializeInstruction(args: {
    payer: PublicKey;
    owner: PublicKey;
    chain: ChainName;
    mint: PublicKey;
    outboundLimit: BN;
    mode: "burning" | "locking";
  }) {
    const mode: any =
      args.mode === "burning" ? { burning: {} } : { locking: {} };
    const chainId = toChainId(args.chain);
    const mintInfo = await this.program.provider.connection.getAccountInfo(
      args.mint
    );
    if (mintInfo === null) {
      throw new Error(
        "Couldn't determine token program. Mint account is null."
      );
    }
    const tokenProgram = mintInfo.owner;
    const ix = await this.program.methods
      .initialize({ chainId, limit: args.outboundLimit, mode })
      .accounts({
        payer: args.payer,
        deployer: args.owner,
        programData: programDataAddress(this.program.programId),
        config: this.configAccountAddress(),
        mint: args.mint,
        rateLimit: this.outboxRateLimitAccountAddress(),
        tokenProgram,
        tokenAuthority: this.tokenAuthorityAddress(),
        custody: await this.custodyAccountAddress(args.mint),
        bpfLoaderUpgradeableProgram: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
      })
      .instruction();
    return ix;
  }

  async initialize(args: {
    payer: Keypair;
    owner: Keypair;
    chain: ChainName;
    mint: PublicKey;
    outboundLimit: BN;
    mode: "burning" | "locking";
  }) {
    const initializeInstruction = await this.createInitializeInstruction({
      ...args,
      payer: args.payer.publicKey,
      owner: args.owner.publicKey,
    });

    return sendAndConfirmTransaction(
      this.program.provider.connection,
      new Transaction().add(initializeInstruction),
      [args.payer, args.owner]
    );
  }

  async transfer(args: {
    payer: Keypair;
    from: PublicKey;
    fromAuthority: Keypair;
    amount: BN;
    recipientChain: ChainName;
    recipientAddress: ArrayLike<number>;
    shouldQueue: boolean;
    outboxItem?: Keypair;
    config?: Config;
  }): Promise<PublicKey> {
    const config: Config = await this.getConfig(args.config);

    const outboxItem = args.outboxItem ?? Keypair.generate();

    const txArgs = {
      ...args,
      payer: args.payer.publicKey,
      fromAuthority: args.fromAuthority.publicKey,
      outboxItem: outboxItem.publicKey,
      config,
    };

    let transferIx: TransactionInstruction;
    if (config.mode.locking != null) {
      transferIx = await this.createTransferLockInstruction(txArgs);
    } else if (config.mode.burning != null) {
      transferIx = await this.createTransferBurnInstruction(txArgs);
    } else {
      // @ts-ignore
      transferIx = exhaustive(config.mode);
    }

    const releaseIx: TransactionInstruction =
      await this.createReleaseOutboundInstruction({
        payer: args.payer.publicKey,
        outboxItem: outboxItem.publicKey,
        revertOnDelay: !args.shouldQueue,
      });

    const signers = [args.payer, args.fromAuthority, outboxItem];

    const transferArgs: TransferArgs = {
      amount: args.amount,
      recipientChain: { id: toChainId(args.recipientChain) },
      recipientAddress: Array.from(args.recipientAddress),
      shouldQueue: args.shouldQueue,
    };
    const approveIx = splToken.createApproveInstruction(
      args.from,
      this.sessionAuthorityAddress(args.fromAuthority.publicKey, transferArgs),
      args.fromAuthority.publicKey,
      BigInt(args.amount.toString())
    );
    const tx = new Transaction();
    tx.add(approveIx, transferIx, releaseIx);
    await this.sendAndConfirmTransaction(tx, signers);

    return outboxItem.publicKey;
  }

  /**
   * Like `sendAndConfirmTransaction` but parses the anchor error code.
   */
  private async sendAndConfirmTransaction(
    tx: Transaction,
    signers: Keypair[]
  ): Promise<TransactionSignature> {
    try {
      return await sendAndConfirmTransaction(
        this.program.provider.connection,
        tx,
        signers
      );
    } catch (err) {
      throw translateError(err, this.errors);
    }
  }

  /**
   * Creates a transfer_burn instruction. The `payer` and `fromAuthority`
   * arguments must sign the transaction
   */
  async createTransferBurnInstruction(args: {
    payer: PublicKey;
    from: PublicKey;
    fromAuthority: PublicKey;
    amount: BN;
    recipientChain: ChainName;
    recipientAddress: ArrayLike<number>;
    outboxItem: PublicKey;
    shouldQueue: boolean;
    config?: Config;
  }): Promise<TransactionInstruction> {
    const config = await this.getConfig(args.config);

    if (await this.isPaused(config)) {
      throw new Error("Contract is paused");
    }

    const chainId = toChainId(args.recipientChain);
    const mint = await this.mintAccountAddress(config);

    const transferArgs: TransferArgs = {
      amount: args.amount,
      recipientChain: { id: chainId },
      recipientAddress: Array.from(args.recipientAddress),
      shouldQueue: args.shouldQueue,
    };

    return await this.program.methods
      .transferBurn(transferArgs)
      .accounts({
        common: {
          payer: args.payer,
          config: { config: this.configAccountAddress() },
          mint,
          from: args.from,
          outboxItem: args.outboxItem,
          outboxRateLimit: this.outboxRateLimitAccountAddress(),
        },
        peer: this.peerAccountAddress(args.recipientChain),
        inboxRateLimit: this.inboxRateLimitAccountAddress(args.recipientChain),
        sessionAuthority: this.sessionAuthorityAddress(
          args.fromAuthority,
          transferArgs
        ),
      })
      .instruction();
  }

  /**
   * Creates a transfer_lock instruction. The `payer`, `fromAuthority`, and `outboxItem`
   * arguments must sign the transaction
   */
  async createTransferLockInstruction(args: {
    payer: PublicKey;
    from: PublicKey;
    fromAuthority: PublicKey;
    amount: BN;
    recipientChain: ChainName;
    recipientAddress: ArrayLike<number>;
    shouldQueue: boolean;
    outboxItem: PublicKey;
    config?: Config;
  }): Promise<TransactionInstruction> {
    const config = await this.getConfig(args.config);

    if (await this.isPaused(config)) {
      throw new Error("Contract is paused");
    }

    const chainId = toChainId(args.recipientChain);
    const mint = await this.mintAccountAddress(config);

    const transferArgs: TransferArgs = {
      amount: args.amount,
      recipientChain: { id: chainId },
      recipientAddress: Array.from(args.recipientAddress),
      shouldQueue: args.shouldQueue,
    };

    return await this.program.methods
      .transferLock(transferArgs)
      .accounts({
        common: {
          payer: args.payer,
          config: { config: this.configAccountAddress() },
          mint,
          from: args.from,
          tokenProgram: await this.tokenProgram(config),
          outboxItem: args.outboxItem,
          outboxRateLimit: this.outboxRateLimitAccountAddress(),
        },
        peer: this.peerAccountAddress(args.recipientChain),
        inboxRateLimit: this.inboxRateLimitAccountAddress(args.recipientChain),
        custody: await this.custodyAccountAddress(config),
        sessionAuthority: this.sessionAuthorityAddress(
          args.fromAuthority,
          transferArgs
        ),
      })
      .instruction();
  }

  /**
   * Creates a release_outbound instruction. The `payer` needs to sign the transaction.
   */
  async createReleaseOutboundInstruction(args: {
    payer: PublicKey;
    outboxItem: PublicKey;
    revertOnDelay: boolean;
  }): Promise<TransactionInstruction> {
    const whAccs = getWormholeDerivedAccounts(
      this.program.programId,
      this.wormholeId
    );

    return await this.program.methods
      .releaseWormholeOutbound({
        revertOnDelay: args.revertOnDelay,
      })
      .accounts({
        payer: args.payer,
        config: { config: this.configAccountAddress() },
        outboxItem: args.outboxItem,
        wormholeMessage: this.wormholeMessageAccountAddress(args.outboxItem),
        emitter: whAccs.wormholeEmitter,
        transceiver: this.registeredTransceiverAddress(this.program.programId),
        wormhole: {
          bridge: whAccs.wormholeBridge,
          feeCollector: whAccs.wormholeFeeCollector,
          sequence: whAccs.wormholeSequence,
          program: this.wormholeId,
        },
      })
      .instruction();
  }

  async releaseOutbound(args: {
    payer: Keypair;
    outboxItem: PublicKey;
    revertOnDelay: boolean;
    config?: Config;
  }) {
    if (await this.isPaused()) {
      throw new Error("Contract is paused");
    }

    const txArgs = {
      ...args,
      payer: args.payer.publicKey,
    };

    const tx = new Transaction();
    tx.add(await this.createReleaseOutboundInstruction(txArgs));

    const signers = [args.payer];
    return await sendAndConfirmTransaction(
      this.program.provider.connection,
      tx,
      signers
    );
  }

  // TODO: document that if recipient is provided, then the instruction can be
  // created before the inbox item is created (i.e. they can be put in the same tx)
  async createReleaseInboundMintInstruction(args: {
    payer: PublicKey;
    chain: ChainName | ChainId;
    nttMessage: NttMessage;
    revertOnDelay: boolean;
    recipient?: PublicKey;
    config?: Config;
  }): Promise<TransactionInstruction> {
    const config = await this.getConfig(args.config);

    if (await this.isPaused(config)) {
      throw new Error("Contract is paused");
    }

    const recipientAddress =
      args.recipient ??
      (await this.getInboxItem(args.chain, args.nttMessage)).recipientAddress;

    const mint = await this.mintAccountAddress(config);

    return await this.program.methods
      .releaseInboundMint({
        revertOnDelay: args.revertOnDelay,
      })
      .accounts({
        common: {
          payer: args.payer,
          config: { config: this.configAccountAddress() },
          inboxItem: this.inboxItemAccountAddress(args.chain, args.nttMessage),
          recipient: getAssociatedTokenAddressSync(mint, recipientAddress),
          mint,
          tokenAuthority: this.tokenAuthorityAddress(),
        },
      })
      .instruction();
  }

  async releaseInboundMint(args: {
    payer: Keypair;
    chain: ChainName | ChainId;
    nttMessage: NttMessage;
    revertOnDelay: boolean;
    config?: Config;
  }): Promise<void> {
    if (await this.isPaused()) {
      throw new Error("Contract is paused");
    }

    const txArgs = {
      ...args,
      payer: args.payer.publicKey,
    };

    const tx = new Transaction();
    tx.add(await this.createReleaseInboundMintInstruction(txArgs));

    const signers = [args.payer];
    await this.sendAndConfirmTransaction(tx, signers);
  }

  async createReleaseInboundUnlockInstruction(args: {
    payer: PublicKey;
    chain: ChainName | ChainId;
    nttMessage: NttMessage;
    revertOnDelay: boolean;
    recipient?: PublicKey;
    config?: Config;
  }): Promise<TransactionInstruction> {
    const config = await this.getConfig(args.config);

    if (await this.isPaused(config)) {
      throw new Error("Contract is paused");
    }

    const recipientAddress =
      args.recipient ??
      (await this.getInboxItem(args.chain, args.nttMessage)).recipientAddress;

    const mint = await this.mintAccountAddress(config);

    return await this.program.methods
      .releaseInboundUnlock({
        revertOnDelay: args.revertOnDelay,
      })
      .accounts({
        common: {
          payer: args.payer,
          config: { config: this.configAccountAddress() },
          inboxItem: this.inboxItemAccountAddress(args.chain, args.nttMessage),
          recipient: getAssociatedTokenAddressSync(mint, recipientAddress),
          mint,
          tokenAuthority: this.tokenAuthorityAddress(),
        },
        custody: await this.custodyAccountAddress(config),
      })
      .instruction();
  }

  async releaseInboundUnlock(args: {
    payer: Keypair;
    chain: ChainName | ChainId;
    nttMessage: NttMessage;
    revertOnDelay: boolean;
    config?: Config;
  }): Promise<void> {
    if (await this.isPaused()) {
      throw new Error("Contract is paused");
    }

    const txArgs = {
      ...args,
      payer: args.payer.publicKey,
    };

    const tx = new Transaction();
    tx.add(await this.createReleaseInboundUnlockInstruction(txArgs));

    const signers = [args.payer];
    await this.sendAndConfirmTransaction(tx, signers);
  }

  createSetPeerInstruction(args: {
    payer: PublicKey;
    owner: PublicKey;
    chain: ChainName;
    limit: BN;
    address: ArrayLike<number>;
    tokenDecimals: number;
  }) {
    return this.program.methods
      .setPeer({
        chainId: { id: toChainId(args.chain) },
        address: Array.from(args.address),
        limit: args.limit,
        tokenDecimals: args.tokenDecimals,
      })
      .accounts({
        payer: args.payer,
        owner: args.owner,
        config: this.configAccountAddress(),
        peer: this.peerAccountAddress(args.chain),
        inboxRateLimit: this.inboxRateLimitAccountAddress(args.chain),
      })
      .instruction();
  }

  async setPeer(args: {
    payer: Keypair;
    owner: Keypair;
    chain: ChainName;
    address: ArrayLike<number>;
    limit: BN;
    tokenDecimals: number;
    config?: Config;
  }) {
    const ix = await this.createSetPeerInstruction({
      payer: args.payer.publicKey,
      owner: args.owner.publicKey,
      chain: args.chain,
      limit: args.limit,
      tokenDecimals: args.tokenDecimals,
      address: args.address,
    });

    return await sendAndConfirmTransaction(
      this.program.provider.connection,
      new Transaction().add(ix),
      [args.payer, args.owner]
    );
  }

  async createSetTransceiverPeerInstructions(args: {
    chain: ChainName;
    address: ArrayLike<number>;
    payer: PublicKey;
    owner: PublicKey;
    wormholeMessage: Keypair;
  }) {
    const ix = await this.program.methods
      .setWormholePeer({
        chainId: { id: toChainId(args.chain) },
        address: Array.from(args.address),
      })
      .accounts({
        payer: args.payer,
        owner: args.owner,
        config: this.configAccountAddress(),
        peer: this.transceiverPeerAccountAddress(args.chain),
      })
      .instruction();

    const whAccs = getWormholeDerivedAccounts(
      this.program.programId,
      this.wormholeId
    );
    const broadcastIx = await this.program.methods
      .broadcastWormholePeer({ chainId: toChainId(args.chain) })
      .accounts({
        payer: args.payer,
        config: this.configAccountAddress(),
        peer: this.transceiverPeerAccountAddress(args.chain),
        wormholeMessage: args.wormholeMessage.publicKey,
        emitter: this.emitterAccountAddress(),
        wormhole: {
          bridge: whAccs.wormholeBridge,
          feeCollector: whAccs.wormholeFeeCollector,
          sequence: whAccs.wormholeSequence,
          program: this.wormholeId,
        },
      })
      .instruction();
    return [ix, broadcastIx];
  }

  async setWormholeTransceiverPeer(args: {
    payer: Keypair;
    owner: Keypair;
    chain: ChainName;
    address: ArrayLike<number>;
    config?: Config;
  }) {
    const wormholeMessage = Keypair.generate();
    const [ix, broadcastIx] = await this.createSetTransceiverPeerInstructions({
      owner: args.owner.publicKey,
      payer: args.payer.publicKey,
      chain: args.chain,
      address: args.address,
      wormholeMessage,
    });
    return await sendAndConfirmTransaction(
      this.program.provider.connection,
      new Transaction().add(ix, broadcastIx),
      [args.payer, args.owner, wormholeMessage]
    );
  }

  async createRegisterTransceiverInstructions(args: {
    payer: PublicKey;
    owner: PublicKey;
    transceiver: PublicKey;
    wormholeMessage: PublicKey;
  }) {
    const registerIx = await this.program.methods
      .registerTransceiver()
      .accounts({
        payer: args.payer,
        owner: args.owner,
        config: this.configAccountAddress(),
        transceiver: args.transceiver,
        registeredTransceiver: this.registeredTransceiverAddress(
          args.transceiver
        ),
      })
      .instruction();

    const whAccs = getWormholeDerivedAccounts(
      this.program.programId,
      this.wormholeId
    );
    const broadcastIx = await this.program.methods
      .broadcastWormholeId()
      .accounts({
        payer: args.payer,
        config: this.configAccountAddress(),
        mint: await this.mintAccountAddress(),
        wormholeMessage: args.wormholeMessage,
        emitter: this.emitterAccountAddress(),
        wormhole: {
          bridge: whAccs.wormholeBridge,
          feeCollector: whAccs.wormholeFeeCollector,
          sequence: whAccs.wormholeSequence,
          program: this.wormholeId,
        },
      })
      .instruction();

    return [registerIx, broadcastIx];
  }

  async registerTransceiver(args: {
    payer: Keypair;
    owner: Keypair;
    transceiver: PublicKey;
  }) {
    const wormholeMessage = Keypair.generate();
    const instructions = await this.createRegisterTransceiverInstructions({
      ...args,
      payer: args.payer.publicKey,
      owner: args.owner.publicKey,
      wormholeMessage: wormholeMessage.publicKey,
    });

    return await sendAndConfirmTransaction(
      this.program.provider.connection,
      new Transaction().add(...instructions),
      [args.payer, args.owner, wormholeMessage]
    );
  }

  async createSetoutboundLimitInstruction(args: {
    owner: PublicKey;
    limit: BN;
  }) {
    return await this.program.methods
      .setOutboundLimit({
        limit: args.limit,
      })
      .accounts({
        owner: args.owner,
        config: this.configAccountAddress(),
        rateLimit: this.outboxRateLimitAccountAddress(),
      })
      .instruction();
  };

  async setOutboundLimit(args: {
    owner: Keypair;
    chain: ChainName;
    limit: BN;
  }) {
    const ix = await this.createSetoutboundLimitInstruction({
      owner: args.owner.publicKey,
      limit: args.limit,
    });
    
    return sendAndConfirmTransaction(
      this.program.provider.connection,
      new Transaction().add(ix),
      [args.owner]
    );
  }

  async createSetInboundLimitInstruction(args: {
    owner: PublicKey;
    chain: ChainName;
    limit: BN;
  }) {
    return this.program.methods
      .setInboundLimit({
        chainId: { id: toChainId(args.chain) },
        limit: args.limit,
      })
      .accounts({
        owner: args.owner,
        config: this.configAccountAddress(),
        rateLimit: this.inboxRateLimitAccountAddress(args.chain),
      })
      .instruction();
  }

  async setInboundLimit(args: { owner: Keypair; chain: ChainName; limit: BN }) {
    const ix = await this.createSetInboundLimitInstruction({
      owner: args.owner.publicKey,
      chain: args.chain,
      limit: args.limit,
    });

    return sendAndConfirmTransaction(
      this.program.provider.connection,
      new Transaction().add(ix),
      [args.owner]
    );
  }

  async createTransferOwnershipInstruction(args: {
    owner: PublicKey;
    newOwner: PublicKey;
  }) {
    return this.program.methods
      .transferOwnership()
      .accounts({
        owner: args.owner,
        newOwner: args.newOwner,
        config: this.configAccountAddress(),
        upgradeLock: this.upgradeLockAccountAddress(),
        programData: programDataAddress(this.program.programId),
        bpfLoaderUpgradeableProgram: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
      })
      .instruction();
  }

  async createClaimOwnershipInstruction(args: {
    owner: PublicKey;
  }) {
    return this.program.methods
      .claimOwnership()
      .accounts({
        newOwner: args.owner,
        config: this.configAccountAddress(),
        upgradeLock: this.upgradeLockAccountAddress(),
        programData: programDataAddress(this.program.programId),
        bpfLoaderUpgradeableProgram: BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
      })
      .instruction();
  }

  async createReceiveWormholeMessageInstruction(args: {
    payer: PublicKey;
    vaa: SignedVaa;
    config?: Config;
  }): Promise<TransactionInstruction> {
    const config = await this.getConfig(args.config);

    if (await this.isPaused(config)) {
      throw new Error("Contract is paused");
    }

    const wormholeNTT = deserialize("Ntt:WormholeTransfer", args.vaa);
    const nttMessage = wormholeNTT.payload.nttManagerPayload;
    // NOTE: we do an 'as ChainId' cast here, which is generally unsafe.
    // TODO: explain why this is fine here
    const chainId = SDKv2toChainId(wormholeNTT.emitterChain) as ChainId;

    const transceiverPeer = this.transceiverPeerAccountAddress(chainId);

    return await this.program.methods
      .receiveWormholeMessage()
      .accounts({
        payer: args.payer,
        config: { config: this.configAccountAddress() },
        peer: transceiverPeer,
        vaa: derivePostedVaaKey(this.wormholeId, Buffer.from(wormholeNTT.hash)),
        transceiverMessage: this.transceiverMessageAccountAddress(
          chainId,
          nttMessage.id
        ),
      })
      .instruction();
  }

  async createRedeemInstruction(args: {
    payer: PublicKey;
    vaa: SignedVaa;
    config?: Config;
  }): Promise<TransactionInstruction> {
    const config = await this.getConfig(args.config);

    if (await this.isPaused(config)) {
      throw new Error("Contract is paused");
    }

    const wormholeNTT = deserialize("Ntt:WormholeTransfer", args.vaa);
    const nttMessage = wormholeNTT.payload.nttManagerPayload;
    // NOTE: we do an 'as ChainId' cast here, which is generally unsafe.
    // TODO: explain why this is fine here
    const chainId = SDKv2toChainId(wormholeNTT.emitterChain) as ChainId;

    const nttManagerPeer = this.peerAccountAddress(chainId);
    const inboxRateLimit = this.inboxRateLimitAccountAddress(chainId);

    return await this.program.methods
      .redeem({})
      .accounts({
        payer: args.payer,
        config: this.configAccountAddress(),
        peer: nttManagerPeer,
        transceiverMessage: this.transceiverMessageAccountAddress(
          chainId,
          nttMessage.id
        ),
        transceiver: this.registeredTransceiverAddress(this.program.programId),
        mint: await this.mintAccountAddress(config),
        inboxItem: this.inboxItemAccountAddress(chainId, nttMessage),
        inboxRateLimit,
        outboxRateLimit: this.outboxRateLimitAccountAddress(),
      })
      .instruction();
  }

  /**
   * Redeems a VAA.
   *
   * @returns Whether the transfer was released. If the transfer was delayed,
   *          this will be false. In that case, a subsequent call to
   *          `releaseInboundMint` or `releaseInboundUnlock` will release the
   *          transfer after the delay (24h).
   */
  async redeem(args: {
    payer: Keypair;
    vaa: SignedVaa;
    config?: Config;
  }): Promise<boolean> {
    const config = await this.getConfig(args.config);

    const redeemArgs = {
      ...args,
      payer: args.payer.publicKey,
    };

    const wormholeNTT = deserialize("Ntt:WormholeTransfer", args.vaa);
    const nttMessage = wormholeNTT.payload.nttManagerPayload;
    // TODO: explain why this is fine here
    const chainId = SDKv2toChainId(wormholeNTT.emitterChain) as ChainId;

    // Here we create a transaction with three instructions:
    // 1. receive wormhole messsage (vaa)
    // 1. redeem
    // 2. releaseInboundMint or releaseInboundUnlock (depending on mode)
    //
    // The first instruction verifies the VAA.
    // The second instruction places the transfer in the inbox, then the third instruction
    // releases it.
    //
    // In case the redeemed amount exceeds the remaining inbound rate limit capacity,
    // the transaction gets delayed. If this happens, the second instruction will not actually
    // be able to release the transfer yet.
    // To make sure the transaction still succeeds, we set revertOnDelay to false, which will
    // just make the second instruction a no-op in case the transfer is delayed.

    const tx = new Transaction();
    tx.add(await this.createReceiveWormholeMessageInstruction(redeemArgs));
    tx.add(await this.createRedeemInstruction(redeemArgs));

    const releaseArgs = {
      ...args,
      payer: args.payer.publicKey,
      nttMessage,
      recipient: new PublicKey(
        nttMessage.payload.recipientAddress.toUint8Array()
      ),
      chain: chainId,
      revertOnDelay: false,
      config: config,
    };

    if (config.mode.locking != null) {
      tx.add(await this.createReleaseInboundUnlockInstruction(releaseArgs));
    } else {
      tx.add(await this.createReleaseInboundMintInstruction(releaseArgs));
    }

    const signers = [args.payer];
    await this.sendAndConfirmTransaction(tx, signers);

    // Let's check if the transfer was released
    const inboxItem = await this.getInboxItem(chainId, nttMessage);
    return inboxItem.releaseStatus.released !== undefined;
  }

  // Account access

  /**
   * Fetches the Config account from the contract.
   *
   * @param config If provided, the config is just returned without making a
   *               network request. This is handy in case multiple config
   *               accessor functions are used, the config can just be queried
   *               once and passed around.
   */
  async getConfig(config?: Config): Promise<Config> {
    return (
      config ??
      (await this.program.account.config.fetch(this.configAccountAddress()))
    );
  }

  async isPaused(config?: Config): Promise<boolean> {
    return (await this.getConfig(config)).paused;
  }

  async mintAccountAddress(config?: Config): Promise<PublicKey> {
    return (await this.getConfig(config)).mint;
  }

  async tokenProgram(config?: Config): Promise<PublicKey> {
    return (await this.getConfig(config)).tokenProgram;
  }

  async getInboxItem(
    chain: ChainName | ChainId,
    nttMessage: NttMessage
  ): Promise<InboxItem> {
    return await this.program.account.inboxItem.fetch(
      this.inboxItemAccountAddress(chain, nttMessage)
    );
  }

  /**
   * Returns the address of the custody account. If the config is available
   * (i.e. the program is initialised), the mint is derived from the config.
   * Otherwise, the mint must be provided.
   */
  async custodyAccountAddress(
    configOrMint: Config | PublicKey
  ): Promise<PublicKey> {
    if (configOrMint instanceof PublicKey) {
      return associatedAddress({
        mint: configOrMint,
        owner: this.tokenAuthorityAddress(),
      });
    } else {
      return associatedAddress({
        mint: await this.mintAccountAddress(configOrMint),
        owner: this.tokenAuthorityAddress(),
      });
    }
  }
}

function exhaustive<A>(_: never): A {
  throw new Error("Impossible");
}
