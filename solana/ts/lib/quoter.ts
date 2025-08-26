import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  PublicKeyInitData,
  SystemProgram,
} from "@solana/web3.js";
import { amount, chainToPlatform } from "@wormhole-foundation/sdk-base";
import {
  Chain,
  deserializeLayout,
  toChainId,
} from "@wormhole-foundation/sdk-base";
import IDL from "../idl/2_0_0/json/ntt_quoter.json";
import { NttQuoter as Idl } from "../idl/2_0_0/ts/ntt_quoter.js";
import {
  U64,
  chainToBytes,
  derivePda,
  programDataAddress,
  programDataLayout,
  quoterAddresses,
} from "./utils.js";

//constants that must match ntt-quoter lib.rs / implementation:
const USD_UNIT = 1e6;
const GWEI_PER_ETH = 1e9;
export const WEI_PER_GWEI = 1e9;

const SEED_PREFIX_INSTANCE = "instance";
const SEED_PREFIX_REGISTERED_CHAIN = "registered_chain";
const SEED_PREFIX_REGISTERED_NTT = "registered_ntt";
const SEED_PREFIX_RELAY_REQUEST = "relay_request";

export class NttQuoter {
  readonly instance: PublicKey;
  private readonly program: Program<Idl>;
  nttProgramId: PublicKey;
  pdas: ReturnType<typeof quoterAddresses>;

  constructor(
    connection: Connection,
    programId: PublicKeyInitData,
    nttProgramId: PublicKeyInitData
  ) {
    // @ts-ignore
    this.program = new Program<Idl>(IDL as Idl, new PublicKey(programId), {
      connection,
    });
    this.nttProgramId = new PublicKey(nttProgramId);
    this.pdas = quoterAddresses(this.program.programId);
    this.instance = derivePda([SEED_PREFIX_INSTANCE], this.program.programId);
  }

  // ---- user relevant functions ----

  async isRelayEnabled(destination: Chain) {
    try {
      const { paused } = await this.getRegisteredChain(destination);
      return !paused;
    } catch (e: any) {
      if (e.message?.includes("Account does not exist")) {
        return false;
      }
      throw e;
    }
  }

  async calcRelayCostInSol(
    nttProgramId: PublicKey,
    chain: Chain,
    requestedGasDropoffEth: number
  ) {
    const [chainData, nttData, instanceData, rentCost] = await Promise.all([
      this.getRegisteredChain(chain),
      this.getRegisteredNtt(nttProgramId),
      this.getInstance(),
      this.program.provider.connection.getMinimumBalanceForRentExemption(
        this.program.account.relayRequest.size
      ),
    ]);

    if (requestedGasDropoffEth > chainData.maxGasDropoffEth)
      throw new Error("Requested gas dropoff exceeds allowed maximum");

    const totalNativeGasCostUsd =
      chainData.nativePriceUsd *
      (requestedGasDropoffEth +
        (chainData.gasPriceGwei * nttData.gasCost) / GWEI_PER_ETH);

    const totalCostSol =
      rentCost / LAMPORTS_PER_SOL +
      (chainData.basePriceUsd + totalNativeGasCostUsd) /
        instanceData.solPriceUsd;

    return totalCostSol;
  }

  /**
   * Estimate the cost of a relay request
   * @param chain The destination chain
   * @param gasDropoff The amount of native gas to end up with on the destination chain
   * @returns The estimated cost in lamports
   */
  async quoteDeliveryPrice(chain: Chain, gasDropoff?: bigint) {
    if (chainToPlatform(chain) !== "Evm")
      throw new Error("Only EVM chains are supported");

    // Convert to decimal number since we're multiplying other numbers
    const gasDropoffEth = amount.whole(
      amount.fromBaseUnits(gasDropoff ?? 0n, 18)
    );

    const [chainData, instanceData, nttData, rentCost] = await Promise.all([
      this.getRegisteredChain(chain),
      this.getInstance(),
      this.getRegisteredNtt(this.nttProgramId),
      this.program.provider.connection.getMinimumBalanceForRentExemption(
        this.program.account.relayRequest.size
      ),
    ]);

    if (chainData.nativePriceUsd === 0) throw new Error("Native price is 0");
    if (instanceData.solPriceUsd === 0) throw new Error("SOL price is 0");
    if (gasDropoffEth > chainData.maxGasDropoffEth)
      throw new Error("Requested gas dropoff exceeds allowed maximum");

    const totalNativeGasCostUsd =
      chainData.nativePriceUsd *
      (gasDropoffEth +
        (chainData.gasPriceGwei * nttData.gasCost) / GWEI_PER_ETH);

    const totalCostSol =
      rentCost / LAMPORTS_PER_SOL +
      (chainData.basePriceUsd + totalNativeGasCostUsd) /
        instanceData.solPriceUsd;

    // Add 5% to account for possible price updates while the tx is in flight
    return BigInt(U64.to(totalCostSol * 1.05, LAMPORTS_PER_SOL).toString());
  }

