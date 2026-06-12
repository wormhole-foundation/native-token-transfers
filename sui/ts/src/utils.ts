import { SuiGrpcClient } from "@mysten/sui/grpc";
import { isValidSuiAddress } from "@mysten/sui/utils";
import { bcs, fromBase64 } from "@mysten/bcs";
import { NATIVE_TOKEN_IDENTIFIERS } from "./constants.js";
import { InboxItemNative } from "./bcs-types.js";
import { graphql } from "@mysten/sui/graphql/schema";
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { graphQL, Network } from "@wormhole-foundation/sdk-base";

// In @mysten/sui v2 (gRPC core API) object content is returned as a FLAT `object.json`
// Move-struct map (no JSON-RPC `{ dataType, type, fields }` wrapper, no nested `.fields`).
export interface SuiMoveObject {
  type: string;
  fields: any;
}

/**
 * Checks if a token is native SUI
 */
export function isNativeToken(token: string): boolean {
  return NATIVE_TOKEN_IDENTIFIERS.includes(token as any);
}

/**
 * Extracts the flat Move-struct fields (`object.json`) from a gRPC getObject result.
 * Accepts either the `{ object }` response envelope or the unwrapped object.
 */
export function getFieldsFromObjectResponse(object: any) {
  const obj = object?.object ?? object;
  return obj?.json ?? null;
}

/**
 * Gets object fields with validation
 */
export async function getObjectFields(
  provider: SuiGrpcClient,
  objectId: string
): Promise<Record<string, any> | null> {
  if (!isValidSuiAddress(objectId)) {
    throw new Error(`Invalid object ID: ${objectId}`);
  }

  const { object } = await provider.getObject({
    objectId,
    include: { json: true },
  });
  return (object?.json as Record<string, any>) ?? null;
}

/**
 * Gets a Sui object with proper typing and validation
 */
export async function getSuiObject(
  client: SuiGrpcClient,
  objectId: string,
  errorMessage?: string
): Promise<SuiMoveObject> {
  const { object } = await client.getObject({
    objectId,
    include: { json: true },
  });

  if (!object || !object.json) {
    throw new Error(errorMessage || `Failed to fetch object ${objectId}`);
  }

  return { type: object.type, fields: object.json };
}

/**
 * Gets Wormhole package ID from core bridge state
 */
export async function getWormholePackageId(
  provider: SuiGrpcClient,
  coreBridgeStateId: string
): Promise<string> {
  let currentPackage: { fieldId: string } | undefined;
  let nextCursor: string | null | undefined;
  do {
    const dynamicFields = await provider.listDynamicFields({
      parentId: coreBridgeStateId,
      cursor: nextCursor,
    });
    currentPackage = dynamicFields.dynamicFields.find((field) =>
      field.name.type.endsWith("CurrentPackage")
    );
    nextCursor = dynamicFields.hasNextPage ? dynamicFields.cursor : null;
  } while (nextCursor && !currentPackage);

  if (!currentPackage) {
    throw new Error("CurrentPackage not found");
  }

  const fields = await getObjectFields(provider, currentPackage.fieldId);
  const packageId = fields?.["value"]?.["package"];
  if (!packageId) {
    throw new Error("Unable to get current package");
  }

  return packageId;
}

/**
 * Extracts package ID and fields from a state object
 */
export async function getPackageId(
  provider: SuiGrpcClient,
  stateId: string
): Promise<{ packageId: string; fields?: any }> {
  const { object } = await provider.getObject({
    objectId: stateId,
    include: { json: true },
  });

  if (!object || !object.json) {
    throw new Error("Failed to fetch state object");
  }

  const packageId = object.type.split("::")[0];
  if (!packageId || !packageId.startsWith("0x")) {
    throw new Error("Could not extract package ID from state object type");
  }

  return { packageId, fields: object.json };
}

/**
 * Gets transceiver state IDs from transceiver registry
 */
