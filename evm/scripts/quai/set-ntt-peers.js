const { ethers } = require("ethers"); // For Sepolia
const { Wallet, Contract, JsonRpcProvider } = require("quais"); // For Quai
require("dotenv").config();
const fs = require("fs");

/*
 * Expected environment variables:
 *   PASSWORD                    – password to decrypt the wallet.json files
 *   SEPOLIA_RPC_URL            – Sepolia JSON-RPC endpoint
 *   QUAI_RPC_URL               – Quai JSON-RPC endpoint
 *   SEPOLIA_PRIVATE_KEY        – Private key for Sepolia (optional, uses wallet.json if not provided)
 *   QUAI_NTT_MANAGER           – Address of NTT Manager on Quai
 *   SEPOLIA_NTT_MANAGER        – Address of NTT Manager on Sepolia
 *   QUAI_WORMHOLE_TRANSCEIVER  – Address of Wormhole Transceiver on Quai
 *   SEPOLIA_WORMHOLE_TRANSCEIVER – Address of Wormhole Transceiver on Sepolia
 */

// Chain IDs (Wormhole format)
const QUAI_CHAIN_ID = 15000;  // Wormhole chain ID for Quai testnet
const SEPOLIA_CHAIN_ID = 10002; // Wormhole chain ID for Sepolia

// ABIs
const NTT_MANAGER_ABI = [
  "function setPeer(uint16 peerChainId, bytes32 peerContract, uint8 decimals, uint256 inboundLimit) external",
  "function getPeer(uint16 chainId_) external view returns (tuple(bytes32 peerAddress, uint8 tokenDecimals))",
  "function owner() external view returns (address)"
];

const WORMHOLE_TRANSCEIVER_ABI = [
  "function setWormholePeer(uint16 chainId, bytes32 peerContract) external",
  "function getWormholePeer(uint16 chainId) external view returns (bytes32)",
  "function owner() external view returns (address)"
];

function getEnv(name, required = true) {
  const value = process.env[name];
  if (required && (value === undefined || value === "")) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function loadQuaiWalletFromFile(walletPath, password) {
  try {
    const walletData = fs.readFileSync(walletPath, "utf8");
    const wallet = await Wallet.fromEncryptedJson(walletData, password);
    return wallet;
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`Wallet file not found: ${walletPath}`);
    } else if (error.message.includes("invalid password")) {
      throw new Error("Invalid password for wallet decryption");
    } else {
      throw new Error(`Failed to load wallet: ${error.message}`);
    }
  }
}

// Convert address to bytes32 (left-padded with zeros)
function addressToBytes32(address) {
  return ethers.zeroPadValue(address, 32);
}

