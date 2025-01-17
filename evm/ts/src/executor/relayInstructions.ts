import { BinaryReader } from "./BinaryReader.js";
import { BinaryWriter } from "./BinaryWriter.js";

const RECV_INST_TYPE_GAS = 1;
const RECV_INST_TYPE_DROP_OFF = 2;

interface RelayInstruction {
  type: string;
}

interface GasInstruction extends RelayInstruction {
  type: "GasInstruction";
  gasLimit: bigint;
  msgValue: bigint;
}

interface GasDropOffInstruction extends RelayInstruction {
  type: "GasDropOffInstruction";
  dropOff: bigint;
  recipient: string;
}

type RelayInstructions = (GasInstruction | GasDropOffInstruction)[];

export function decodeRelayInstructions(
  relayInstructionsBytes:
    | WithImplicitCoercion<ArrayBuffer | SharedArrayBuffer>
    | string
): RelayInstructions {
  const relayInstructions: RelayInstructions = [];
  const reader = new BinaryReader(relayInstructionsBytes);
  while (reader.offset() < reader.length()) {
    const type = reader.readUint8();
    if (type === RECV_INST_TYPE_GAS) {
      relayInstructions.push({
        type: "GasInstruction",
        gasLimit: reader.readUint128(),
        msgValue: reader.readUint128(),
      });
    } else if (type === RECV_INST_TYPE_DROP_OFF) {
      relayInstructions.push({
        type: "GasDropOffInstruction",
        dropOff: reader.readUint128(),
        recipient: reader.readHex(32),
      });
    } else {
      throw new Error(`unsupported relay instruction type: ${type}`);
    }
  }
  if (reader.offset() > reader.length()) {
    throw new Error(`unable to decode relay instructions`);
  }
  return relayInstructions;
}

export function encodeRelayInstructions(
  relayInstructions: RelayInstructions
): `0x${string}` {
  const writer = new BinaryWriter();
  for (const relayInstruction of relayInstructions) {
    if (relayInstruction.type === "GasInstruction") {
      writer
        .writeUint8(RECV_INST_TYPE_GAS)
        .writeUint128(relayInstruction.gasLimit)
        .writeUint128(relayInstruction.msgValue);
    } else if (relayInstruction.type === "GasDropOffInstruction") {
      // TODO: enforce length on recipient
      writer
        .writeUint8(RECV_INST_TYPE_DROP_OFF)
        .writeUint128(relayInstruction.dropOff)
        .writeHex(relayInstruction.recipient);
    }
  }
  return writer.toHex();
}

export function totalGasLimitAndMsgValue(
  relayInstructions: RelayInstructions
): {
  gasLimit: bigint;
  msgValue: bigint;
} {
  let gasLimit = 0n;
  let msgValue = 0n;
  for (const relayInstruction of relayInstructions) {
    if (relayInstruction.type === "GasInstruction") {
      gasLimit += relayInstruction.gasLimit;
      msgValue += relayInstruction.msgValue;
    }
  }
  return { gasLimit, msgValue };
}