export async function getTransceivers(
  provider: SuiGrpcClient,
  transceiverRegistryId: string
): Promise<string[]> {
  const dynamicFields = await provider.listDynamicFields({
    parentId: transceiverRegistryId,
  });

  for (const field of dynamicFields.dynamicFields) {
    if (field.name?.type?.includes("transceiver_registry::Key")) {
      try {
        const { object } = await provider.getObject({
          objectId: field.fieldId,
          include: { json: true },
        });

        if (object?.json) {
          // flat json: the dynamic field's value struct
          const value = (object.json as any).value;
          if (value && Number(value.id) === 0) {
            return [value.state_object_id as string];
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
  provider: SuiGrpcClient,
  objectId: string
): Promise<string> {
  const { object } = await provider.getObject({ objectId });

  if (!object?.type) {
    throw new Error(`Unable to get type for object ${objectId}`);
  }

  // Extract package ID from type string (format: "0x123::module::Type")
  const packageMatch = object.type.match(/^(0x[a-f0-9]+)::/i);
  if (!packageMatch) {
    throw new Error(`Unable to extract package ID from type: ${object.type}`);
  }

  return packageMatch[1]!;
}

/**
 * Gets package ID from object with upgrade cap support
 */
export async function getPackageIdFromObject(
  client: SuiGrpcClient,
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
      current: upgradeCap.fields.cap.package,
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
 * Derives the ntt-common package id (where the `native_token_transfer` /
 * `ntt_manager_message` modules live) from an NTT `State` object.
 *
 * The flat gRPC `object.json` no longer carries nested struct `type`s, so the old
 * approach of reading `state.inbox.type` does not work. Instead we introspect the
 * Move `State` datatype and walk the `inbox` field's open signature to find the
 * `NttManagerMessage` / `NativeTokenTransfer` datatype and extract its package id.
 */
export async function getNttCommonPackageId(
  provider: SuiGrpcClient,
  managerStateId: string
): Promise<string> {
  const { object } = await provider.getObject({ objectId: managerStateId });
  if (!object?.type) {
    throw new Error("Failed to fetch NTT state object type");
  }

  // type looks like "<nttPkg>::ntt::State<CoinType>"
  const [packageId, moduleName] = object.type.split("::");
  const datatypeName = object.type.split("::")[2]!.split("<")[0]!;

  // gRPC MovePackageService.GetDatatype returns a UnaryCall whose `.response`
  // carries the DatatypeDescriptor under `datatype`.
  const { response } = await provider.movePackageService.getDatatype({
    packageId,
    moduleName,
    name: datatypeName,
  });
  const datatype = response.datatype;

  const inboxField = datatype?.fields.find((f) => f.name === "inbox");
  if (!inboxField) {
    throw new Error("inbox field not found on NTT State");
  }

  // Walk the field's OpenSignatureBody (gRPC shape: a `typeName` plus nested
  // `typeParameterInstantiation` children) to find the NttManagerMessage /
  // NativeTokenTransfer datatype and return its package id.
  const walk = (body: any): string | null => {
    if (!body) return null;
    const tn: string | undefined = body.typeName;
    if (
      tn &&
      (tn.includes("ntt_manager_message::NttManagerMessage") ||
        tn.includes("native_token_transfer::NativeTokenTransfer"))
    ) {
      return tn.split("::")[0]!;
    }
    for (const tp of body.typeParameterInstantiation ?? []) {
      const r = walk(tp);
      if (r) return r;
    }
    return null;
  };

  const pkg = walk(inboxField.type);
  if (!pkg) {
    throw new Error(
      "Unable to derive ntt_common package id from NTT State inbox type"
    );
  }
  return pkg;
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
 * Parses the result of simulateTransaction to extract and deserialize inbox item data.
 * (gRPC: command results are under `commandResults`, return values carry BCS bytes.)
 */
export function parseInboxItemResult(
  inspectResult: any,
  threshold: number
): { inboxItemFields: any; threshold: number } {
  const commandResults = inspectResult.commandResults;
  if (!commandResults || commandResults.length === 0) {
    throw new Error("No command results returned from simulateTransaction");
  }

  // Get the last result which contains the serialized inbox item bytes from bcs::to_bytes call
  const lastResult = commandResults[commandResults.length - 1];
  const serializedInboxItem = lastResult?.returnValues?.[0]?.bcs;

  if (!serializedInboxItem) {
    throw new Error("Invalid result format from simulateTransaction");
  }

  // Parse the serialized InboxItem using BCS
  // The data is wrapped as vector<u8>, so we need to unwrap it first
  const outerBytes = new Uint8Array(serializedInboxItem);
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

// Gets the CoinMetadata object ID for a given coin type.
// The Sui RPC getCoinMetadata call returns a Currency<T> object,
// so use this instead if you need the CoinMetadata<T> object ID.
export async function getCoinMetadataId(
  network: Network,
  coinType: string
): Promise<string> {
  const graphQLClient = new SuiGraphQLClient({
    url: graphQL.graphQLAddress(network, "Sui"),
    network: network === "Mainnet" ? "mainnet" : "testnet",
  });

  const query = graphql(`
        query {
          objects(filter: { type: "0x2::coin::CoinMetadata<${coinType}>" }) {
            nodes {
              address
            }
          }
        }
        `);

  const result = await graphQLClient.query({
    query,
  });

  const coinMetadataId = result.data?.objects?.nodes?.[0]?.address;
  if (!coinMetadataId) {
    throw new Error(`CoinMetadata object not found for type ${coinType}`);
  }

  return coinMetadataId;
}
