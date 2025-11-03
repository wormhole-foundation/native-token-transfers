// SPDX-License-Identifier: Apache 2
pragma solidity >=0.8.8 <0.9.0;

import "forge-std/Script.sol";
import "forge-std/console.sol";
import "../src/MultiTokenNtt/MultiTokenNtt.sol";
import {Token} from "../src/MultiTokenNtt/Token.sol";
import "../src/GmpManager/GmpManager.sol";
import "../src/interfaces/IGmpManager.sol";
import "../src/libraries/TokenId.sol";
import "../test/mocks/WETH9.sol";
import {GenericWormholeTransceiver} from
    "../src/Transceiver/WormholeTransceiver/GenericWormholeTransceiver.sol";
import "wormhole-solidity-sdk/interfaces/IWormhole.sol";
import "wormhole-solidity-sdk/Utils.sol";
import "openzeppelin-contracts/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/libraries/Implementation.sol";
import "../src/NttManager/ManagerBase.sol";

contract DeployMultiTokenNtt is Script {
    // Configuration struct to make deployment parameters manageable
    struct DeploymentConfig {
        uint16 chainId;
        uint64 rateLimitDuration;
        bool skipRateLimiting;
        address weth;
    }

    function run() external virtual {
        // Get deployment configuration from environment
        (
            DeploymentConfig memory config,
            WormholeTransceiverDeploymentConfig memory transceiverConfig
        ) = getConfig();

        // Start broadcasting transactions
        vm.startBroadcast();

        // Deploy GmpManager implementation and proxy
        GmpManager gmpImplementation = new GmpManager(config.chainId);
        bytes memory gmpInitData = abi.encodeCall(Implementation.initialize, ());
        ERC1967Proxy gmpProxy = new ERC1967Proxy(address(gmpImplementation), gmpInitData);
        GmpManager gmpManager = GmpManager(address(gmpProxy));

        // Deploy GenericWormholeTransceiver
        GenericWormholeTransceiver transceiver = GenericWormholeTransceiver(
            deployWormholeTransceiver(transceiverConfig, address(gmpManager))
        );

        gmpManager.setTransceiver(address(transceiver));
        // Note: setThreshold now requires chainId parameter
        // This would typically be set for specific peer chains after deployment
        // gmpManager.setThreshold(peerChainId, 1);

        // deploy token implementation
        Token token = new Token();

        // Deploy MultiTokenNtt implementation and proxy
        MultiTokenNtt implementation = new MultiTokenNtt(
            IGmpManager(address(gmpManager)),
            config.rateLimitDuration,
            config.skipRateLimiting,
            address(token),
            config.weth
        );
        bytes memory nttInitData = abi.encodeCall(Implementation.initialize, ());
        ERC1967Proxy nttProxy = new ERC1967Proxy(address(implementation), nttInitData);

        vm.stopBroadcast();

        // Log deployed addresses
        console.log("GmpManager:", address(gmpProxy));
        console.log("MultiTokenNtt:", address(nttProxy));
    }

    function getConfig()
        internal
        view
        returns (DeploymentConfig memory, WormholeTransceiverDeploymentConfig memory)
    {
        // Get configuration from environment variables
        address wormhole = vm.envAddress("WORMHOLE");
        uint16 chainId = IWormhole(wormhole).chainId();
        console.log("Chain ID:", chainId);
        uint64 rateLimitDuration = uint64(vm.envUint("RATE_LIMIT_DURATION"));
        bool skipRateLimiting = vm.envBool("SKIP_RATE_LIMITING");

        DeploymentConfig memory config = DeploymentConfig({
            chainId: chainId,
            rateLimitDuration: rateLimitDuration,
            skipRateLimiting: skipRateLimiting,
            weth: vm.envAddress("WETH")
        });

        WormholeTransceiverDeploymentConfig memory transceiverConfig =
        WormholeTransceiverDeploymentConfig({
            wormhole: wormhole,
            consistencyLevel: uint8(vm.envUint("CONSISTENCY_LEVEL")),
            gasLimit: 600000
        });

        return (config, transceiverConfig);
    }

    struct WormholeTransceiverDeploymentConfig {
        address wormhole;
        uint8 consistencyLevel;
        uint256 gasLimit;
    }

    function deployWormholeTransceiver(
        WormholeTransceiverDeploymentConfig memory config,
        address manager
    ) public returns (address) {
        GenericWormholeTransceiver implementation = new GenericWormholeTransceiver(
            manager, config.wormhole, config.consistencyLevel, config.gasLimit
        );

        GenericWormholeTransceiver transceiverProxy =
            GenericWormholeTransceiver(address(new ERC1967Proxy(address(implementation), "")));

        transceiverProxy.initialize();

        console.log("GenericWormholeTransceiver:", address(transceiverProxy));

        return address(transceiverProxy);
    }
}

contract OverrideTokens is Script {
    function run() external {
        vm.startBroadcast();
        linkSepoliaToMonad(
            0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238, 0x4804916f7c16c20E1a557feb8E3E29418DDC54DC
        ); // USDC
        linkSepoliaToMonad(
            0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0, 0x72111141639bfAa9A1Ad7A638F546e2397f0dc7a
        ); // USDT
        linkSepoliaToMonad(
            0xBe9566f1bc9a6a18ad1ed5620Ccb76ff639534d5, 0x5B3540B0a48F8b30A655402eE5dcD213fd2B4BEa
        ); // WBTC
        linkSepoliaToMonad(
            0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9, 0xA296f47E8Ff895Ed7A092b4a9498bb13C46ac768
        ); // WETH
        // linkSepoliaToMonad(0x824CB8fC742F8D3300d29f16cA8beE94471169f5, 0xD14c60bbE24E5b8200a9B126b548Dd4754Dc4120); // WSOL
        vm.stopBroadcast();
    }

    function linkSepoliaToMonad(address sepolia, address monad) internal {
        // Get deployed contract addresses from environment
        address ntt = vm.envAddress("NTT");
        MultiTokenNtt(payable(ntt)).overrideLocalAsset(
            TokenId({chainId: 10002, tokenAddress: toWormholeFormat(sepolia)}), monad
        );
    }
}

contract ConfigureMultiTokenNtt is Script {
    function run() external {
        // Get deployed contract addresses from environment
        address ntt = vm.envAddress("NTT");
        address gmpManager = address(MultiTokenNtt(payable(ntt)).gmpManager());
        address transceiver = ManagerBase(gmpManager).getTransceivers()[0];

        // Get configuration
        uint16 peerChainId = uint16(vm.envUint("PEER_CHAIN_ID"));
        address peerGmpManager = vm.envAddress("PEER_GMP");
        address peerNtt = vm.envAddress("PEER_NTT");
        address peerTransceiver = vm.envAddress("PEER_TRANSCEIVER");

        vm.startBroadcast();

        // Configure GmpManager
        GmpManager(gmpManager).setPeer(peerChainId, toWormholeFormat(peerGmpManager));
        GmpManager(gmpManager).setSendTransceiverForChain(peerChainId, transceiver);
        GmpManager(gmpManager).setReceiveTransceiverForChain(peerChainId, transceiver);
        GmpManager(gmpManager).setThreshold(peerChainId, 1);

        // Configure MultiTokenNtt
        MultiTokenNtt(payable(ntt)).setPeer(peerChainId, toWormholeFormat(peerNtt));

        GenericWormholeTransceiver(transceiver).setWormholePeer(
            peerChainId, toWormholeFormat(peerTransceiver)
        );

        vm.stopBroadcast();

        console.log("Configuration completed for contracts:");
        console.log("GmpManager:", gmpManager);
        console.log("MultiTokenNtt:", ntt);
    }
}

contract DeployWETH is Script {
    function run() external {
        // Deploy WETH9
        vm.startBroadcast();
        MockWETH9 weth = new MockWETH9();

        console.log("WETH:", address(weth));
        vm.stopBroadcast();
    }
}

