
import { getStacksSigner, StacksChains, StacksPlatform, StacksZeroAddress } from "@wormhole-foundation/sdk-stacks";
import { StacksNtt, StacksNttWormholeTransceiver } from "../src/ntt.js";
import { deserializePayload, Network, payloadFactory, registerPayloadTypes, SignAndSendSigner, Signer, toNative, TxHash, UniversalAddress, Wormhole } from "@wormhole-foundation/sdk";
import { signAndSendWait } from "@wormhole-foundation/sdk-connect";
import { StacksNetwork, StacksNetworkName } from "@stacks/network";
import { broadcastTransaction, Cl, cvToValue, deserializeCV, fetchCallReadOnlyFunction, makeContractCall, PostConditionMode, privateKeyToAddress } from "@stacks/transactions";
import "@wormhole-foundation/sdk-definitions-ntt";

const MANAGER_ADDRESS = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM'
const WORMHOLE_TRANSCEIVER_ADDRESS = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM'
const CORE_BRIDGE_ADDRESS = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM'
const TOKEN_ADDRESS = 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.sbtc-token'
const DEPLOYER_PRIV_KEY = '753b7cc01a1a2e86221266a154af739463fce51219d97e4f856cd7200c3bd2a601'
const WALLET_1_PRIV_KEY = '7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801'

const dstPeerChain = 'Ethereum'
const dstPeerAddress = new UniversalAddress('0x0000000000000000000000000000000000000001')

let wallet1Addr: string

