import { SuiClient } from "@mysten/sui/client";
import { isValidSuiAddress } from "@mysten/sui/utils";
import { NATIVE_TOKEN_IDENTIFIERS } from "./constants.js";

// TypeScript types matching the Move structs
export interface SuiMoveObject {
  dataType: "moveObject";
  type: string;
  fields: any;
  hasPublicTransfer: boolean;
}

/**
 * Checks if a token is native SUI
 */
export function isNativeToken(token: string): boolean {
  return NATIVE_TOKEN_IDENTIFIERS.includes(token as any);
}

/**
 * Extracts fields from a Sui object response
 */
export function getFieldsFromObjectResponse(object: any) {
  const content = object.data?.content;
  return content && content.dataType === "moveObject" ? content.fields : null;
}

/**
 * Gets object fields with validation
 */
export async function getObjectFields(
  provider: SuiClient,
  objectId: string
): Promise<Record<string, any> | null> {
  if (!isValidSuiAddress(objectId)) {
    throw new Error(`Invalid object ID: ${objectId}`);
  }

  const res = await provider.getObject({
    id: objectId,
    options: {
      showContent: true,
    },
  });
  return getFieldsFromObjectResponse(res);
}

/**
 * Gets a Sui object with proper typing and validation
 */
export async function getSuiObject(
  client: SuiClient,
  objectId: string,
  errorMessage?: string
): Promise<SuiMoveObject> {
  const response = await client.getObject({
    id: objectId,
    options: { showContent: true },
  });

  if (
    !response.data?.content ||
    response.data.content.dataType !== "moveObject"
  ) {
    throw new Error(errorMessage || `Failed to fetch object ${objectId}`);
  }

  return response.data.content as SuiMoveObject;
}

/**
 * Gets Wormhole package ID from core bridge state
 */
export async function getWormholePackageId(
  provider: SuiClient,
  coreBridgeStateId: string
): Promise<string> {
  let currentPackage;
  let nextCursor;
  do {
    const dynamicFields = await provider.getDynamicFields({
      parentId: coreBridgeStateId,
      cursor: nextCursor,
    });
    currentPackage = dynamicFields.data.find((field) =>
      field.name.type.endsWith("CurrentPackage")
    );
    nextCursor = dynamicFields.hasNextPage ? dynamicFields.nextCursor : null;
  } while (nextCursor && !currentPackage);

  if (!currentPackage) {
    throw new Error("CurrentPackage not found");
  }

  const fields = await getObjectFields(provider, currentPackage.objectId);
  const packageId = fields?.["value"]?.fields?.package;
  if (!packageId) {
    throw new Error("Unable to get current package");
  }

  return packageId;
}

/**
 * Extracts package ID and fields from a state object
 */
export async function getPackageId(
  provider: SuiClient,
  stateId: string
): Promise<{ packageId: string; fields?: any }> {
  const state = await provider.getObject({
    id: stateId,
    options: { showContent: true },
  });

  if (!state.data?.content || state.data.content.dataType !== "moveObject") {
    throw new Error("Failed to fetch state object");
  }

  const objectType = state.data.content.type;
  const packageId = objectType.split("::")[0];
  if (!packageId || !packageId.startsWith("0x")) {
    throw new Error("Could not extract package ID from state object type");
  }

  const fields = state.data.content.fields;

  return { packageId, fields };
}

/**
 * Gets transceiver state IDs from transceiver registry
 */
export async function getTransceivers(
  provider: SuiClient,
  transceiverRegistryId: string
): Promise<string[]> {
  const dynamicFields = await provider.getDynamicFields({
    parentId: transceiverRegistryId,
  });

  for (const field of dynamicFields.data) {
    if (field.name?.type?.includes("transceiver_registry::Key")) {
      try {
        const transceiverInfo = await provider.getObject({
          id: field.objectId,
          options: { showContent: true },
        });

        if (
          transceiverInfo.data?.content &&
          transceiverInfo.data.content.dataType === "moveObject"
        ) {
          const infoFields = (transceiverInfo.data.content.fields as any)
            .value.fields;
          const transceiverIndex = infoFields.id;

          if (transceiverIndex === 0) {
            return [infoFields.state_object_id as string];
          }
        }
      } catch (e) {
        console.warn(`Failed to read transceiver info: ${e}`);
      }
    }
  }
  throw new Error("Unable to find transceivers");
}

/**
 * Extracts the original package ID from an object type
 */
export async function getOriginalPackageId(
  provider: SuiClient,
  objectId: string
): Promise<string> {
  const object = await provider.getObject({
    id: objectId,
    options: { showType: true },
  });

  if (!object.data?.type) {
    throw new Error(`Unable to get type for object ${objectId}`);
  }

  // Extract package ID from type string (format: "0x123::module::Type")
  const packageMatch = object.data.type.match(/^(0x[a-f0-9]+)::/i);
  if (!packageMatch) {
    throw new Error(
      `Unable to extract package ID from type: ${object.data.type}`
    );
  }

  return packageMatch[1]!;
}

/**
 * Gets package ID from object with upgrade cap support
 */
export async function getPackageIdFromObject(
  client: SuiClient,
  objectId: string
): Promise<{ original: string; current: string; object: SuiMoveObject }> {
  const object = await getSuiObject(
    client,
    objectId,
    "Failed to fetch state object"
  );

  // The package ID can be inferred from the object type
  // This will be the package when the object was first introduced
  const objectType = object.type;
  // Object type format: "packageId::module::Type<...>"
  const packageId = objectType.split("::")[0];
  if (!packageId || !packageId.startsWith("0x")) {
    throw new Error("Could not extract package ID from state object type");
  }

  // If we find an upgrade cap id, fetch it and grab the latest package id from there
  if (object.fields.upgrade_cap_id) {
    const upgradeCap = await getSuiObject(
      client,
      object.fields.upgrade_cap_id,
      "Failed to fetch upgrade cap object"
    );
    return {
      object,
      original: packageId,
      current: upgradeCap.fields.cap.fields.package,
    };
  }

  return { object, original: packageId, current: packageId };
}

/**
 * Extracts generic type from a Move type string
 */
export function extractGenericType(typeString: string): string | null {
  const match = typeString.match(/<([^>]+)>/);
  return match ? match[1]! : null;
}

/**
 * Counts the number of set bits in a number
 */
export function countSetBits(n: number): number {
  let count = 0;
  while (n) {
    count += n & 1;
    n >>= 1;
  }
  return count;
}