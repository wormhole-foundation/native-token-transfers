import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  type Connection,
  SystemProgram,
  AccountMeta,
  TransactionInstruction,
} from "@solana/web3.js";
import { ParsedVaa } from "@certusone/wormhole-sdk";
import { derivePostedVaaKey } from "@certusone/wormhole-sdk/lib/cjs/solana/wormhole";

import { encoding } from "@wormhole-foundation/sdk-base";
import { type WormholeGovernance as RawWormholeGovernance } from "../../target/types/wormhole_governance";
import IDL from "../../target/idl/wormhole_governance.json";

type Seed = Uint8Array | string;
function derivePda(seeds: Seed | readonly Seed[], programId: PublicKey) {
  const toBytes = (s: string | Uint8Array) =>
    typeof s === "string" ? encoding.bytes.encode(s) : s;
  return PublicKey.findProgramAddressSync(
    Array.isArray(seeds) ? seeds.map(toBytes) : [toBytes(seeds as Seed)],
    programId
  )[0];
}

// This is a workaround for the fact that the anchor idl doesn't support generics
// yet. This type is used to remove the generics from the idl types.
type OmitGenerics<T> = {
  [P in keyof T]: T[P] extends Record<"generics", any>
    ? never
    : T[P] extends object
      ? OmitGenerics<T[P]>
      : T[P];
};

export type WormholeGovernance = OmitGenerics<RawWormholeGovernance>;

export const GOV_PROGRAM_IDS = [
  "NTTManager111111111111111111111111111111111",
  "NGoD1yTeq5KaURrZo7MnCTFzTA4g62ygakJCnzMLCfm",
  "NGoD1yTeq5KaURrZo7MnCTFzTA4g62ygakJCnzMLCfm",
] as const;

export type GovProgramId = (typeof GOV_PROGRAM_IDS)[number];

export class NTTGovernance {
  readonly program: Program<WormholeGovernance>;
  readonly wormholeId: PublicKey;

  constructor(connection: Connection, args: { programId: GovProgramId }) {
    // TODO: initialise a new Program here with a passed in Connection
    this.program = new Program(IDL as any, new PublicKey(args.programId), {
      connection,
    });
  }

  governanceAccountAddress() {
    return derivePda("governance", this.program.programId);
  }

  async createGovernanceVaaInstruction(args: {
    payer: PublicKey;
    wormholeId: PublicKey;
    vaa: ParsedVaa;
  }) {
    const vaaKey = derivePostedVaaKey(args.wormholeId, args.vaa.hash);
    const emitterChain = Buffer.alloc(2);
    emitterChain.writeUInt16BE(args.vaa.emitterChain);
    const sequence = Buffer.alloc(8);
    sequence.writeBigUInt64BE(BigInt(args.vaa.sequence));
    const [governanceProgramId, ixData] = verifyGovernanceHeader(
      args.vaa.payload
    );
    const ix = deserializeInstruction(ixData);

    const governanceIx = await this.program.methods
      .governance()
      .accountsStrict({
        payer: args.payer,
        governance: derivePda("governance", this.program.programId),
        vaa: vaaKey,
        program: ix.programId,
        replay: derivePda(
          ["replay", emitterChain, args.vaa.emitterAddress, sequence],
          this.program.programId
        ),
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    // add extra instructions
    governanceIx.keys = governanceIx.keys.concat(
      ix.keys.map((k) => {
        return { ...k, isSigner: false };
      })
    );
    return governanceIx;
  }
}

function deserializeInstruction(data: Buffer): TransactionInstruction {
  let offset = 0;
  const programId = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const accountsLen = data.readUInt16BE(offset);
  offset += 2;
  const keys: Array<AccountMeta> = [];
  for (let i = 0; i < accountsLen; i++) {
    const pubkey = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    const isSigner = data.readUInt8(offset) === 1;
    offset += 1;
    const isWritable = data.readUInt8(offset) === 1;
    offset += 1;
    keys.push({ pubkey, isSigner, isWritable });
  }
  const dataLen = data.readUInt16BE(offset);
  offset += 2;
  const instructionData = data.subarray(offset, offset + dataLen);
  return new TransactionInstruction({ keys, programId, data: instructionData });
}

function verifyGovernanceHeader(data: Buffer): [PublicKey, Buffer] {
  let offset = 0;
  const module = data.subarray(offset, offset + 32);
  offset += 32;
  const action = data.readUInt8(offset);
  offset += 1;
  const chainId = data.readUInt16BE(offset);
  offset += 2;
  const governanceProgramId = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  if (
    !module.equals(Buffer.from("GeneralPurposeGovernance".padStart(32, "\0")))
  ) {
    throw new Error("Invalid module");
  }
  if (action !== 2) {
    throw new Error("Invalid action");
  }
  if (chainId !== 1) {
    throw new Error("Invalid chainId");
  }
  return [governanceProgramId, data.subarray(offset)];
}
