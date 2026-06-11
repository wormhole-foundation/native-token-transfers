import { describe, it, expect } from "bun:test";
import {
  serializeRequest,
  deserializeRequest,
  RequestPrefix,
  buildGasInstructionHex,
  type RequestLayout,
} from "../xrpl/executorLayouts";

describe("request layout round-trip", () => {
  it("ERN1 (NTT transfer) serializes with prefix 0x45524e31 and round-trips", () => {
    const req: RequestLayout = {
      request: {
        prefix: RequestPrefix.ERN1,
        srcChain: 66,
        srcManager: `0x${"11".repeat(32)}`,
        messageId: `0x${"22".repeat(32)}`,
      },
    };
    const hex = serializeRequest(req);
    expect(hex.slice(2, 10)).toBe("45524e31"); // "ERN1"
    const back = deserializeRequest(hex);
    expect(back).toEqual(req);
  });

  it("ERV1 (VAA_V1) serializes with prefix 0x45525631 and round-trips", () => {
    const req: RequestLayout = {
      request: {
        prefix: RequestPrefix.ERV1,
        chain: 66,
        address: `0x${"ab".repeat(32)}`,
        sequence: 1234567890n,
      },
    };
    const hex = serializeRequest(req);
    expect(hex.slice(2, 10)).toBe("45525631"); // "ERV1"
    const back = deserializeRequest(hex);
    expect(back).toEqual(req);
  });
});

describe("buildGasInstructionHex", () => {
  it("encodes 0x01 + 16-byte gasLimit + 16-byte msgValue", () => {
    const hex = buildGasInstructionHex(250_000n, 0n);
    // 1 + 16 + 16 = 33 bytes => 66 hex chars + 0x
    expect(hex.length).toBe(2 + 66);
    expect(hex.slice(2, 4)).toBe("01");
    // gasLimit 250000 = 0x3d090 as a 16-byte big-endian field, then 16 zero bytes
    const gasLimitField = (250_000).toString(16).padStart(32, "0");
    const msgValueField = "00".repeat(16);
    expect(hex.slice(2)).toBe("01" + gasLimitField + msgValueField);
  });
});
