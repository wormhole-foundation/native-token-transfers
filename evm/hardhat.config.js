require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();
require("@quai/hardhat-deploy-metadata");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.19",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true, // Enable IR compilation for smaller bytecode
      metadata: {
        bytecodeHash: 'ipfs',
        useLiteralContent: true,
      },
      evmVersion: 'london',
    },
  },
  networks: {
    hardhat: {
      // For local testing
    },
    quai: {
      url: process.env.RPC_URL || "https://rpc.orchard.quai.network",
      // No accounts needed for compilation - handled by encrypted wallet in deploy scripts
      chainId: 9000,
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://sepolia.infura.io/v3/your-infura-project-id",
      // No accounts needed for compilation - handled by encrypted wallet in deploy scripts  
      chainId: 11155111,
    },
  },
  paths: {
    sources: "./src",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 40000,
  },
};