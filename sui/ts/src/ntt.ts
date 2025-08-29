import {
  AccountAddress,
  ChainAddress,
  UnsignedTransaction,
  toUniversal,
  Contracts,
  ChainsConfig,
  serialize,
} from "@wormhole-foundation/sdk-definitions";
import type { Chain, Network } from "@wormhole-foundation/sdk-base";
import { chainToChainId, serializeLayout } from "@wormhole-foundation/sdk-base";
import {
  Ntt,
  NttTransceiver,
  nativeTokenTransferLayout,
} from "@wormhole-foundation/sdk-definitions-ntt";
import {
  SuiAddress,
  SuiChains,
  SuiPlatform,
  SuiPlatformType,
  SuiUnsignedTransaction,
} from "@wormhole-foundation/sdk-sui";
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { SUI_ADDRESSES, RATE_LIMIT_DURATION } from "./constants.js";
import {
  SuiMoveObject,
  isNativeToken,
  getSuiObject,
  getWormholePackageId,
  getPackageIdFromObject,
  countSetBits,
  extractNttCommonPackageId,
  createNttManagerMessageObjects,
  parseInboxItemResult,
} from "./utils.js";

interface SuiMode {
  variant: "Locking" | "Burning";
}

interface SuiRateLimitState {
  limit: string;
  capacity_at_last_tx: string;
  last_tx_timestamp: string;
}

interface SuiTransceiverRegistry {
  id: { id: string };
  next_id: string;
  enabled_bitmap: any;
}

interface SuiTable {
  id: { id: string };
  size: string;
}

interface SuiOutbox {
  entries: SuiTable;
  rate_limit: SuiRateLimitState;
}

interface SuiInbox {
  type: string;
  fields: SuiTable;
}

interface SuiNttState {
  id: { id: string };
  mode: SuiMode;
  balance: any; // Balance<T>
  threshold: string;
  treasury_cap: any; // Option<TreasuryCap<T>>
  peers: SuiTable;
  outbox: SuiOutbox;
  inbox: SuiInbox;
  transceivers: SuiTransceiverRegistry;
  chain_id: string;
  next_sequence: string;
  paused: boolean;
  version: string;
  admin_cap_id: string;
  upgrade_cap_id: string;
}

