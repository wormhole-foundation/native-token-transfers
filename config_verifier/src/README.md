## NTT Configuration Verifier
The Native Transfer Token (NTT) ecosystem is explained well in the main README. So, please read that first. 
  
If the configuration of an NTT is incorrect or soft, then it can lead high losses even when the code is secure. 
  
In order to prevent misconfigurations, this tool is here to help scan and verify that all things are proper. 

### Scan Checks
Here's a list of configurations that are checked by the tool: 
- Decimals match on every chain for a given token 
- One *locking* mode and the rest are *burning* modes. 
- Manager peers match
- Inbound rate limit for each chain is turned on
- Outbound rate limit is turned on
- Rate limit duration queue is greater than 24 hours
- Threshold is the same as the enabled transceivers
- Chain ID provided matches wormhole core and manager chain id
- Wormhole transceiver specific checks:
    - Peers match the real one on each chain
    - ConsistencyLevel is FINAL
    - Transceiver is owned by the manager

### Configuration File
The tool works by taking in a provided set of addresses on various chains, pulling down information then performing the security checks on them. Edit the ``config.json`` file in order to change address that will be scanned.

The file is formatted as a JSON array with objects that conform to the following standard:
- ``chainid``:
    - The wormhole chain ID. Since Wormhole spans multiple ecosystems, the chain id does not necessarily correspond to the actual chain id. 
    - List of constants can be found at https://docs.wormhole.com/wormhole/reference/constants. 
- ``description``:
    - Name of the blockchain, such as 'Ethereum' or 'Solana'. 
- ``rpc``:
    - The URL to use in order to query chain specific information 
- ``networkType``:
    - The blockchain network being used. Right now, NTT only supports `evm` and `solana`. 
- ``managerAddress``:
    - The address of the NTT manager for the chain. This will pull all of the other necessary information for the checks.

## Running the Tool
### Required Tools
- Foundry tools for EVM:
    - https://book.getfoundry.sh/
- Solana:
    - https://docs.solanalabs.com/cli/install
- Anchor:
    - https://www.anchor-lang.com/docs/installation
- nodejs/npm:
    - https://nodejs.org/en/learn/getting-started/how-to-install-nodejs
- typechain: 
    - Install with the ethers v5 setup.
    - https://github.com/dethcrypto/TypeChain

### Running
1. Install typechain and anchor typescript bindings
    - EVM - ``typechain --target ethers-v5 --out-dir evm_binding/ '../evm/out/*/*.json'``
    - Solana - build normally
2. Run ``npm install`` to install the dependencies
3. Write out the configuration in the ``config.json`` file with the managers, rpcs and other information necessary for the tool to run. 
4. Run ``npm run go`` to run the tool. The list of things checked are listed above. 