  async createRequestRelayInstruction(
    payer: PublicKey,
    outboxItem: PublicKey,
    chain: Chain,
    maxFeeSol: number,
    gasDropoffEth: number
  ) {
    return this.program.methods
      .requestRelay({
        maxFee: U64.to(maxFeeSol, LAMPORTS_PER_SOL),
        gasDropoff: U64.to(gasDropoffEth, GWEI_PER_ETH),
      })
      .accountsStrict({
        payer,
        instance: this.instance,
        registeredChain: this.registeredChainPda(chain),
        outboxItem,
        relayRequest: this.relayRequestPda(outboxItem),
        systemProgram: SystemProgram.programId,
        registeredNtt: this.pdas.registeredNttAccount(this.nttProgramId),
      })
      .instruction();
  }

  // ---- admin/assistant (=authority) relevant functions ----

  async getInstance() {
    const data = await this.program.account.instance.fetch(this.instance);
    return {
      owner: data.owner,
      assistant: data.assistant,
      feeRecipient: data.feeRecipient,
      solPriceUsd: U64.from(data.solPrice, USD_UNIT),
    };
  }

  async getRegisteredChain(chain: Chain) {
    const data = await this.program.account.registeredChain.fetch(
      this.registeredChainPda(chain)
    );

    return {
      paused: data.basePrice.eq(U64.MAX),
      maxGasDropoffEth: U64.from(data.maxGasDropoff, GWEI_PER_ETH),
      basePriceUsd: U64.from(data.basePrice, USD_UNIT),
      nativePriceUsd: U64.from(data.nativePrice, USD_UNIT),
      gasPriceGwei: U64.from(data.gasPrice, WEI_PER_GWEI),
    };
  }

  async getRegisteredNtt(nttProgramId: PublicKey) {
    const data = await this.program.account.registeredNtt.fetch(
      this.registeredNttPda(nttProgramId)
    );

    return {
      gasCost: data.gasCost,
      wormholeTransceiverIndex: data.wormholeTransceiverIndex,
    };
  }

  //returns null if no relay was requested, otherwise it the requested gas dropoff (in eth),
  //  which can be 0, so a strict === null check is required!
  async wasRelayRequested(outboxItem: PublicKey) {
    const relayRequest = await this.program.account.relayRequest.fetchNullable(
      this.relayRequestPda(outboxItem)
    );

    return relayRequest
      ? U64.from(relayRequest.requestedGasDropoff, GWEI_PER_ETH)
      : null;
  }