describe("Test", () => {
  const wh = new Wormhole("Devnet", [StacksPlatform]);
  const ctx = wh.getChain("Stacks");
  let rpc: StacksNetwork

  let ntt: StacksNtt<Network, StacksChains>
  let deployerSigner: SignAndSendSigner<Network, StacksChains>
  let wallet1Signer: SignAndSendSigner<Network, StacksChains>

  beforeAll( async () => {
    rpc = await ctx.getRpc()
    deployerSigner = await getStacksSigner(
      rpc,
      DEPLOYER_PRIV_KEY,
    )
    wallet1Signer = await getStacksSigner(
      rpc,
      WALLET_1_PRIV_KEY,
    )
    ntt = await StacksNtt.fromRpc(rpc, {
      ...ctx.config,
      contracts: {
        ...ctx.config.contracts,
        ntt: {
          manager: MANAGER_ADDRESS,
          token: TOKEN_ADDRESS
        }
      }
    })

    wallet1Addr = privateKeyToAddress(WALLET_1_PRIV_KEY, ntt.network.toLowerCase() as StacksNetworkName)

    // initialize core bridge

    const isActive = await fetchCallReadOnlyFunction({
      contractName: 'wormhole-core-v4',
      contractAddress: CORE_BRIDGE_ADDRESS,
      functionName: 'is-active-deployment',
      functionArgs: [],
      senderAddress: StacksZeroAddress,
      client: {
        baseUrl: rpc.client.baseUrl
      },
      network: 'devnet'
    })

    if(!cvToValue(isActive)) {
      console.log(`Initializing core bridge`)
      const initCoreBridgeTx = await makeContractCall({
        contractName: 'wormhole-core-v4',
        contractAddress: CORE_BRIDGE_ADDRESS,
        functionName: 'initialize',
        functionArgs: [
          Cl.none()
        ],
        senderKey: DEPLOYER_PRIV_KEY,
        network: 'devnet',
        postConditionMode: PostConditionMode.Allow,
      })
      const initCoreBridgeTxHash = await broadcastTransaction({
        transaction: initCoreBridgeTx,
        client: rpc.client,
      })
      console.log(initCoreBridgeTxHash)
      await waitForTx(initCoreBridgeTxHash.txid)
    }

    // set transceiver
    console.log(`Adding transceiver`)
    const addTransceiverTx = await makeContractCall({
      contractName: StacksNtt.CONTRACT_NAME,
      contractAddress: MANAGER_ADDRESS,
      functionName: 'add-transceiver',
      functionArgs: [
        Cl.address(`${WORMHOLE_TRANSCEIVER_ADDRESS}.${StacksNttWormholeTransceiver.CONTRACT_NAME}`)
      ],
      senderKey: DEPLOYER_PRIV_KEY,
      network: 'devnet',
      postConditionMode: PostConditionMode.Allow,
    })
    const addTransceiverTxHash = await broadcastTransaction({
      transaction: addTransceiverTx,
      client: rpc.client,
    })
    console.log(addTransceiverTxHash)

    await waitForTx(addTransceiverTxHash.txid)

    // TEMP?
    // register sender in the core bridge state contract
    console.log(`Registering sender in core bridge state contract`)
    const mapSenderPrincipal = await makeContractCall({
      contractName: 'wormhole-core-v4',
      contractAddress: CORE_BRIDGE_ADDRESS,
      functionName: 'get-wormhole-address',
      functionArgs: [
        Cl.address(wallet1Addr)
      ],
      senderKey: DEPLOYER_PRIV_KEY,
      network: 'devnet',
      postConditionMode: PostConditionMode.Allow,
    })
    const mapSenderPrincipalTxHash = await broadcastTransaction({
      transaction: mapSenderPrincipal,
      client: rpc.client,
    })
    console.log(mapSenderPrincipalTxHash)
    await waitForTx(mapSenderPrincipalTxHash.txid)

    // add ntt manager peer
    console.log(`Adding ntt manager peer`)
    const unsignedTxs = ntt.setPeer({
        address: dstPeerAddress,
        chain: dstPeerChain,
      },
      18,
      0n
    )
    const txHashes = await signAndSendWait(unsignedTxs, deployerSigner)
    await waitForTx(txHashes[0]?.txid)
  })

  it("get peer", async () => {
    const peer = await ntt.getPeer(dstPeerChain)
    expect(peer?.address.address.toString()).toBe(dstPeerAddress.toString())
    expect(peer?.tokenDecimals).toBe(18)
    expect(peer?.inboundLimit).toBe(0n)
  });

  it("get token decimals", async() => {
    const sBTCDecimals = 8;
    const decimals = await ntt.getTokenDecimals()
    expect(decimals).toBe(sBTCDecimals)
  })

  it.only("transfer", async() => {
    const wallet1AddrNative = toNative(ntt.chain, wallet1Addr)
    const transferAmount = 69n

    const balBefore = await StacksPlatform.getBalance(
      ntt.network,
      ntt.chain,
      ntt.connection,
      wallet1AddrNative.toString(),
      toNative(ntt.chain, TOKEN_ADDRESS)
    )
    if(!balBefore) {
      throw new Error("Balance before is null")
    }

    const unsignedTxs = ntt.transfer(
      wallet1AddrNative,
      transferAmount,
      {
        chain: dstPeerChain,
        address: new UniversalAddress('0x0000000000000000000000000000000000000003')
      },
      {
        queue: false
      }
    )
    const txHashes = await signAndSendWait(unsignedTxs, wallet1Signer)
    const txId = txHashes[0]?.txid
    
    if(!txId) {
      throw new Error("No tx id")
    }

    await waitForTx(txId)

    const event = await parseTransaction(txId)
    const vaaPayload = `0x${event[0].payload}`
    console.log(vaaPayload)
    const deserializedPayload = deserializePayload("Ntt:TransceiverInfo", vaaPayload)
    console.log(deserializedPayload)

    const balAfter = await StacksPlatform.getBalance(
      ntt.network,
      ntt.chain,
      ntt.connection,
      wallet1AddrNative.toString(),
      toNative(ntt.chain, TOKEN_ADDRESS)
    )
    if(!balAfter) {
      throw new Error("Balance after is null")
    }
    expect(BigInt(balAfter)).toBe(BigInt(balBefore) - transferAmount)
  })

  it("admins", async() => {
    const wallet1AddrNative = toNative(ntt.chain, wallet1Addr)

    const isAdminBefore = await ntt.isOwner(wallet1AddrNative)

    const unsignedTxs = ntt.setOwner(wallet1AddrNative)
    const txHashes = await signAndSendWait(unsignedTxs, deployerSigner)
    await waitForTx(txHashes[0]?.txid)

    const isAdminAfter = await ntt.isOwner(wallet1AddrNative)

    const removeAdminUnsignedTxs = ntt.removeOwner(wallet1AddrNative)
    const removeAdminTxHashes = await signAndSendWait(removeAdminUnsignedTxs, deployerSigner)
    await waitForTx(removeAdminTxHashes[0]?.txid)

    expect(isAdminBefore).toBe(false)
    expect(isAdminAfter).toBe(true)
  })

  async function waitForTx(txId: string | undefined) {
    if(!txId) {
      throw new Error("No tx id")
    }
    const apiUrl = `${rpc.client.baseUrl}/extended/v1/tx/${txId}`
    const res = await fetch(apiUrl)
    let data = await res.json()
    let tries = 0
    while(data.tx_status !== 'success') {
      console.log(`Waiting for tx ${txId} ... try: ${tries}`)
      await new Promise(resolve => setTimeout(resolve, 1000))
      data = await fetch(apiUrl).then(res => res.json())
      tries++
    }
    console.log(`tx mined!: ${txId}`)
  }

  async function parseTransaction(txid: TxHash) {
    const apiUrl = `${rpc.client.baseUrl}/extended/v1/tx/${txid}`
    const res = await fetch(apiUrl)
    const data = await res.json()
    if(!data) {
      return []
    }
    if(data.tx_status !== 'success') {
      return []
    }

    const events = data.events
    
    const whEvent = events.filter((e: any) => {
      return e.event_type === "smart_contract_log"
        && e.contract_log?.contract_id === `${CORE_BRIDGE_ADDRESS}.wormhole-core-state`
        && e.contract_log?.topic === "print"
        && e.contract_log?.value?.repr?.includes("post-message")
    })
    const parsedEvents: any = whEvent.map((e: any) => deserializeCV(e.contract_log?.value?.hex))
    if(!parsedEvents) {
      return []
    }

    const eventValues = parsedEvents.map((e: any) => e.value?.data?.value)
    if(!eventValues) {
      return []
    }
    return Promise.resolve(eventValues.map((e: any) => {
      return {
        emitter: new UniversalAddress(e['emitter'].value),
        sequence: e['sequence'].value,
        emitterPrincipal: e['emitter-principal'].value,
        payload: e['payload'].value,
      }
    }))
  }
});
