import { ChainContext, chainToPlatform } from "@wormhole-foundation/sdk";
import type { Network, Chain } from "@wormhole-foundation/sdk";
import type { SolanaChains } from "@wormhole-foundation/sdk-solana";
import type { EvmChains } from "@wormhole-foundation/sdk-evm";
import * as spl from "@solana/spl-token";
import { PublicKey, Connection, Keypair } from "@solana/web3.js";
import { NTT } from "@wormhole-foundation/sdk-solana-ntt";
import type { SignerType } from "./getSigner";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { createMetadataAccountV3, findMetadataPda, fetchMetadata } from "@metaplex-foundation/mpl-token-metadata";
import { fromWeb3JsKeypair } from "@metaplex-foundation/umi-web3js-adapters";
import { keypairIdentity, publicKey, createSignerFromKeypair } from "@metaplex-foundation/umi";
import { ethers } from "ethers";
import fs from "fs";

export interface TokenMetadata {
    name: string;
    symbol: string;
    uri?: string;
}

export interface StandardTokenInfo {
    address: string;
    name: string;
    symbol: string;
    uri: string;
    decimals: number;
}

export interface CreateTokenOptions {
    decimals: number;
    metadata: TokenMetadata;
}

export interface SolanaCreateTokenOptions extends CreateTokenOptions {
    tokenProgram: "legacy" | "token22";
    payer: string;
}

export interface EvmCreateTokenOptions extends CreateTokenOptions {
    signerType: SignerType;
}

// Main routing function
export async function createToken<N extends Network, C extends Chain>(
    ch: ChainContext<N, C>,
    options: CreateTokenOptions
): Promise<string> {
    const platform = chainToPlatform(ch.chain);
    switch (platform) {
        case "Solana":
            return await createTokenSolana(
                ch as ChainContext<N, SolanaChains>,
                options as SolanaCreateTokenOptions
            );
        case "Evm":
            return await createTokenEvm(
                ch as ChainContext<N, EvmChains>,
                options as EvmCreateTokenOptions
            );
        default:
            throw new Error(`Token creation not supported for platform: ${platform}`);
    }
}

// Solana implementation with Metaplex metadata
async function createTokenSolana<N extends Network, C extends SolanaChains>(
    ch: ChainContext<N, C>,
    options: SolanaCreateTokenOptions
): Promise<string> {
    const { decimals, tokenProgram, payer, metadata } = options;

    const tokenProgramId = tokenProgram === "legacy"
        ? spl.TOKEN_PROGRAM_ID
        : spl.TOKEN_2022_PROGRAM_ID;

    // Step 1: Create token with payer as mint authority
    const createTokenArgs = [
        "spl-token",
        "create-token",
        "--fee-payer", payer,
        "--mint-authority", payer,
        "--decimals", decimals.toString(),
        "-u", ch.config.rpc,
        "--program-id", tokenProgramId.toBase58(),
    ];

    const proc = Bun.spawn(createTokenArgs);
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0) {
        throw new Error(`Failed to create token: ${out}`);
    }

    const tokenAddress = out.split("\n")
        .find((line) => line.startsWith("Address: "))
        ?.split(" ")[2];

    const signature = out.split("\n")
        .find((line) => line.startsWith("Signature: "))
        ?.split(" ")[1];

    if (!tokenAddress) {
        throw new Error("Failed to parse token address from output");
    }

    // Wait for transaction confirmation
    if (signature) {
        console.error("Waiting for token creation transaction to confirm...");
        const connection = new Connection(ch.config.rpc);
        await connection.confirmTransaction(signature, "finalized");
    }

    // Step 2: Create metadata
    await createMetaplexMetadata(ch, tokenAddress, payer, metadata);
    return tokenAddress;
}

