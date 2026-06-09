import { describe, expect, test } from "bun:test";
import { decodeAccountID } from "xrpl";
import {
  XRPL_ONBOARDING_PREFIX,
  buildInitData,
  buildOnboardingPayload,
  buildPublishMemoData,
  currencyToHex40,
} from "../xrpl/onboarding";

const ADMIN = "r9qAVHiq4gNPFJTHduy7fWEgUPvre2VLpG";
const FOO_CURRENCY = "000000000000000000000000464F4F0000000000";
const MPT_ID = "00EE5E8C05394002CF8CF3975AC29D11553735BBEDF87BF9";

describe("currencyToHex40", () => {
  test("passes through a 40-char hex code (lowercased)", () => {
    expect(currencyToHex40(FOO_CURRENCY)).toBe(FOO_CURRENCY.toLowerCase());
  });

  test("encodes a 3-char ASCII code into bytes 12-14", () => {
    // "FOO" => 0x46 0x4F 0x4F at offset 12
    expect(currencyToHex40("FOO")).toBe(FOO_CURRENCY.toLowerCase());
  });

  test("rejects invalid lengths", () => {
    expect(() => currencyToHex40("RLUSD")).toThrow(/Invalid currency/);
  });
});

describe("buildInitData", () => {
  test("xrp: short form is just the decimals byte", () => {
    expect(buildInitData(6, { type: "xrp" })).toBe("06");
    expect(buildInitData(8, { type: "xrp" })).toBe("08");
  });

  test("iou: decimals + 0x01 + currency + issuer, right-padded to 43 bytes total", () => {
    const out = buildInitData(9, {
      type: "iou",
      currency: FOO_CURRENCY,
      issuer: ADMIN,
    });
    const issuerHex = Buffer.from(decodeAccountID(ADMIN)).toString("hex");
    // 1 (decimals) + 42 (token_id padded) = 43 bytes => 86 hex chars
    expect(out.length).toBe(86);
    expect(out.startsWith("09" + "01" + FOO_CURRENCY.toLowerCase() + issuerHex)).toBe(
      true
    );
    // trailing byte is zero padding (41 bytes of data -> padded to 42)
    expect(out.endsWith("00")).toBe(true);
  });

  test("mpt: decimals + 0x02 + mpt_id, right-padded to 43 bytes total", () => {
    const out = buildInitData(9, { type: "mpt", mptId: MPT_ID });
    expect(out.length).toBe(86);
    expect(out.startsWith("09" + "02" + MPT_ID.toLowerCase())).toBe(true);
    // 1 + 2 + 48 = 51 hex of data, padded to 84 -> ends in zeros
    expect(out.endsWith("0000")).toBe(true);
  });

  test("mpt: rejects a wrong-length issuance id", () => {
    expect(() => buildInitData(9, { type: "mpt", mptId: "00EE" })).toThrow(
      /48/
    );
  });

  test("rejects decimals out of byte range", () => {
    expect(() => buildInitData(256, { type: "xrp" })).toThrow(/one unsigned byte/);
  });
});

describe("buildOnboardingPayload", () => {
  test("xrp: assembles prefix + admin + app + tickets + init_data", () => {
    const initData = buildInitData(6, { type: "xrp" });
    const out = buildOnboardingPayload({
      admin: ADMIN,
      app: "NTT",
      initialTicket: 100,
      ticketCount: 150,
      initData,
    });

    const adminHex = Buffer.from(decodeAccountID(ADMIN)).toString("hex");
    const appHex = Buffer.from("NTT", "utf8").toString("hex").padStart(64, "0");
    const expected =
      XRPL_ONBOARDING_PREFIX +
      adminHex +
      appHex +
      "0000000000000064" + // 100
      "0000000000000096" + // 150
      "06";
    expect(out).toBe(expected);
    // 4 + 20 + 32 + 8 + 8 + 1 = 73 bytes => 146 hex chars
    expect(out.length).toBe(146);
  });

  test("full form (iou) is 115 bytes", () => {
    const initData = buildInitData(8, {
      type: "iou",
      currency: FOO_CURRENCY,
      issuer: ADMIN,
    });
    const out = buildOnboardingPayload({
      admin: ADMIN,
      app: "NTT",
      initialTicket: 1,
      ticketCount: 2,
      initData,
    });
    // 72 (fixed) + 43 (init_data) = 115 bytes => 230 hex chars
    expect(out.length).toBe(230);
  });
});

describe("buildPublishMemoData", () => {
  test("prepends version + nonce and uppercases", () => {
    expect(buildPublishMemoData("abcd")).toBe("0100000000ABCD");
  });
});
