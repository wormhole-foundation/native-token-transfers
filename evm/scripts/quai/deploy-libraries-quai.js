const { deployMetadata } = require("hardhat");
require("dotenv").config();
const fs = require("fs");

// Quai SDK
const { Wallet, ContractFactory, JsonRpcProvider } = require("quais");

// Library artifacts - Only TransceiverStructs and its dependency BytesParsing are needed
const TransceiverStructsArtifact = require("../../artifacts/src/libraries/TransceiverStructs.sol/TransceiverStructs.json");
const BytesParsingArtifact = require("../../artifacts/wormhole-solidity-sdk/libraries/BytesParsing.sol/BytesParsing.json");

function getEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function loadWalletFromFile(walletPath, password) {
  const walletData = fs.readFileSync(walletPath, "utf8");
  return await Wallet.fromEncryptedJson(walletData, password);
}

async function main() {
  const provider = new JsonRpcProvider(getEnv("QUAI_RPC_URL"), undefined, {
    usePathing: true,
  });

  const password = getEnv("PASSWORD");
  let wallet = await loadWalletFromFile("./wallet.json", password);
  wallet = wallet.connect(provider);

  console.log("Deploying minimal libraries for NTT...");
  console.log("Deployer address:", wallet.address);

  // Ensure deployments directory exists
  if (!fs.existsSync("./deployments")) {
    fs.mkdirSync("./deployments");
  }

  const libraries = {};

  // Deploy BytesParsing library first (no dependencies, required by TransceiverStructs)
  console.log("\nDeploying BytesParsing library...");
  const bytesParsingHash = await deployMetadata.pushMetadataToIPFS("BytesParsing");
  const BytesParsingFactory = new ContractFactory(
    BytesParsingArtifact.abi,
    BytesParsingArtifact.bytecode.replace(/\s/g, ''),
    wallet,
    bytesParsingHash
  );
  const bytesParsing = await BytesParsingFactory.deploy();
  console.log("  tx hash:", bytesParsing.deploymentTransaction().hash);
  await bytesParsing.waitForDeployment();
  const bytesParsingAddress = await bytesParsing.getAddress();
  console.log("  BytesParsing library deployed at:", bytesParsingAddress);
  libraries["wormhole-solidity-sdk/libraries/BytesParsing.sol:BytesParsing"] = bytesParsingAddress;

  // Deploy TransceiverStructs library (depends on BytesParsing)
  console.log("\nDeploying TransceiverStructs library...");
  const transceiverStructsHash = await deployMetadata.pushMetadataToIPFS("TransceiverStructs");
  
  // Link dependencies in bytecode
  let linkedBytecode = TransceiverStructsArtifact.bytecode.replace(/\s/g, '');
  // Replace BytesParsing placeholder
  linkedBytecode = linkedBytecode.replace(
    /__\$[a-f0-9]{34}\$__/g, // BytesParsing placeholder pattern
    bytesParsingAddress.slice(2) // Remove 0x prefix
  );
  
  const TransceiverStructsFactory = new ContractFactory(
    TransceiverStructsArtifact.abi,
    linkedBytecode,
    wallet,
    transceiverStructsHash
  );
  const transceiverStructs = await TransceiverStructsFactory.deploy();
  console.log("  tx hash:", transceiverStructs.deploymentTransaction().hash);
  await transceiverStructs.waitForDeployment();
  const transceiverStructsAddress = await transceiverStructs.getAddress();
  console.log("  TransceiverStructs library deployed at:", transceiverStructsAddress);
  libraries["src/libraries/TransceiverStructs.sol:TransceiverStructs"] = transceiverStructsAddress;

  fs.writeFileSync(
    "./deployments/libraries.json",
    JSON.stringify(libraries, null, 2)
  );

  console.log("\n✅ Library deployment complete!");
  console.log("Library addresses saved to deployments/libraries.json");
  console.log("BytesParsing:", bytesParsingAddress);
  console.log("TransceiverStructs:", transceiverStructsAddress);
  
  console.log("\nNext steps:");
  console.log("1. Update your NTT deployment script to link this library");
  console.log("2. Replace the placeholder in bytecode with the deployed address (forge should do this for you)");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });