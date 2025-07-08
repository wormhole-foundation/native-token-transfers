import { type Layout, type LayoutToType } from "@wormhole-foundation/sdk-base";

export type TrimmedAmount = LayoutToType<typeof trimmedAmountLayout>;

const trimmedAmountLayout = [
  { name: "decimals", binary: "uint", size: 1 },
  { name: "amount", binary: "uint", size: 8 },
] as const satisfies Layout;

export const trimmedAmountItem = {
  binary: "bytes",
  layout: trimmedAmountLayout,
} as const;
