load('ext://namespace', 'namespace_create', 'namespace_inject')
load('ext://git_resource', 'git_checkout')

git_checkout('https://github.com/wormhole-foundation/wormhole.git#main', '.wormhole/', unsafe_mode=True)
local(['sed','-i.bak','s/{chainId: vaa.ChainIDEthereum, addr: "000000000000000000000000855FA758c77D68a04990E992aA4dcdeF899F654A"},/{chainId: vaa.ChainIDEthereum, addr: "000000000000000000000000855FA758c77D68a04990E992aA4dcdeF899F654A"},{chainId: vaa.ChainIDSolana, addr: "8bf0b547c96edc5c1d512ca25c5c1d1812a180438a0046e511d1fb61561d5cdf"},{chainId: vaa.ChainIDSolana, addr: "0a490691c21334ca173d9ce386e2a86774ce173f351db10d5d0cccc5c4875376"},{chainId: vaa.ChainIDEthereum, addr: "0000000000000000000000006f84742680311cef5ba42bc10a71a4708b4561d1"},{chainId: vaa.ChainIDEthereum, addr: "000000000000000000000000c3ef4965b788cc4b905084d01f2eb7d4b6e93abf"},{chainId: vaa.ChainIDBSC, addr: "0000000000000000000000006f84742680311cef5ba42bc10a71a4708b4561d1"},{chainId: vaa.ChainIDBSC, addr: "0000000000000000000000003f4e941ef5071a1d09c2eb4a24da1fc43f76fcff"},/g', '.wormhole/node/pkg/accountant/ntt_config.go'])

config.define_bool("m1", False, "Build Solana from source for m1 arm64")
load(".wormhole/Tiltfile", "namespace", "k8s_yaml_with_ns", "cfg")
m1 = cfg.get("m1", False)

# Copied from .wormhole/Tiltfile, as this setup will extend the `solana-contract` image in order to inject the .so at startup
docker_build(
    ref = "bridge-client",
    context = ".wormhole/",
    only = ["./proto", "./solana", "./clients"],
    dockerfile = ".wormhole/solana/Dockerfile.client",
    # Ignore target folders from local (non-container) development.
    ignore = [".wormhole/solana/*/target"],
)
docker_build(
    ref = "solana-contract",
    context = ".wormhole/solana",
    dockerfile = ".wormhole/solana/Dockerfile",
    target = "builder",
    build_args = {"BRIDGE_ADDRESS": "Bridge1p5gheXUvJ6jGWGeCsgPKgnE3YgdGKRVCMY9o"}
)
# Solana deploy
docker_build(
    ref = "ntt-solana-contract",
    context = "./",
    only = ["./sdk", "./solana"],
    ignore=["./sdk/__tests__", "./sdk/Dockerfile", "./sdk/ci.yaml", "./sdk/**/dist", "./sdk/node_modules", "./sdk/**/node_modules"],
    dockerfile = "./solana/Dockerfile",
)
build_args = {}
if m1:
    build_args = {"BASE_IMAGE": "ghcr.io/wormholelabs-xyz/solana-test-validator-m1:1.17.29@sha256:c5a43c0762f2dab4873a9e632a389029b6d5f706be7dfb89a42a66cc65a3dd24"}
docker_build(
    ref = "solana-test-validator",
    context = "solana",
    dockerfile = "solana/Dockerfile.test-validator",
    build_args = build_args
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

# EVM build
docker_build(
    ref = "ntt-evm-contract",
    context = "./evm",
    dockerfile = "./evm/Dockerfile",
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
