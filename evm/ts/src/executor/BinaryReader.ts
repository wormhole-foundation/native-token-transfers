import { Buffer } from "buffer";

export function isValidHexString(s: string): boolean {
  return /^(0x)?[0-9a-fA-F]+$/.test(s);
}

export function hexToBuffer(s: string): Buffer {
  if (!isValidHexString(s)) {
    throw new Error(`${s} is not hex`);
  }
  if (s.startsWith("0x")) {
    s = s.slice(2);
  }
  s.padStart(s.length + (s.length % 2), "0");
  return Buffer.from(s, "hex");
}

export function hexToUint8Array(s: string): Uint8Array {
  return new Uint8Array(hexToBuffer(s));
}

export function uint8ArrayToHex(b: Uint8Array): `0x${string}` {
  return `0x${Buffer.from(b).toString("hex")}`;
}

// BinaryReader provides the inverse of BinaryWriter
// Numbers are encoded as big endian
export class BinaryReader {
  private _buffer: Buffer;
  private _offset: number;

  constructor(
    arrayBufferOrString:
      | WithImplicitCoercion<ArrayBuffer | SharedArrayBuffer>
      | string
  ) {
    if (typeof arrayBufferOrString === "string") {
      this._buffer = hexToBuffer(arrayBufferOrString);
    } else {
      this._buffer = Buffer.from(arrayBufferOrString);
    }
    this._offset = 0;
  }

  length(): number {
    return this._buffer.length;
  }

  offset(): number {
    return this._offset;
  }

  readUint8(): number {
    const tmp = this._buffer.readUint8(this._offset);
    this._offset += 1;
    return tmp;
  }

  readUint16(): number {
    const tmp = this._buffer.readUint16BE(this._offset);
    this._offset += 2;
    return tmp;
  }

  readUint32(): number {
    const tmp = this._buffer.readUint32BE(this._offset);
    this._offset += 4;
    return tmp;
  }

  readUint64(): bigint {
    const tmp = this._buffer.readBigUInt64BE(this._offset);
    this._offset += 8;
    return tmp;
  }

  readUint128(): bigint {
    const tmp = this._buffer.subarray(this._offset, this._offset + 16);
    this._offset += 16;
    return BigInt(`0x${tmp.toString("hex") || "0"}`);
  }

  readUint256(): bigint {
    const tmp = this._buffer.subarray(this._offset, this._offset + 32);
    this._offset += 32;
    return BigInt(`0x${tmp.toString("hex") || "0"}`);
  }

  readUint8Array(length: number): Uint8Array {
    const tmp = this._buffer.subarray(this._offset, this._offset + length);
    this._offset += length;
    return new Uint8Array(tmp);
  }

  readHex(length: number): `0x${string}` {
    return uint8ArrayToHex(this.readUint8Array(length));
  }

  readString(length: number): string {
    const tmp = this._buffer
      .subarray(this._offset, this._offset + length)
      .toString();
    this._offset += length;
    return tmp;
  }
}
