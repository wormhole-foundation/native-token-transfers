import fs from "fs";
import { Transaction } from "@mysten/sui/transactions";
import {
  generatePublishedToml,
  buildSuiPackage,
  publishSuiPackage,
  findCreatedObject,
} from "./sui/helpers";

// ─── Types ───

export interface NttAddresses {
  nttPackageId: string;
  nttCommonPackageId: string;
  adminCapId?: string;
  upgradeCapId?: string;
}

export interface GovernancePublishResult {
  govPackageId: string;
  govStateId: string;
}

// ─── Address Helpers ───

function normalizeAddress(addr: string): string {
  return addr.startsWith("0x") ? addr.toLowerCase() : `0x${addr}`.toLowerCase();
}

// ─── Address Discovery ───

/**
 * Discover NTT package addresses and capability IDs from a State object.
 * Extracts nttPackageId from the object type, nttCommonPackageId from the
 * normalized struct's outbox field, and cap IDs from the state fields.
 */
export async function discoverNttAddresses(
  client: any,
  stateId: string
): Promise<NttAddresses> {
  const stateObj = await client.getObject({
    id: stateId,
    options: { showContent: true },
  });

  if (
    !stateObj.data?.content ||
    stateObj.data.content.dataType !== "moveObject"
  ) {
    throw new Error(
      `NTT State not found at ${stateId}. Verify the ID and network.`
    );
  }

  // Extract nttPackageId from type string: "0x<pkg>::state::State<...>"
  const stateType = stateObj.data.content.type;
  const nttPackageId = stateType.split("::")[0];
  if (!nttPackageId || !nttPackageId.startsWith("0x")) {
    throw new Error("Could not extract NTT package ID from State object type");
  }

  // Extract ntt_common package ID via normalized struct
  const normalizedStruct = (await client.call("sui_getNormalizedMoveStruct", [
    nttPackageId.replace(/^0x/, ""),
    "state",
    "State",
  ])) as any;

  const outboxField = normalizedStruct.fields?.find(
    (f: any) => f.name === "outbox"
  );
  const rawNttCommon =
    outboxField?.type?.Struct?.typeArguments?.[0]?.Struct?.address;

  if (!rawNttCommon) {
    throw new Error(
      "Could not extract ntt_common package ID from normalized struct. " +
        "The outbox field type structure may have changed."
    );
  }

  const nttCommonPackageId = rawNttCommon.startsWith("0x")
    ? rawNttCommon
    : `0x${rawNttCommon}`;

  // Extract cap IDs from state fields
  const stateFields = stateObj.data.content.fields as any;

  return {
    nttPackageId,
    nttCommonPackageId,
    adminCapId: stateFields?.admin_cap_id,
    upgradeCapId: stateFields?.upgrade_cap_id,
  };
}

/**
 * Extract the governance package ID from a GovernanceState object's type string.
 * Type format: "0x<pkg>::governance::GovernanceState"
 */
export async function discoverGovernancePackageId(
  client: any,
  govStateId: string
): Promise<string> {
  const obj = await client.getObject({
    id: govStateId,
    options: { showContent: true },
  });

  if (!obj.data?.content || obj.data.content.dataType !== "moveObject") {
    throw new Error(
      `Object not found at ${govStateId}. Verify the ID and network.`
    );
  }

  const objType: string = obj.data.content.type;
  if (!objType.includes("::governance::GovernanceState")) {
    throw new Error(
      `Object at ${govStateId} is not a GovernanceState (type: ${objType})`
    );
  }

  const packageId = objType.split("::")[0];
  if (!packageId || !packageId.startsWith("0x")) {
    throw new Error("Could not extract package ID from GovernanceState type");
  }

  return packageId;
}

/**
 * Verify that a governance package was compiled against the expected NTT package.
 *
 * Inspects the normalized `receive_admin_cap` function to find the NTT package
 * address baked into the `Receiving<AdminCap>` parameter type. Since Sui resolves
 * all imported types to their defining package addresses at compile time, this
 * tells us exactly which NTT package the governance contract targets.
 */