// Create metadata using Metaplex TypeScript SDK
async function createMetaplexMetadata<N extends Network, C extends SolanaChains>(
    ch: ChainContext<N, C>,
    mintAddress: string,
    payer: string,
    metadata: TokenMetadata
): Promise<void> {
    try {
        console.error("Creating metadata using Metaplex SDK...");

        // Load the payer keypair
        const payerKeypairData = JSON.parse(fs.readFileSync(payer, 'utf8'));
        const payerKeypair = Keypair.fromSecretKey(new Uint8Array(payerKeypairData));

        // Create UMI instance
        const umi = createUmi(ch.config.rpc);

        // Set the keypair as the identity
        const umiKeypair = fromWeb3JsKeypair(payerKeypair);
        umi.use(keypairIdentity(umiKeypair));

        // Create signer for parameters that need it
        const signer = createSignerFromKeypair(umi, umiKeypair);

        // Convert mint address to UMI format
        const mint = publicKey(mintAddress);

        // Verify mint exists
        const connection = new Connection(ch.config.rpc);
        const mintInfo = await connection.getAccountInfo(new PublicKey(mintAddress));
        if (!mintInfo) {
            throw new Error("Mint account not found after creation - transaction may not be confirmed");
        }

        // Create metadata account
        const transaction = createMetadataAccountV3(umi, {
            mint,
            mintAuthority: signer,
            payer: signer,
            updateAuthority: signer.publicKey,
            data: {
                name: metadata.name,
                symbol: metadata.symbol,
                uri: metadata.uri || "",
                sellerFeeBasisPoints: 0,
                creators: null,
                collection: null,
                uses: null,
            },
            isMutable: true,
            collectionDetails: null,
        });

        // Build and send the transaction
        await transaction.sendAndConfirm(umi);

    } catch (error) {
        console.error("Failed to create metadata with Metaplex SDK:");
        if (error instanceof Error) {
            console.error(`  ${error.message}`);
        }
        throw error;
    }
}

// Stub for future EVM implementation
async function createTokenEvm<N extends Network, C extends EvmChains>(
    _ch: ChainContext<N, C>,
    _options: EvmCreateTokenOptions
): Promise<string> {
    throw new Error("EVM token creation not yet implemented");
}

// Fetch token metadata from EVM chains
async function fetchTokenMetadataEvm<N extends Network, C extends EvmChains>(
    ch: ChainContext<N, C>,
    tokenAddress: string
): Promise<StandardTokenInfo> {
    try {
        // Create provider
        const provider = new ethers.JsonRpcProvider(ch.config.rpc);

        // ERC-20 standard function signatures
        const erc20Abi = [
            "function name() view returns (string)",
            "function symbol() view returns (string)",
            "function decimals() view returns (uint8)"
        ];

        // ERC-721 metadata extension (optional)
        const erc721MetadataAbi = [
            "function tokenURI(uint256 tokenId) view returns (string)"
        ];

        // ERC-1155 metadata extension (optional)
        const erc1155MetadataAbi = [
            "function uri(uint256 id) view returns (string)"
        ];

        // Create contract instance for ERC-20 functions
        const contract = new ethers.Contract(tokenAddress, erc20Abi, provider);

        // Fetch basic ERC-20 metadata
        const [name, symbol, decimals] = await Promise.all([
            contract.name(),
            contract.symbol(),
            contract.decimals()
        ]);

        // Try to get URI from various metadata standards
        let uri = "";

        // Try ERC-721 tokenURI (using token ID 0 as default)
        try {
            const erc721Contract = new ethers.Contract(tokenAddress, erc721MetadataAbi, provider);
            uri = await erc721Contract.tokenURI(0);
        } catch {
            // Try ERC-1155 uri (using ID 0 as default)
            try {
                const erc1155Contract = new ethers.Contract(tokenAddress, erc1155MetadataAbi, provider);
                uri = await erc1155Contract.uri(0);
            } catch {
                // No metadata URI available, leave empty
                uri = "";
            }
        }

        return {
            address: tokenAddress,
            name: name,
            symbol: symbol,
            uri: uri,
            decimals: Number(decimals),
        };
    } catch (error) {
        if (error instanceof Error) {
            if (error.message.includes("call revert exception") || error.message.includes("execution reverted")) {
                throw new Error(`Token at ${tokenAddress} does not implement ERC-20 standard functions`);
            }
            throw new Error(`Failed to fetch EVM token metadata: ${error.message}`);
        }
        throw error;
    }
}

