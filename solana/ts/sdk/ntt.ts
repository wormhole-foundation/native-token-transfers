import { Program, web3 } from "@coral-xyz/anchor";
import * as splToken from "@solana/spl-token";
import { createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import { Chain, Network, toChainId } from "@wormhole-foundation/sdk-base";
import {
  AccountAddress,
  ChainAddress,
  ChainsConfig,
  Contracts,
  NativeAddress,
  UnsignedTransaction,
  toUniversal,
} from "@wormhole-foundation/sdk-definitions";
import {
  Ntt,
  SolanaNttTransceiver,
  WormholeNttTransceiver,
} from "@wormhole-foundation/sdk-definitions-ntt";
import {
  AnySolanaAddress,
  SolanaAddress,
  SolanaChains,
  SolanaPlatform,
  SolanaPlatformType,
  SolanaTransaction,
  SolanaUnsignedTransaction,
} from "@wormhole-foundation/sdk-solana";
import {
  SolanaWormholeCore,
  utils,
} from "@wormhole-foundation/sdk-solana-core";
import BN from "bn.js";
import {
  IdlVersion,
  NttBindings,
  getNttProgram,
  getTransceiverProgram,
} from "../lib/bindings.js";
import { NTT, NttQuoter, WEI_PER_GWEI } from "../lib/index.js";
import { parseVersion } from "../lib/utils.js";

export class SolanaNttWormholeTransceiver<
  N extends Network,
  C extends SolanaChains
> implements
    WormholeNttTransceiver<N, C>,
    SolanaNttTransceiver<N, C, WormholeNttTransceiver.VAA>
{
  programId: PublicKey;
  pdas: NTT.TransceiverPdas;

  constructor(
    readonly manager: SolanaNtt<N, C>,
    readonly program: Program<NttBindings.Transceiver<IdlVersion>>,
    readonly version: string = "3.0.0"
  ) {
    this.programId = program.programId;
    this.pdas = NTT.transceiverPdas(program.programId);
  }

  async getPauser(): Promise<AccountAddress<C> | null> {
    return null;
  }

  async *setPauser(_newPauser: AccountAddress<C>, _payer: AccountAddress<C>) {
    throw new Error("Method not implemented.");
  }

  // NOTE: this method is not used for the Solana Wormhole transceiver.
  // `createReceiveIx` is used directly as it can be batched with other ixs in a single tx
  async *receive(
    attestation: WormholeNttTransceiver.VAA,
    payer: AccountAddress<C>
  ) {
    if (attestation.payloadName !== "WormholeTransfer") {
      throw new Error("Invalid attestation payload");
    }
    const senderAddress = new SolanaAddress(payer).unwrap();

    const ix = await this.createReceiveIx(attestation, senderAddress);
    const tx = new Transaction();
    tx.feePayer = senderAddress;
    tx.add(ix);
    yield this.manager.createUnsignedTx({ transaction: tx }, "Ntt.Redeem");
  }

  async createReceiveIx(
    attestation: WormholeNttTransceiver.VAA<"WormholeTransfer">,
    payer: PublicKey
  ) {
    const nttMessage = attestation.payload.nttManagerPayload;
    const chain = attestation.emitterChain;
    return this.program.methods
      .receiveWormholeMessage()
      .accounts({
        payer,
        config: { config: this.manager.pdas.configAccount() },
        peer: this.pdas.transceiverPeerAccount(chain),
        vaa: utils.derivePostedVaaKey(
          this.manager.core.address,
          Buffer.from(attestation.hash)
        ),
        transceiverMessage: this.pdas.transceiverMessageAccount(
          chain,
          nttMessage.id
        ),
      })
      .instruction();
  }

  async getTransceiverType(payer: AccountAddress<C>): Promise<string> {
    // NOTE: transceiver type does not exist for versions < 3.x.x so we hardcode
    const [major, , ,] = parseVersion(this.version);
    if (major < 3) {
      return "wormhole";
    }

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
    const payerKey = new SolanaAddress(payer).unwrap();
    const ix = await this.program.methods
      .transceiverType()
      .accountsStrict({})
      .instruction();
    const latestBlockHash =
      await this.program.provider.connection.getLatestBlockhash();

    const msg = new TransactionMessage({
      payerKey,
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
    if (txSimulation.value.returnData?.data[0]) {
      const buffer = Buffer.from(
        txSimulation.value.returnData?.data[0],
        "base64"
      );
      const len = buffer.readUInt32LE(0);
      return buffer.subarray(4, len + 4).toString();
    } else {
      throw new Error("no transceiver type found");
    }
  }

  getAddress(): ChainAddress<C> {
    return {
      chain: this.manager.chain,
      address: toUniversal(
        this.manager.chain,
        this.pdas.emitterAccount().toBase58()
      ),
    };
  }

  async *setPeer(peer: ChainAddress<C>, payer: AccountAddress<C>) {
    const sender = new SolanaAddress(payer).unwrap();
    const ix = await this.program.methods
      .setWormholePeer({
        chainId: { id: toChainId(peer.chain) },
        address: Array.from(peer.address.toUniversalAddress().toUint8Array()),
      })
      .accounts({
        payer: sender,
        owner: sender,
        config: this.manager.pdas.configAccount(),
        peer: this.pdas.transceiverPeerAccount(peer.chain),
      })
      .instruction();

    const wormholeMessage = Keypair.generate();
    const broadcastIx = await this.createBroadcastWormholePeerIx(
      peer.chain,
      sender,
      wormholeMessage.publicKey
    );

    const tx = new Transaction();
    tx.feePayer = sender;
    tx.add(ix, broadcastIx);
    yield this.manager.createUnsignedTx(
      { transaction: tx, signers: [wormholeMessage] },
      "Ntt.SetWormholeTransceiverPeer"
    );
  }

  async getPeer<C extends Chain>(chain: C): Promise<ChainAddress<C> | null> {
    const peer =
      await this.manager.program.account.transceiverPeer.fetchNullable(
        this.pdas.transceiverPeerAccount(chain)
      );

    if (!peer) return null;

    return {
      chain,
      address: toUniversal(chain, new Uint8Array(peer.address)),
    };
  }

  async createBroadcastWormholeIdIx(
    payer: PublicKey,
    config: NttBindings.Config<IdlVersion>,
    wormholeMessage: PublicKey
  ): Promise<web3.TransactionInstruction> {
    const whAccs = utils.getWormholeDerivedAccounts(
      this.program.programId,
      this.manager.core.address
    );

    return this.program.methods
      .broadcastWormholeId()
      .accountsStrict({
        payer,
        config: this.manager.pdas.configAccount(),
        mint: config.mint,
        wormholeMessage: wormholeMessage,
        emitter: whAccs.wormholeEmitter,
        wormhole: {
          bridge: whAccs.wormholeBridge,
          feeCollector: whAccs.wormholeFeeCollector,
          sequence: whAccs.wormholeSequence,
          program: this.manager.core.address,
          systemProgram: SystemProgram.programId,
          clock: web3.SYSVAR_CLOCK_PUBKEY,
          rent: web3.SYSVAR_RENT_PUBKEY,
        },
      })
      .instruction();
  }

  async createBroadcastWormholePeerIx(
    chain: Chain,
    payer: PublicKey,
    wormholeMessage: PublicKey
  ): Promise<web3.TransactionInstruction> {
    const whAccs = utils.getWormholeDerivedAccounts(
      this.program.programId,
      this.manager.core.address
    );

    return this.program.methods
      .broadcastWormholePeer({ chainId: toChainId(chain) })
      .accounts({
        payer: payer,
        config: this.manager.pdas.configAccount(),
        peer: this.pdas.transceiverPeerAccount(chain),
        wormholeMessage: wormholeMessage,
        emitter: whAccs.wormholeEmitter,
        wormhole: {
          bridge: whAccs.wormholeBridge,
          feeCollector: whAccs.wormholeFeeCollector,
          sequence: whAccs.wormholeSequence,
          program: this.manager.core.address,
        },
      })
      .instruction();
  }

  async createReleaseWormholeOutboundIx(
    payer: PublicKey,
    outboxItem: PublicKey,
    revertOnDelay: boolean
  ): Promise<web3.TransactionInstruction> {
    const [major, , ,] = parseVersion(this.version);
    const whAccs = utils.getWormholeDerivedAccounts(
      this.program.programId,
      this.manager.core.address
    );

    return this.program.methods
      .releaseWormholeOutbound({
        revertOnDelay: revertOnDelay,
      })
      .accounts({
        payer,
        config: { config: this.manager.pdas.configAccount() },
        outboxItem,
        wormholeMessage: this.pdas.wormholeMessageAccount(outboxItem),
        emitter: whAccs.wormholeEmitter,
        transceiver: this.manager.pdas.registeredTransceiver(
          this.program.programId
        ),
        wormhole: {
          bridge: whAccs.wormholeBridge,
          feeCollector: whAccs.wormholeFeeCollector,
          sequence: whAccs.wormholeSequence,
          program: this.manager.core.address,
        },
        // NOTE: baked-in transceiver case is handled separately
        // due to tx size error when LUT is not configured
        ...(major >= 3 && {
          manager: this.manager.program.programId,
          outboxItemSigner: this.pdas.outboxItemSigner(),
        }),
      })
      .instruction();
  }
}

export class SolanaNtt<N extends Network, C extends SolanaChains>
  implements Ntt<N, C>
{
  core: SolanaWormholeCore<N, C>;
  pdas: NTT.Pdas;

  program: Program<NttBindings.NativeTokenTransfer<IdlVersion>>;

  config?: NttBindings.Config<IdlVersion>;
  quoter?: NttQuoter;
  addressLookupTable?: AddressLookupTableAccount;

  // 0 = Wormhole xcvr
  transceivers: Program<NttBindings.Transceiver<IdlVersion>>[];

  // NOTE: these are stored from the constructor, but are not used directly
  // (only in verifyAddresses)
  private managerAddress: string;
  private tokenAddress: string;

  constructor(
    readonly network: N,
    readonly chain: C,
    readonly connection: Connection,
    readonly contracts: Contracts & { ntt?: Ntt.Contracts },
    readonly version: string = "3.0.0"
  ) {
    if (!contracts.ntt) throw new Error("Ntt contracts not found");

    this.program = getNttProgram(
      connection,
      contracts.ntt.manager,
      version as IdlVersion
    );

    this.transceivers = [];
    if (
      "wormhole" in contracts.ntt.transceiver &&
      contracts.ntt.transceiver["wormhole"]
    ) {
      const transceiverTypes = [
        "wormhole", // wormhole xcvr should be ix 0
        ...Object.keys(contracts.ntt.transceiver).filter((transceiverType) => {
          transceiverType !== "wormhole";
        }),
      ];
      transceiverTypes.map((transceiverType) => {
        // we currently only support wormhole transceivers
        if (transceiverType !== "wormhole") {
          throw new Error(`Unsupported transceiver type: ${transceiverType}`);
        }

        const transceiverKey = new PublicKey(
          contracts.ntt!.transceiver[transceiverType]!
        );
        // handle emitterAccount case separately
        if (!PublicKey.isOnCurve(transceiverKey)) {
          const whTransceiver = new SolanaNttWormholeTransceiver(
            this,
            getTransceiverProgram(
              connection,
              contracts.ntt!.manager,
              version as IdlVersion
            ),
            version
          );
          if (!whTransceiver.pdas.emitterAccount().equals(transceiverKey)) {
            throw new Error(
              `Invalid emitterAccount provided. Expected: ${whTransceiver.pdas
                .emitterAccount()
                .toBase58()}; Actual: ${transceiverKey.toBase58()}`
            );
          }
          this.transceivers.push(whTransceiver.program);
        } else {
          this.transceivers.push(
            getTransceiverProgram(
              connection,
              contracts.ntt!.transceiver[transceiverType]!,
              version as IdlVersion
            )
          );
        }
      });
    }

    this.managerAddress = contracts.ntt.manager;
    this.tokenAddress = contracts.ntt.token;

    if (this.contracts.ntt?.quoter)
      this.quoter = new NttQuoter(
        connection,
        this.contracts.ntt.quoter!,
        this.contracts.ntt.manager
      );

    this.core = new SolanaWormholeCore<N, C>(
      network,
      chain,
      connection,
      contracts
    );
    this.pdas = NTT.pdas(this.program.programId);
  }

  async getTransceiver<T extends number>(
    ix: T
  ): Promise<
    | (T extends 0
        ? SolanaNttWormholeTransceiver<N, C>
        : SolanaNttTransceiver<N, C, any>)
    | null
  > {
    const transceiverProgram = this.transceivers[ix] ?? null;
    if (!transceiverProgram) return null;
    if (ix === 0)
      return new SolanaNttWormholeTransceiver(
        this,
        transceiverProgram,
        this.version
      );
    return null;
  }

  async getWormholeTransceiver(): Promise<SolanaNttWormholeTransceiver<
    N,
    C
  > | null> {
    return this.getTransceiver(0);
  }

  async getMode(): Promise<Ntt.Mode> {
    const config = await this.getConfig();
    return config.mode.locking != null ? "locking" : "burning";
  }

  async isPaused(): Promise<boolean> {
    const config = await this.getConfig();
    return config.paused;
  }

  async *pause(payer: AccountAddress<C>) {
    const sender = new SolanaAddress(payer).unwrap();
    const ix = await NTT.createSetPausedInstruction(this.program, {
      owner: sender,
      paused: true,
    });

    const tx = new Transaction();
    tx.feePayer = sender;
    tx.add(ix);
    yield this.createUnsignedTx({ transaction: tx }, "Ntt.Pause");
  }

  async *unpause(payer: AccountAddress<C>) {
    const sender = new SolanaAddress(payer).unwrap();
    const ix = await NTT.createSetPausedInstruction(this.program, {
      owner: sender,
      paused: false,
    });

    const tx = new Transaction();
    tx.feePayer = sender;
    tx.add(ix);
    yield this.createUnsignedTx({ transaction: tx }, "Ntt.Unpause");
  }

  async getThreshold(): Promise<number> {
    const config = await this.getConfig();
    return config.threshold;
  }

  async getOwner(): Promise<AccountAddress<C>> {
    const config = await this.getConfig();
    return new SolanaAddress(config.owner) as AccountAddress<C>;
  }

  async getPauser(): Promise<AccountAddress<C> | null> {
    return null;
  }

  async *setOwner(newOwner: AnySolanaAddress, payer: AccountAddress<C>) {
    const sender = new SolanaAddress(payer).unwrap();
    const ix = await NTT.createTransferOwnershipInstruction(this.program, {
      newOwner: new SolanaAddress(newOwner).unwrap(),
    });

    const tx = new Transaction();
    tx.feePayer = sender;
    tx.add(ix);
    yield this.createUnsignedTx({ transaction: tx }, "Ntt.SetOwner");
  }

  async *setPauser(_newPauser: AnySolanaAddress, _payer: AccountAddress<C>) {
    throw new Error("Pauser role not supported on Solana.");
  }

  async isRelayingAvailable(destination: Chain): Promise<boolean> {
    if (!this.quoter) return false;
    return await this.quoter.isRelayEnabled(destination);
  }

  async quoteDeliveryPrice(
    destination: Chain,
    options: Ntt.TransferOptions
  ): Promise<bigint> {
    if (!this.quoter) throw new Error("Quoter not available");
    if (!this.quoter.isRelayEnabled(destination))
      throw new Error("Relay not enabled");

    return await this.quoter.quoteDeliveryPrice(
      destination,
      options.gasDropoff
    );
  }

  static async fromRpc<N extends Network>(
    provider: Connection,
    config: ChainsConfig<N, SolanaPlatformType>
  ): Promise<SolanaNtt<N, SolanaChains>> {
    const [network, chain] = await SolanaPlatform.chainFromRpc(provider);
    const conf = config[chain]!;

    if (conf.network !== network)
      throw new Error(`Network mismatch: ${conf.network} != ${network}`);

    if (!("ntt" in conf.contracts)) throw new Error("Ntt contracts not found");
    const ntt = conf.contracts["ntt"];

    const version = await SolanaNtt.getVersion(
      provider,
      //@ts-ignore
      conf.contracts
    );

    return new SolanaNtt(
      network as N,
      chain,
      provider,
      { ...conf.contracts, ntt },
      version
    );
  }

  async getConfig(): Promise<NttBindings.Config<IdlVersion>> {
    this.config = this.config ?? (await NTT.getConfig(this.program, this.pdas));
    return this.config!;
  }

  async getTokenDecimals(): Promise<number> {
    const config = await this.getConfig();
    return await SolanaPlatform.getDecimals(
      this.chain,
      this.connection,
      config.mint
    );
  }

  async getPeer<C extends Chain>(chain: C): Promise<Ntt.Peer<C> | null> {
    const peer = await this.program.account.nttManagerPeer.fetchNullable(
      this.pdas.peerAccount(chain)
    );

    if (!peer) return null;

    return {
      address: {
        chain: chain,
        address: toUniversal(chain, new Uint8Array(peer.address)),
      },
      tokenDecimals: peer.tokenDecimals,
      gasLimit: BigInt(0), //TODO: read this from peer account
      inboundLimit: await this.getInboundLimit(chain),
    };
  }

  async getCustodyAddress(): Promise<string> {
    return (await this.getConfig()).custody.toBase58();
  }

  static async getVersion(
    connection: Connection,
    contracts: Contracts & { ntt: Ntt.Contracts },
    sender?: AccountAddress<SolanaChains>
  ): Promise<IdlVersion> {
    try {
      return await NTT.getVersion(
        connection,
        new PublicKey(contracts.ntt.manager!),
        sender ? new SolanaAddress(sender).unwrap() : undefined
      );
    } catch (e) {
      // This might happen if e.g. the program is not deployed yet.
      const version = "3.0.0";
      return version;
    }
  }

  async *initialize(
    sender: AccountAddress<C>,
    args: {
      mint: PublicKey;
      mode: Ntt.Mode;
      outboundLimit: bigint;
    }
  ) {
    const mintInfo = await this.connection.getAccountInfo(args.mint);
    if (mintInfo === null)
      throw new Error(
        "Couldn't determine token program. Mint account is null."
      );

    const payer = new SolanaAddress(sender).unwrap();

    const ix = await NTT.createInitializeInstruction(
      this.program,
      {
        ...args,
        payer,
        owner: payer,
        chain: this.chain,
        tokenProgram: mintInfo.owner,
      },
      this.pdas
    );

    const tx = new Transaction();
    tx.feePayer = payer;
    tx.add(ix);
    yield this.createUnsignedTx(
      { transaction: tx, signers: [] },
      "Ntt.Initialize"
    );

    yield* this.initializeOrUpdateLUT({ payer });
  }

  async *initializeOrUpdateLUT(args: { payer: PublicKey }) {
    const config = await this.getConfig();

    const whTransceiver = await this.getWormholeTransceiver();
    if (!whTransceiver) {
      throw new Error("wormhole transceiver not found");
    }
    const whTransceiverProgramId = whTransceiver.programId;

    const ix = await NTT.initializeOrUpdateLUT(
      this.program,
      config,
      whTransceiverProgramId,
      {
        payer: args.payer,
        wormholeId: new PublicKey(this.core.address),
      }
    );
    // Already up to date
    if (!ix) return;

    const tx = new Transaction().add(ix);
    tx.feePayer = args.payer;

    yield this.createUnsignedTx({ transaction: tx }, "Ntt.InitializeLUT");
  }

  async *registerWormholeTransceiver(args: {
    payer: AccountAddress<C>;
    owner: AccountAddress<C>;
  }) {
    const payer = new SolanaAddress(args.payer).unwrap();
    const owner = new SolanaAddress(args.owner).unwrap();

    const config = await this.getConfig();
    if (config.paused) throw new Error("Contract is paused");

    const ix = await this.createRegisterTransceiverIx(0, payer, owner);

    const whTransceiver = (await this.getWormholeTransceiver())!;
    const wormholeMessage = Keypair.generate();
    const broadcastIx = await whTransceiver.createBroadcastWormholeIdIx(
      payer,
      config,
      wormholeMessage.publicKey
    );

    const tx = new Transaction();
    tx.feePayer = payer;
    tx.add(ix, broadcastIx);
    yield this.createUnsignedTx(
      { transaction: tx, signers: [wormholeMessage] },
      "Ntt.RegisterTransceiver"
    );
  }

  // TODO: maybe add to Ntt interface
  async createRegisterTransceiverIx(
    ix: number,
    payer: web3.PublicKey,
    owner: web3.PublicKey
  ): Promise<web3.TransactionInstruction> {
    const transceiver = await this.getTransceiver(ix);
    if (!transceiver) {
      throw new Error(`Transceiver not found`);
    }
    const transceiverProgramId = transceiver.programId;

    return this.program.methods
      .registerTransceiver()
      .accountsStrict({
        payer,
        owner,
        config: this.pdas.configAccount(),
        transceiver: transceiverProgramId,
        registeredTransceiver:
          this.pdas.registeredTransceiver(transceiverProgramId),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async *setWormholeTransceiverPeer(
    peer: ChainAddress,
    payer: AccountAddress<C>
  ) {
    yield* this.setTransceiverPeer(0, peer, payer);
  }

  async *setTransceiverPeer(
    ix: number,
    peer: ChainAddress,
    payer: AccountAddress<C>
  ) {
    const transceiver = await this.getTransceiver(ix);
    if (!transceiver) {
      throw new Error("Transceiver not found");
    }
    yield* transceiver.setPeer(peer, payer);
  }

  async *setPeer(
    peer: ChainAddress,
    tokenDecimals: number,
    _gasLimit: bigint,
    inboundLimit: bigint,
    payer: AccountAddress<C>
  ) {
    const sender = new SolanaAddress(payer).unwrap();

    const ix = await NTT.createSetPeerInstruction(this.program, {
      payer: sender,
      owner: sender,
      chain: peer.chain,
      address: peer.address.toUniversalAddress().toUint8Array(),
      limit: new BN(inboundLimit.toString()),
      tokenDecimals,
    });

    const tx = new Transaction();
    tx.feePayer = sender;
    tx.add(ix);
    yield this.createUnsignedTx({ transaction: tx }, "Ntt.SetPeer");
  }

  async *transfer(
    sender: AccountAddress<C>,
    amount: bigint,
    destination: ChainAddress,
    options: Ntt.TransferOptions,
    outboxItem?: Keypair
  ): AsyncGenerator<UnsignedTransaction<N, C>, any, unknown> {
    const config = await this.getConfig();
    if (config.paused) throw new Error("Contract is paused");

    outboxItem = outboxItem ?? Keypair.generate();

    const payerAddress = new SolanaAddress(sender).unwrap();
    const fromAuthority = payerAddress;
    const from = await this.getTokenAccount(fromAuthority);

    const transferArgs = NTT.transferArgs(amount, destination, options.queue);

    const txArgs = {
      transferArgs,
      payer: payerAddress,
      from,
      fromAuthority,
      outboxItem: outboxItem.publicKey,
    };

    const approveIx = splToken.createApproveInstruction(
      from,
      this.pdas.sessionAuthority(fromAuthority, transferArgs),
      fromAuthority,
      amount,
      [],
      config.tokenProgram
    );

    const asyncIxs: Promise<web3.TransactionInstruction>[] = [];
    const transferIx =
      config.mode.locking != null
        ? NTT.createTransferLockInstruction(
            this.program,
            config,
            txArgs,
            this.pdas
          )
        : NTT.createTransferBurnInstruction(
            this.program,
            config,
            txArgs,
            this.pdas
          );
    asyncIxs.push(transferIx);

    for (let ix = 0; ix < this.transceivers.length; ++ix) {
      if (ix === 0) {
        const whTransceiver = await this.getWormholeTransceiver();
        if (!whTransceiver) {
          throw new Error("wormhole transceiver not found");
        }
        const releaseIx = whTransceiver.createReleaseWormholeOutboundIx(
          payerAddress,
          outboxItem.publicKey,
          !options.queue
        );
        asyncIxs.push(releaseIx);
      }
    }

    const tx = new Transaction();
    tx.feePayer = payerAddress;
    tx.add(approveIx, ...(await Promise.all(asyncIxs)));

    if (options.automatic) {
      if (!this.quoter)
        throw new Error(
          "No quoter available, cannot initiate an automatic transfer."
        );

      const fee = await this.quoteDeliveryPrice(destination.chain, options);

      const relayIx = await this.quoter.createRequestRelayInstruction(
        payerAddress,
        outboxItem.publicKey,
        destination.chain,
        Number(fee) / LAMPORTS_PER_SOL,
        // NOTE: quoter expects gas dropoff to be in terms of gwei
        Number(options.gasDropoff ?? 0n) / WEI_PER_GWEI
      );
      tx.add(relayIx);
    }

    const luts: AddressLookupTableAccount[] = [];
    try {
      luts.push(await this.getAddressLookupTable());
    } catch {}

    const messageV0 = new TransactionMessage({
      payerKey: payerAddress,
      instructions: tx.instructions,
      recentBlockhash: (await this.connection.getLatestBlockhash()).blockhash,
    }).compileToV0Message(luts);

    const vtx = new VersionedTransaction(messageV0);

    yield this.createUnsignedTx(
      { transaction: vtx, signers: [outboxItem] },
      "Ntt.Transfer"
    );
  }

  private async getTokenAccount(sender: PublicKey): Promise<PublicKey> {
    const config = await this.getConfig();
    const tokenAccount = await splToken.getAssociatedTokenAddress(
      config.mint,
      sender,
      true,
      config.tokenProgram
    );
    return tokenAccount;
  }

  private async *createAta(sender: AccountAddress<C>) {
    const config = await this.getConfig();
    const senderAddress = new SolanaAddress(sender).unwrap();

    const ata = await this.getTokenAccount(senderAddress);

    // If the ata doesn't exist yet, create it
    const acctInfo = await this.connection.getAccountInfo(ata);
    if (acctInfo === null) {
      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          senderAddress,
          ata,
          senderAddress,
          config.mint,
          config.tokenProgram
        )
      );
      transaction.feePayer = senderAddress;
      yield this.createUnsignedTx({ transaction }, "Redeem.CreateATA");
    }
  }

  async *redeem(attestations: Ntt.Attestation[], payer: AccountAddress<C>) {
    const config = await this.getConfig();
    if (config.paused) throw new Error("Contract is paused");

    if (attestations.length !== this.transceivers.length) {
      throw new Error("Not enough attestations provided");
    }

    for (const { attestation, ix } of attestations.map((attestation, ix) => ({
      attestation,
      ix,
    }))) {
      if (ix === 0) {
        const wormholeNTT = attestation;
        if (wormholeNTT.payloadName !== "WormholeTransfer") {
          throw new Error("Invalid attestation payload");
        }
        const whTransceiver = await this.getWormholeTransceiver();
        if (!whTransceiver) {
          throw new Error("wormhole transceiver not found");
        }

        // Create the vaa if necessary
        yield* this.createAta(payer);

        // Post the VAA that we intend to redeem
        yield* this.core.postVaa(payer, wormholeNTT);

        const senderAddress = new SolanaAddress(payer).unwrap();

        const receiveMessageIx = whTransceiver.createReceiveIx(
          wormholeNTT,
          senderAddress
        );

        const redeemIx = NTT.createRedeemInstruction(
          this.program,
          config,
          whTransceiver.program.programId,
          {
            payer: senderAddress,
            vaa: wormholeNTT,
          }
        );

        const nttMessage = wormholeNTT.payload.nttManagerPayload;
        const emitterChain = wormholeNTT.emitterChain;
        const releaseArgs = {
          payer: senderAddress,
          config,
          nttMessage,
          recipient: new PublicKey(
            nttMessage.payload.recipientAddress.toUint8Array()
          ),
          chain: emitterChain,
          revertOnDelay: false,
        };
        const releaseIx =
          config.mode.locking != null
            ? NTT.createReleaseInboundUnlockInstruction(
                this.program,
                config,
                releaseArgs
              )
            : NTT.createReleaseInboundMintInstruction(
                this.program,
                config,
                releaseArgs
              );

        const tx = new Transaction();
        tx.feePayer = senderAddress;
        tx.add(...(await Promise.all([receiveMessageIx, redeemIx, releaseIx])));

        const luts: AddressLookupTableAccount[] = [];
        try {
          luts.push(await this.getAddressLookupTable());
        } catch {}

        const messageV0 = new TransactionMessage({
          payerKey: senderAddress,
          instructions: tx.instructions,
          recentBlockhash: (await this.connection.getLatestBlockhash())
            .blockhash,
        }).compileToV0Message(luts);

        const vtx = new VersionedTransaction(messageV0);

        yield this.createUnsignedTx({ transaction: vtx }, "Ntt.Redeem");
      }
    }
  }

  async getCurrentOutboundCapacity(): Promise<bigint> {
    const rl = await this.program.account.outboxRateLimit.fetch(
      this.pdas.outboxRateLimitAccount()
    );
    return BigInt(rl.rateLimit.capacityAtLastTx.toString());
  }

  async getOutboundLimit(): Promise<bigint> {
    const rl = await this.program.account.outboxRateLimit.fetch(
      this.pdas.outboxRateLimitAccount()
    );
    return BigInt(rl.rateLimit.limit.toString());
  }

  async *setOutboundLimit(limit: bigint, payer: AccountAddress<C>) {
    const sender = new SolanaAddress(payer).unwrap();
    const ix = await NTT.createSetOutboundLimitInstruction(this.program, {
      owner: sender,
      limit: new BN(limit.toString()),
    });

    const tx = new Transaction();
    tx.feePayer = sender;
    tx.add(ix);
    yield this.createUnsignedTx({ transaction: tx }, "Ntt.SetOutboundLimit");
  }

  async getCurrentInboundCapacity(fromChain: Chain): Promise<bigint> {
    const rl = await this.program.account.inboxRateLimit.fetch(
      this.pdas.inboxRateLimitAccount(fromChain)
    );
    return BigInt(rl.rateLimit.capacityAtLastTx.toString());
  }

  async getRateLimitDuration(): Promise<bigint> {
    // The rate limit duration is hardcoded to 24 hours on Solana
    return BigInt(24 * 60 * 60);
  }

  async getInboundLimit(fromChain: Chain): Promise<bigint> {
    const rl = await this.program.account.inboxRateLimit.fetch(
      this.pdas.inboxRateLimitAccount(fromChain)
    );
    return BigInt(rl.rateLimit.limit.toString());
  }

  async *setInboundLimit(
    fromChain: Chain,
    limit: bigint,
    payer: AccountAddress<C>
  ) {
    const sender = new SolanaAddress(payer).unwrap();
    const ix = await NTT.setInboundLimit(this.program, {
      owner: sender,
      chain: fromChain,
      limit: new BN(limit.toString()),
    });

    const tx = new Transaction();
    tx.feePayer = sender;
    tx.add(ix);
    yield this.createUnsignedTx({ transaction: tx }, "Ntt.SetInboundLimit");
  }

  async getIsExecuted(attestation: Ntt.Attestation): Promise<boolean> {
    if (attestation.payloadName !== "WormholeTransfer") return false;
    const payload = attestation.payload["nttManagerPayload"];
    let inboxItem;
    try {
      inboxItem = await this.program.account.inboxItem.fetch(
        this.pdas.inboxItemAccount(attestation.emitterChain, payload)
      );
    } catch (e: any) {
      if (e.message?.includes("Account does not exist")) {
        return false;
      }
      throw e;
    }
    return !!inboxItem.releaseStatus.released;
  }

  async getIsTransferInboundQueued(
    attestation: Ntt.Attestation
  ): Promise<boolean> {
    if (attestation.payloadName !== "WormholeTransfer") return false;
    const payload = attestation.payload["nttManagerPayload"];
    let inboxItem;
    try {
      inboxItem = await this.program.account.inboxItem.fetch(
        this.pdas.inboxItemAccount(attestation.emitterChain, payload)
      );
    } catch (e: any) {
      if (e.message?.includes("Account does not exist")) {
        return false;
      }
      throw e;
    }
    return !!inboxItem.releaseStatus.releaseAfter;
  }

  async getIsApproved(attestation: Ntt.Attestation): Promise<boolean> {
    if (attestation.payloadName !== "WormholeTransfer") {
      throw new Error(`Invalid payload: ${attestation.payloadName}`);
    }
    const payload = attestation.payload["nttManagerPayload"];
    try {
      // check that the inbox item was initialized
      const inboxItem = await this.program.account.inboxItem.fetch(
        this.pdas.inboxItemAccount(attestation.emitterChain, payload)
      );
      return inboxItem.init;
    } catch (e: any) {
      if (e.message?.includes("Account does not exist")) {
        return false;
      }
      throw e;
    }
  }

  async *completeInboundQueuedTransfer(
    fromChain: Chain,
    transceiverMessage: Ntt.Message,
    payer: AccountAddress<C>
  ) {
    const config = await this.getConfig();
    if (config.paused) throw new Error("Contract is paused");

    const senderAddress = new SolanaAddress(payer).unwrap();
    const tx = new Transaction();
    tx.feePayer = senderAddress;
    const releaseArgs = {
      payer: senderAddress,
      config,
      nttMessage: transceiverMessage,
      recipient: new PublicKey(
        transceiverMessage.payload.recipientAddress.toUint8Array()
      ),
      chain: fromChain,
      revertOnDelay: false,
    };

    tx.add(
      await (config.mode.locking != null
        ? NTT.createReleaseInboundUnlockInstruction(
            this.program,
            config,
            releaseArgs
          )
        : NTT.createReleaseInboundMintInstruction(
            this.program,
            config,
            releaseArgs
          ))
    );

    yield this.createUnsignedTx(
      { transaction: tx },
      "Ntt.CompleteInboundTransfer"
    );
  }

  async getInboundQueuedTransfer(
    chain: Chain,
    nttMessage: Ntt.Message
  ): Promise<Ntt.InboundQueuedTransfer<C> | null> {
    let inboxItem;
    try {
      inboxItem = await this.program.account.inboxItem.fetch(
        this.pdas.inboxItemAccount(chain, nttMessage)
      );
    } catch (e: any) {
      if (e.message?.includes("Account does not exist")) {
        return null;
      }
      throw e;
    }

    if (inboxItem.releaseStatus.releaseAfter) {
      const { recipientAddress, amount, releaseStatus } = inboxItem;
      const rateLimitExpiry = releaseStatus.releaseAfter[0].toNumber();
      const xfer: Ntt.InboundQueuedTransfer<C> = {
        recipient: new SolanaAddress(recipientAddress) as NativeAddress<C>,
        amount: BigInt(amount.toString()),
        rateLimitExpiryTimestamp: rateLimitExpiry,
      };
      return xfer;
    }
    return null;
  }

  async verifyAddresses(): Promise<Partial<Ntt.Contracts> | null> {
    // NOTE: This function should only be called when the wormhole transceiver is the manager.
    // For the generic transceiver case, transceivers can not be compared as there is no
    // reverse lookup given manager address to the registered transceivers.
    const whTransceiver = await this.getWormholeTransceiver();
    const local: Partial<Ntt.Contracts> = {
      manager: this.managerAddress,
      token: this.tokenAddress,
      transceiver: {
        ...(whTransceiver && {
          wormhole: whTransceiver.pdas.emitterAccount().toBase58(),
        }),
      },
    };

    const remote: Partial<Ntt.Contracts> = {
      manager: this.program.programId.toBase58(),
      token: (await this.getConfig()).mint.toBase58(),
      transceiver: {
        wormhole: NTT.transceiverPdas(this.program.programId)
          .emitterAccount()
          .toBase58(),
      },
    };

    const deleteMatching = (a: any, b: any) => {
      for (const k in a) {
        if (typeof a[k] === "object") {
          deleteMatching(a[k], b[k]);
          if (Object.keys(a[k]).length === 0) delete a[k];
        } else if (a[k] === b[k]) {
          delete a[k];
        }
      }
    };

    deleteMatching(remote, local);

    return Object.keys(remote).length > 0 ? remote : null;
  }

  async getAddressLookupTable(
    useCache = true
  ): Promise<AddressLookupTableAccount> {
    if (!useCache || !this.addressLookupTable) {
      const alut = await NTT.getAddressLookupTable(this.program, this.pdas);
      if (alut) this.addressLookupTable = alut;
    }

    if (!this.addressLookupTable)
      throw new Error(
        "Address lookup table not found. Did you forget to call initializeLUT?"
      );

    return this.addressLookupTable;
  }

  createUnsignedTx(
    txReq: SolanaTransaction,
    description: string,
    parallelizable: boolean = false
  ): SolanaUnsignedTransaction<N, C> {
    return new SolanaUnsignedTransaction(
      txReq,
      this.network,
      this.chain,
      description,
      parallelizable
    );
  }
}
