## NTT Layouts

Ntt:WormholeTransfer

```ts

const data = {
    sourceNttManager: UniversalAddress { address:  [/*...*/] },
    recipientNttManager: UniversalAddress { address: [/*...*/] },
    nttManagerPayload: {
        id: [/*...*/],
        sender: UniversalAddress { address: [/*...*/] },
        payload: {
            trimmedAmount: {amount: number, decimals: 123},
            sourceToken: [ UniversalAddress ],
            recipientAddress: [ UniversalAddress ],
            recipientChain: 'Ethereum'
        }
    },
    transceiverPayload: null
}


```