// Transfer token mint authority to NTT program (Solana only)
export async function transferTokenAuthoritySolana<N extends Network, C extends SolanaChains>(
    ch: ChainContext<N, C>,
    tokenAddress: string,
    nttProgram: string,
    payer: string
): Promise<void> {
    // Get token authority from NTT program
    const programId = new PublicKey(nttProgram);
    const tokenAuthority = NTT.pdas(programId).tokenAuthority();

    // Transfer mint authority to NTT program
    const transferAuthorityArgs = [
        "spl-token",
        "authorize",
        tokenAddress,
        "mint",
        tokenAuthority.toBase58(),
        "--fee-payer", payer,
        "--authority", payer,
        "-u", ch.config.rpc,
    ];

    const transferProc = Bun.spawn(transferAuthorityArgs);
    const transferOut = await new Response(transferProc.stdout).text();
    await transferProc.exited;

    if (transferProc.exitCode !== 0) {
        throw new Error(`Failed to transfer mint authority: ${transferOut}`);
    }

    console.log("✓ Mint authority transferred to NTT program");
    console.log(`  Token: ${tokenAddress}`);
    console.log(`  New mint authority: ${tokenAuthority.toBase58()}`);
}

// Fetch token metadata (Solana only for now)
export async function fetchTokenMetadata<N extends Network, C extends Chain>(
    ch: ChainContext<N, C>,
    tokenAddress: string
): Promise<StandardTokenInfo> {
    const platform = chainToPlatform(ch.chain);
    switch (platform) {
        case "Solana":
            return await fetchTokenMetadataSolana(
                ch as ChainContext<N, SolanaChains>,
                tokenAddress
            );
        case "Evm":
            return await fetchTokenMetadataEvm(
                ch as ChainContext<N, EvmChains>,
                tokenAddress
            );
        default:
            throw new Error(`Token metadata fetching not supported for platform: ${platform}`);
    }
}

// Fetch token metadata from Solana using Metaplex SDK
async function fetchTokenMetadataSolana<N extends Network, C extends SolanaChains>(
    ch: ChainContext<N, C>,
    tokenAddress: string
): Promise<StandardTokenInfo> {
    try {
        // Create UMI instance
        const umi = createUmi(ch.config.rpc);

        // Convert mint address to UMI format
        const mint = publicKey(tokenAddress);

        // Find the metadata PDA for this mint
        const metadataPda = findMetadataPda(umi, { mint });

        // Fetch the metadata account
        const metadata = await fetchMetadata(umi, metadataPda);

        // Also fetch basic mint info using web3.js for additional details
        const connection = new Connection(ch.config.rpc);
        const mintInfo = await connection.getAccountInfo(new PublicKey(tokenAddress));

        let mintData = null;
        if (mintInfo) {
            // Parse mint data to get decimals, supply, etc.
            try {
                mintData = spl.MintLayout.decode(new Uint8Array(mintInfo.data));
            } catch (error) {
                // Might be Token-2022, try different parsing
                console.log("Failed to parse with legacy mint layout, might be Token-2022");
            }
        }

        // Get decimals from mint data
        const decimals = mintData?.decimals ?? 0;

        return {
            address: tokenAddress,
            name: metadata.name,
            symbol: metadata.symbol,
            uri: metadata.uri,
            decimals,
        };
    } catch (error) {
        if (error instanceof Error && error.message.includes("Account not found")) {
            throw new Error(`No metadata found for token ${tokenAddress}. This token may not have Metaplex metadata.`);
        }
        throw error;
    }
}

export { createToken as default };
