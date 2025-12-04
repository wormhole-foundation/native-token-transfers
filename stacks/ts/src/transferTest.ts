import { StacksNetwork, StacksNetworks } from "@stacks/network"
import { StacksNtt } from "./ntt"
import { getStacksSigner, StacksPlatform, StacksZeroAddress } from "@wormhole-foundation/sdk-stacks"
import { deserialize, signAndSendWait, toNative, UniversalAddress, Wormhole, signSendWait } from "@wormhole-foundation/sdk"
import { broadcastTransaction, Cl, fetchCallReadOnlyFunction, makeContractCall, PostConditionMode } from "@stacks/transactions"
import evm from "@wormhole-foundation/sdk/platforms/evm";
import { ethers, keccak256 } from "ethers"
import { EvmNtt } from "../../../evm/ts/src"
import "@wormhole-foundation/sdk-solana-ntt";
import "@wormhole-foundation/sdk-sui-ntt";
import "@wormhole-foundation/sdk-stacks-ntt";
import "@wormhole-foundation/sdk-definitions-ntt";

const accessControlAbi = [{"inputs":[],"stateMutability":"nonpayable","type":"constructor"},{"inputs":[],"name":"IncompatibleGovernorAndGuardian","type":"error"},{"inputs":[],"name":"InvalidCore","type":"error"},{"inputs":[],"name":"NotEnoughGovernorsLeft","type":"error"},{"inputs":[],"name":"ZeroAddress","type":"error"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"_core","type":"address"}],"name":"CoreUpdated","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"address","name":"_flashloanModule","type":"address"}],"name":"FlashLoanModuleUpdated","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"role","type":"bytes32"},{"indexed":true,"internalType":"bytes32","name":"previousAdminRole","type":"bytes32"},{"indexed":true,"internalType":"bytes32","name":"newAdminRole","type":"bytes32"}],"name":"RoleAdminChanged","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"role","type":"bytes32"},{"indexed":true,"internalType":"address","name":"account","type":"address"},{"indexed":true,"internalType":"address","name":"sender","type":"address"}],"name":"RoleGranted","type":"event"},{"anonymous":false,"inputs":[{"indexed":true,"internalType":"bytes32","name":"role","type":"bytes32"},{"indexed":true,"internalType":"address","name":"account","type":"address"},{"indexed":true,"internalType":"address","name":"sender","type":"address"}],"name":"RoleRevoked","type":"event"},{"inputs":[],"name":"DEFAULT_ADMIN_ROLE","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"FLASHLOANER_TREASURY_ROLE","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"GOVERNOR_ROLE","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[],"name":"GUARDIAN_ROLE","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"treasury","type":"address"}],"name":"addFlashLoanerTreasuryRole","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"governor","type":"address"}],"name":"addGovernor","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[],"name":"flashLoanModule","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"role","type":"bytes32"}],"name":"getRoleAdmin","outputs":[{"internalType":"bytes32","name":"","type":"bytes32"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"role","type":"bytes32"},{"internalType":"uint256","name":"index","type":"uint256"}],"name":"getRoleMember","outputs":[{"internalType":"address","name":"","type":"address"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"role","type":"bytes32"}],"name":"getRoleMemberCount","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"bytes32","name":"role","type":"bytes32"},{"internalType":"address","name":"account","type":"address"}],"name":"grantRole","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32","name":"role","type":"bytes32"},{"internalType":"address","name":"account","type":"address"}],"name":"hasRole","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"governor","type":"address"},{"internalType":"address","name":"guardian","type":"address"}],"name":"initialize","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"treasury","type":"address"}],"name":"isFlashLoanerTreasury","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"admin","type":"address"}],"name":"isGovernor","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"admin","type":"address"}],"name":"isGovernorOrGuardian","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"},{"inputs":[{"internalType":"address","name":"treasury","type":"address"}],"name":"removeFlashLoanerTreasuryRole","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"governor","type":"address"}],"name":"removeGovernor","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32","name":"role","type":"bytes32"},{"internalType":"address","name":"account","type":"address"}],"name":"renounceRole","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes32","name":"role","type":"bytes32"},{"internalType":"address","name":"account","type":"address"}],"name":"revokeRole","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"contract ICoreBorrow","name":"_core","type":"address"}],"name":"setCore","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"address","name":"_flashLoanModule","type":"address"}],"name":"setFlashLoanModule","outputs":[],"stateMutability":"nonpayable","type":"function"},{"inputs":[{"internalType":"bytes4","name":"interfaceId","type":"bytes4"}],"name":"supportsInterface","outputs":[{"internalType":"bool","name":"","type":"bool"}],"stateMutability":"view","type":"function"}]

