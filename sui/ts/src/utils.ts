import { SuiClient } from "@mysten/sui/client";
import { isValidSuiAddress } from "@mysten/sui/utils";
import { bcs, fromBase64 } from "@mysten/bcs";
import { NATIVE_TOKEN_IDENTIFIERS } from "./constants.js";
import { InboxItemNative } from "./bcs-types.js";

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
  return object.data?.content?.dataType === "moveObject"
    ? object.data.content.fields
    : null;
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
          const infoFields = (transceiverInfo.data.content.fields as any).value
            .fields;
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
 * Counts the number of set bits in a number.
 * Uses Brian Kernighan’s Algorithm
 */
export function countSetBits(n: number): number {
  let count = 0;
  while (n) {
    n &= n - 1; // Remove the rightmost set bit
    count += 1;
  }
  return count;
}

/**
 * BCS parsing function for inbox items
 */
export function parseInboxItemNative(base64VecU8: string) {
  const outer = fromBase64(base64VecU8); // bytes of vector<u8>
  const inner = bcs.vector(bcs.u8()).parse(outer); // extract inner bytes[]
  return InboxItemNative.parse(Uint8Array.from(inner)); // fully parsed struct
}

/**
 * Extracts the NTT common package ID from a manager state's inbox type
 * The inbox type format is: "0x<packageId>::ntt_manager_message::NttManagerMessage<...>"
 */
export function extractNttCommonPackageId(inboxType: string): string {
  const match = inboxType.match("<(.+)>")?.[1]?.split("::")[0];
  if (!match) {
    throw new Error(
      `Unable to extract NTT common package ID from inbox type: ${inboxType}`
    );
  }
  return match;
}

/**
 * Creates Move objects for NttManagerMessage construction in a Sui transaction
 */
export function createNttManagerMessageObjects(
  txb: any,
  nttCommonPackageId: string,
  wormholeCoreBridgePackageId: string,
  messageBytes: Uint8Array,
  messageId: Uint8Array,
  senderAddress: Uint8Array
) {
  // Create the native token transfer object from the serialized payload
  const [native_token_transfer] = txb.moveCall({
    target: `${nttCommonPackageId}::native_token_transfer::parse`,
    arguments: [txb.pure.vector("u8", messageBytes)],
  });

  // Create the message ID from bytes
  const [id] = txb.moveCall({
    target: `${wormholeCoreBridgePackageId}::bytes32::from_bytes`,
    arguments: [txb.pure.vector("u8", messageId)],
  });

  // Create the sender external address
  const [sender] = txb.moveCall({
    target: `${wormholeCoreBridgePackageId}::external_address::from_address`,
    arguments: [
      txb.pure.address("0x" + Buffer.from(senderAddress).toString("hex")),
    ],
  });

  // Create the NttManagerMessage object
  const [manager_message] = txb.moveCall({
    target: `${nttCommonPackageId}::ntt_manager_message::new`,
    typeArguments: [
      `${nttCommonPackageId}::native_token_transfer::NativeTokenTransfer`,
    ],
    arguments: [id!, sender!, native_token_transfer!],
  });

  return manager_message;
}

/**
 * Parses the result of devInspectTransactionBlock to extract and deserialize inbox item data
 */
export function parseInboxItemResult(
  inspectResult: any,
  threshold: number
): { inboxItemFields: any; threshold: number } {
  if (!inspectResult.results || inspectResult.results.length === 0) {
    throw new Error("No results returned from devInspectTransactionBlock");
  }

  // Get the last result which contains the serialized inbox item bytes from bcs::to_bytes call
  const lastResult = inspectResult.results[inspectResult.results.length - 1];
  const serializedInboxItem = lastResult?.returnValues?.[0];

  if (!Array.isArray(serializedInboxItem)) {
    throw new Error("Invalid result format from devInspectTransactionBlock");
  }

  const [bytesData, type] = serializedInboxItem;
  if (type !== "vector<u8>" || !Array.isArray(bytesData)) {
    throw new Error(`Expected vector<u8> but got ${type}`);
  }

  // Parse the serialized InboxItem using BCS
  // The data is wrapped as vector<u8>, so we need to unwrap it first
  const outerBytes = new Uint8Array(bytesData);
  const innerBytes = bcs.vector(bcs.u8()).parse(outerBytes);
  const parsedInboxItem = InboxItemNative.parse(Uint8Array.from(innerBytes));

  const inboxItemFields = {
    votes: {
      fields: {
        bitmap: parsedInboxItem.votes.bitmap.toString(),
      },
    },
    release_status: parsedInboxItem.release_status,
    data: parsedInboxItem.data,
  };

  return { inboxItemFields, threshold };
}
