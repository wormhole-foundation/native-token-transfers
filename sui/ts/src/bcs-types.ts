// BCS type definitions for NTT inbox items
import { bcs, type BcsType } from '@mysten/bcs';

// Primitives/containers per docs:
// - enums via bcs.enum
// - structs via bcs.struct
// - vector<u8> via bcs.vector(bcs.u8())
// - Option<T> via bcs.option(T)

// ---- leaf types ----
const Bitmap = bcs.struct('Bitmap', { 
  bitmap: bcs.u128() 
});

const ReleaseStatus = bcs.enum('ReleaseStatus', {
  NotApproved: null,
  ReleaseAfter: bcs.u64(),
  Released: null,
});

const TrimmedAmount = bcs.struct('TrimmedAmount', {
  amount: bcs.u64(),
  decimals: bcs.u8(),
});

const Bytes32 = bcs.struct('Bytes32', { 
  data: bcs.vector(bcs.u8())
});

const ExternalAddress = bcs.struct('ExternalAddress', { 
  value: Bytes32 
});

const NativeTokenTransfer = bcs.struct('NativeTokenTransfer', {
  amount: TrimmedAmount,
  source_token: ExternalAddress,
  to: ExternalAddress,
  to_chain: bcs.u16(),
  payload: bcs.option(bcs.vector(bcs.u8())),
});

// ---- generic container ----
function InboxItem<T extends BcsType<any>>(T: T) {
  return bcs.struct(`InboxItem<${T.name}>`, {
    votes: Bitmap,
    release_status: ReleaseStatus,
    data: T,
  });
}

// Concrete type:
export const InboxItemNative = InboxItem(NativeTokenTransfer);

// Export types for use in other files
export type InboxItemNativeType = typeof InboxItemNative;
export type ParsedInboxItem = ReturnType<typeof InboxItemNative.parse>;