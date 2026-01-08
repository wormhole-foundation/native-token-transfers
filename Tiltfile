load('ext://namespace', 'namespace_create', 'namespace_inject')
load('ext://git_resource', 'git_checkout')

git_checkout('https://github.com/wormhole-foundation/wormhole.git#main', '.wormhole/', unsafe_mode=True)
local(['sed','-i.bak','s/{chainId: vaa.ChainIDEthereum, addr: "000000000000000000000000855FA758c77D68a04990E992aA4dcdeF899F654A"},/{chainId: vaa.ChainIDEthereum, addr: "000000000000000000000000855FA758c77D68a04990E992aA4dcdeF899F654A"},{chainId: vaa.ChainIDSolana, addr: "253e5fcb56de6013759d1bbed9c2b0940b7a556b9333957d37be63d9ba096dd3"},{chainId: vaa.ChainIDSolana, addr: "739c49640a801d835bae7c77b64f1c6403c1665e443b87bb4147c75187750830"},{chainId: vaa.ChainIDEthereum, addr: "0000000000000000000000006f84742680311cef5ba42bc10a71a4708b4561d1"},{chainId: vaa.ChainIDEthereum, addr: "0000000000000000000000009ba423008e530c4d464da15f0c9652942216f019"},{chainId: vaa.ChainIDBSC, addr: "0000000000000000000000006f84742680311cef5ba42bc10a71a4708b4561d1"},{chainId: vaa.ChainIDBSC, addr: "000000000000000000000000baac7efcddde498b0b791eda92d43b20f5cd8ff6"},/g', '.wormhole/node/pkg/accountant/ntt_config.go'])

load(".wormhole/Tiltfile", "namespace", "k8s_yaml_with_ns")

# Registry for pre-built images (speeds up CI builds via layer caching)
REGISTRY = "ghcr.io/wormhole-foundation/native-token-transfers"

# Solana deploy - uses cache_from for faster CI builds
# Note: Must use 'builder' target (not 'export') because Dockerfile.test-validator
# copies from ntt-solana-contract and needs the full builder filesystem
docker_build(
    ref = "ntt-solana-contract",
    context = "./",
    only = ["./sdk", "./solana"],
    ignore=["./sdk/__tests__", "./sdk/Dockerfile", "./sdk/ci.yaml", "./sdk/**/dist", "./sdk/node_modules", "./sdk/**/node_modules"],
    target = "builder",
    dockerfile = "./solana/Dockerfile",
    cache_from = [REGISTRY + "/ntt-solana-contract:latest"],
)
docker_build(
    ref = "solana-test-validator",
    context = "solana",
    dockerfile = "solana/Dockerfile.test-validator"
)
k8s_yaml_with_ns("./solana/solana-devnet.yaml")
k8s_resource(
    "solana-devnet",
    labels = ["anchor-ntt"],
    port_forwards = [
        port_forward(8899, name = "Solana RPC [:8899]"),
        port_forward(8900, name = "Solana WS [:8900]"),
    ],
)

# EVM build - uses cache_from for faster CI builds
docker_build(
    ref = "ntt-evm-contract",
    context = "./evm",
    dockerfile = "./evm/Dockerfile",
    cache_from = [REGISTRY + "/ntt-evm-contract:latest"],
)

# CI tests
docker_build(
    ref = "ntt-ci",
    context = "./",
    only=["./sdk", "./package.json", "./package-lock.json", "jest.config.ts", "tsconfig.json", "tsconfig.esm.json", "tsconfig.cjs.json", "tsconfig.test.json"],
    dockerfile = "./sdk/Dockerfile",
)
k8s_yaml_with_ns("./sdk/ci.yaml")
k8s_resource(
    "ntt-ci-tests",
    labels = ["ntt"],
    resource_deps = ["eth-devnet", "eth-devnet2", "solana-devnet", "guardian", "relayer-engine", "wormchain"],
)
