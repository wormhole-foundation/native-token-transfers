import fs from "fs";
import { Transaction } from "@mysten/sui/transactions";
import {
  generatePublishedToml,
  buildSuiPackage,
  publishSuiPackage,
  findCreatedObject,
} from "./suiDeploy";

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
  govUpgradeCapId?: string;
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
  const normalizedStruct = (await client.call(
    "sui_getNormalizedMoveStruct",
    [nttPackageId.replace(/^0x/, ""), "state", "State"]
  )) as any;

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
 * Build and publish the ntt_governance package. Returns the governance
 * package ID, GovernanceState shared object ID, and governance UpgradeCap ID.
 */
export function buildAndPublishGovernance(
  packagesPath: string,
  buildEnv: string,
  gasBudget: number
): GovernancePublishResult {
  buildSuiPackage(packagesPath, "ntt_governance", buildEnv);

  const { packageId: govPackageId, objectChanges } = publishSuiPackage(
    packagesPath,
    "ntt_governance",
    gasBudget
  );

  const govStateId = findCreatedObject(
    objectChanges,
    "governance::GovernanceState",
    true
  );
  if (!govStateId) {
    throw new Error("Could not find GovernanceState object in publish result");
  }

  const govUpgradeCapId = findCreatedObject(
    objectChanges,
    "0x2::package::UpgradeCap"
  );

  return { govPackageId, govStateId, govUpgradeCapId };
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
