const { deployMetadata } = require("hardhat"); // Still needed for IPFS metadata
require("dotenv").config();
const fs = require("fs");
const { execSync } = require("child_process");
const path = require("path");

// Quai SDK (ethers v6 fork)
const {
  Wallet,
  ContractFactory,
  Contract,
  JsonRpcProvider,
  getAddress,
  parseQuai,
} = require("quais");

// Load ABIs from Forge artifacts
const NttManagerArtifact = require("../../out/NttManager.sol/NttManager.json");
const WormholeTransceiverArtifact = require("../../out/WormholeTransceiver.sol/WormholeTransceiver.json");
const ERC1967ProxyArtifact = require("../../out/ERC1967Proxy.sol/ERC1967Proxy.json");

/*
 * Expected environment variables:
 *   PASSWORD                    – password to decrypt the wallet.json file
 *   RPC_URL                    – Quai JSON-RPC endpoint
 *   WORMHOLE_CORE_ADDRESS      – Address of deployed Wormhole Core contract
 *   TOKEN_ADDRESS              – Address of token to bridge (use address(0) for native QUAI)
 *   MODE                       – 0 for LOCKING, 1 for BURNING
 *   CHAIN_ID                   – Wormhole chain ID for this network
 *   RATE_LIMIT_DURATION        – Rate limit duration in seconds (86400 = 24 hours)
 *   SKIP_RATE_LIMIT            – true/false to skip rate limiting
 *   WORMHOLE_RELAYER_ADDRESS   – Wormhole relayer address (can be zero address for manual)
 *   SPECIAL_RELAYER_ADDRESS    – Special relayer address (can be zero address)
 *   CONSISTENCY_LEVEL          – Wormhole consistency level (202 for finalized)
 *   GAS_LIMIT                  – Gas limit for cross-chain messages (500000 recommended)
 *   OUTBOUND_LIMIT            – Outbound rate limit amount (in token units)
 */

function getEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

/**
 * Run forge build once with all libraries linked
 * @param {Object} libraries - Library addresses to link
 */
function compileContractsWithForge(libraries) {
  console.log("Compiling contracts with Forge...");
  
  // Build libraries *flags* for forge: one --libraries per item so commas don't break parsing
  const libArgs = Object.entries(libraries)
    .map(([libPath, address]) => `--libraries "${libPath}:${address}"`)
    .join(' ');

  // Run forge build with libraries
  const forgeCmd = `forge build ${libArgs}`;
  console.log(`Running: ${forgeCmd}`);
  
  try {
    execSync(forgeCmd, { 
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..')
    });
  } catch (error) {
    throw new Error(`Forge compilation failed: ${error.message}`);
  }
  
  console.log("Forge compilation complete!");
}

/**
 * Get artifact for a specific contract (after forge build has been run)
 * @param {string} contractName - Name of the contract (e.g., "NttManager")
 * @returns {Object} - The compiled artifact with ABI and bytecode
 */
function getForgeArtifact(contractName) {
  // Load the pre-required artifact (which now has updated bytecode from forge build)
  let artifact;
  if (contractName === "NttManager") {
    artifact = NttManagerArtifact;
  } else if (contractName === "WormholeTransceiver") {
    artifact = WormholeTransceiverArtifact;
  } else {
    throw new Error(`Unknown contract: ${contractName}`);
  }
  
  return {
    abi: artifact.abi,
    // Forge's JSON omits the 0x prefix; ContractFactory expects one
    bytecode: artifact.bytecode.object.startsWith("0x")
      ? artifact.bytecode.object
      : "0x" + artifact.bytecode.object,
    deployedBytecode: artifact.deployedBytecode && artifact.deployedBytecode.object
      ? (artifact.deployedBytecode.object.startsWith("0x") ? artifact.deployedBytecode.object : "0x" + artifact.deployedBytecode.object)
      : undefined,
  };
}