export async function verifyGovernancePackageTarget(
  client: any,
  govPackageId: string,
  expectedNttPackageId: string
): Promise<void> {
  const normalizedFn = (await client.call("sui_getNormalizedMoveFunction", [
    govPackageId.replace(/^0x/, ""),
    "governance",
    "receive_admin_cap",
  ])) as any;

  // Find the Receiving<AdminCap> parameter by scanning for a Struct named "Receiving"
  const receivingParam = normalizedFn.parameters?.find((p: any) =>
    p?.MutableReference?.Struct?.name === "GovernanceState"
      ? false
      : p?.Struct?.name === "Receiving"
  );

  if (!receivingParam) {
    throw new Error(
      "Could not find Receiving parameter in receive_admin_cap. " +
        "The governance module structure may have changed."
    );
  }

  const adminCapStruct = receivingParam.Struct?.typeArguments?.[0]?.Struct;
  if (!adminCapStruct?.address) {
    throw new Error(
      "Could not extract AdminCap package address from Receiving type argument"
    );
  }

  const actualNttPackageId = normalizeAddress(adminCapStruct.address);
  const expected = normalizeAddress(expectedNttPackageId);

  if (actualNttPackageId !== expected) {
    throw new Error(
      `Governance package targets NTT at ${actualNttPackageId}, ` +
        `but expected ${expected}. ` +
        "This governance contract was not compiled for this NTT deployment."
    );
  }
}

// ─── Governance Transfer (shared logic) ───

export interface TransferGovernanceOptions {
  adminCapOverride?: string;
  upgradeCapOverride?: string;
  gasBudget: number;
  skipVerification?: boolean;
  /** When known (e.g. from deploy-governance), skip RPC discovery */
  govPackageId?: string;
}

/**
 * Verify and transfer NTT caps to a GovernanceState. Used by both
 * `deploy-governance --transfer` and `transfer-governance`.
 */
export async function transferGovernance(
  client: any,
  keypair: any,
  nttStateId: string,
  govStateId: string,
  opts: TransferGovernanceOptions
): Promise<void> {
  // Discover NTT addresses (and governance package ID if not provided)
  console.log("Discovering NTT addresses from State object...");
  let govPackageId: string;
  const addresses = await discoverNttAddresses(client, nttStateId);
  if (opts.govPackageId) {
    govPackageId = opts.govPackageId;
  } else {
    govPackageId = await discoverGovernancePackageId(client, govStateId);
  }
  console.log(`NTT Package: ${addresses.nttPackageId}`);

  // Verify governance targets the correct NTT
  if (!opts.skipVerification) {
    console.log("Verifying governance contract targets correct NTT...");
    await verifyGovernancePackageTarget(
      client,
      govPackageId,
      addresses.nttPackageId
    );
    console.log("Verification passed");
  }

  // Resolve cap IDs
  const adminCapId = opts.adminCapOverride || addresses.adminCapId;
  const upgradeCapId = opts.upgradeCapOverride || addresses.upgradeCapId;

  if (!adminCapId) {
    throw new Error(
      "Could not discover AdminCap ID from State object. Provide it with --admin-cap."
    );
  }
  if (!upgradeCapId) {
    throw new Error(
      "Could not discover UpgradeCap ID from State object. Provide it with --upgrade-cap."
    );
  }

  console.log(`AdminCap: ${adminCapId}`);
  console.log(`UpgradeCap: ${upgradeCapId}`);

  await transferCapsToGovernance(
    client,
    keypair,
    govPackageId,
    govStateId,
    adminCapId,
    upgradeCapId,
    opts.gasBudget
  );
}

// ─── Published.toml Management ───

/**
 * Write temporary Published.toml files for ntt and ntt_common so that the
 * governance package can build against already-deployed packages. Returns a
 * cleanup function that restores the originals.
 */
export function writePublishedTomls(
  packagesPath: string,
  buildEnv: string,
  chainId: string,
  nttPackageId: string,
  nttCommonPackageId: string
): () => void {
  const nttPath = `${packagesPath}/ntt/Published.toml`;
  const nttCommonPath = `${packagesPath}/ntt_common/Published.toml`;

  const nttBackup = fs.existsSync(nttPath)
    ? fs.readFileSync(nttPath, "utf8")
    : null;
  const nttCommonBackup = fs.existsSync(nttCommonPath)
    ? fs.readFileSync(nttCommonPath, "utf8")
    : null;

  fs.writeFileSync(
    nttPath,
    generatePublishedToml(buildEnv, chainId, nttPackageId)
  );
  fs.writeFileSync(
    nttCommonPath,
    generatePublishedToml(buildEnv, chainId, nttCommonPackageId)
  );

  return () => {
    if (nttBackup !== null) {
      fs.writeFileSync(nttPath, nttBackup);
    } else if (fs.existsSync(nttPath)) {
      fs.unlinkSync(nttPath);
    }
    if (nttCommonBackup !== null) {
      fs.writeFileSync(nttCommonPath, nttCommonBackup);
    } else if (fs.existsSync(nttCommonPath)) {
      fs.unlinkSync(nttCommonPath);
    }
  };
}

// ─── Build & Publish ───

/**
 * Build and publish the ntt_governance package, then call `governance::create`
 * to make the package immutable and create the shared GovernanceState.
 *
 * The publish step creates a DeployerCap and an UpgradeCap. The create step
 * consumes both, destroying the UpgradeCap via `make_immutable` to enforce
 * governance package immutability.
 */
