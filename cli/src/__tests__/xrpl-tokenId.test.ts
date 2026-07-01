import { describe, it, expect } from "bun:test";
import { decodeAccountID } from "xrpl";
import {
  computeEmitterAddressFromRAddress,
  iouToken,
  mptToken,
  xrpToken,
  encodeCurrency,
  decodeCurrency,
  buildTokenIdForEmitter,
  tokenIdFromFlags,
  formatTokenId,
  xrplAccountToEmitter,
  xrplGeneratedEmitter,
  xrplGeneratedEmitterFromRAddress,
  XRPL_GENERATED_EMITTER_PREFIX,
} from "../xrpl/tokenId";

// Known-good vectors from full_docs.md "New Sequencer Setups" — these are the
// XRPL transceiver addresses of real testnet NTT deployments, which equal the
// token-derived emitter keccak256("ntt" || manager || tokenId32).
describe("computeEmitterAddress — known testnet vectors", () => {
  it("XRP deployment (manager rfeMQr71KJQwNUbRwGTgCfVLoUVdWuvyny)", () => {
    const emitter = computeEmitterAddressFromRAddress(
      "rfeMQr71KJQwNUbRwGTgCfVLoUVdWuvyny",
      xrpToken()
    );
    expect(emitter.toString("hex")).toBe(
      "3f7582b4a9df3bfd4f5b8b6634b1d1eaa4a4b96f33f0a56184a1c7584641e5e2"
    );
  });

  it("IOU FOO deployment (manager+issuer rnv8uG8r7mewUqTZ7us3KESFE4cAEqsjm1)", () => {
    const emitter = computeEmitterAddressFromRAddress(
      "rnv8uG8r7mewUqTZ7us3KESFE4cAEqsjm1",
      iouToken("FOO", "rnv8uG8r7mewUqTZ7us3KESFE4cAEqsjm1")
    );
    expect(emitter.toString("hex")).toBe(
      "23779ce2426c7ec8ef398cdf44bd6fc4d744aa80d0018cc34e7b86d6a30cd0e0"
    );
  });

  it("MPT deployment (manager rf6VeCw74SzN9RQXm6qZUcUdJ1zziGRzU3)", () => {
    const emitter = computeEmitterAddressFromRAddress(
      "rf6VeCw74SzN9RQXm6qZUcUdJ1zziGRzU3",
      mptToken("00F069F049794EF254FE5B399DBBC2622A50AE8747707B18")
    );
    expect(emitter.toString("hex")).toBe(
      "b97ab26d22bf8688ce7466aac3031abfde0af2ab86ca57854d773f485c3cbb8a"
    );
  });
});

describe("xrplGeneratedEmitter — watcher-generated message emitter", () => {
  const rAddress = "rfeMQr71KJQwNUbRwGTgCfVLoUVdWuvyny";
  const accountId = Buffer.from(decodeAccountID(rAddress));

  it("is 32 bytes / 64 hex chars", () => {
    expect(xrplGeneratedEmitter(accountId).length).toBe(64);
  });

  it("starts with the 'XRPL' (0x5852504c) prefix", () => {
    expect(XRPL_GENERATED_EMITTER_PREFIX).toBe("5852504c");
    expect(xrplGeneratedEmitter(accountId).startsWith("5852504c")).toBe(true);
  });

  it("has 8 zero bytes between the prefix and the account", () => {
    const hex = xrplGeneratedEmitter(accountId);
    expect(hex.slice(8, 24)).toBe("00".repeat(8));
  });

  it("preserves the account in the last 20 bytes", () => {
    const hex = xrplGeneratedEmitter(accountId);
    expect(hex.slice(24)).toBe(accountId.toString("hex"));
  });

  it("differs from the raw core account emitter for the same account", () => {
    expect(xrplGeneratedEmitter(accountId)).not.toBe(
      xrplAccountToEmitter(accountId)
    );
  });

  it("FromRAddress matches the buffer form", () => {
    expect(xrplGeneratedEmitterFromRAddress(rAddress)).toBe(
      xrplGeneratedEmitter(accountId)
    );
  });

  it("rejects a non-20-byte account id", () => {
    expect(() => xrplGeneratedEmitter(Buffer.alloc(19))).toThrow();
  });
});

describe("buildTokenIdForEmitter — type discriminants", () => {
  it("XRP is 32 zero bytes", () => {
    expect(buildTokenIdForEmitter(xrpToken()).toString("hex")).toBe(
      "00".repeat(32)
    );
  });

  it("IOU starts with 0x01", () => {
    const id = buildTokenIdForEmitter(
      iouToken("FOO", "rnv8uG8r7mewUqTZ7us3KESFE4cAEqsjm1")
    );
    expect(id[0]).toBe(0x01);
    expect(id.length).toBe(32);
  });

  it("MPT is 0x02 + 7 zeros + 24-byte issuance id", () => {
    const issuance = "00F069F049794EF254FE5B399DBBC2622A50AE8747707B18";
    const id = buildTokenIdForEmitter(mptToken(issuance));
    expect(id[0]).toBe(0x02);
    expect(id.subarray(1, 8).toString("hex")).toBe("00".repeat(7));
    expect(id.subarray(8, 32).toString("hex").toUpperCase()).toBe(issuance);
  });
});

describe("encodeCurrency / decodeCurrency", () => {
  it("round-trips a 3-char code (FOO)", () => {
    const encoded = encodeCurrency("FOO");
    expect(encoded.length).toBe(20);
    expect(encoded[0]).toBe(0x00); // standard-code marker
    expect(decodeCurrency(encoded)).toBe("FOO");
  });

  it("RLUSD uses the 40-hex non-standard form", () => {
    // RLUSD hex from DESIGN.md
    const hex = "524C555344000000000000000000000000000000";
    const encoded = encodeCurrency(hex);
    expect(encoded.toString("hex").toUpperCase()).toBe(hex);
  });

  it("rejects XRP as an IOU currency", () => {
    expect(() => encodeCurrency("XRP")).toThrow();
  });
});

describe("tokenIdFromFlags", () => {
  it("xrp", () => {
    expect(tokenIdFromFlags({ type: "xrp" }).type).toBe("XRP");
  });

  it("iou requires currency + issuer", () => {
    expect(() => tokenIdFromFlags({ type: "iou" })).toThrow();
    const t = tokenIdFromFlags({
      type: "iou",
      currency: "FOO",
      issuer: "rnv8uG8r7mewUqTZ7us3KESFE4cAEqsjm1",
    });
    expect(formatTokenId(t)).toBe("FOO/rnv8uG8r7mewUqTZ7us3KESFE4cAEqsjm1");
  });

  it("mpt requires mpt-id", () => {
    expect(() => tokenIdFromFlags({ type: "mpt" })).toThrow();
    const t = tokenIdFromFlags({
      type: "mpt",
      mptId: "00F069F049794EF254FE5B399DBBC2622A50AE8747707B18",
    });
    expect(t.type).toBe("MPT");
  });

  it("rejects unknown token type", () => {
    expect(() => tokenIdFromFlags({ type: "doge" })).toThrow();
  });
});