async function loadWalletFromFile(walletPath, password) {
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

async function main() {
  // ---------------------------------------------------------------------------
  // Provider / Wallet Setup
  // ---------------------------------------------------------------------------
  const provider = new JsonRpcProvider(getEnv("QUAI_RPC_URL"), undefined, {
    usePathing: true,
  });

  const password = getEnv("PASSWORD");
  const walletPath = "./wallet.json";
  
  console.log("Loading encrypted wallet from:", walletPath);
  let wallet = await loadWalletFromFile(walletPath, password);
  wallet = wallet.connect(provider);
  
  console.log("Wallet address:", wallet.address);
  console.log("Wallet balance:", await provider.getBalance(wallet.address));

  // Address validation for Quai (should start with 0x00 for proper sharding)
  if (!wallet.address.toLowerCase().startsWith("0x00")) {
    console.warn(
      `WARNING: Deployer address ${wallet.address} does not start with 0x00 - ` +
        `contracts may deploy to the wrong shard.`
    );
  }

  // ---------------------------------------------------------------------------
  // Gather deployment parameters
  // ---------------------------------------------------------------------------
  const wormholeCore = getAddress(getEnv("WORMHOLE_CORE_ADDRESS"));
  const tokenAddress = getEnv("TOKEN_ADDRESS");
  const token = tokenAddress === "0x0000000000000000000000000000000000000000" ? 
    "0x0000000000000000000000000000000000000000" : getAddress(tokenAddress);

  const mode = parseInt(getEnv("MODE")); // 0 = LOCKING, 1 = BURNING
  const chainId = parseInt(getEnv("CHAIN_ID"));
  const rateLimitDuration = parseInt(getEnv("RATE_LIMIT_DURATION"));
  const shouldSkipRateLimit = getEnv("SKIP_RATE_LIMIT").toLowerCase() === "true";
  
  const wormholeRelayer = getAddress(getEnv("WORMHOLE_RELAYER_ADDRESS"));
  const specialRelayer = getAddress(getEnv("SPECIAL_RELAYER_ADDRESS"));
  const consistencyLevel = parseInt(getEnv("CONSISTENCY_LEVEL"));
  const gasLimit = parseInt(getEnv("GAS_LIMIT"));
  const outboundLimit = parseQuai(getEnv("OUTBOUND_LIMIT"));

  // For native QUAI, we need to determine decimals
  const decimals = token === "0x0000000000000000000000000000000000000000" ? 18 : 18; // QUAI has 18 decimals
  const TRIMMED_DECIMALS = 8;
  const scale = decimals > TRIMMED_DECIMALS ? 10n ** BigInt(decimals - TRIMMED_DECIMALS) : 1n;

  console.log("Deployment parameters:", {
    wormholeCore,
    token: token,
    mode: mode === 0 ? "LOCKING" : "BURNING",
    chainId,
    rateLimitDuration,
    shouldSkipRateLimit,
    decimals,
    outboundLimit: outboundLimit.toString(),
  });

  // Load deployed library addresses
  const librariesPath = "./deployments/libraries.json";
  if (!fs.existsSync(librariesPath)) {
    throw new Error("Libraries not deployed. Run: npx hardhat run scripts/deploy-libraries-quai.js");
  }
  const deployedLibraries = JSON.parse(fs.readFileSync(librariesPath, "utf8"));
  
  // Get library addresses in the format Forge expects
  const forgeLibraries = {
    "src/libraries/TransceiverStructs.sol:TransceiverStructs": deployedLibraries["src/libraries/TransceiverStructs.sol:TransceiverStructs"],
    "wormhole-solidity-sdk/libraries/BytesParsing.sol:BytesParsing": deployedLibraries["wormhole-solidity-sdk/libraries/BytesParsing.sol:BytesParsing"],
  };
  
  console.log("Available libraries for Forge:", forgeLibraries);
  
  // Verify required library exists
  if (!forgeLibraries["src/libraries/TransceiverStructs.sol:TransceiverStructs"]) {
    throw new Error("TransceiverStructs library not found in deployments. Run deploy-libraries-quai.js first.");
  }

  // Compile all contracts with Forge once (with linked libraries)
  //compileContractsWithForge(forgeLibraries);

  // Check for existing deployments
  const existingNttManager = process.env.NTT_MANAGER_ADDRESS;
  const existingWormholeTransceiver = process.env.WORMHOLE_TRANSCEIVER_ADDRESS;

  console.log("\nChecking for existing deployments:");
  console.log("  NTT Manager:", existingNttManager || "Not set - will deploy");
  console.log("  Wormhole Transceiver:", existingWormholeTransceiver || "Not set - will deploy");

  // Verify WQUAI contract accessibility
  console.log("\nVerifying WQUAI contract...");
  const wquaiContract = new Contract(token, ["function decimals() view returns (uint8)"], wallet);
  try {
    const decimals = await wquaiContract.decimals();
    console.log("  WQUAI decimals:", decimals);
  } catch (error) {
    console.log("  WARNING: Could not read WQUAI decimals:", error.message);
  }

  // ---------------------------------------------------------------------------
  // Deploy NttManager Implementation (if not exists)
  // ---------------------------------------------------------------------------
  let nttManagerAddress, nttManagerImplAddress;
  
  if (existingNttManager && existingNttManager !== "your_deployed_ntt_manager_address_here") {
    console.log("\nUsing existing NttManager:", existingNttManager);
    nttManagerAddress = existingNttManager;
  } else {
    console.log("\nDeploying NttManager Implementation...");
  
    // Get the compiled NttManager artifact
    const nttManagerArtifact = getForgeArtifact("NttManager");
    
    const ipfsHash1 = await deployMetadata.pushMetadataToIPFS("NttManager");
    const NttManagerFactory = new ContractFactory(
      nttManagerArtifact.abi,
      nttManagerArtifact.bytecode,
      wallet,
      ipfsHash1 // provide IPFS hash required by quais ContractFactory
    );

    console.log("Bytecode size after linking: ", nttManagerArtifact.deployedBytecode.length / 2);

  const nttManagerImpl = await NttManagerFactory.deploy(
    token,
    mode, // Mode: 0 = LOCKING, 1 = BURNING
    chainId,
    rateLimitDuration,
    shouldSkipRateLimit
  );

  console.log("  tx hash:", nttManagerImpl.deploymentTransaction().hash);
  await nttManagerImpl.waitForDeployment();
  const nttManagerImplAddress = await nttManagerImpl.getAddress();
  console.log("  NttManager Implementation deployed at:", nttManagerImplAddress);

  // ---------------------------------------------------------------------------
  // Deploy NttManager Proxy
  // ---------------------------------------------------------------------------
  console.log("\nDeploying NttManager Proxy...");
  const ipfsHash2 = await deployMetadata.pushMetadataToIPFS("ERC1967Proxy");
  const ProxyFactory = new ContractFactory(
    ERC1967ProxyArtifact.abi,
    ERC1967ProxyArtifact.bytecode,
    wallet,
    ipfsHash2
  );

  const nttManagerProxy = await ProxyFactory.deploy(nttManagerImplAddress, "0x");
  console.log("  tx hash:", nttManagerProxy.deploymentTransaction().hash);
  await nttManagerProxy.waitForDeployment();
  nttManagerAddress = await nttManagerProxy.getAddress();
  console.log("  NttManager Proxy deployed at:", nttManagerAddress);

  // Initialize the proxy with higher gas limit
  const nttManager = new Contract(nttManagerAddress, NttManagerArtifact.abi, wallet);
  const initTx = await nttManager.initialize({ gasLimit: 500000 }); // Increased gas limit
  console.log("  Initialize tx hash:", initTx.hash);
  await initTx.wait();
  console.log("  NttManager initialized");
  }

  // ---------------------------------------------------------------------------
  // Deploy WormholeTransceiver Implementation (if not exists)
  // ---------------------------------------------------------------------------
  let wormholeTransceiverAddress;
  
  if (existingWormholeTransceiver && existingWormholeTransceiver !== "your_deployed_wormhole_transceiver_address_here") {
    console.log("\nUsing existing WormholeTransceiver:", existingWormholeTransceiver);
    wormholeTransceiverAddress = existingWormholeTransceiver;
  } else {
    console.log("\nDeploying WormholeTransceiver Implementation...");
  
    // Ensure nttManagerAddress is defined
    if (!nttManagerAddress) {
      throw new Error("nttManagerAddress is undefined. Please deploy NttManager first or set NTT_MANAGER_ADDRESS env var.");
    }
    
    // Get the compiled WormholeTransceiver artifact
    const wormholeTransceiverArtifact = getForgeArtifact("WormholeTransceiver");
    
    const ipfsHash3 = await deployMetadata.pushMetadataToIPFS("WormholeTransceiver");
    const WormholeTransceiverFactory = new ContractFactory(
      wormholeTransceiverArtifact.abi,
      wormholeTransceiverArtifact.bytecode,
      wallet,
      ipfsHash3
    );

  const wormholeTransceiverImpl = await WormholeTransceiverFactory.deploy(
    nttManagerAddress,
    wormholeCore,
    wormholeRelayer,
    specialRelayer,
    consistencyLevel,
    gasLimit
  );

  console.log("  tx hash:", wormholeTransceiverImpl.deploymentTransaction().hash);
  await wormholeTransceiverImpl.waitForDeployment();
  const wormholeTransceiverImplAddress = await wormholeTransceiverImpl.getAddress();
  console.log("  WormholeTransceiver Implementation deployed at:", wormholeTransceiverImplAddress);

  // ---------------------------------------------------------------------------
  // Deploy WormholeTransceiver Proxy
  // ---------------------------------------------------------------------------
  console.log("\nDeploying WormholeTransceiver Proxy...");
  const ipfsHash2 = await deployMetadata.pushMetadataToIPFS("ERC1967Proxy");
  const ProxyFactory = new ContractFactory(
    ERC1967ProxyArtifact.abi,
    ERC1967ProxyArtifact.bytecode,
    wallet,
    ipfsHash2
  );
  const wormholeTransceiverProxy = await ProxyFactory.deploy(wormholeTransceiverImplAddress, "0x");
  console.log("  tx hash:", wormholeTransceiverProxy.deploymentTransaction().hash);
  await wormholeTransceiverProxy.waitForDeployment();
  wormholeTransceiverAddress = await wormholeTransceiverProxy.getAddress();
  console.log("  WormholeTransceiver Proxy deployed at:", wormholeTransceiverAddress);

  // Initialize the transceiver (requires message fee for Wormhole)
  const wormholeTransceiver = new Contract(
    wormholeTransceiverAddress, 
    WormholeTransceiverArtifact.abi, 
    wallet
  );

  // Get message fee from Wormhole core
  const wormholeContract = new Contract(
    wormholeCore,
    ["function messageFee() external view returns (uint256)"],
    wallet
  );
  const messageFee = await wormholeContract.messageFee();
  console.log("  Wormhole message fee:", messageFee.toString());

  const transceiverInitTx = await wormholeTransceiver.initialize({ value: messageFee, gasLimit: 500000 });
  console.log("  Initialize tx hash:", transceiverInitTx.hash);
  await transceiverInitTx.wait();
  console.log("  WormholeTransceiver initialized");
  }

  // ---------------------------------------------------------------------------
  // Configure NttManager
  // ---------------------------------------------------------------------------
  console.log("\nConfiguring NttManager...");
  
  // Ensure both addresses are defined before configuration
  if (!nttManagerAddress) {
    throw new Error("nttManagerAddress is undefined. Cannot configure NttManager.");
  }
  if (!wormholeTransceiverAddress) {
    throw new Error("wormholeTransceiverAddress is undefined. Cannot configure NttManager.");
  }
  
  // Create NttManager contract instance (works for both new and existing deployments)
  const nttManager = new Contract(nttManagerAddress, NttManagerArtifact.abi, wallet);
  
  // Check if transceiver is already set
  try {
    const transceivers = await nttManager.getTransceivers();
    const isAlreadySet = transceivers.some(addr => addr.toLowerCase() === wormholeTransceiverAddress.toLowerCase());
    
    if (isAlreadySet) {
      console.log("  Transceiver already set on NttManager:", wormholeTransceiverAddress);
    } else {
      console.log("  Setting transceiver...");
      const setTransceiverTx = await nttManager.setTransceiver(wormholeTransceiverAddress, { gasLimit: 500000 });
      console.log("  Set transceiver tx hash:", setTransceiverTx.hash);
      await setTransceiverTx.wait();
      console.log("  Transceiver set on NttManager");
    }
  } catch (error) {
    console.log("  Could not check existing transceivers, attempting to set:", error.message);
    try {
      const setTransceiverTx = await nttManager.setTransceiver(wormholeTransceiverAddress, { gasLimit: 500000 });
      console.log("  Set transceiver tx hash:", setTransceiverTx.hash);
      await setTransceiverTx.wait();
      console.log("  Transceiver set on NttManager");
    } catch (setError) {
      console.log("  Failed to set transceiver:", setError.message);
      if (!setError.message.includes("already set") && !setError.message.includes("duplicate")) {
        throw setError; // Re-throw if it's not a "already set" error
      }
      console.log("  Assuming transceiver is already set");
    }
  }

  // Set outbound limit (if rate limiting is enabled)
  if (!shouldSkipRateLimit) {
    const adjustedLimit = outboundLimit / scale; // Divide to scale DOWN from 18 to 8 decimals
    console.log("  Outbound limit calculation:");
    console.log("    Raw limit (18 decimals):", outboundLimit.toString());
    console.log("    Scale factor (10^10):", scale.toString());
    console.log("    Adjusted limit (8 decimals):", adjustedLimit.toString());
    
    const setOutboundLimitTx = await nttManager.setOutboundLimit(adjustedLimit, { gasLimit: 500000 });
    console.log("  Set outbound limit tx hash:", setOutboundLimitTx.hash);
    await setOutboundLimitTx.wait();
    console.log("  Outbound limit set:", adjustedLimit.toString());
  }

  // Set threshold (1 for single transceiver)
  const setThresholdTx = await nttManager.setThreshold(1, { gasLimit: 500000 });
  console.log("  Set threshold tx hash:", setThresholdTx.hash);
  await setThresholdTx.wait();
  console.log("  Threshold set to 1");

  // ---------------------------------------------------------------------------
  // Deployment Summary
  // ---------------------------------------------------------------------------
  console.log("\n NTT Deployment Complete!");
  console.log("=".repeat(50));
  console.log("NttManager:", nttManagerAddress);
  console.log("WormholeTransceiver:", wormholeTransceiverAddress);
  console.log("Token:", token === "0x0000000000000000000000000000000000000000" ? "NATIVE_QUAI" : token);
  console.log("Mode:", mode === 0 ? "LOCKING" : "BURNING");
  console.log("Chain ID:", chainId);
  console.log("=".repeat(50));

  // Save deployment info
  const deploymentInfo = {
    network: "quai",
    nttManager: nttManagerAddress,
    wormholeTransceiver: wormholeTransceiverAddress,
    token: token,
    mode: mode === 0 ? "LOCKING" : "BURNING",
    chainId: chainId,
    wormholeCore: wormholeCore,
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(
    `./deployments/ntt-quai-${Date.now()}.json`,
    JSON.stringify(deploymentInfo, null, 2)
  );
  console.log("Deployment info saved to deployments directory");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });