import "dotenv/config";
import { readFileSync, writeFileSync } from "fs";
import { promises as fsp } from "fs";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

type ChainKey = "chainA" | "chainB";

type DeploymentManifest = {
  chains: Record<
    ChainKey,
    {
      core?: string;
      weth?: string;
      ntt_manager?: string | null;
      ntt_transceiver?: string | null;
      wormholeChainId?: number;
      evmChainId?: number;
    }
  >;
};

type Args = {
  chain: ChainKey;
  variant: "noRateLimiting" | "default";
  mode: "locking" | "burning";
  gasLimit: number;
  consistencyLevel: number;
  rpcUrl?: string;
  deployerKey?: string;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const arg = (name: string, def?: string) => {
    const pref = `--${name}=`;
    const found = argv.find((a) => a.startsWith(pref));
    return found ? found.slice(pref.length) : def;
  };
  const chain = (arg("chain") as ChainKey) || (process.env.CHAIN as ChainKey);
  if (chain !== "chainA" && chain !== "chainB") {
    throw new Error(`--chain required: chainA|chainB`);
  }
  const variant = (arg("variant", "noRateLimiting") as Args["variant"]) || "noRateLimiting";
  const modeStr = arg("mode", "locking");
  const mode = (modeStr === "burning" ? "burning" : "locking") as Args["mode"];
  const gasLimit = Number(arg("gasLimit", "500000"));
  const consistencyLevel = Number(arg("consistencyLevel", "1"));
  const rpcUrl = arg("rpc-url") || process.env.RPC_URL;
  const deployerKey = arg("deployerKey") || process.env.DEPLOYER_KEY;
  return { chain, variant, mode, gasLimit, consistencyLevel, rpcUrl, deployerKey };
}

async function readJson<T>(p: string): Promise<T> {
  const raw = await fsp.readFile(p, "utf8");
  return JSON.parse(raw) as T;
}

function writeJson(p: string, data: unknown) {
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function loadEnvFile(envPath: string): Record<string, string> {
  const txt = readFileSync(envPath, "utf8");
  const out: Record<string, string> = {};
  for (const line of txt.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    out[k] = v;
  }
  return out;
}

async function getErc20Decimals(rpcUrl: string, token: string): Promise<number> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const abi = ["function decimals() view returns (uint8)"];
  const erc20 = new ethers.Contract(token, abi, provider);
  const dec: number = await erc20.decimals();
  return Number(dec);
}

async function runForgeScript(args: {
  projectRoot: string;
  rpcUrl: string;
  deployerKey: string;
  env: Record<string, string>;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    // Run from evm/ so Foundry picks up foundry.toml, remappings, and lib/ correctly.
    // We invoke `forge script` programmatically and stream stdio so users see
    // the normal Forge compile/deploy logs in their terminal.
    const evmRoot = path.join(args.projectRoot, "evm");
    // Fully-qualified script name ensures the correct entrypoint is executed.
    const scriptPath = path.join("script", "DeployWormholeNtt.s.sol:DeployWormholeNtt");
    const child = spawn(
      "forge",
      [
        "script",
        scriptPath,
        "--rpc-url",
        args.rpcUrl,
        "--private-key",
        args.deployerKey,
        "--broadcast",
        "-vvv",
      ],
      {
        stdio: "inherit",
        cwd: evmRoot,
        env: {
          ...process.env,
          // Provide the release/runtime configuration expected by the Forge script
          // (core address, token, decimals, mode, gas limit, etc.).
          ...args.env,
        },
      }
    );
    // Resolve on successful completion; reject if Forge exits non‑zero.
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`forge script exited with code ${code}`));
    });
    // Propagate spawn errors (e.g. missing `forge` binary).
    child.on("error", reject);
  });
}

async function readBroadcastAddresses(projectRoot: string, chainId: number, rpcUrl: string): Promise<{ manager?: string; transceiver?: string }> {
  const broadcast = path.join(
    projectRoot,
    "evm",
    "broadcast",
    "DeployWormholeNtt.s.sol",
    String(chainId),
    "run-latest.json"
  );
  const raw = await readJson<any>(broadcast);
  const txs: Array<{ contractName?: string; contractAddress?: string }> = raw?.transactions ?? [];
  // Preferred: discover proxies by ERC1967Proxy entries, then identify the transceiver by probing nttManager()
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const proxyAddrs = txs
    .filter((t) => t.contractName === "ERC1967Proxy" && t.contractAddress)
    .map((t) => t.contractAddress as string);

  // Iterate from last to first to find the most recent deployments
  for (let i = proxyAddrs.length - 1; i >= 0; i--) {
    const candidate = proxyAddrs[i];
    try {
      const tr = new ethers.Contract(candidate, ["function nttManager() view returns (address)"], provider);
      const mgr: string = await tr.nttManager();
      if (mgr && mgr !== ethers.ZeroAddress) {
        // This proxy is the transceiver; the returned mgr is the manager proxy
        return { manager: mgr, transceiver: candidate };
      }
    } catch {
      // Not a transceiver proxy; continue
    }
  }

  // Fallback: use contractName heuristics (may point to implementations if script doesn't label proxies)
  let fallbackManager: string | undefined;
  let fallbackTransceiver: string | undefined;
  const lastMgr = txs.filter((t) => (t.contractName || "").includes("NttManager")).pop();
  const lastTr = txs.filter((t) => t.contractName === "WormholeTransceiver").pop();
  fallbackManager = lastMgr?.contractAddress;
  fallbackTransceiver = lastTr?.contractAddress;
  return { manager: fallbackManager, transceiver: fallbackTransceiver };
}

