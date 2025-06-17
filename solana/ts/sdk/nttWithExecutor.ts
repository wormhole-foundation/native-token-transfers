import { toChainId, type Network } from "@wormhole-foundation/sdk-base";
import {
  type AccountAddress,
  type ChainAddress,
  type ChainsConfig,
  Contracts,
  UnsignedTransaction,
} from "@wormhole-foundation/sdk-definitions";
import { Ntt, NttWithExecutor } from "@wormhole-foundation/sdk-definitions-ntt";
import {
  SolanaPlatform,
  type SolanaPlatformType,
  type SolanaChains,
  SolanaAddress,
} from "@wormhole-foundation/sdk-solana";
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { SolanaNtt } from "./ntt.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ExampleNttWithExecutor,
  ExampleNttWithExecutorIdl,
} from "../idl/executor/example_ntt_with_executor.js";
import {
  ExampleNttSvmLut,
  ExampleNttSvmLutIdl,
} from "../idl/executor/example_ntt_svm_lut.js";
import { chainToBytes } from "../lib/utils.js";

export class SolanaNttWithExecutor<N extends Network, C extends SolanaChains>
  implements NttWithExecutor<N, C>
{
  readonly nttWithExecutorProgramId: PublicKey;
  readonly nttLutProgramId: PublicKey;
  readonly executorProgramId: PublicKey;

  constructor(
    readonly network: N,
    readonly chain: C,
    readonly connection: Connection,
    readonly contracts: Contracts & { ntt?: Ntt.Contracts }
  ) {
    this.nttWithExecutorProgramId = new PublicKey(
      "nex1gkSWtRBheEJuQZMqHhbMG5A45qPU76KqnCZNVHR"
    );

    this.nttLutProgramId = new PublicKey(
      "1uteB5DZdNfns9B12rgGf5msKh1d7FbbkvciWmhsZiC"
    );

    this.executorProgramId = new PublicKey(
      "execXUrAsMnqMmTHj5m7N1YQgsDz3cwGLYCYyuDRciV"
    );
  }

  static async fromRpc<N extends Network>(
    connection: Connection,
    config: ChainsConfig<N, SolanaPlatformType>
  ): Promise<SolanaNttWithExecutor<N, SolanaChains>> {
    const [network, chain] = await SolanaPlatform.chainFromRpc(connection);
    const conf = config[chain]!;
    if (conf.network !== network)
      throw new Error(`Network mismatch: ${conf.network} != ${network}`);

    return new SolanaNttWithExecutor(
      network as N,
      chain,
      connection,
      conf.contracts
    );
  }

  async *transfer(
    sender: AccountAddress<C>,
    destination: ChainAddress,
    amount: bigint,
    quote: NttWithExecutor.Quote,
    ntt: SolanaNtt<N, C>,
    wrapNative: boolean = false
  ): AsyncGenerator<UnsignedTransaction<N, C>> {
    const senderPk = new SolanaAddress(sender).unwrap();

    const options = { queue: false, automatic: false, wrapNative };
    const outboxItem = Keypair.generate();

    const txs = ntt.transfer(
      sender,
      quote.remainingAmount,
      destination,
      options,
      outboxItem
    );

    for await (const tx of txs) {
      if (tx.description === "Ntt.Transfer") {
        const luts: AddressLookupTableAccount[] = [];
        try {
          luts.push(await ntt.getAddressLookupTable());
        } catch (e: any) {
          console.debug(e);
        }

        const message = TransactionMessage.decompile(
          tx.transaction.transaction.message,
          { addressLookupTableAccounts: luts }
        );

        if (quote.referrerFee > 0n) {
          const referrer = new PublicKey(quote.referrer.address.toString());

          const { mint, tokenProgram } = await ntt.getConfig();
          const referrerAta = getAssociatedTokenAddressSync(
            mint,
            referrer,
            true,
            tokenProgram
          );
          const senderAta = getAssociatedTokenAddressSync(
            mint,
            senderPk,
            true,
            tokenProgram
          );
          const referrerAtaAccount = await this.connection.getAccountInfo(
            referrerAta
          );
          if (!referrerAtaAccount) {
            message.instructions.push(
              createAssociatedTokenAccountIdempotentInstruction(
                senderPk,
                referrerAta,
                referrer,
                mint,
                tokenProgram
              )
            );
          }
          message.instructions.push(
            createTransferInstruction(
              senderAta,
              referrerAta,
              senderPk,
              quote.referrerFee,
              undefined,
              tokenProgram
            )
          );
        }

        const nttWithExecutorProgram = new Program<ExampleNttWithExecutor>(
          ExampleNttWithExecutorIdl as ExampleNttWithExecutor,
          this.nttWithExecutorProgramId,
          { connection: this.connection }
        );

        const nttProgramId = new PublicKey(this.contracts.ntt!.manager);
        const nttPeer = PublicKey.findProgramAddressSync(
          [Buffer.from("peer"), chainToBytes(destination.chain)],
          nttProgramId
        )[0];

        message.instructions.push(
          await nttWithExecutorProgram.methods
            .relayNttMesage({
              execAmount: new BN(quote.estimatedCost.toString()),
              recipientChain: toChainId(destination.chain),
              signedQuoteBytes: Buffer.from(quote.signedQuote),
              relayInstructions: Buffer.from(quote.relayInstructions),
            })
            .accounts({
              payer: senderPk,
              payee: new PublicKey(quote.payeeAddress),
              nttProgramId,
              nttPeer,
              nttMessage: outboxItem.publicKey,
              executorProgram: this.executorProgramId,
            })
            .instruction()
        );

        if (luts.length === 0) {
          console.debug(
            "no manager lookup table found, checking helper program"
          );
          const nttSvmLutProgram = new Program<ExampleNttSvmLut>(
            ExampleNttSvmLutIdl as ExampleNttSvmLut,
            this.nttLutProgramId,
            { connection: this.connection }
          );

          const lutPointerAddress = PublicKey.findProgramAddressSync(
            [Buffer.from("lut"), nttProgramId.toBuffer()],
            nttSvmLutProgram.programId
          )[0];

          let lutPointer =
            // @ts-ignore
            await nttSvmLutProgram.account.lut.fetchNullable(lutPointerAddress);

          if (!lutPointer) {
            console.debug(
              "no helper program lookup table found, initializing..."
            );
            const [nttConfigPDA] = await PublicKey.findProgramAddressSync(
              [Buffer.from("config")],
              nttProgramId
            );

            const [authorityPDA] = await PublicKey.findProgramAddressSync(
              [Buffer.from("lut_authority")],
              nttSvmLutProgram.programId
            );

            const recentSlot =
              (await this.connection.getSlot("finalized")) - 10;

            const [lutAddressPDA] = await PublicKey.findProgramAddressSync(
              [
                authorityPDA.toBuffer(),
                new BN(recentSlot).toArrayLike(Buffer, "le", 8),
              ],
              AddressLookupTableProgram.programId
            );

            const [lutPDA] = await PublicKey.findProgramAddressSync(
              [Buffer.from("lut"), nttProgramId.toBuffer()],
              nttSvmLutProgram.programId
            );

            const ix = await nttSvmLutProgram.methods
              .initializeLut(new BN(recentSlot))
              .accounts({
                nttProgramId,
                nttConfig: nttConfigPDA,
                authority: authorityPDA,
                lutAddress: lutAddressPDA,
                lut: lutPDA,
                lutProgram: AddressLookupTableProgram.programId,
                systemProgram: SystemProgram.programId,
                payer: senderPk,
              })
              .instruction();

            const lutInitMessage = new TransactionMessage({
              payerKey: senderPk,
              recentBlockhash: (
                await this.connection.getLatestBlockhash("finalized")
              ).blockhash,
              instructions: [ix],
            }).compileToV0Message();

            yield ntt.createUnsignedTx(
              { transaction: new VersionedTransaction(lutInitMessage) },
              "NttSvmLut.InitializeLut"
            );

            console.debug(`initialized lookup table: ${tx}`);

            let retries = 0;
            while (!lutPointer && retries < 10) {
              // wait for lut to warm up
              await new Promise((resolve) => setTimeout(resolve, 2000));
              lutPointer =
                // @ts-ignore
                await nttSvmLutProgram.account.lut.fetchNullable(
                  lutPointerAddress
                );
              retries++;
            }
          }

          const response = await this.connection.getAddressLookupTable(
            lutPointer.address
          );
          if (!response.value) {
            throw new Error("unable to fetch lookup table");
          }
          luts.push(response.value);
        }

        tx.transaction.transaction.message = message.compileToV0Message(luts);
        yield tx;
      } else {
        yield tx;
      }
    }
  }

  static associatedTokenAccountMinRent: bigint | undefined = undefined;

  async estimateMsgValueAndGasLimit(
    recipient: ChainAddress | undefined
  ): Promise<{ msgValue: bigint; gasLimit: bigint }> {
    let msgValue = 0n;

    // These are estimates with some padding, actual values may vary
    msgValue += 2n * 5000n + 7n * 5000n + 1_400_000n; // post vaa, 2 sigs + 7 Secp256k1 SigVerify Precompile + 1 sig account rent (59 bytes)
    msgValue += 2n * 5000n + 7n * 5000n; // post vaa, 2 signatures + 7 Secp256k1 SigVerify Precompile
    msgValue += 5000n + 3_200_000n; // core bridge post vaa account
    msgValue += 5000n + 5_000_000n; // receive wormhole message accounts
    msgValue += 5000n; // release has no accounts, unless sending to a new ATA

    if (recipient) {
      const recipientPk = new PublicKey(recipient.address.toString());

      const mint = new SolanaAddress(this.contracts.ntt!.token).unwrap();
      const mintInfo = await this.connection.getAccountInfo(mint);
      if (mintInfo === null)
        throw new Error(
          "Couldn't determine token program. Mint account is null."
        );

      const ata = getAssociatedTokenAddressSync(
        mint,
        recipientPk,
        true,
        mintInfo.owner
      );

      if ((await this.connection.getAccountInfo(ata)) === null) {
        if (!SolanaNttWithExecutor.associatedTokenAccountMinRent) {
          SolanaNttWithExecutor.associatedTokenAccountMinRent = BigInt(
            await this.connection.getMinimumBalanceForRentExemption(165) // ATA is 165 bytes
          );
        }
        msgValue += SolanaNttWithExecutor.associatedTokenAccountMinRent;
      }
    }

    return { msgValue, gasLimit: 250_000n };
  }
}