export async function buildAndPublishGovernance(
  client: any,
  keypair: any,
  packagesPath: string,
  buildEnv: string,
  gasBudget: number
): Promise<GovernancePublishResult> {
  // Remove stale Published.toml so @ntt_governance compiles as 0x0
  // (gets replaced with actual package ID at publish time)
  const govPublishedPath = `${packagesPath}/ntt_governance/Published.toml`;
  if (fs.existsSync(govPublishedPath)) {
    fs.unlinkSync(govPublishedPath);
  }

  buildSuiPackage(packagesPath, "ntt_governance", buildEnv);

  const { packageId: govPackageId, objectChanges: publishChanges } =
    publishSuiPackage(packagesPath, "ntt_governance", gasBudget);

  // Find DeployerCap and UpgradeCap from publish result
  const deployerCapId = findCreatedObject(
    publishChanges,
    "governance::DeployerCap"
  );
  if (!deployerCapId) {
    throw new Error("Could not find DeployerCap in publish result");
  }

  const govUpgradeCapId = findCreatedObject(
    publishChanges,
    "0x2::package::UpgradeCap"
  );
  if (!govUpgradeCapId) {
    throw new Error("Could not find UpgradeCap in publish result");
  }

  // Wait for publish to finalize before using objects via SDK
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // Call governance::create to make package immutable and create GovernanceState
  console.log("Making governance package immutable...");
  const createTx = new Transaction();
  createTx.moveCall({
    target: `${govPackageId}::governance::create`,
    arguments: [
      createTx.object(deployerCapId),
      createTx.object(govUpgradeCapId),
    ],
  });
  createTx.setGasBudget(gasBudget);

  const createResult = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: createTx,
    options: { showEffects: true, showObjectChanges: true },
  });

  if (createResult.effects?.status?.status !== "success") {
    throw new Error(
      `governance::create transaction failed: ${JSON.stringify(createResult.effects?.status)}`
    );
  }

  const createChanges = createResult.objectChanges || [];
  const govStateId = findCreatedObject(
    createChanges,
    "governance::GovernanceState",
    true
  );
  if (!govStateId) {
    throw new Error(
      "Could not find GovernanceState in create transaction result. " +
        `Transaction digest: ${createResult.digest}. ` +
        `Object changes: ${JSON.stringify(createChanges.map((c: any) => c.objectType))}`
    );
  }

  return { govPackageId, govStateId };
}

// ─── Cap Transfer ───

/**
 * Transfer AdminCap and UpgradeCap to a GovernanceState, then call
 * receive_admin_cap and receive_upgrade_cap to store them as dynamic fields.
 * Requires two transactions (transfer must finalize before receive).
 */
export async function transferCapsToGovernance(
  client: any,
  keypair: any,
  govPackageId: string,
  govStateId: string,
  adminCapId: string,
  upgradeCapId: string,
  gasBudget: number
): Promise<void> {
  // TX1: Transfer caps to GovernanceState address
  console.log("Transferring AdminCap and UpgradeCap to GovernanceState...");
  const transferTx = new Transaction();
  transferTx.transferObjects([transferTx.object(adminCapId)], govStateId);
  transferTx.transferObjects([transferTx.object(upgradeCapId)], govStateId);
  transferTx.setGasBudget(gasBudget);

  const transferResult = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: transferTx,
    options: { showEffects: true },
  });

  if (transferResult.effects?.status?.status !== "success") {
    throw new Error(
      `Failed to transfer caps to GovernanceState: ${JSON.stringify(transferResult.effects?.status)}. ` +
        "The signer may not own AdminCap/UpgradeCap."
    );
  }
  console.log("Caps transferred successfully");

  // Wait for the transfer to finalize before receiving
  await new Promise((resolve) => setTimeout(resolve, 2000));

  // TX2: Receive caps into GovernanceState
  console.log("Receiving caps into GovernanceState...");
  const receiveTx = new Transaction();
  receiveTx.moveCall({
    target: `${govPackageId}::governance::receive_admin_cap`,
    arguments: [receiveTx.object(govStateId), receiveTx.object(adminCapId)],
  });
  receiveTx.moveCall({
    target: `${govPackageId}::governance::receive_upgrade_cap`,
    arguments: [receiveTx.object(govStateId), receiveTx.object(upgradeCapId)],
  });
  receiveTx.setGasBudget(gasBudget);

  const receiveResult = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: receiveTx,
    options: { showEffects: true },
  });

  if (receiveResult.effects?.status?.status !== "success") {
    throw new Error(
      `Failed to receive caps into GovernanceState: ${JSON.stringify(receiveResult.effects?.status)}`
    );
  }
}
