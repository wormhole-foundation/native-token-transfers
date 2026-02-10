/**
 * Hyperliquid L1 action for setting big blocks on HyperEVM
 */

import { ethers, Signature } from "ethers";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { colors } from "./colors.js";

const HYPERLIQUID_API = {
  testnet: "https://api.hyperliquid-testnet.xyz",
  mainnet: "https://api.hyperliquid.xyz",
};

/**
 * Enable or disable big blocks for HyperEVM deployments.
 * Big blocks are required for deploying large contracts like NTT.
 */
export async function setHyperEvmBigBlocks(
  privateKey: string,
  enable: boolean,
  isTestnet: boolean
): Promise<{ success: boolean; address: string; error?: string }> {
  const apiUrl = isTestnet ? HYPERLIQUID_API.testnet : HYPERLIQUID_API.mainnet;
  const action = { type: "evmUserModify", usingBigBlocks: enable };
  const nonce = Date.now();

  let wallet: ethers.Wallet | undefined;
  try {
    wallet = new ethers.Wallet(privateKey);
    // Compute action hash: keccak256(msgpack(action) + nonce_bytes + vault_byte)
    const actionPacked = msgpackEncode(action);
    const nonceBytes = new Uint8Array(8);
    new DataView(nonceBytes.buffer).setBigUint64(0, BigInt(nonce), false);
    const data = new Uint8Array(actionPacked.length + nonceBytes.length + 1);
    data.set(actionPacked, 0);
    data.set(nonceBytes, actionPacked.length);
    data[data.length - 1] = 0; // no vault

    const connectionId = ethers.keccak256(data);

    // Sign with EIP-712
    const sig = Signature.from(
      await wallet.signTypedData(
        {
          name: "Exchange",
          version: "1",
          chainId: 1337,
          verifyingContract: "0x0000000000000000000000000000000000000000",
        },
        {
          Agent: [
            { name: "source", type: "string" },
            { name: "connectionId", type: "bytes32" },
          ],
        },
        { source: isTestnet ? "b" : "a", connectionId }
      )
    );

    const res = await fetch(`${apiUrl}/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        nonce,
        signature: { r: sig.r, s: sig.s, v: sig.v },
        vaultAddress: null,
      }),
    });

    const json = (await res.json()) as { status?: string; response?: unknown };
    if (!res.ok || json.status === "err") {
      throw new Error(JSON.stringify(json.response ?? json));
    }

    return { success: true, address: wallet.address };
  } catch (error) {
    return {
      success: false,
      address: wallet?.address ?? "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * CLI helper to enable/disable big blocks with console output and error handling
 */
export async function enableBigBlocks(
  isTestnet: boolean,
  enable: boolean = true
): Promise<void> {
  const privateKey = process.env.ETH_PRIVATE_KEY;
  if (!privateKey) {
    console.error(
      colors.red(
        "ETH_PRIVATE_KEY environment variable is not set. Please set it to your deployer wallet's private key."
      )
    );
    process.exit(1);
  }

  const networkName = isTestnet ? "HyperEVM Testnet" : "HyperEVM Mainnet";
  console.log(
    colors.cyan(
      `${enable ? "Enabling" : "Disabling"} big blocks on ${networkName}...`
    )
  );

  const result = await setHyperEvmBigBlocks(privateKey, enable, isTestnet);
  if (result.success) {
    console.log(
      colors.green(
        `Successfully ${enable ? "enabled" : "disabled"} big blocks for address ${result.address}`
      )
    );
  } else {
    console.error(colors.red(`Failed to set big blocks: ${result.error}`));
    process.exit(1);
  }
}