async function main() {
  // Parse CLI/environment arguments (chain, mode, gas limits, rpc url, key)
  const args = parseArgs();
  // Resolve repo root and paths used for reading/writing the deployment manifest
  const projectRoot = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const manifestPath = path.join(projectRoot, "devnet", "config", "deployment.local.json");
  const manifest = await readJson<DeploymentManifest>(manifestPath);

  // Load chain-specific config from the manifest and validate required fields
  const chain = manifest.chains[args.chain];
  if (!chain) {
    throw new Error(`Missing chains.${args.chain} in deployment.local.json`);
  }
  const core = chain.core;
  const token = chain.weth;
  const evmChainId = chain.evmChainId;
  if (!core || !token || !evmChainId) {
    throw new Error(`chains.${args.chain} must have core, weth, evmChainId set`);
  }

  // Resolve RPC URL in this order:
  // 1) --rpc-url flag
  // 2) devnet/chains/<chain>.env (RPC_URL)
  // 3) process.env.RPC_URL (already handled in parseArgs)
  let rpcUrl = args.rpcUrl;
  if (!rpcUrl) {
    const envFile = path.join(projectRoot, "devnet", "chains", `${args.chain}.env`);
    const envVars = loadEnvFile(envFile);
    rpcUrl = envVars["RPC_URL"];
  }
  if (!rpcUrl) {
    throw new Error(`RPC_URL not provided and not found in devnet/chains/${args.chain}.env`);
  }

  // Require the deployer private key for the forge broadcast
  const deployerKey = args.deployerKey || process.env.DEPLOYER_KEY;
  if (!deployerKey) {
    throw new Error(`DEPLOYER_KEY is required (env or --deployerKey=)`);
  }

  // Discover ERC20 decimals directly from the token on the target chain
  const decimals = await getErc20Decimals(rpcUrl, token);

  // Map human-readable mode to the numeric expected by the forge deploy script
  const releaseMode = args.mode === "burning" ? 1 : 0;

  // Prepare environment variables consumed by the Forge script (DeployWormholeNtt.s.sol)
  // These mirror the previous manual exports to make the deploy reproducible and scriptable.
  const envForForge: Record<string, string> = {
    RELEASE_CORE_BRIDGE_ADDRESS: core,
    RELEASE_TOKEN_ADDRESS: token,
    RELEASE_DECIMALS: String(decimals),
    RELEASE_MODE: String(releaseMode),
    RELEASE_WORMHOLE_RELAYER_ADDRESS: "0x0000000000000000000000000000000000000000",
    RELEASE_SPECIAL_RELAYER_ADDRESS: "0x0000000000000000000000000000000000000000",
    RELEASE_CONSISTENCY_LEVEL: String(args.consistencyLevel),
    RELEASE_GAS_LIMIT: String(args.gasLimit),
    MANAGER_VARIANT: args.variant,
  };

  // Run the Forge deploy from evm/ so remappings and lib/ resolve; broadcast writes run-latest.json
  console.log(`Deploying NTT on ${args.chain} (chainId=${evmChainId}) via forge script...`);
  await runForgeScript({
    projectRoot,
    rpcUrl,
    deployerKey,
    env: envForForge,
  });

  // Read the latest broadcast and identify the proxy addresses:
  // - Prefer ERC1967Proxy where the transceiver is detected by probing nttManager()
  // - This returns (managerProxy, transceiverProxy)
  const { manager, transceiver } = await readBroadcastAddresses(projectRoot, evmChainId, rpcUrl);
  if (!manager || !transceiver) {
    throw new Error(`Could not find deployed NTT addresses in broadcast for chainId=${evmChainId}`);
  }

  // Persist discovered proxy addresses into the deployment manifest for later scripts/tools
  manifest.chains[args.chain].ntt_manager = manager;
  manifest.chains[args.chain].ntt_transceiver = transceiver;
  writeJson(manifestPath, manifest);

  console.log(`NTT deployed on ${args.chain}:`);
  console.log(`  NttManager:         ${manager}`);
  console.log(`  WormholeTransceiver:${transceiver}`);
  console.log(`Updated ${path.relative(projectRoot, manifestPath)}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});


