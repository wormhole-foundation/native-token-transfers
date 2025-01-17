load('ext://namespace', 'namespace_create', 'namespace_inject')
load('ext://git_resource', 'git_checkout')

git_checkout('https://github.com/wormhole-foundation/wormhole.git#main', '.wormhole/', unsafe_mode=True)
local(['sed','-i.bak','s/{chainId: vaa.ChainIDEthereum, addr: "000000000000000000000000855FA758c77D68a04990E992aA4dcdeF899F654A"},/{chainId: vaa.ChainIDEthereum, addr: "000000000000000000000000855FA758c77D68a04990E992aA4dcdeF899F654A"},{chainId: vaa.ChainIDSolana, addr: "8bf0b547c96edc5c1d512ca25c5c1d1812a180438a0046e511d1fb61561d5cdf"},{chainId: vaa.ChainIDSolana, addr: "0a490691c21334ca173d9ce386e2a86774ce173f351db10d5d0cccc5c4875376"},{chainId: vaa.ChainIDEthereum, addr: "0000000000000000000000006f84742680311cef5ba42bc10a71a4708b4561d1"},{chainId: vaa.ChainIDEthereum, addr: "0000000000000000000000009ba423008e530c4d464da15f0c9652942216f019"},{chainId: vaa.ChainIDBSC, addr: "0000000000000000000000006f84742680311cef5ba42bc10a71a4708b4561d1"},{chainId: vaa.ChainIDBSC, addr: "000000000000000000000000baac7efcddde498b0b791eda92d43b20f5cd8ff6"},/g', '.wormhole/node/pkg/accountant/ntt_config.go'])

load(".wormhole/Tiltfile", "namespace", "k8s_yaml_with_ns")

# Solana deploy
docker_build(
    ref = "ntt-solana-contract",
    context = "./",
    only = ["./sdk", "./solana"],
    ignore=["./sdk/__tests__", "./sdk/Dockerfile", "./sdk/ci.yaml", "./sdk/**/dist", "./sdk/node_modules", "./sdk/**/node_modules"],
    dockerfile = "./solana/Dockerfile",
)
# docker_build(
#     ref = "solana-test-validator",
#     context = "solana",
#     dockerfile = "solana/Dockerfile.test-validator"
# )
# k8s_yaml_with_ns("./solana/solana-devnet.yaml")
# k8s_resource(
#     "solana-devnet",
#     labels = ["anchor-ntt"],
#     port_forwards = [
#         port_forward(8899, name = "Solana RPC [:8899]"),
#         port_forward(8900, name = "Solana WS [:8900]"),
#     ],
# )

# EVM build
docker_build(
    ref = "ntt-evm-contract",
    context = "./evm",
    dockerfile = "./evm/Dockerfile",
)

# MM and Executor Contract Deploy / Setup
docker_build(
    ref = "executor-deploy",
    context = "tilt",
    dockerfile = "tilt/Dockerfile.deploy",
    only = ["deploy.sh"]
)
docker_build(
    ref = "executor",
    context = "tilt",
    dockerfile = "tilt/Dockerfile.executor",
    only = [],
)
k8s_yaml_with_ns("tilt/executor-deploy.yaml") 
k8s_resource(
    "executor-deploy",
    labels = ["executor"],
    resource_deps = ["eth-devnet", "eth-devnet2"],
)
k8s_yaml_with_ns("tilt/executor.yaml") 
k8s_resource(
    "executor",
    labels = ["executor"],
    resource_deps = ["eth-devnet", "eth-devnet2", "guardian", "executor-deploy"],
    port_forwards = [
        port_forward(3000, name = "Executor [:3000]"),
    ],
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
    resource_deps = ["eth-devnet", "eth-devnet2", "solana-devnet", "guardian", "relayer-engine", "wormchain", "executor"],
)
