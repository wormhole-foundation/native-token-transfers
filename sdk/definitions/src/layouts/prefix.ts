export type Prefix = readonly [number, number, number, number];
export const prefixItem = (prefix: Prefix) =>
  ({
    name: "prefix",
    binary: "bytes",
    custom: Uint8Array.from(prefix),
    omit: true,
  }) as const;