contract UpgradeMultiTokenNtt is Script {
    function run() public virtual {
        MultiTokenNtt ntt = MultiTokenNtt(payable(vm.envAddress("NTT")));

        vm.startBroadcast();
        MultiTokenNtt implementation = new MultiTokenNtt(
            IGmpManager(address(ntt.gmpManager())),
            ntt.rateLimitDuration(),
            ntt.rateLimitDuration() == 0,
            ntt.tokenImplementation(),
            address(ntt.WETH())
        );
        MultiTokenNtt(payable(ntt)).upgrade(address(implementation));
        vm.stopBroadcast();
    }
}

contract UpgradeGmpManager is Script {
    function run() public virtual {
        GmpManager gmp = GmpManager(vm.envAddress("GMP"));

        vm.startBroadcast();
        GmpManager implementation = new GmpManager(gmp.chainId());
        GmpManager(gmp).upgrade(address(implementation));
        vm.stopBroadcast();
    }
}

contract SetupAxelarTransceiver is Script {
    function run() public {
        GmpManager gmpManager = GmpManager(vm.envAddress("GMP"));

        uint16 peerChainId = uint16(vm.envUint("PEER_CHAIN_ID"));
        ITransceiver axelarTransceiver = ITransceiver(vm.envAddress("AXELAR_TRANSCEIVER"));

        assert(
            keccak256(abi.encodePacked(axelarTransceiver.getTransceiverType()))
                == keccak256("axelar")
        );

        vm.startBroadcast();

        gmpManager.setTransceiver(address(axelarTransceiver));
        gmpManager.setSendTransceiverForChain(peerChainId, address(axelarTransceiver));
        gmpManager.setReceiveTransceiverForChain(peerChainId, address(axelarTransceiver));
        gmpManager.setThreshold(peerChainId, 2);

        vm.stopBroadcast();
    }
}

contract SetInboundLimit is Script {
    function run() external {
        vm.startBroadcast();
        address tokenAddress = vm.envAddress("TOKEN_ADDRESS");
        MultiTokenNtt ntt = MultiTokenNtt(payable(vm.envAddress("NTT")));
        (TokenId memory tokenId,) = ntt.getTokenId(tokenAddress);
        ntt.setInboundLimit(tokenId, uint256(vm.envUint("INBOUND_LIMIT")), tokenId.chainId);
        vm.stopBroadcast();
    }
}

contract MigrateGmpManagerRound1 is UpgradeGmpManager {
    function run() public override {
        UpgradeGmpManager.run();

        vm.startBroadcast();
        GmpManager gmpManager = GmpManager(vm.envAddress("GMP"));
        ITransceiver wormholeTransceiver =
            ITransceiver(ManagerBase(gmpManager).getTransceivers()[0]);
        assert(
            keccak256(abi.encodePacked(wormholeTransceiver.getTransceiverType()))
                == keccak256("wormhole")
        );

        uint16 peerChainId = uint16(vm.envUint("PEER_CHAIN_ID"));

        gmpManager.setSendTransceiverForChain(peerChainId, address(wormholeTransceiver));
        gmpManager.setReceiveTransceiverForChain(peerChainId, address(wormholeTransceiver));
        gmpManager.setThreshold(peerChainId, 1);

        vm.stopBroadcast();
    }
}

contract UpgradeWormholeTransceiverMultiNtt is DeployMultiTokenNtt {
    function run() external override {
        GenericWormholeTransceiver transceiver =
            GenericWormholeTransceiver(vm.envAddress("WH_TRANSCEIVER"));

        vm.startBroadcast();

        WormholeTransceiverDeploymentConfig memory config = WormholeTransceiverDeploymentConfig({
            wormhole: address(transceiver.wormhole()),
            consistencyLevel: transceiver.consistencyLevel(),
            gasLimit: transceiver.gasLimit()
        });

        GenericWormholeTransceiver implementation = new GenericWormholeTransceiver(
            address(transceiver.nttManager()),
            config.wormhole,
            config.consistencyLevel,
            config.gasLimit
        );
        transceiver.upgrade(address(implementation));
        vm.stopBroadcast();
    }
}