  async createInitalizeInstruction(feeRecipient: PublicKey) {
    if (!this.program.account.instance.fetchNullable(this.instance))
      throw new Error("Already initialized");

    const programData = programDataAddress(this.program.programId);

    const accInfo = await this.program.provider.connection.getAccountInfo(
      programData
    );
    if (!accInfo) throw new Error("Could not find program data account");

    const deserProgramData = deserializeLayout(programDataLayout, accInfo.data);
    if (!deserProgramData.upgradeAuthority.isSome)
      throw new Error("Could not determine program owner from program data.");

    return this.program.methods
      .initialize()
      .accounts({
        owner: deserProgramData.upgradeAuthority.value,
        instance: this.instance,
        feeRecipient,
        programData,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async createSetAssistantInstruction(assistant: PublicKey) {
    const { owner, assistant: currentAssistant } = await this.getInstance();
    if (currentAssistant.equals(assistant))
      throw new Error("Is already assistant");

    return this.program.methods
      .setAssistant()
      .accounts({
        owner,
        instance: this.instance,
        assistant,
      })
      .instruction();
  }

  async createSetFeeRecipientInstruction(feeRecipient: PublicKey) {
    if (feeRecipient.equals(PublicKey.default))
      throw new Error("Fee recipient cannot be default public key");

    const { owner, feeRecipient: currentFeeRecipient } =
      await this.getInstance();
    if (currentFeeRecipient.equals(feeRecipient))
      throw new Error("Is already feeRecipient");

    return this.program.methods
      .setFeeRecipient()
      .accounts({
        owner,
        instance: this.instance,
        feeRecipient,
      })
      .instruction();
  }

  async createRegisterChainInstruction(authority: PublicKey, chain: Chain) {
    const chainId = toChainId(chain);
    return this.program.methods
      .registerChain({ chainId })
      .accounts({
        authority,
        instance: this.instance,
        registeredChain: this.registeredChainPda(chain),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async createRegisterNttInstruction(
    authority: PublicKey,
    nttProgramId: PublicKey,
    gasCost: number,
    wormholeTransceiverIndex: number
  ) {
    return this.program.methods
      .registerNtt({
        nttProgramId,
        gasCost,
        wormholeTransceiverIndex,
      })
      .accounts({
        authority,
        instance: this.instance,
        registeredNtt: this.registeredNttPda(nttProgramId),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async createDeregisterNttInstruction(
    authority: PublicKey,
    nttProgramId: PublicKey
  ) {
    return this.program.methods
      .deregisterNtt({ nttProgramId })
      .accounts({
        authority,
        instance: this.instance,
        registeredNtt: this.registeredNttPda(nttProgramId),
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async createUpdateSolPriceInstruction(
    authority: PublicKey,
    solPriceUsd: number
  ) {
    return this.program.methods
      .updateSolPrice({
        solPrice: U64.to(solPriceUsd, USD_UNIT),
      })
      .accounts({
        authority,
        instance: this.instance,
      })
      .instruction();
  }

  async createUpdateChainParamsInstruction(
    authority: PublicKey,
    chain: Chain,
    maxGasDropoffEth: number,
    basePriceUsd: number
  ) {
    return this.program.methods
      .updateChainParams({
        maxGasDropoff: U64.to(maxGasDropoffEth, GWEI_PER_ETH),
        basePrice: U64.to(basePriceUsd, USD_UNIT),
      })
      .accounts({
        authority,
        instance: this.instance,
        registeredChain: this.registeredChainPda(chain),
      })
      .instruction();
  }

  async createPauseRelayForChainInstruction(
    authority: PublicKey,
    chain: Chain
  ) {
    return this.program.methods
      .updateChainParams({
        maxGasDropoff: U64.to(0, 1),
        basePrice: U64.MAX,
      })
      .accounts({
        authority,
        instance: this.instance,
        registeredChain: this.registeredChainPda(chain),
      })
      .instruction();
  }

  async createUpdateChainPricesInstruction(
    authority: PublicKey,
    chain: Chain,
    nativePriceUsd: number,
    gasPriceGwei: number
  ) {
    return this.program.methods
      .updateChainPrices({
        nativePrice: U64.to(nativePriceUsd, USD_UNIT),
        gasPrice: U64.to(gasPriceGwei, WEI_PER_GWEI),
      })
      .accounts({
        authority,
        instance: this.instance,
        registeredChain: this.registeredChainPda(chain),
      })
      .instruction();
  }

  async createCloseRelayInstruction(
    authority: PublicKey,
    outboxItem: PublicKey
  ) {
    return this.program.methods
      .closeRelay()
      .accounts({
        authority,
        instance: this.instance,
        relayRequest: this.relayRequestPda(outboxItem),
      })
      .instruction();
  }

  // ---- private ----

  private registeredChainPda(chainId: Chain) {
    return derivePda(
      [SEED_PREFIX_REGISTERED_CHAIN, chainToBytes(chainId)],
      this.program.programId
    );
  }

  private registeredNttPda(nttProgramId: PublicKey) {
    return derivePda(
      [SEED_PREFIX_REGISTERED_NTT, nttProgramId.toBytes()],
      this.program.programId
    );
  }

  private relayRequestPda(outboxItem: PublicKey) {
    return derivePda(
      [SEED_PREFIX_RELAY_REQUEST, outboxItem.toBytes()],
      this.program.programId
    );
  }
}
