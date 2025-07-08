import { BN } from "@coral-xyz/anchor";
import { PublicKey, type PublicKeyInitData } from "@solana/web3.js";
import {
  encoding,
  toChainId,
  type Chain,
  type ChainId,
  type CustomConversion,
  type Layout,
} from "@wormhole-foundation/sdk-base";

export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

export function programDataAddress(programId: PublicKeyInitData) {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(programId).toBytes()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID
  )[0];
}

export function parseVersion(
  version: string
): [number, number, number, string] {
  const components = version.split(".");
  if (components.length < 3) throw new Error("Invalid version string");
  const patchVersion = components[2]!;
  const patchNumber = patchVersion.split(/[^0-9]/)[0]!;
  const patchLabel = patchVersion.slice(patchNumber.length);
  return [
    Number(components[0]),
    Number(components[1]),
    Number(patchNumber),
    patchLabel,
  ];
}

export const pubKeyConversion = {
  to: (encoded: Uint8Array) => new PublicKey(encoded),
  from: (decoded: PublicKey) => decoded.toBytes(),
} as const satisfies CustomConversion<Uint8Array, PublicKey>;

//neither anchor nor solana web3 have a built-in way to parse this, because ofc they don't
export const programDataLayout = [
  { name: "slot", binary: "uint", endianness: "little", size: 8 },
  {
    name: "upgradeAuthority",
    binary: "switch",
    idSize: 1,
    idTag: "isSome",
    layouts: [
      [[0, false], []],
      [
        [1, true],
        [
          {
            name: "value",
            binary: "bytes",
            size: 32,
            custom: pubKeyConversion,
          },
        ],
      ],
    ],
  },
] as const satisfies Layout;
export const programVersionLayout = [
  { name: "length", binary: "uint", endianness: "little", size: 4 },
  { name: "version", binary: "bytes" },
] as const satisfies Layout;

export const U64 = {
  MAX: new BN((2n ** 64n - 1n).toString()),
  to: (amount: number, unit: number) => {
    const ret = new BN(Math.round(amount * unit));

    if (ret.isNeg()) throw new Error("Value negative");

    if (ret.bitLength() > 64) throw new Error("Value too large");

    return ret;
  },
  from: (amount: BN, unit: number) => amount.toNumber() / unit,
};

type Seed = Uint8Array | string;
export function derivePda(
  seeds: Seed | readonly Seed[],
  programId: PublicKeyInitData
) {
  const toBytes = (s: string | Uint8Array) =>
    typeof s === "string" ? encoding.bytes.encode(s) : s;
  return PublicKey.findProgramAddressSync(
    Array.isArray(seeds) ? seeds.map(toBytes) : [toBytes(seeds as Seed)],
    new PublicKey(programId)
  )[0];
}

export const chainToBytes = (chain: Chain | ChainId) =>
  encoding.bignum.toBytes(toChainId(chain), 2);

export const quoterAddresses = (programId: PublicKeyInitData) => {
  const instanceAccount = () => derivePda("instance", programId);
  const registeredNttAccount = (nttProgramId: PublicKey) =>
    derivePda(["registered_ntt", nttProgramId.toBytes()], programId);
  const relayRequestAccount = (outboxItem: PublicKey) =>
    derivePda(["relay_request", outboxItem.toBytes()], programId);
  const registeredChainAccount = (chain: Chain) =>
    derivePda(["registered_chain", chainToBytes(chain)], programId);
  return {
    relayRequestAccount,
    instanceAccount,
    registeredChainAccount,
    registeredNttAccount,
  };
};