async function main() {


  //// Devnet
  // const STACKS_PRIV_KEY = "714a5bf161a680ebb2670c5ea6e8bcd75f299eae234412af0cf12d21e11ae09901"
  // const ETH_PRIV_KEY = "0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d"
  // const STACKS_RPC = "http://localhost:3999"
  // const ETH_RPC = "http://localhost:8545"
  // const NETWORK = "Devnet"
  // const SDK_CONFIG = {
  //   api: "http://localhost:7071",
  //   chains: {
  //     Ethereum: { rpc: ETH_RPC },
  //     Bsc: { rpc: "http://localhost:8546" },
  //     Solana: { rpc: "http://localhost:8899" },
  //     Stacks: { rpc: STACKS_RPC },
  //   },
  // }
  // const ETH_CHAIN_SDK_NAME = "Ethereum"
  /// Sepolia testnet
  const STACKS_PRIV_KEY = "f31fc0469f0d47bd66552df267a193ee8290f98393e4cd0855081fa1a7b016cc01"
  const ETH_PRIV_KEY = "0x4aaac1323a4ca055a37f4606877b4ffdcaf1328bc0b16d8aae8fd674aaf47f79"
  // const STACKS_RPC = "http://54.235.251.128:20443"
  const ETH_RPC = "https://eth-sepolia.api.onfinality.io/public"
  const NETWORK = "Testnet"
  const SDK_CONFIG = {}
  const ETH_CHAIN_SDK_NAME = "Sepolia"

  const wh = new Wormhole(NETWORK, [StacksPlatform, evm.Platform], SDK_CONFIG);
  const stacksCtx = wh.getChain("Stacks");
  const ethCtx = wh.getChain(ETH_CHAIN_SDK_NAME);
  const stacksRpc: StacksNetwork = await stacksCtx.getRpc()
  const ethRpc = await ethCtx.getRpc()

  const deploymentJson = require("../../../deployment.json")
  const stacksConfig = deploymentJson.chains.Stacks
  const ethConfig = deploymentJson.chains[ETH_CHAIN_SDK_NAME]

  const stacksSigner = await getStacksSigner(
    stacksRpc,
    STACKS_PRIV_KEY,
  )
  
  const ethSigner = await evm.getSigner(new ethers.JsonRpcProvider(ETH_RPC), ETH_PRIV_KEY)
  
  console.log(`Using Stacks address: ${stacksSigner.address()}`)
  console.log(`Using Ethereum address: ${ethSigner.address()}`)

  const stacksNtt = await StacksNtt.fromRpc(stacksRpc, {
    "Stacks": {
      ...stacksCtx.config,
    contracts: {
      ...stacksCtx.config.contracts,
      ntt: {
        manager: stacksConfig.manager,
        token: stacksConfig.token,
        transceiver: stacksConfig.transceivers.wormhole.address,
      }
    }
    }
    }
  )

  const ethNtt = await EvmNtt.fromRpc(ethRpc, {
    [ETH_CHAIN_SDK_NAME]: {
      ...ethCtx.config,
    contracts: {
      ...ethCtx.config.contracts,
      ntt: {
        manager: ethConfig.manager,
        transceiver: {
          wormhole: ethConfig.transceivers.wormhole.address
        },
      }
    }
    }
    }
  )

  const stacksPeerForEthChain = await stacksNtt.getPeer(ETH_CHAIN_SDK_NAME)
  console.log(`Stacks peer for ${ETH_CHAIN_SDK_NAME}: ${stacksPeerForEthChain?.address.address.toString()}`, stacksPeerForEthChain)

  const ethPeerForStacksChain = await ethNtt.getPeer("Stacks")
  console.log(`EVM peer for Stacks:`, ethPeerForStacksChain)

console.log(`1`)
  const resp1 = await fetchCallReadOnlyFunction({
    contractAddress: `ST2W4SFFKXMGFJW7K7NZFK3AH52ZTXDB74HKV9MRA`,
    contractName: "ntt-manager-state",
    functionName: "peers-get",
    functionArgs: [
      Cl.buffer(Buffer.from([0x27, 0x12]))
    ],
    senderAddress: StacksZeroAddress,
    network: NETWORK.toLowerCase() as any,
    client: {
      baseUrl: stacksRpc.client.baseUrl
    }
  })

  console.log(resp1)
console.log(`2`)

const resp2 = await fetchCallReadOnlyFunction({
  contractAddress: `ST2W4SFFKXMGFJW7K7NZFK3AH52ZTXDB74HKV9MRA`,
  contractName: "ntt-manager-state",
  functionName: "peers-get",
  functionArgs: [
   Cl.buffer(Buffer.from([0x0a, 0x98]))
  ],
  senderAddress: StacksZeroAddress,
  network: NETWORK.toLowerCase() as any,
  client: {
    baseUrl: stacksRpc.client.baseUrl
  }
})

console.log(resp2)
console.log(`3`)



  const ethOwner = await ethNtt.getOwner()
  const stacksOwner = await stacksNtt.getOwner()
  console.log(`Getting role for token: ${ethConfig.token} for owner: ${ethOwner.address}`)
  const token = new ethers.Contract(ethConfig.token, accessControlAbi, 
    new ethers.Wallet(ETH_PRIV_KEY, new ethers.JsonRpcProvider(ETH_RPC)))

  const deployerHasRole = await token["hasRole(bytes32,address)"]!(
    keccak256(ethers.toUtf8Bytes("MINTER_ROLE")),
    ethOwner.address
  )

  console.log(`Deployer has role: ${deployerHasRole}`)

  const managerHasRole = await token["hasRole(bytes32,address)"]!(
    keccak256(ethers.toUtf8Bytes("MINTER_ROLE")),
    ethConfig.manager
  )

  console.log(`Manager has role: ${managerHasRole}`)

  const tx = await token["grantRole(bytes32,address)"]!(
    keccak256(ethers.toUtf8Bytes("MINTER_ROLE")),
    ethConfig.manager
  )

  console.log(`Granted role to manager: ${tx.hash} , waiting...`)
  await tx.wait()

  const managerHasRole2 = await token["hasRole(bytes32,address)"]!(
    keccak256(ethers.toUtf8Bytes("MINTER_ROLE")),
    ethConfig.manager
  )

  console.log(`Manager has role: ${managerHasRole2}`)

  console.log(`Using Ethereum owner: ${ethOwner}`)
  console.log(`Using Stacks owner: ${stacksOwner}`)

  const evmInboundLimit = await ethNtt.getInboundLimit("Stacks")
  console.log(`EVM inbound limit: ${evmInboundLimit}`)


  const tokenAddress = stacksConfig.token.split(".")[0]
  const tokenName = stacksConfig.token.split(".")[1]

  const mintSbtcTx = await makeContractCall({
    contractName: tokenName,
    contractAddress: tokenAddress,
    functionName: 'protocol-mint',
    functionArgs: [
      Cl.uint(1000n**8n),
      Cl.principal(stacksSigner.address()),
      Cl.buffer(new Uint8Array([1]))
    ],
    senderKey: STACKS_PRIV_KEY,
    network: NETWORK.toLowerCase() as any,
    client: stacksRpc.client,
    postConditionMode: PostConditionMode.Allow,
  })
  const mintSbtcTxHash = await broadcastTransaction({
    transaction: mintSbtcTx,
    network: NETWORK.toLowerCase() as any,
    client: stacksRpc.client,
  })

  console.log(mintSbtcTxHash)

  await StacksPlatform.waitForTx(mintSbtcTxHash.txid, stacksRpc.client.baseUrl, true)

  console.log(`SBTC STACKS balance BEFORE: ${await wh.getBalance("Stacks", toNative("Stacks", stacksConfig.token), stacksSigner.address())}`)
console.log(`SBTC ETH balance BEFORE: ${await wh.getBalance(ETH_CHAIN_SDK_NAME, toNative(ETH_CHAIN_SDK_NAME, ethConfig.token), ethSigner.address())}`)

const amountToTransfer = 23n*10n**8n
console.log(`Amount to transfer: ${amountToTransfer}`)
  const unsignedTransfer = await stacksNtt.transfer(
    toNative("Stacks", stacksSigner.address()),
    amountToTransfer,
    {
      chain: ETH_CHAIN_SDK_NAME,
      address: new UniversalAddress(ethSigner.address())
    },
    {
      queue: false
    }
  )
  const txHashes = await signAndSendWait(unsignedTransfer, stacksSigner)
  await StacksPlatform.waitForTx(txHashes[0]!.txid, stacksRpc.client.baseUrl, true)

   const srcCore = await stacksCtx.getWormholeCore();
  const msgId = (
    await srcCore.parseTransaction(txHashes[txHashes.length - 1]!.txid)
  )[0]!;

  console.log(msgId)


  const vaa = await wh.getVaa(msgId, "Ntt:WormholeTransfer")

  // const decodedVaa = encoding.b64.decode(`AQAAAAABAJ4l41SayZ2s4IZGc1AH9Aeco4GyNxIoS2TEWHRTr3CtQ7A+DeqM6kLaHR+VtGsyWUfnJmiNeh/p/O1LA3nJaCIAaRw/kgAAAAAAPF3D/W7/EtKqnZWRAY/1NPVlXOQiXT+DJmWMIvhUqYsFAAAAAAAAAAIAmUX/ENuWuEtjCPZJY/OM8Ae7QueGWsdnvc9gseLtPfPdAbOzAAAAAAAAAAAAAAAAqP7eKmieXTHANaL9MVpg9o0EQOMAkQAAAAAAAAAAAAAAAAA34dgAAAAAAAAAAAAAAAAAAAAAsPB80k2By6mrzz0MA9PmY/fh+eCX2W0V3OB2azCcwywAT5lOVFQIAAAAAIkXNwA8JucMg+BXyVkdwDrB+3845cDDWrIRLTz4Z7fNeXLcvQAAAAAAAAAAAAAAAL5FK0HkL8iBhPHCk7JJ+HfBnZkwJxIAAA==`)
  // const vaaHex = encoding.hex.encode(decodedVaa)
  // const vaaBytes = Buffer.from(vaaHex, 'hex')
  // const vaa = deserialize(`Ntt:WormholeTransfer`, vaaBytes)

  // console.log(vaa)

  const unsignedRedeem = await ethNtt.redeem(
    [vaa!],
  )

  const redeemTxHashes = await signSendWait(ethCtx as any, unsignedRedeem, ethSigner)
  console.log(redeemTxHashes)

  await sleep(5000)

  console.log(`SBTC STACKS balance AFTER: ${await wh.getBalance("Stacks", toNative("Stacks", stacksConfig.token), stacksSigner.address())}`)
  console.log(`SBTC ETH balance AFTER: ${await wh.getBalance(ETH_CHAIN_SDK_NAME, toNative(ETH_CHAIN_SDK_NAME, ethConfig.token), ethSigner.address())}`)
 
  const queuedTransfer = await ethNtt.getInboundQueuedTransfer(
    vaa!.emitterChain,
    vaa!.payload["nttManagerPayload"]
  );
  console.log(`!!!!!!! QUeued transfer:`)
  console.log(queuedTransfer)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main()
