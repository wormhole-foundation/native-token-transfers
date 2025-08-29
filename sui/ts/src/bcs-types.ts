// BCS type definitions for NTT inbox items
import { bcs, type BcsType } from "@mysten/bcs";

const Bitmap = bcs.struct("Bitmap", {
  bitmap: bcs.u128(),
});

const ReleaseStatus = bcs.enum("ReleaseStatus", {
  NotApproved: null,
  ReleaseAfter: bcs.u64(),
  Released: null,
});

const TrimmedAmount = bcs.struct("TrimmedAmount", {
  amount: bcs.u64(),
  decimals: bcs.u8(),
});

const Bytes32 = bcs.struct("Bytes32", {
  data: bcs.vector(bcs.u8()),
});

const ExternalAddress = bcs.struct("ExternalAddress", {
  value: Bytes32,
});

const NativeTokenTransfer = bcs.struct("NativeTokenTransfer", {
  amount: TrimmedAmount,
  source_token: ExternalAddress,
  to: ExternalAddress,
  to_chain: bcs.u16(),
  payload: bcs.option(bcs.vector(bcs.u8())),
});

function InboxItem<T extends BcsType<any>>(T: T) {
  return bcs.struct(`InboxItem<${T.name}>`, {
    votes: Bitmap,
    release_status: ReleaseStatus,
    data: T,
  });
}

export const InboxItemNative = InboxItem(NativeTokenTransfer);
