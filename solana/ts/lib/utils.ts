import {
  PublicKey,
  PublicKeyInitData,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  Chain,
  ChainId,
  CustomConversion,
  Layout,
  encoding,
  toChainId,
} from "@wormhole-foundation/sdk-base";
import BN from "bn.js";

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

// governance utils

export function serializeInstruction(ix: TransactionInstruction): Buffer {
  const programId = ix.programId.toBuffer();
  const accountsLen = Buffer.alloc(2);
  accountsLen.writeUInt16BE(ix.keys.length);
  const accounts = Buffer.concat(
    ix.keys.map((account) => {
      const isSigner = Buffer.alloc(1);
      isSigner.writeUInt8(account.isSigner ? 1 : 0);
      const isWritable = Buffer.alloc(1);
      isWritable.writeUInt8(account.isWritable ? 1 : 0);
      const pubkey = account.pubkey.toBuffer();
      return Buffer.concat([pubkey, isSigner, isWritable]);
    })
  );
  const dataLen = Buffer.alloc(2);
  dataLen.writeUInt16BE(ix.data.length);
  return Buffer.concat([programId, accountsLen, accounts, dataLen, ix.data]);
}

export function appendGovernanceHeader(
  data: Buffer,
  governanceProgramId: PublicKey
): Buffer {
  const module = Buffer.from("GeneralPurposeGovernance".padStart(32, "\0"));
  const action = Buffer.alloc(1);
  action.writeUInt8(2); // SolanaCall
  const chainId = Buffer.alloc(2);
  chainId.writeUInt16BE(1); // solana
  const programId = governanceProgramId.toBuffer();
  return Buffer.concat([module, action, chainId, programId, data]);
}

// sentinel values used in governance
export const OWNER = new PublicKey(Buffer.from("owner".padEnd(32, "\0")));
export const PAYER = new PublicKey(Buffer.from("payer".padEnd(32, "\0")));
