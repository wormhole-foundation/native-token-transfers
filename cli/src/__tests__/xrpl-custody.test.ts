import { describe, expect, test } from "bun:test";
import { Wallet, decodeAccountID } from "xrpl";
import { validateRAddress } from "../xrpl/helpers";
import {
  deriveSignerEntries,
  parseManagerSet,
  signerEntriesFromAddresses,
} from "../xrpl/manager-set";

describe("validateRAddress", () => {
  test("accepts a valid classic address", () => {
    expect(validateRAddress("r9qAVHiq4gNPFJTHduy7fWEgUPvre2VLpG")).toBe(
      "r9qAVHiq4gNPFJTHduy7fWEgUPvre2VLpG"
    );
  });

  test("rejects an invalid address", () => {
    expect(() => validateRAddress("not-an-address")).toThrow(/Invalid XRPL/);
  });
});

describe("parseManagerSet", () => {
  function pk(byte: number): Buffer {
    const b = Buffer.alloc(33, byte);
    b[0] = 0x02; // compressed-key prefix-ish (value irrelevant to parsing)
    return b;
  }

  test("parses version, threshold, total and 33-byte pubkeys", () => {
    const header = Buffer.from([1, 2, 3]); // version 1, mThreshold 2, nTotal 3
    const body = Buffer.concat([pk(0xaa), pk(0xbb), pk(0xcc)]);
    const set = parseManagerSet(Buffer.concat([header, body]));
    expect(set.mThreshold).toBe(2);
    expect(set.nTotal).toBe(3);
    expect(set.pubkeys.length).toBe(3);
    expect(set.pubkeys[0].length).toBe(33);
  });

  test("rejects a bad version", () => {
    expect(() => parseManagerSet(Buffer.from([0, 1, 0]))).toThrow(/version/);
  });

  test("rejects truncated pubkey data", () => {
    // nTotal says 2 but only one 33-byte key follows
    const buf = Buffer.concat([Buffer.from([1, 1, 2]), Buffer.alloc(33)]);
    expect(() => parseManagerSet(buf)).toThrow(/expected/);
  });
});

describe("signer entries", () => {
  test("deriveSignerEntries: pubkey -> account, weight 1, sorted", () => {
    const w1 = Wallet.generate();
    const w2 = Wallet.generate();
    const entries = deriveSignerEntries([
      Buffer.from(w1.publicKey, "hex"),
      Buffer.from(w2.publicKey, "hex"),
    ]);
    // derived accounts match the wallets' classic addresses
    const accounts = entries.map((e) => e.SignerEntry.Account);
    expect(accounts).toContain(w1.classicAddress);
    expect(accounts).toContain(w2.classicAddress);
    expect(entries.every((e) => e.SignerEntry.SignerWeight === 1)).toBe(true);
    // sorted ascending by account ID
    const ids = accounts.map((a) => Buffer.from(decodeAccountID(a)));
    expect(Buffer.compare(ids[0], ids[1])).toBeLessThanOrEqual(0);
  });

  test("signerEntriesFromAddresses: trims, weight 1, sorted", () => {
    const a = "r9qAVHiq4gNPFJTHduy7fWEgUPvre2VLpG";
    const b = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";
    const entries = signerEntriesFromAddresses([` ${a} `, b]);
    expect(entries.length).toBe(2);
    expect(entries.every((e) => e.SignerEntry.SignerWeight === 1)).toBe(true);
    const ids = entries.map((e) =>
      Buffer.from(decodeAccountID(e.SignerEntry.Account))
    );
    expect(Buffer.compare(ids[0], ids[1])).toBeLessThanOrEqual(0);
  });
});
