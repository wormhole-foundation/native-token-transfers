import { describe, it, expect } from "bun:test";
import { ethers } from "ethers";
import { decodeAccountID } from "xrpl";
import {
  parsePayload,
  parseOnboarding,
  parseAdmin,
  parseVaa,
} from "../xrpl/payloads";
import { toChainId } from "@wormhole-foundation/sdk";

// Build an onboarding payload exactly as xrpl_accounts/init.ts does, then parse it back.
function buildOnboardingHex(
  admin: string,
  initialTicket: number,
  ticketCount: number,
  initDataHex: string,
): string {
  return (
    "5852504C" + // "XRPL"
    ethers.hexlify(decodeAccountID(admin)).substring(2) +
    ethers
      .zeroPadValue(ethers.hexlify(ethers.toUtf8Bytes("NTT")), 32)
      .substring(2) +
    ethers.toBeHex(initialTicket, 8).substring(2) +
    ethers.toBeHex(ticketCount, 8).substring(2) +
    initDataHex
  );
}

describe("parseOnboarding — round-trips xrpl_accounts/init.ts encoding", () => {
  it("XRP onboarding (init data = 0x06)", () => {
    const admin = "rypanhdnNhrtnDMGq6RRr497oDBLJnPeA";
    const hex = buildOnboardingHex(admin, 15229056, 10, "06");
    const parsed = parseOnboarding(Buffer.from(hex, "hex"));
    expect(parsed.admin).toBe(admin);
    expect(parsed.appType).toBe("NTT");
    expect(parsed.initialTicket).toBe(15229056n);
    expect(parsed.ticketCount).toBe(10n);
    expect(parsed.initDataHex).toBe("06");
  });

  it("dispatch via parsePayload tags it Onboarding", () => {
    const hex = buildOnboardingHex("rypanhdnNhrtnDMGq6RRr497oDBLJnPeA", 1, 2, "06");
    const parsed = parsePayload(Buffer.from(hex, "hex"));
    expect(parsed.kind).toBe("Onboarding");
  });
});

describe("parseAdmin — round-trips xrpl_accounts/register_peer.ts encoding", () => {
  it("RegisterPeer (action 0x01)", () => {
    const target = "rwooXFqJZc5cwuG3XJT5eWUgmdvKs2br4Q";
    const chainId = 1;
    const peer =
      "bd9ea0c58c349b4c6768e005c0b794418c46c71a1953f59e089f181bf6d81457";
    const hex =
      "5841444D" + // "XADM"
      "01" +
      ethers.hexlify(decodeAccountID(target)).substring(2) +
      ethers.toBeHex(chainId, 2).substring(2) +
      peer;
    const parsed = parseAdmin(Buffer.from(hex, "hex"));
    expect(parsed.actionName).toBe("RegisterPeer");
    expect(parsed.targetAccount).toBe(target);
    expect(parsed.chainId).toBe(1);
    expect(parsed.peerAddress).toBe(peer);
  });

  it("RotateAdmin (action 0x02)", () => {
    const target = "rwooXFqJZc5cwuG3XJT5eWUgmdvKs2br4Q";
    const newAdmin = "rnv8uG8r7mewUqTZ7us3KESFE4cAEqsjm1";
    const hex =
      "5841444D" +
      "02" +
      ethers.hexlify(decodeAccountID(target)).substring(2) +
      ethers.hexlify(decodeAccountID(newAdmin)).substring(2);
    const parsed = parseAdmin(Buffer.from(hex, "hex"));
    expect(parsed.actionName).toBe("RotateAdmin");
    expect(parsed.targetAccount).toBe(target);
    expect(parsed.newAdmin).toBe(newAdmin);
  });
});

describe("parseVaa — real testnet VAA (full_docs.md NTT redeem)", () => {
  // VAA from full_docs.md `manual redeem 0100...` example (XRPL → Solana NTT transfer).
  const VAA_HEX =
    "01000000000100ce5c54ee4c4834b5baaeec8f94c2c930b90ec3a2265d583d1b518df23cabc5d15ee768d4fd3ee4b8cc6a78bd754353bca5b2ef7ab787a0e9a3dea6aadddb0b7e0069865efc0000000000421e201a713837dfa392d301657c9273933aa797379cf0e1d65d8aac2b8078fe9d00e0043100000001009945ff1000000000000000000000000030576ecdd1813fa5651de47350bd23395ca22afb0ba58b9c343d2f24031b992d78158bc9a752318b88b4fb56bf87503b1c785499009100000000000000000000000000000000000000000000000000e00431000000010000000000000000000000000a98339b479125caaed23f4c6b02f275f39889ae004f994e5454060000000000000064000000000000000000000000000000000000000000000000000000000000000083718b7ec89617b7040685e01bdcca03214022980daae91340e0c3f840c005ef00010000";

  it("decodes the envelope with emitter chain 66 (XRPL)", () => {
    const vaa = parseVaa(Buffer.from(VAA_HEX, "hex"));
    expect(vaa.version).toBe(1);
    expect(vaa.emitterChain).toBe(66); // XRPL
    expect(vaa.signatures.length).toBe(1);
    // payload starts with the Wormhole transceiver prefix 0x9945FF10
    expect(vaa.payload.subarray(0, 4).toString("hex")).toBe("9945ff10");
  });

  it("parsePayload decodes the inner NTT transfer", () => {
    const vaa = parseVaa(Buffer.from(VAA_HEX, "hex"));
    const parsed = parsePayload(vaa.payload);
    expect(parsed.kind).toBe("NttTransfer");
    if (parsed.kind !== "NttTransfer") throw new Error("unexpected");
    // recipient chain is Solana in this transfer
    expect(parsed.recipientChain).toBe(toChainId("Solana"));
    // amount 0x64 = 100 (trimmed, 6 decimals), source token = XRP (zero)
    expect(parsed.amount).toBe(100n);
    expect(parsed.decimals).toBe(6);
    expect(parsed.sourceToken).toBe("00".repeat(32));
  });
});
