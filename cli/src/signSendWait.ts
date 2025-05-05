import type { EvmChains, EvmNativeSigner, EvmUnsignedTransaction } from "@wormhole-foundation/sdk-evm";
import { type Network, type Chain, type ChainContext, type UnsignedTransaction, type TransactionId, type Signer, type AccountAddress, signSendWait, chainToPlatform } from "@wormhole-foundation/sdk";
import { Interface } from "ethers";




export const signSendWaitEvmSpecialOwner = async <N extends Network>(
    ctx: ChainContext<N, EvmChains>,
    txs: AsyncGenerator<EvmUnsignedTransaction<N, EvmChains>>,
    evmSigner: EvmNativeSigner<N>,
    nttOwner: string
) => {
    const executorInterface = new Interface(["function execute(address target, bytes calldata data)"] as const)
    const allIds: TransactionId[] = []
    for await (const tx of txs) {
        if(tx.transaction.to === undefined) {
            console.log(`skipping evm txn with no to address`)
            continue
        }
        // reencode the call data to call the execute function
        const newCallData = executorInterface.encodeFunctionData("execute", [tx.transaction.to, tx.transaction.data])
        tx.transaction.data = newCallData
        // set the new target to the ntt owner
        tx.transaction.to = nttOwner.toString()
        try {
            const signedTx = await evmSigner.sign([tx])
            const ids = await ctx.sendWait(signedTx)
            for(const id of ids) {
                allIds.push({
                    chain: ctx.chain,
                    txid: id,
                })
            }
        }catch (e) {
            console.warn(`failed to execute tx on ${ctx.network}`)
            throw e
        }
    }
    return allIds
}

export const signSendWaitWithOverride = async <N extends Network, C extends Chain>(
    chain: ChainContext<N, C>,
    xfer: AsyncGenerator<UnsignedTransaction<N, C>>,
    signer: Signer<N, C>,
    nttOwner: string | undefined
): Promise<TransactionId[]> => {
    const ctx = chain as ChainContext<N, EvmChains>
    const platform = chainToPlatform(ctx.chain)
    if(nttOwner && platform === "Evm"){
        // unsafe casts here but we should know by the platform check.
        return signSendWaitEvmSpecialOwner(ctx, xfer  as any, signer as any, nttOwner.toString())
    }
    return signSendWait(chain, xfer, signer)
}

export const newSignSendWaiter = <N extends Network, C extends Chain>(nttOwner: string | undefined) => {
    return async (
        chain: ChainContext<N, C>,
        xfer: AsyncGenerator<UnsignedTransaction<N, C>>,
        signer: Signer<N, C>,
    )=> {
            return await signSendWaitWithOverride(
                chain,
                xfer,
                signer,
                nttOwner,
            )
        }
}