async function main() {
  console.log("Setting up NTT peers for cross-chain bridging...\n");

  // Get contract addresses
  const quaiNttManager = getEnv("QUAI_NTT_MANAGER");
  const sepoliaNttManager = getEnv("SEPOLIA_NTT_MANAGER");
  const quaiWormholeTransceiver = getEnv("QUAI_WORMHOLE_TRANSCEIVER");
  const sepoliaWormholeTransceiver = getEnv("SEPOLIA_WORMHOLE_TRANSCEIVER");

  console.log("Contract addresses:");
  console.log("  Quai NTT Manager:", quaiNttManager);
  console.log("  Sepolia NTT Manager:", sepoliaNttManager);
  console.log("  Quai Wormhole Transceiver:", quaiWormholeTransceiver);
  console.log("  Sepolia Wormhole Transceiver:", sepoliaWormholeTransceiver);

  // ---------------------------------------------------------------------------
  // Setup Sepolia connection (ethers.js v6)
  // ---------------------------------------------------------------------------
  console.log("\nSetting up Sepolia connection...");
  const sepoliaRpcUrl = getEnv("SEPOLIA_RPC_URL");
  const sepoliaProvider = new ethers.JsonRpcProvider(sepoliaRpcUrl);

  let sepoliaSigner;
  const sepoliaPrivateKey = getEnv("SEPOLIA_PRIVATE_KEY", false);
  if (sepoliaPrivateKey) {
    sepoliaSigner = new ethers.Wallet(sepoliaPrivateKey, sepoliaProvider);
  } else {
    // Use encrypted wallet file for Sepolia (assuming similar format)
    const password = getEnv("PASSWORD");
    const walletData = fs.readFileSync("./sepolia-wallet.json", "utf8");
    sepoliaSigner = await ethers.Wallet.fromEncryptedJson(walletData, password);
    sepoliaSigner = sepoliaSigner.connect(sepoliaProvider);
  }

  console.log("Sepolia signer address:", sepoliaSigner.address);
  const sepoliaBalance = await sepoliaProvider.getBalance(sepoliaSigner.address);
  console.log("Sepolia balance:", ethers.formatEther(sepoliaBalance), "ETH");

  // ---------------------------------------------------------------------------
  // Setup Quai connection (quais.js)
  // ---------------------------------------------------------------------------
  console.log("\nSetting up Quai connection...");
  const quaiRpcUrl = getEnv("QUAI_RPC_URL");
  const quaiProvider = new JsonRpcProvider(quaiRpcUrl, undefined, {
    usePathing: true, // Required for Quai
  });

  const password = getEnv("PASSWORD");
  const walletPath = "./wallet.json";
  let quaiWallet = await loadQuaiWalletFromFile(walletPath, password);
  quaiWallet = quaiWallet.connect(quaiProvider);

  console.log("Quai wallet address:", quaiWallet.address);
  const quaiBalance = await quaiProvider.getBalance(quaiWallet.address);
  console.log("Quai balance:", quaiBalance.toString(), "wei");

  // ---------------------------------------------------------------------------
  // Create contract instances
  // ---------------------------------------------------------------------------
  const sepoliaNttManagerContract = new ethers.Contract(sepoliaNttManager, NTT_MANAGER_ABI, sepoliaSigner);
  const quaiNttManagerContract = new Contract(quaiNttManager, NTT_MANAGER_ABI, quaiWallet);

  const sepoliaTransceiverContract = new ethers.Contract(sepoliaWormholeTransceiver, WORMHOLE_TRANSCEIVER_ABI, sepoliaSigner);
  const quaiTransceiverContract = new Contract(quaiWormholeTransceiver, WORMHOLE_TRANSCEIVER_ABI, quaiWallet);

  // ---------------------------------------------------------------------------
  // Check current peer settings
  // ---------------------------------------------------------------------------
  console.log("\n=== Checking current peer settings ===");

  try {
    const quaiPeerOnSepolia = await sepoliaNttManagerContract.getPeer(QUAI_CHAIN_ID);
    console.log("Sepolia -> Quai peer:", {
      address: quaiPeerOnSepolia.peerAddress,
      decimals: quaiPeerOnSepolia.tokenDecimals
    });
  } catch (error) {
    console.log("Sepolia -> Quai peer: Not set");
  }

  try {
    const sepoliaPeerOnQuai = await quaiNttManagerContract.getPeer(SEPOLIA_CHAIN_ID);
    console.log("Quai -> Sepolia peer:", {
      address: sepoliaPeerOnQuai.peerAddress,
      decimals: sepoliaPeerOnQuai.tokenDecimals
    });
  } catch (error) {
    console.log("Quai -> Sepolia peer: Not set");
  }

  // Check Wormhole transceiver peers
  try {
    const quaiWormholePeerOnSepolia = await sepoliaTransceiverContract.getWormholePeer(QUAI_CHAIN_ID);
    console.log("Sepolia Transceiver -> Quai Transceiver peer:", quaiWormholePeerOnSepolia);
  } catch (error) {
    console.log("Sepolia Transceiver -> Quai Transceiver peer: Not set");
  }

  try {
    const sepoliaWormholePeerOnQuai = await quaiTransceiverContract.getWormholePeer(SEPOLIA_CHAIN_ID);
    console.log("Quai Transceiver -> Sepolia Transceiver peer:", sepoliaWormholePeerOnQuai);
  } catch (error) {
    console.log("Quai Transceiver -> Sepolia Transceiver peer: Not set");
  }

  // ---------------------------------------------------------------------------
  // Set NTT Manager peers
  // ---------------------------------------------------------------------------
  console.log("\n=== Setting NTT Manager peers ===");

  // Convert addresses to bytes32 format
  const quaiNttManagerBytes32 = addressToBytes32(quaiNttManager);
  const sepoliaNttManagerBytes32 = addressToBytes32(sepoliaNttManager);

  console.log("Setting Sepolia NTT Manager peer to point to Quai...");
  try {
    // Use max uint64 for unlimited inbound transfers when rate limiting is disabled
    const maxInboundLimit = "18446744073709551615"; // 2^64 - 1
    const setPeerTx1 = await sepoliaNttManagerContract.setPeer(
      QUAI_CHAIN_ID,
      quaiNttManagerBytes32,
      18, // decimals for WQUAI
      maxInboundLimit, // inboundLimit - unlimited when SKIP_RATE_LIMIT=true
      { gasLimit: 500000 }
    );
    console.log("  TX hash:", setPeerTx1.hash);
    await setPeerTx1.wait();
    console.log("  Sepolia -> Quai peer set successfully");
  } catch (error) {
    console.log("  Failed to set Sepolia -> Quai peer:", error.message);
  }

  console.log("\nSetting Quai NTT Manager peer to point to Sepolia...");
  try {
    // Use max uint64 for unlimited inbound transfers when rate limiting is disabled (for now)
    const maxInboundLimit = "18446744073709551615"; // 2^64 - 1
    const setPeerTx2 = await quaiNttManagerContract.setPeer(
      SEPOLIA_CHAIN_ID,
      sepoliaNttManagerBytes32,
      18, // decimals for BridgedWQUAI
      maxInboundLimit, // inboundLimit - unlimited when SKIP_RATE_LIMIT=true
      { gasLimit: 500000 }
    );
    console.log("  TX hash:", setPeerTx2.hash);
    await setPeerTx2.wait();
    console.log("  Quai -> Sepolia peer set successfully");
  } catch (error) {
    console.log("  Failed to set Quai -> Sepolia peer:", error.message);
  }

  // ---------------------------------------------------------------------------
  // Set Wormhole Transceiver peers (for manual relaying, these might not be strictly necessary)
  // ---------------------------------------------------------------------------
  console.log("\n=== Setting Wormhole Transceiver peers ===");

  const quaiTransceiverBytes32 = addressToBytes32(quaiWormholeTransceiver);
  const sepoliaTransceiverBytes32 = addressToBytes32(sepoliaWormholeTransceiver);

  console.log("Setting Sepolia Transceiver peer to point to Quai Transceiver...");
  try {
    const setWormholePeerTx1 = await sepoliaTransceiverContract.setWormholePeer(
      QUAI_CHAIN_ID,
      quaiTransceiverBytes32,
      { gasLimit: 500000 }
    );
    console.log("  TX hash:", setWormholePeerTx1.hash);
    await setWormholePeerTx1.wait();
    console.log("  Sepolia Transceiver -> Quai Transceiver peer set successfully");
  } catch (error) {
    console.log("  Failed to set Sepolia Transceiver peer:", error.message);
  }

  console.log("\nSetting Quai Transceiver peer to point to Sepolia Transceiver...");
  try {
    const setWormholePeerTx2 = await quaiTransceiverContract.setWormholePeer(
      SEPOLIA_CHAIN_ID,
      sepoliaTransceiverBytes32,
      { gasLimit: 500000 }
    );
    console.log("  TX hash:", setWormholePeerTx2.hash);
    await setWormholePeerTx2.wait();
    console.log("  Quai Transceiver -> Sepolia Transceiver peer set successfully");
  } catch (error) {
    console.log("  Failed to set Quai Transceiver peer:", error.message);
  }

  // ---------------------------------------------------------------------------
  // Verify peer settings
  // ---------------------------------------------------------------------------
  console.log("\n=== Verifying peer settings ===");

  try {
    const quaiPeerOnSepolia = await sepoliaNttManagerContract.getPeer(QUAI_CHAIN_ID);
    console.log("Sepolia -> Quai peer:", {
      address: quaiPeerOnSepolia.peerAddress,
      decimals: quaiPeerOnSepolia.tokenDecimals.toString()
    });
  } catch (error) {
    console.log("Failed to verify Sepolia -> Quai peer");
  }

  try {
    const sepoliaPeerOnQuai = await quaiNttManagerContract.getPeer(SEPOLIA_CHAIN_ID);
    console.log("Quai -> Sepolia peer:", {
      address: sepoliaPeerOnQuai.peerAddress,
      decimals: sepoliaPeerOnQuai.tokenDecimals.toString()
    });
  } catch (error) {
    console.log("Failed to verify Quai -> Sepolia peer");
  }

  console.log("\nPeer configuration complete!");
  console.log("Your NTT bridge is now ready for cross-chain transfers between Quai and Sepolia.");
  console.log("\nNext steps:");
  console.log("1. Test with a small transfer from Quai to Sepolia");
  console.log("2. Use Wormhole's manual relay process to complete the transfer");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  });