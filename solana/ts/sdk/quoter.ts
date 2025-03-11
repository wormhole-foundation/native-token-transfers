import {
  deserializeLayout,
  Chain,
  toChainId,
} from "@wormhole-foundation/sdk-base";
import {
  Connection,
  PublicKeyInitData,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { NttQuoter as Idl } from '../../target/types/ntt_quoter'
import IDL from "../../target/idl/ntt_quoter.json";
import { U64, programDataLayout, programDataAddress, chainIdToBeBytes, derivePda } from "./utils";

type QuoterInstanceState = NonNullable<Awaited<ReturnType<typeof NttQuoter.prototype.tryGetInstance>>>;

//constants that must match ntt-quoter lib.rs / implementation:
const USD_UNIT     = 1e6;
const WEI_PER_GWEI = 1e9;
const GWEI_PER_ETH = 1e9;
const SEED_PREFIX_INSTANCE         = "instance";
const SEED_PREFIX_REGISTERED_CHAIN = "registered_chain";
const SEED_PREFIX_REGISTERED_NTT   = "registered_ntt";
const SEED_PREFIX_RELAY_REQUEST    = "relay_request";

export class NttQuoter {
  readonly instance: PublicKey;
  private readonly program: Program<Idl>;
  
  constructor(connection: Connection, programId: PublicKeyInitData) {
    this.program  = new Program<Idl>(IDL as Idl, new PublicKey(programId), {connection});
    this.instance = derivePda([SEED_PREFIX_INSTANCE], this.program.programId);
  }

  // ---- user relevant functions ----

  async calcRelayCostInSol(nttProgramId: PublicKey, chain: Chain, requestedGasDropoffEth: number) {
    const [chainData, nttData, instanceData, rentCost] = await Promise.all([
      this.tryGetRegisteredChain(chain),
      this.tryGetRegisteredNtt(nttProgramId),
      this.tryGetInstance(),
      this.program.provider.connection.getMinimumBalanceForRentExemption(
        this.program.account.relayRequest.size
      )
    ]);

    if (instanceData === null) {
      throw new Error("Quoter contract is not initialized.");
    }

    if (chainData === null) {
      throw new Error(`Chain ${chain} is not registered.`);
    }

    if (nttData === null) {
      throw new Error(`NTT manager ${nttProgramId.toBase58()} is not registered.`);
    }

    if (requestedGasDropoffEth > chainData.maxGasDropoffEth)
      throw new Error("Requested gas dropoff exceeds allowed maximum");

    const totalNativeGasCostUsd = chainData.nativePriceUsd *
      (requestedGasDropoffEth + chainData.gasPriceGwei * nttData.gasCost / GWEI_PER_ETH);

    const totalCostSol = rentCost / LAMPORTS_PER_SOL +
      (chainData.basePriceUsd + totalNativeGasCostUsd) / instanceData.solPriceUsd;
    
    return totalCostSol;
  }

  async createRequestRelayInstruction(
    payer:         PublicKey,
    outboxItem:    PublicKey,
    chain:         Chain,
    maxFeeSol:     number,
    gasDropoffEth: number,
  ) {
    return this.program.methods.requestRelay({
      maxFee:     U64.to(maxFeeSol, LAMPORTS_PER_SOL),
      gasDropoff: U64.to(gasDropoffEth, GWEI_PER_ETH),
    }).accounts({
      payer,
      instance: this.instance,
      registeredChain: this.registeredChainPda(toChainId(chain)),
      outboxItem,
      relayRequest: this.relayRequestPda(outboxItem),
      systemProgram: SystemProgram.programId,
    }).instruction();
  }

  // ---- admin/assistant (=authority) relevant functions ----

  async tryGetInstance() {
    const data = await this.program.account.instance.fetchNullable(this.instance);
    return data && {
      owner:        data.owner,
      assistant:    data.assistant,
      feeRecipient: data.feeRecipient,
      solPriceUsd:  U64.from(data.solPrice, USD_UNIT),
    };
  }

  async tryGetRegisteredChain(chain: Chain) {
    const data = await this.program.account.registeredChain.fetchNullable(
      this.registeredChainPda(toChainId(chain))
    );
    
    return data && {
      paused:           data.basePrice.eq(U64.MAX),
      maxGasDropoffEth: U64.from(data.maxGasDropoff, GWEI_PER_ETH),
      basePriceUsd:     U64.from(data.basePrice,     USD_UNIT    ),
      nativePriceUsd:   U64.from(data.nativePrice,   USD_UNIT    ),
      gasPriceGwei:     U64.from(data.gasPrice,      WEI_PER_GWEI),
    };
  }

  async tryGetRegisteredNtt(nttProgramId: PublicKey) {
    const data = await this.program.account.registeredNtt.fetchNullable(
      this.registeredNttPda(nttProgramId)
    );
    
    return data && {
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

    return relayRequest ? U64.from(relayRequest.requestedGasDropoff, GWEI_PER_ETH) : null;
  }


  async createInitializeInstruction(feeRecipient: PublicKey) {
    const instance = await this.tryGetInstance();
    if (instance !== null)
      throw new Error("Quoter is already initialized");
    const programData = programDataAddress(this.program.programId);

    const accInfo = await this.program.provider.connection.getAccountInfo(programData);
    if (!accInfo)
      throw new Error("Could not find program data account");

    const deserProgramData = deserializeLayout(programDataLayout, accInfo.data);
    if (!deserProgramData.upgradeAuthority.isSome)
      throw new Error("Could not determine program owner from program data.");

    return this.program.methods.initialize().accounts({
      owner: deserProgramData.upgradeAuthority.value,
      instance: this.instance,
      feeRecipient,
      programData,
      systemProgram: SystemProgram.programId,
    }).instruction();
  }

  async createSetAssistantInstruction(instance: QuoterInstanceState, assistant: PublicKey) {
    const {owner, assistant: currentAssistant} = instance;
    if (currentAssistant.equals(assistant))
      throw new Error("Is already assistant");

    return this.program.methods.setAssistant().accounts({
      owner,
      instance: this.instance,
      assistant,
    }).instruction();
  }

  async createSetFeeRecipientInstruction(instance: QuoterInstanceState, feeRecipient: PublicKey) {
    if (feeRecipient.equals(PublicKey.default))
      throw new Error("Fee recipient cannot be default public key");

    const {owner, feeRecipient: currentFeeRecipient} = instance;
    if (currentFeeRecipient.equals(feeRecipient))
      throw new Error("Is already feeRecipient");

    return this.program.methods.setFeeRecipient().accounts({
      owner,
      instance: this.instance,
      feeRecipient,
    }).instruction();
  }

  async createRegisterChainInstruction(authority: PublicKey, chain: Chain) {
    const chainId = toChainId(chain);
    return this.program.methods.registerChain({chainId}).accounts({
      authority,
      instance: this.instance,
      registeredChain: this.registeredChainPda(chainId),
      systemProgram: SystemProgram.programId,
    }).instruction();
  }

  async createRegisterNttInstruction(
    authority: PublicKey,
    nttProgramId: PublicKey,
    gasCost: number,
    wormholeTransceiverIndex: number,
  ) {
    return this.program.methods.registerNtt({
      nttProgramId,
      gasCost,
      wormholeTransceiverIndex,
    }).accounts({
      authority,
      instance: this.instance,
      registeredNtt: this.registeredNttPda(nttProgramId),
      systemProgram: SystemProgram.programId,
    }).instruction();
  }

  async createDeregisterNttInstruction(
    authority: PublicKey,
    nttProgramId: PublicKey,
  ) {
    return this.program.methods.deregisterNtt({ nttProgramId }).accounts({
      authority,
      instance: this.instance,
      registeredNtt: this.registeredNttPda(nttProgramId),
      systemProgram: SystemProgram.programId,
    }).instruction();
  }

  async createUpdateSolPriceInstruction(authority: PublicKey, solPriceUsd: number) {
    return this.program.methods.updateSolPrice({
      solPrice: U64.to(solPriceUsd, USD_UNIT),
    }).accounts({
      authority,
      instance: this.instance,
    }).instruction();
  }

  async createUpdateChainParamsInstruction(
    authority:        PublicKey,
    chain:            Chain,
    maxGasDropoffEth: number,
    basePriceUsd:     number,
  ) {
    return this.program.methods.updateChainParams({
      maxGasDropoff: U64.to(maxGasDropoffEth, GWEI_PER_ETH),
      basePrice:     U64.to(basePriceUsd,     USD_UNIT    ),
    }).accounts({
      authority,
      instance: this.instance,
      registeredChain: this.registeredChainPda(toChainId(chain)),
    }).instruction();
  }

  async createPauseRelayForChainInstruction(authority: PublicKey, chain: Chain) {
    return this.program.methods.updateChainParams({
      maxGasDropoff: U64.to(0, 1),
      basePrice:     U64.MAX,
    }).accounts({
      authority,
      instance: this.instance,
      registeredChain: this.registeredChainPda(toChainId(chain)),
    }).instruction();
  }

  async createUpdateChainPricesInstruction(
    authority: PublicKey,
    chain: Chain,
    nativePriceUsd: number,
    gasPriceGwei: number,
  ) {
    return this.program.methods.updateChainPrices({
      nativePrice: U64.to(nativePriceUsd, USD_UNIT),
      gasPrice:    U64.to(gasPriceGwei, WEI_PER_GWEI),
    }).accounts({
      authority,
      instance: this.instance,
      registeredChain: this.registeredChainPda(toChainId(chain)),
    }).instruction();
  }

  async createCloseRelayInstruction(authority: PublicKey, outboxItem: PublicKey) {
    return this.program.methods.closeRelay().accounts({
      authority,
      instance: this.instance,
      relayRequest: this.relayRequestPda(outboxItem),
    }).instruction();
  }

  // ---- PDA derivation methods ----

  private registeredChainPda(chainId: number) {
    return derivePda(
      [SEED_PREFIX_REGISTERED_CHAIN, chainIdToBeBytes(chainId)],
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