export class SuiNtt<N extends Network, C extends SuiChains>
  implements Ntt<N, C>
{
  readonly coreBridgeStateId: string;
  // Helper function to extract token type from Sui state object
  static async extractTokenTypeFromSuiState(
    provider: SuiClient,
    stateObjectId: string
  ): Promise<string> {
    const response = await provider.getObject({
      id: stateObjectId,
      options: { showType: true },
    });

    if (!response.data?.type) {
      throw new Error("Failed to fetch state object type");
    }

    // Parse the generic type parameter from the state object type
    // Format: "packageId::ntt::State<TokenType>"
    const objectType = response.data.type;
    const genericStart = objectType.indexOf("<");
    const genericEnd = objectType.lastIndexOf(">");

    if (genericStart === -1 || genericEnd === -1) {
      throw new Error(
        `No generic type parameter found in state object type: ${objectType}`
      );
    }

    const tokenType = objectType.substring(genericStart + 1, genericEnd);
    return tokenType;
  }

  // Helper method to fetch and validate NTT state object with proper typing
  private async getNttState(): Promise<SuiNttState> {
    try {
      const content = await getSuiObject(
        this.provider,
        this.contracts.ntt!["manager"],
        "Failed to fetch NTT state object"
      );
      return content.fields as SuiNttState;
    } catch (error: any) {
      throw new Error(
        `Failed to fetch NTT state object: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  readonly network: N;
  readonly chain: C;
  readonly provider: SuiClient;
  private adminCapId?: string; // Cached NTT AdminCap object ID
  private packageId?: string; // Cached NTT package ID for move calls

  constructor(
    network: N,
    chain: C,
    provider: SuiClient,
    readonly contracts: Contracts & { ntt?: Ntt.Contracts }
  ) {
    if (!contracts.ntt) {
      throw new Error("NTT contracts not found");
    }

    if (!contracts.coreBridge) {
      throw new Error("Core Bridge contract not found");
    }

    this.network = network;
    this.chain = chain;
    this.provider = provider;
    this.coreBridgeStateId =
      SUI_ADDRESSES[network as keyof typeof SUI_ADDRESSES].coreBridgeStateId;
  }

  static async fromRpc<N extends Network>(
    provider: SuiClient,
    config: ChainsConfig<N, SuiPlatformType>
  ): Promise<SuiNtt<N, SuiChains>> {
    const [network, chain] = await SuiPlatform.chainFromRpc(provider);
    const conf = config[chain]!;

    if (conf.network !== network)
      throw new Error(`Network mismatch: ${conf.network} != ${network}`);

    if (!("ntt" in conf.contracts)) throw new Error("Ntt contracts not found");

    const ntt = conf.contracts["ntt"];

    return new SuiNtt(network as N, chain, provider, {
      ...conf.contracts,
      ntt,
    });
  }

  // State & Configuration Methods
  async getMode(): Promise<Ntt.Mode> {
    const state = await this.getNttState();
    const modeField = state.mode;

    // Mode is an enum with a variant field: { variant: "Locking" } or { variant: "Burning" }
    if (modeField.variant === "Locking") {
      return "locking";
    } else if (modeField.variant === "Burning") {
      return "burning";
    }

    throw new Error("Invalid mode in NTT state");
  }

  async isPaused(): Promise<boolean> {
    const state = await this.getNttState();
    return state.paused;
  }

  async getAdminCapId(): Promise<string> {
    if (this.adminCapId) {
      return this.adminCapId;
    }

    const state = await this.getNttState();
    if (!state.admin_cap_id) {
      throw new Error("AdminCap ID not found in NTT state");
    }

    this.adminCapId = state.admin_cap_id;
    return this.adminCapId!;
  }

  async getPackageId(): Promise<string> {
    if (this.packageId) {
      return this.packageId;
    }

    const packageIdFromType = await this.getPackageIdFromObject(
      this.contracts.ntt!["manager"]
    );

    this.packageId = packageIdFromType;
    return this.packageId!;
  }

  async getPackageIdFromObject(objectId: string): Promise<string> {
    // TODO: replace with getOriginalPackageId from our sdk?
    const result = await getPackageIdFromObject(this.provider, objectId);
    return result.current;
  }

  async getOwner(): Promise<AccountAddress<C>> {
    const adminCapId = await this.getAdminCapId();

    try {
      const adminCap = await this.provider.getObject({
        id: adminCapId,
        options: {
          showOwner: true,
        },
      });

      if (!adminCap.data?.owner) {
        throw new Error("Could not fetch AdminCap owner information");
      }

      // Extract owner address from the owner field
      let ownerAddress: string;
      if (
        typeof adminCap.data.owner === "object" &&
        "AddressOwner" in adminCap.data.owner
      ) {
        ownerAddress = adminCap.data.owner.AddressOwner;
      } else if (typeof adminCap.data.owner === "string") {
        ownerAddress = adminCap.data.owner;
      } else {
        throw new Error(
          `AdminCap has unexpected owner type: ${JSON.stringify(
            adminCap.data.owner
          )}`
        );
      }

      return ownerAddress as unknown as AccountAddress<C>;
    } catch (error) {
      throw new Error(`Failed to get AdminCap owner: ${error}`);
    }
  }

  async getPauser(): Promise<AccountAddress<C> | null> {
    // In Sui NTT, the owner and pauser are the same (AdminCap holder)
    return this.getOwner();
  }

  async getThreshold(): Promise<number> {
    const state = await this.getNttState();
    return parseInt(state.threshold, 10);
  }

  async *setThreshold(
    threshold: number,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    const adminCapId = await this.getAdminCapId();
    const packageId = await this.getPackageId();

    // Build transaction to set threshold
    const txb = new Transaction();

    txb.moveCall({
      target: `${packageId}::state::set_threshold`,
      typeArguments: [this.contracts.ntt!["token"]], // Use the token type from contracts
      arguments: [
        txb.object(adminCapId), // AdminCap
        txb.object(this.contracts.ntt!["manager"]), // NTT state
        txb.pure.u8(threshold), // New threshold
      ],
    });

    const unsignedTx = new SuiUnsignedTransaction(
      txb,
      this.network,
      this.chain,
      "Set Threshold"
    );

    yield unsignedTx;
  }

  async getTokenDecimals(): Promise<number> {
    const coinMetadata = await this.provider.getCoinMetadata({
      coinType: this.contracts.ntt!["token"],
    });

    if (!coinMetadata?.decimals) {
      throw new Error(
        `CoinMetadata not found for ${this.contracts.ntt!["token"]}`
      );
    }

    return coinMetadata.decimals;
  }

  async getCustodyAddress(): Promise<string> {
    // In Sui, custody is managed by the State object itself
    // Return the state object ID as the custody address
    return this.contracts.ntt!["manager"];
  }

  // Admin Methods
  async *pause(): AsyncGenerator<UnsignedTransaction<N, C>> {
    const adminCapId = await this.getAdminCapId();
    const packageId = await this.getPackageId();

    // Build transaction to pause the contract
    const txb = new Transaction();

    txb.moveCall({
      target: `${packageId}::state::pause`,
      typeArguments: [this.contracts.ntt!["token"]], // Use the token type from contracts
      arguments: [
        txb.object(adminCapId), // AdminCap
        txb.object(this.contracts.ntt!["manager"]), // NTT state
      ],
    });

    const unsignedTx = new SuiUnsignedTransaction(
      txb,
      this.network,
      this.chain,
      "Pause Contract"
    );

    yield unsignedTx;
  }

  async *unpause(): AsyncGenerator<UnsignedTransaction<N, C>> {
    const adminCapId = await this.getAdminCapId();
    const packageId = await this.getPackageId();

    // Build transaction to unpause the contract
    const txb = new Transaction();

    txb.moveCall({
      target: `${packageId}::state::unpause`,
      typeArguments: [this.contracts.ntt!["token"]], // Use the token type from contracts
      arguments: [
        txb.object(adminCapId), // AdminCap
        txb.object(this.contracts.ntt!["manager"]), // NTT state
      ],
    });

    const unsignedTx = new SuiUnsignedTransaction(
      txb,
      this.network,
      this.chain,
      "Unpause Contract"
    );

    yield unsignedTx;
  }

  async *setOwner(
    newOwner: AccountAddress<C>,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    const txb = new Transaction();

    // Get Admin and Upgrade cap IDs
    const adminCapId = await this.getAdminCapId();
    const upgradeCapId = await this.getUpgradeCapId();

    // Transfer AdminCap and UpgradeCap to new owner
    txb.transferObjects(
      [txb.object(adminCapId), txb.object(upgradeCapId)],
      newOwner.toString()
    );

    const unsignedTx = new SuiUnsignedTransaction(
      txb,
      this.network,
      this.chain,
      "Transfer Ownership"
    );

    yield unsignedTx;
  }

  async *setPauser(
    newPauser: AccountAddress<C>,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    // In Sui NTT, owner and pauser are the same (AdminCap holder)
    // Use setOwner instead to change the pauser
    throw new Error(
      "setPauser not supported: owner and pauser are the same in Sui NTT. Use setOwner instead."
    );
  }

  // Peer Management
  async *setPeer(
    peer: ChainAddress,
    tokenDecimals: number,
    inboundLimit: bigint,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    const adminCapId = await this.getAdminCapId();
    const packageId = await this.getPackageId();

    // Build transaction to set peer
    const txb = new Transaction();

    // Convert chain to wormhole chain ID
    const wormholeChainId = chainToChainId(peer.chain);

    // Convert peer address to ExternalAddress format
    const peerAddressBytes: Uint8Array = peer.address.toUint8Array();

    try {
      // Query the wormhole package ID from the state object
      const wormholePackageId = await this.getPackageIdFromObject(
        this.contracts.coreBridge!
      );

      const bytes32 = txb.moveCall({
        target: `${wormholePackageId}::bytes32::from_bytes`,
        arguments: [txb.pure.vector("u8", peerAddressBytes)],
      });

      const externalAddress = txb.moveCall({
        target: `${wormholePackageId}::external_address::new`,
        arguments: [bytes32],
      });

      txb.moveCall({
        target: `${packageId}::state::set_peer`,
        typeArguments: [this.contracts.ntt!["token"]], // Use the token type from contracts
        arguments: [
          txb.object(adminCapId), // AdminCap
          txb.object(this.contracts.ntt!["manager"]), // NTT state
          txb.pure.u16(wormholeChainId), // Chain ID
          externalAddress, // ExternalAddress object (properly created)
          txb.pure.u8(tokenDecimals), // Token decimals
          txb.pure.u64(inboundLimit.toString()), // Inbound limit
          txb.object(SUI_CLOCK_OBJECT_ID),
        ],
      });
    } catch (error) {
      throw new Error(
        `Failed to create setPeer transaction: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const unsignedTx = new SuiUnsignedTransaction(
      txb,
      this.network,
      this.chain,
      "Set Peer"
    );

    yield unsignedTx;
  }

  async getPeer<PC extends Chain>(chain: PC): Promise<Ntt.Peer<PC> | null> {
    const state = await this.provider.getObject({
      id: this.contracts.ntt!["manager"],
      options: {
        showContent: true,
      },
    });

    if (!state.data?.content || state.data.content.dataType !== "moveObject") {
      throw new Error("Failed to fetch NTT state object");
    }

    const fields = (state.data.content as SuiMoveObject).fields;
    const peersTable = fields.peers;

    // Convert chain name to chain ID and look up in peers table
    const chainId = chainToChainId(chain);

    try {
      // Query the dynamic field for this chain ID in the peers table
      const peerField = await this.provider.getDynamicFieldObject({
        parentId: peersTable.fields.id.id,
        name: {
          type: "u16",
          value: chainId,
        },
      });

      if (
        !peerField.data?.content ||
        peerField.data.content.dataType !== "moveObject"
      ) {
        // Peer not found for this chain
        return null;
      }

      const peerData = (peerField.data.content as SuiMoveObject).fields.value
        .fields;

      // Extract address bytes from ExternalAddress
      const externalAddress = peerData.address;
      const addressBytes = externalAddress.fields.value.fields.data;

      // Convert address bytes to ChainAddress
      // The address bytes are stored as a vector of u8, we need to convert to the appropriate format
      const addressUint8Array = new Uint8Array(addressBytes);
      const chainAddress = {
        chain: chain,
        address: toUniversal(chain, addressUint8Array),
      } as ChainAddress<PC>;

      // Extract token decimals
      const tokenDecimals = parseInt(peerData.token_decimals, 10);

      // Extract inbound limit from rate limit state
      const inboundRateLimit = peerData.inbound_rate_limit.fields;
      const inboundLimit = BigInt(inboundRateLimit.limit);

      return {
        address: chainAddress,
        tokenDecimals: tokenDecimals,
        inboundLimit: inboundLimit,
      } as Ntt.Peer<PC>;
    } catch (error) {
      // If we get an error (like object not found), the peer doesn't exist
      console.error(error);
      return null;
    }
  }

  async *setTransceiverPeer(
    ix: number,
    peer: ChainAddress,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    // For now, only support index 0 which is the wormhole transceiver
    if (ix !== 0) {
      throw new Error(
        "Only transceiver index 0 (wormhole) is currently supported"
      );
    }

    const wormholeTransceiverStateId =
      this.contracts.ntt!["transceiver"]?.["wormhole"];
    if (!wormholeTransceiverStateId) {
      throw new Error("Wormhole transceiver not found in contracts");
    }

    // Get the transceiver package ID and admin cap ID
    const transceiverPackageId = await this.getPackageIdFromObject(
      wormholeTransceiverStateId
    );

    // Query the transceiver admin cap ID from the state object
    const transceiverState = await getSuiObject(
      this.provider,
      wormholeTransceiverStateId,
      "Failed to fetch transceiver state object"
    );

    const transceiverFields = transceiverState.fields;
    const transceiverAdminCapId = transceiverFields.admin_cap_id;

    // Build transaction to set transceiver peer
    const txb = new Transaction();

    // Convert chain to wormhole chain ID
    const chainId = chainToChainId(peer.chain);

    // Convert peer address to ExternalAddress format
    const peerAddressBytes: Uint8Array = peer.address.toUint8Array();

    // Convert Uint8Array to regular array
    const peerAddressBytesArray = Array.from(peerAddressBytes);

    try {
      // Query the wormhole package ID from the core bridge state object
      const wormholePackageId = await this.getPackageIdFromObject(
        this.contracts.coreBridge!
      );

      // Create ExternalAddress from the peer address bytes
      const bytes32 = txb.moveCall({
        target: `${wormholePackageId}::bytes32::from_bytes`,
        arguments: [txb.pure.vector("u8", peerAddressBytesArray)],
      });

      const externalAddress = txb.moveCall({
        target: `${wormholePackageId}::external_address::new`,
        arguments: [bytes32],
      });

      // Get the NTT package ID for the manager auth type
      const nttPackageId = await this.getPackageId();

      // Call the transceiver's set_peer function which returns a MessageTicket
      const messageTicket = txb.moveCall({
        target: `${transceiverPackageId}::wormhole_transceiver::set_peer`,
        typeArguments: [`${nttPackageId}::auth::ManagerAuth`], // Fully qualified manager auth type
        arguments: [
          txb.object(transceiverAdminCapId), // Transceiver AdminCap
          txb.object(wormholeTransceiverStateId), // Transceiver state
          txb.pure.u16(chainId), // Chain ID
          externalAddress, // ExternalAddress object
        ],
      });

      // Get the wormhole state ID from the core bridge
      const wormholeStateId = this.contracts.coreBridge!;

      // Create a zero coin for the message fee (0 SUI)
      const [messageFee] = txb.splitCoins(txb.gas, [0]);

      // Publish the message to emit the WormholeMessage event
      txb.moveCall({
        target: `${wormholePackageId}::publish_message::publish_message`,
        arguments: [
          txb.object(wormholeStateId), // Wormhole state
          messageFee, // Message fee (0 SUI)
          messageTicket, // MessageTicket from set_peer
          txb.object(SUI_CLOCK_OBJECT_ID),
        ],
      });
    } catch (error) {
      throw new Error(
        `Failed to create setTransceiverPeer transaction: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const unsignedTx = new SuiUnsignedTransaction(
      txb,
      this.network,
      this.chain,
      "Set Transceiver Peer"
    );

    yield unsignedTx;
  }

  // Transfer Methods
  async *transfer(
    sender: AccountAddress<C>,
    amount: bigint,
    destination: ChainAddress,
    options: Ntt.TransferOptions
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    const packageId = await this.getPackageId();

    // Build the transaction for Sui transfer
    const txb = new Transaction();

    // Convert destination chain to wormhole chain ID
    const destinationChainId = chainToChainId(destination.chain);

    // Convert destination address to bytes
    // TODO: do this address handling stuff properly
    let destinationAddressBytes: Uint8Array;
    try {
      if (typeof destination.address.toUint8Array === "function") {
        destinationAddressBytes = destination.address.toUint8Array();
      } else if (typeof destination.address.toUniversalAddress === "function") {
        const universalAddr = destination.address.toUniversalAddress();
        if (!universalAddr) {
          throw new Error("toUniversalAddress() returned null or undefined");
        }
        destinationAddressBytes = universalAddr.toUint8Array();
      } else {
        throw new Error(
          `destination.address does not have expected methods. Type: ${typeof destination.address}`
        );
      }
    } catch (error) {
      throw new Error(
        `Failed to convert destination address to bytes: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // Query the CoinMetadata object ID dynamically
    let coinMetadataId: string;
    try {
      const coinMetadata = await this.provider.getCoinMetadata({
        coinType: this.contracts.ntt!["token"],
      });
      if (!coinMetadata?.id) {
        throw new Error(
          `CoinMetadata not found for ${this.contracts.ntt!["token"]}`
        );
      }
      coinMetadataId = coinMetadata.id;
    } catch (error) {
      throw new Error(
        `Failed to get CoinMetadata for ${this.contracts.ntt!["token"]}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // get token ID
    const token = this.contracts.ntt!["token"];
    const isNative = isNativeToken(token);
    const tokenAddress = new SuiAddress(
      isNative
        ? SuiPlatform.nativeTokenId(this.network, this.chain).address
        : token
    );
    const tokenId: string = tokenAddress.getCoinType();

    // Get the coin to transfer
    // For SUI (native), we can split from gas
    // For other tokens, we need to get the user's coins of that type
    const [coin] = await (async () => {
      if (isNative) {
        // For SUI, split from gas
        return txb.splitCoins(txb.gas, [amount]);
      } else {
        // For other tokens, get the user's coins of that type
        const coins = await SuiPlatform.getCoins(
          this.provider,
          sender,
          tokenId
        );

        if (coins.length === 0) {
          throw new Error(`No coins found for token type ${tokenId}`);
        }

        const [primaryCoin, ...mergeCoins] = coins;

        if (!primaryCoin) {
          throw new Error(`No primary coin found for token type ${tokenId}`);
        }

        const primaryCoinInput = txb.object(primaryCoin.coinObjectId);

        // Merge additional coins if needed
        if (mergeCoins.length > 0) {
          txb.mergeCoins(
            primaryCoinInput,
            mergeCoins.map((coin) => txb.object(coin.coinObjectId))
          );
        }

        // Split the exact amount needed
        return txb.splitCoins(primaryCoinInput, [amount]);
      }
    })();

    // Create VersionGated object
    const [versionGated] = txb.moveCall({
      target: `${packageId}::upgrades::new_version_gated`,
      arguments: [],
    });

    // Since prepare_transfer returns a tuple (TransferTicket, Balance), we need to properly
    // extract the individual elements. In Sui's transaction builder, we can access tuple elements
    // using array-like indexing on the result.
    const [ticket, dust] = txb.moveCall({
      target: `${packageId}::ntt::prepare_transfer`,
      typeArguments: [tokenId],
      arguments: [
        txb.object(this.contracts.ntt!["manager"]), // state
        coin, // coins
        txb.object(coinMetadataId), // coin_meta
        txb.pure.u16(destinationChainId), // recipient_chain
        txb.pure.vector("u8", destinationAddressBytes), // recipient (as vector<u8>)
        txb.pure.option("vector<u8>", null), // payload (no payload for now)
        txb.pure.bool(options.queue || false), // should_queue
      ],
    });

    // Get next sequence number before calling transfer_tx_sender
    const [sequenceBytes32] = txb.moveCall({
      target: `${packageId}::state::get_next_sequence`,
      typeArguments: [tokenId],
      arguments: [txb.object(this.contracts.ntt!["manager"])],
    });

    // Get Wormhole package ID
    const wormholePackageId = await getWormholePackageId(
      this.provider,
      this.coreBridgeStateId
    );

    // Now call transfer_tx_sender
    txb.moveCall({
      target: `${packageId}::ntt::transfer_tx_sender`,
      typeArguments: [tokenId],
      arguments: [
        txb.object(this.contracts.ntt!["manager"]), // state (mutable)
        versionGated!, // version_gated (we know this exists from the previous call)
        txb.object(coinMetadataId), // coin_meta
        ticket!, // TransferTicket (we know this exists from prepare_transfer)
        txb.object(SUI_CLOCK_OBJECT_ID),
      ],
    });

    // Get transceiver info
    const transceiverStateId = this.contracts.ntt!.transceiver?.["wormhole"];
    if (!transceiverStateId) {
      throw new Error("Wormhole transceiver not found in contracts");
    }

    // Get transceiver package ID
    const transceiverPackageId = await this.getPackageIdFromObject(
      transceiverStateId
    );

    // Create transceiver message
    const [transceiverMessage] = txb.moveCall({
      target: `${packageId}::state::create_transceiver_message`,
      typeArguments: [
        `${transceiverPackageId}::wormhole_transceiver::TransceiverAuth`,
        tokenId,
      ],
      arguments: [
        txb.object(this.contracts.ntt!["manager"]),
        sequenceBytes32 as any,
        txb.object(SUI_CLOCK_OBJECT_ID),
      ],
    });

    // Release outbound message
    const [messageTicket] = txb.moveCall({
      target: `${transceiverPackageId}::wormhole_transceiver::release_outbound`,
      typeArguments: [`${packageId}::auth::ManagerAuth`],
      arguments: [txb.object(transceiverStateId), transceiverMessage as any],
    });

    // Split fee coin for publishing message
    const [feeCoin] = txb.splitCoins(txb.gas, [txb.pure.u64(0n)]);

    // Publish message to Wormhole
    txb.moveCall({
      target: `${wormholePackageId}::publish_message::publish_message`,
      arguments: [
        txb.object(this.coreBridgeStateId),
        feeCoin,
        messageTicket as any,
        txb.object(SUI_CLOCK_OBJECT_ID),
      ],
    });

    // Handle dust by converting back to coin and merging with gas if native or back to sender otherwise
    const [dustCoin] = txb.moveCall({
      target: `0x2::coin::from_balance`,
      typeArguments: [tokenId],
      arguments: [dust!], // dust exists from prepare_transfer
    });

    if (isNative) {
      txb.mergeCoins(txb.gas, [dustCoin!]);
    } else {
      // Transfer dust back to sender for non-native tokens
      txb.transferObjects([dustCoin!], sender.toString());
    }

    const unsignedTx = new SuiUnsignedTransaction(
      txb,
      this.network,
      this.chain,
      "NTT Transfer"
    );

    yield unsignedTx;
  }

  async *redeem(
    attestations: Ntt.Attestation[],
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    // Check if paused
    const isPaused = await this.isPaused();
    if (isPaused) {
      throw new Error("Contract is paused");
    }

    if (attestations.length === 0) {
      throw new Error("No attestations provided");
    }

    const packageId = await this.getPackageId();

    // Get coin metadata
    const coinMetadata = await this.provider.getCoinMetadata({
      coinType: this.contracts.ntt!["token"],
    });
    if (!coinMetadata?.id) {
      throw new Error(
        `CoinMetadata not found for ${this.contracts.ntt!["token"]}`
      );
    }

    // Build transaction for all attestations
    const txb = new Transaction();

    for (const attestation of attestations) {
      // Loop to add redeem call for all wormhole attestations
      await this.addRedeemCall(txb, attestation, packageId, coinMetadata.id);
    }

    // Add release call for all redeems
    await this.addReleaseCall(txb, attestations, packageId, coinMetadata.id);

    const unsignedTx = new SuiUnsignedTransaction(
      txb,
      this.network,
      this.chain,
      "Redeem NTT Transfer"
    );

    yield unsignedTx;
  }

  async quoteDeliveryPrice(
    destination: Chain,
    options: Ntt.TransferOptions
  ): Promise<bigint> {
    throw new Error("Not implemented");
  }

  async isRelayingAvailable(destination: Chain): Promise<boolean> {
    // We don't have a quoter in Sui NTT, so relaying is currently not available
    return false;
  }

  // Rate Limiting
  async getCurrentOutboundCapacity(): Promise<bigint> {
    const state = await getSuiObject(
      this.provider,
      this.contracts.ntt!["manager"],
      "Failed to fetch NTT state object"
    );

    const fields = state.fields;
    const outboxRateLimit = fields.outbox.fields.rate_limit.fields;

    // Get current timestamp (this would ideally come from Clock object)
    const currentTime = Date.now();

    // Calculate capacity using the rate limit formula
    // This is a simplified version - in practice we'd need the exact formula from Move
    const limit = BigInt(outboxRateLimit.limit);
    const capacityAtLastTx = BigInt(outboxRateLimit.capacity_at_last_tx);
    const lastTxTimestamp = BigInt(outboxRateLimit.last_tx_timestamp);

    // Simplified capacity calculation
    const timePassed = BigInt(currentTime) - lastTxTimestamp;
    const rateLimitDuration = RATE_LIMIT_DURATION;

    const additionalCapacity = (timePassed * limit) / rateLimitDuration;
    const currentCapacity = capacityAtLastTx + additionalCapacity;

    return currentCapacity > limit ? limit : currentCapacity;
  }

  async getOutboundLimit(): Promise<bigint> {
    const state = await getSuiObject(
      this.provider,
      this.contracts.ntt!["manager"],
      "Failed to fetch NTT state object"
    );

    const fields = state.fields;
    const outboxRateLimit = fields.outbox.fields.rate_limit.fields;

    return BigInt(outboxRateLimit.limit);
  }

  async *setOutboundLimit(
    limit: bigint,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    const adminCapId = await this.getAdminCapId();
    if (!adminCapId) {
      throw new Error("AdminCap ID not found");
    }

    const packageId = await this.getPackageId();
    if (!packageId) {
      throw new Error("Package ID not found");
    }

    // Build the transaction to set the outbound rate limit
    const txb = new Transaction();
    txb.moveCall({
      target: `${packageId}::state::set_outbound_rate_limit`,
      typeArguments: [this.contracts.ntt!["token"]], // Use the token type from contracts
      arguments: [
        txb.object(adminCapId), // AdminCap
        txb.object(this.contracts.ntt!["manager"]), // NTT state
        txb.pure.u64(limit.toString()), // New outbound limit
        txb.object(SUI_CLOCK_OBJECT_ID), // Clock object
      ],
    });

    const unsignedTx = new SuiUnsignedTransaction(
      txb,
      this.network,
      this.chain,
      "Set Outbound Limit"
    );

    yield unsignedTx;
  }

  async getCurrentInboundCapacity<PC extends Chain>(
    fromChain: PC
  ): Promise<bigint> {
    const state = await this.provider.getObject({
      id: this.contracts.ntt!["manager"],
      options: {
        showContent: true,
      },
    });

    if (!state.data?.content || state.data.content.dataType !== "moveObject") {
      throw new Error("Failed to fetch NTT state object");
    }

    const fields = (state.data.content as SuiMoveObject).fields;
    const peersTable = fields.peers;

    // Convert chain to wormhole chain ID
    const chainId = chainToChainId(fromChain);

    try {
      // Query the dynamic field for this chain ID in the peers table
      const peerField = await this.provider.getDynamicFieldObject({
        parentId: peersTable.fields.id.id,
        name: {
          type: "u16",
          value: chainId,
        },
      });

      if (
        !peerField.data?.content ||
        peerField.data.content.dataType !== "moveObject"
      ) {
        throw new Error(`No peer found for chain ${fromChain}`);
      }

      const peerData = (peerField.data.content as SuiMoveObject).fields.value
        .fields;

      // Extract inbound rate limit state
      const inboundRateLimit = peerData.inbound_rate_limit.fields;

      // Get current timestamp (this would ideally come from Clock object)
      const currentTime = Date.now();

      // Calculate capacity using the rate limit formula
      const limit = BigInt(inboundRateLimit.limit);
      const capacityAtLastTx = BigInt(inboundRateLimit.capacity_at_last_tx);
      const lastTxTimestamp = BigInt(inboundRateLimit.last_tx_timestamp);

      // Simplified capacity calculation (same formula as outbound)
      const timePassed = BigInt(currentTime) - lastTxTimestamp;
      const rateLimitDuration = RATE_LIMIT_DURATION;

      const additionalCapacity = (timePassed * limit) / rateLimitDuration;
      const currentCapacity = capacityAtLastTx + additionalCapacity;

      return currentCapacity > limit ? limit : currentCapacity;
    } catch (error) {
      throw new Error(
        `Failed to get inbound capacity for chain ${fromChain}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async getInboundLimit<PC extends Chain>(fromChain: PC): Promise<bigint> {
    const peer = await this.getPeer(fromChain);

    if (!peer) {
      throw new Error(
        `No peer found for chain ${fromChain}. Set up the peer first using setPeer.`
      );
    }

    return peer.inboundLimit;
  }

  async *setInboundLimit<PC extends Chain>(
    fromChain: PC,
    limit: bigint,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    const adminCapId = await this.getAdminCapId();
    const packageId = await this.getPackageId();

    // Get the existing peer to preserve its address and token decimals
    const existingPeer = await this.getPeer(fromChain);
    if (!existingPeer) {
      throw new Error(
        `No peer found for chain ${fromChain}. Set up the peer first using setPeer.`
      );
    }

    // Build transaction to set inbound limit by updating the existing peer
    const txb = new Transaction();

    // Convert chain to wormhole chain ID
    const wormholeChainId = chainToChainId(fromChain);

    // Convert peer address to ExternalAddress format (reuse the existing address)
    const peerAddressBytes: Uint8Array =
      existingPeer.address.address.toUint8Array();

    // Convert Uint8Array to regular array
    const peerAddressBytesArray = Array.from(peerAddressBytes);

    try {
      // Query the wormhole package ID from the state object
      const wormholePackageId = await this.getPackageIdFromObject(
        this.contracts.coreBridge!
      );

      // Create ExternalAddress from the peer address bytes
      const bytes32 = txb.moveCall({
        target: `${wormholePackageId}::bytes32::from_bytes`,
        arguments: [txb.pure.vector("u8", peerAddressBytesArray)],
      });

      const externalAddress = txb.moveCall({
        target: `${wormholePackageId}::external_address::new`,
        arguments: [bytes32],
      });

      // Call set_peer with the existing address and token decimals but new inbound limit
      txb.moveCall({
        target: `${packageId}::state::set_peer`,
        typeArguments: [this.contracts.ntt!["token"]], // Use the token type from contracts
        arguments: [
          txb.object(adminCapId), // AdminCap
          txb.object(this.contracts.ntt!["manager"]), // NTT state
          txb.pure.u16(wormholeChainId), // Chain ID
          externalAddress, // ExternalAddress object (reuse existing address)
          txb.pure.u8(existingPeer.tokenDecimals), // Keep existing token decimals
          txb.pure.u64(limit.toString()), // New inbound limit
          txb.object(SUI_CLOCK_OBJECT_ID),
        ],
      });
    } catch (error) {
      throw new Error(
        `Failed to create setInboundLimit transaction: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const unsignedTx = new SuiUnsignedTransaction(
      txb,
      this.network,
      this.chain,
      "Set Inbound Limit"
    );

    yield unsignedTx;
  }

  async getRateLimitDuration(): Promise<bigint> {
    // Rate limit duration is a constant in the Move contract
    return RATE_LIMIT_DURATION;
  }

  // Transfer Status
  async getIsApproved(attestation: Ntt.Attestation): Promise<boolean> {
    const inboxItem = await this.getInboxItem(attestation);
    if (!inboxItem) {
      return false;
    }

    const { inboxItemFields, threshold } = inboxItem;

    // votes is a Bitmap object, not a simple integer
    // We need to count the number of set bits in the bitmap
    const votesBitmap = inboxItemFields.votes;
    let voteCount = 0;

    if (votesBitmap?.fields?.bitmap) {
      // The bitmap is stored as a string representation of a number
      // Count the number of set bits (votes)
      voteCount = countSetBits(parseInt(votesBitmap.fields.bitmap));
    }

    // Check if votes >= threshold
    return voteCount >= threshold;
  }

  async getIsExecuted(attestation: Ntt.Attestation): Promise<boolean> {
    const releaseStatus = await this.getTransferReleaseStatus(attestation);

    // Check if release_status is Released
    return releaseStatus?.$kind === "Released";
  }

  async getIsTransferInboundQueued(
    attestation: Ntt.Attestation
  ): Promise<boolean> {
    const releaseStatus = await this.getTransferReleaseStatus(attestation);

    // Check if release_status is ReleaseAfter
    return releaseStatus?.$kind === "ReleaseAfter";
  }

  async getInboundQueuedTransfer<PC extends Chain>(
    fromChain: PC,
    transceiverMessage: Ntt.Message
  ): Promise<Ntt.InboundQueuedTransfer<C> | null> {
    // Create an attestation object from the transceiver message
    // The attestation needs to have the proper structure for getInboxItem to find it
    const attestation = {
      emitterChain: fromChain,
      payload: {
        nttManagerPayload: transceiverMessage,
      },
    } as Ntt.Attestation;

    // Get the release status
    const releaseStatus = await this.getTransferReleaseStatus(attestation);

    // Check if it's queued (ReleaseAfter)
    if (releaseStatus?.$kind !== "ReleaseAfter") {
      return null;
    }

    // The timestamp should be in the ReleaseAfter field
    const releaseTimestamp = parseInt(releaseStatus.ReleaseAfter);

    // Get the full inbox item to access the transfer data
    const inboxItem = await this.getInboxItem(attestation);
    if (!inboxItem) {
      return null;
    }

    const { inboxItemFields } = inboxItem;

    // Parse recipient and amount from inbox item data
    // The data field should contain the transfer details
    const transferData = inboxItemFields.data || {};

    // Try to get recipient address - prefer message payload, fallback to inbox data
    let recipientAddress: any;
    if (transceiverMessage.payload?.recipientAddress) {
      recipientAddress = transceiverMessage.payload.recipientAddress;
    } else if (transferData.recipient) {
      recipientAddress = toUniversal(this.chain, transferData.recipient);
    } else if (transferData.recipient_address) {
      recipientAddress = toUniversal(
        this.chain,
        transferData.recipient_address
      );
    } else {
      // If we can't find recipient, return null
      return null;
    }

    // Try to get amount - prefer message payload, fallback to inbox data
    let amount: bigint;
    if (transceiverMessage.payload?.trimmedAmount) {
      amount = transceiverMessage.payload.trimmedAmount.amount;
    } else if (transferData.amount) {
      amount = BigInt(transferData.amount.toString());
    } else {
      // If we can't find amount, return null
      return null;
    }

    // Return the queued transfer info
    const xfer: Ntt.InboundQueuedTransfer<C> = {
      recipient: recipientAddress,
      amount: amount,
      rateLimitExpiryTimestamp: releaseTimestamp / 1000, // NTT route expects seconds
    };

    return xfer;
  }

  async *completeInboundQueuedTransfer<PC extends Chain>(
    fromChain: PC,
    transceiverMessage: Ntt.Message,
    payer?: AccountAddress<C>
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    // Check if paused
    const isPaused = await this.isPaused();
    if (isPaused) {
      throw new Error("Contract is paused");
    }

    // Create an attestation from the transceiverMessage
    // Need proper payload structure to match getInboxItem expectations
    const attestation = {
      emitterChain: fromChain,
      payload: {
        nttManagerPayload: transceiverMessage,
      },
    } as Ntt.Attestation;

    // Call redeem with the attestation
    yield* this.redeem([attestation], payer);
  }

  // Transceiver Management
  async getTransceiver(
    ix: number
  ): Promise<NttTransceiver<N, C, Ntt.Attestation> | null> {
    // For now, only support index 0 which is the wormhole transceiver
    if (ix !== 0) {
      return null;
    }

    // Return a wormhole transceiver if we have the state ID from contracts
    const wormholeTransceiverStateId =
      this.contracts.ntt!["transceiver"]?.["wormhole"];
    if (wormholeTransceiverStateId) {
      const chain = this.chain;

      // Create a transceiver implementation that supports getPeer and setPeer
      const suiNtt = this;
      return {
        async getTransceiverType(): Promise<string> {
          return "wormhole";
        },
        async getAddress(): Promise<ChainAddress<C>> {
          const state = await getSuiObject(
            suiNtt.provider,
            wormholeTransceiverStateId
          );
          return {
            chain: chain,
            address: toUniversal(chain, state.fields.emitter_cap.fields.id.id),
          } as ChainAddress<C>;
        },
        async *setPeer(
          peer: ChainAddress,
          payer?: AccountAddress<C>
        ): AsyncGenerator<UnsignedTransaction<N, C>> {
          yield* suiNtt.setTransceiverPeer(0, peer, payer);
        },
        async getPeer<PC extends Chain>(
          targetChain: PC
        ): Promise<ChainAddress<PC> | null> {
          return await suiNtt.getTransceiverPeer(0, targetChain);
        },
        async *setPauser(): AsyncGenerator<UnsignedTransaction<N, C>> {
          throw new Error("setPauser not implemented for Sui transceiver");
        },
        async getPauser(): Promise<AccountAddress<C> | null> {
          return null;
        },
        async *receive(): AsyncGenerator<UnsignedTransaction<N, C>> {
          throw new Error("receive not implemented for Sui transceiver");
        },
      } as NttTransceiver<N, C, Ntt.Attestation>;
    }

    return null;
  }

  async getTransceiverPeer<PC extends Chain>(
    ix: number,
    targetChain: PC
  ): Promise<ChainAddress<PC> | null> {
    // For now, only support index 0 which is the wormhole transceiver
    if (ix !== 0) {
      return null;
    }

    const wormholeTransceiverStateId =
      this.contracts.ntt!["transceiver"]?.["wormhole"];
    if (!wormholeTransceiverStateId) {
      return null;
    }

    // chainToChainId is already imported at the top of the file

    try {
      // Get the transceiver state object
      const transceiverState = await this.provider.getObject({
        id: wormholeTransceiverStateId,
        options: { showContent: true },
      });

      if (
        !transceiverState.data?.content ||
        transceiverState.data.content.dataType !== "moveObject"
      ) {
        return null;
      }

      const fields = (transceiverState.data.content as SuiMoveObject).fields;
      const peersTable = fields.peers;

      // Convert target chain to chain ID
      const chainId = chainToChainId(targetChain);

      // Query the dynamic field for this chain ID in the transceiver peers table
      const peerField = await this.provider.getDynamicFieldObject({
        parentId: peersTable.fields.id.id,
        name: {
          type: "u16",
          value: chainId,
        },
      });

      if (
        !peerField.data?.content ||
        peerField.data.content.dataType !== "moveObject"
      ) {
        // Peer not found for this chain
        return null;
      }

      // Extract the ExternalAddress from the peer field
      const externalAddress = (peerField.data.content as SuiMoveObject).fields
        .value;
      const addressBytes = externalAddress.fields.value.fields.data;

      // Convert address bytes to ChainAddress
      const addressUint8Array = new Uint8Array(addressBytes);
      const chainAddress = {
        chain: targetChain,
        address: toUniversal(targetChain, addressUint8Array),
      } as ChainAddress<PC>;

      return chainAddress;
    } catch (error) {
      console.error(error);
      // If we get an error (like object not found), the peer doesn't exist
      return null;
    }
  }

  async getTransceiverType(transceiverIndex: number = 0): Promise<string> {
    // For now, only support index 0 which is the wormhole transceiver
    if (transceiverIndex !== 0) {
      throw new Error(`Transceiver index ${transceiverIndex} not supported`);
    }

    const wormholeTransceiverStateId =
      this.contracts.ntt!["transceiver"]?.["wormhole"];
    if (!wormholeTransceiverStateId) {
      throw new Error("Wormhole transceiver not found in contracts");
    }

    // Get the transceiver state object
    const transceiverState = await this.provider.getObject({
      id: wormholeTransceiverStateId,
      options: { showType: true },
    });

    if (!transceiverState.data?.type) {
      throw new Error("Unable to determine transceiver object type");
    }

    // Extract package ID from the object type
    // Type format: "packageId::module::Type<...>"
    const packageId = transceiverState.data.type.split("::")[0];

    // Build transaction to call get_transceiver_type from the standard transceiver module
    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::transceiver::get_transceiver_type`,
      arguments: [],
    });

    // Use devInspectTransactionBlock to call the view function
    const response = await this.provider.devInspectTransactionBlock({
      transactionBlock: tx,
      sender:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    });

    // Parse the response
    if (response.results && response.results.length > 0) {
      const result = response.results[0];
      if (result && result.returnValues && result.returnValues.length > 0) {
        const returnValue = result.returnValues[0];
        if (
          returnValue &&
          Array.isArray(returnValue) &&
          returnValue.length > 0
        ) {
          // The return value should be [bytes, type] where bytes is an array of numbers
          const bytesData = returnValue[0];
          if (Array.isArray(bytesData)) {
            const transceiverType = new TextDecoder().decode(
              new Uint8Array(bytesData)
            );
            return transceiverType;
          }
        }
      }
    }

    throw new Error("Failed to get transceiver info from response");
  }

  async verifyAddresses(): Promise<Partial<Ntt.Contracts> | null> {
    // Verify that the addresses in the contracts configuration are valid
    try {
      // Check if manager address exists and is a valid NTT state object
      const state = await this.provider.getObject({
        id: this.contracts.ntt!["manager"],
        options: { showContent: true },
      });

      if (
        !state.data?.content ||
        state.data.content.dataType !== "moveObject"
      ) {
        return null;
      }

      const fields = (state.data.content as SuiMoveObject).fields;

      // Look up registered transceivers in the transceiver registry
      const transceiverRegistry = fields.transceivers;
      const registryId = transceiverRegistry.fields.id.id;

      // Query the registry's dynamic fields to find registered transceivers
      const dynamicFields = await this.provider.getDynamicFields({
        parentId: registryId,
      });

      const result: Partial<Ntt.Contracts> = {
        manager: this.contracts.ntt!["manager"],
        token: await SuiNtt.extractTokenTypeFromSuiState(
          this.provider,
          this.contracts.ntt!["manager"]
        ),
        transceiver: {},
      };

      // For now, we only look for the wormhole transceiver at index 0
      // The dynamic field key structure is based on the Move code in transceiver_registry.move
      for (const field of dynamicFields.data) {
        if (field.name?.type?.includes("transceiver_registry::Key")) {
          // This is a transceiver registration
          try {
            const transceiverInfo = await this.provider.getObject({
              id: field.objectId,
              options: { showContent: true },
            });

            if (
              transceiverInfo.data?.content &&
              transceiverInfo.data.content.dataType === "moveObject"
            ) {
              const infoFields = (transceiverInfo.data.content as SuiMoveObject)
                .fields.value.fields;
              const transceiverStateId = infoFields.state_object_id;
              const transceiverIndex = infoFields.id;

              // For index 0, assume it's the wormhole transceiver
              if (transceiverIndex === 0) {
                result.transceiver!["wormhole"] = transceiverStateId;
              }
            }
          } catch (e) {
            // Skip this transceiver if we can't read it
            console.warn(`Failed to read transceiver info: ${e}`);
          }
        }
      }

      // Compare with what we have locally
      const local: Partial<Ntt.Contracts> = {
        manager: this.contracts.ntt!["manager"],
        token: this.contracts.ntt!["token"],
        transceiver: this.contracts.ntt!["transceiver"] || {},
      };

      const deleteMatching = (a: any, b: any) => {
        for (const k in a) {
          if (
            typeof a[k] === "object" &&
            a[k] !== null &&
            typeof b[k] === "object" &&
            b[k] !== null
          ) {
            deleteMatching(a[k], b[k]);
            if (Object.keys(a[k]).length === 0) delete a[k];
          } else if (a[k] === b[k]) {
            delete a[k];
          }
        }
      };

      deleteMatching(result, local);

      return Object.keys(result).length > 0 ? result : null;
    } catch (e) {
      console.warn(`Failed to verify addresses: ${e}`);
      return null;
    }
  }

  async getUpgradeCapId(): Promise<string> {
    const state = await this.getNttState();
    if (!state.upgrade_cap_id) {
      throw new Error("UpgradeCap ID not found in NTT state");
    }
    return state.upgrade_cap_id;
  }

  private async addReleaseCall(
    txb: Transaction,
    attestations: Ntt.Attestation[],
    packageId: string,
    coinMetadataId: string
  ): Promise<any> {
    // Find the wormhole attestation
    const wormholeAttestation = attestations.find(
      (a) => a.payloadName === "WormholeTransfer"
    );
    if (!wormholeAttestation) {
      throw new Error("No wormhole attestation found");
    }

    // Get manager state to extract nttCommonPackageId
    const managerState = await this.provider.getObject({
      id: this.contracts.ntt!["manager"],
      options: { showContent: true },
    });

    if (
      !managerState.data?.content ||
      managerState.data.content.dataType !== "moveObject"
    ) {
      throw new Error("Failed to fetch manager state");
    }

    const managerStateObject = managerState.data.content as SuiMoveObject;

    // Extract nttCommonPackageId from manager object's inbox type
    const nttCommonPackageId = extractNttCommonPackageId(
      managerStateObject.fields.inbox.type
    );

    // Get manager payload
    const nttPayload = (wormholeAttestation.payload as any).nttManagerPayload;

    // Get NTT object
    // We need this to create the manager message (see ntt_manager_message::new)
    let payloadBytes: Uint8Array;
    try {
      payloadBytes = serializeLayout(
        nativeTokenTransferLayout,
        nttPayload.payload
      );
    } catch (error) {
      throw new Error(
        `Failed to serialize native token transfer payload: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const wormholeCoreBridgePackageId = await getWormholePackageId(
      this.provider,
      this.coreBridgeStateId
    );

    // Create the NttManagerMessage object using the utility function
    const manager_message = createNttManagerMessageObjects(
      txb,
      nttCommonPackageId,
      wormholeCoreBridgePackageId,
      payloadBytes,
      nttPayload.id,
      nttPayload.sender.toUint8Array()
    );

    // Create version gated object for release
    const [versionGated] = txb.moveCall({
      target: `${packageId}::upgrades::new_version_gated`,
      arguments: [],
    });

    if (!versionGated) {
      throw new Error("Failed to create version gated object");
    }

    // Call ntt::release
    txb.moveCall({
      target: `${packageId}::ntt::release`,
      typeArguments: [this.contracts.ntt!["token"]],
      arguments: [
        txb.object(this.contracts.ntt!["manager"]),
        versionGated,
        txb.pure.u16(chainToChainId(wormholeAttestation.emitterChain)),
        manager_message,
        txb.object(coinMetadataId),
        txb.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  }

  // Helper function to add redeem call for a single attestation
  private async addRedeemCall(
    txb: Transaction,
    attestation: Ntt.Attestation,
    packageId: string,
    coinMetadataId: string
  ): Promise<void> {
    // Get the transceiver
    const wormholeTransceiverStateId =
      this.contracts.ntt!["transceiver"]?.["wormhole"];
    if (!wormholeTransceiverStateId) {
      throw new Error("Wormhole transceiver not found in contracts");
    }

    const transceiverPackageId = await this.getPackageIdFromObject(
      wormholeTransceiverStateId
    );

    // Get wormhole core package ID
    const coreBridgePackageId = await getWormholePackageId(
      this.provider,
      this.coreBridgeStateId
    );

    // Serialize the attestation to get VAA bytes
    const vaa = serialize(attestation);

    // First parse the VAA bytes into a VAA struct using Wormhole core
    const [parsedVAA] = txb.moveCall({
      target: `${coreBridgePackageId}::vaa::parse_and_verify`,
      arguments: [
        txb.object(this.coreBridgeStateId), // wormhole core state
        txb.pure.vector("u8", Array.from(vaa)), // VAA bytes
        txb.object(SUI_CLOCK_OBJECT_ID), // clock
      ],
    });

    if (!parsedVAA) {
      throw new Error("Failed to parse VAA");
    }

    // Get the NTT package ID for the manager auth type
    const nttPackageId = await this.getPackageId();

    // Then pass the parsed VAA struct to validate_message
    const [validatedMessage] = txb.moveCall({
      target: `${transceiverPackageId}::wormhole_transceiver::validate_message`,
      typeArguments: [`${nttPackageId}::auth::ManagerAuth`], // Fully qualified manager auth type
      arguments: [
        txb.object(wormholeTransceiverStateId), // transceiver_state
        parsedVAA, // VAA struct from parse_and_verify
      ],
    });

    if (!validatedMessage) {
      throw new Error("Failed to validate VAA through transceiver");
    }

    // Create VersionGated object
    const versionGated = txb.moveCall({
      target: `${packageId}::upgrades::new_version_gated`,
      arguments: [],
    });

    // Now call redeem function with the validated message
    txb.moveCall({
      target: `${packageId}::ntt::redeem`,
      typeArguments: [
        this.contracts.ntt!["token"], // CoinType
        `${transceiverPackageId}::wormhole_transceiver::TransceiverAuth`, // Transceiver type
      ],
      arguments: [
        txb.object(this.contracts.ntt!["manager"]), // state
        versionGated, // version_gated
        txb.object(coinMetadataId), // coin_meta
        validatedMessage, // validated_message
        txb.object(SUI_CLOCK_OBJECT_ID),
      ],
    });
  }

  // Helper function to get the release status from an attestation
  private async getTransferReleaseStatus(
    attestation: Ntt.Attestation
  ): Promise<any | null> {
    const inboxItem = await this.getInboxItem(attestation);
    if (!inboxItem) {
      return null;
    }

    const { inboxItemFields } = inboxItem;
    return inboxItemFields.release_status;
  }

  // Helper function to get inbox item from an NTT attestation
  private async getInboxItem(attestation: Ntt.Attestation): Promise<
    | {
        inboxItemFields: any;
        threshold: number;
      }
    | undefined
  > {
    const nttState = await this.getNttState();

    const threshold = parseInt(nttState.threshold);
    const nttCommonPackageId = extractNttCommonPackageId(nttState.inbox.type);

    // Get the coin type from the contracts configuration
    const coinType = this.contracts.ntt!["token"];

    // Get chain ID
    const sourceChain = attestation.emitterChain;
    if (!sourceChain) {
      throw new Error("No emitter chain found in attestation");
    }
    const sourceChainId = chainToChainId(sourceChain);

    // Get the NTT package ID
    const nttPackageId = await this.getPackageId();

    // Extract the NTT message from attestation
    const nttManagerPayload = (attestation.payload as any).nttManagerPayload;
    if (!nttManagerPayload) {
      throw new Error("No NTT manager payload found in attestation");
    }

    // Prepare the message bytes for the Move call
    let messageBytes: Uint8Array;
    try {
      messageBytes = serializeLayout(
        nativeTokenTransferLayout,
        nttManagerPayload.payload
      );
    } catch (error) {
      throw new Error(
        `Failed to serialize native token transfer payload: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // Create transaction to call borrow_inbox_item
    const txb = new Transaction();

    // Get the wormhole core bridge package ID for creating message components
    const wormholeCoreBridgePackageId = await getWormholePackageId(
      this.provider,
      this.contracts.coreBridge!
    );

    // Create the NttManagerMessage object using the utility function
    const manager_message = createNttManagerMessageObjects(
      txb,
      nttCommonPackageId,
      wormholeCoreBridgePackageId,
      messageBytes,
      nttManagerPayload.id,
      nttManagerPayload.sender.toUint8Array()
    );

    // Now call borrow_inbox_item with the properly constructed message object
    const [inboxItemRef] = txb.moveCall({
      target: `${nttPackageId}::state::borrow_inbox_item`,
      typeArguments: [coinType],
      arguments: [
        txb.object(this.contracts.ntt!["manager"]!), // State object
        txb.pure.u16(sourceChainId), // Chain ID
        manager_message!, // NttManagerMessage object (not raw bytes)
      ],
    });

    // Then serialize the inbox item reference to bytes
    txb.moveCall({
      target: `0x2::bcs::to_bytes`,
      typeArguments: [
        `${nttPackageId}::inbox::InboxItem<${nttCommonPackageId}::native_token_transfer::NativeTokenTransfer>`,
      ],
      arguments: [inboxItemRef!],
    });

    // Execute the transaction in dev inspect mode to read the result
    const inspectResult = await this.provider.devInspectTransactionBlock({
      transactionBlock: txb,
      sender:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
    });

    // Parse and return the result
    return parseInboxItemResult(inspectResult, threshold);
  }
}
