import { describe, it, expect } from "bun:test";
import {
  buildRegisterPeerPayload,
  buildRotateAdminPayload,
} from "../xrpl/admin";
import { parseAdmin } from "../xrpl/payloads";
import { toChainId } from "@wormhole-foundation/sdk";

// The XADM encoders (admin.ts) and decoder (payloads.ts::parseAdmin) must agree.
describe("XADM admin payloads round-trip through parseAdmin", () => {
  const manager = "rwooXFqJZc5cwuG3XJT5eWUgmdvKs2br4Q";

  it("RegisterPeer (0x01)", () => {
    const peer =
      "bd9ea0c58c349b4c6768e005c0b794418c46c71a1953f59e089f181bf6d81457";
    const hex = buildRegisterPeerPayload({
      manager,
      peerChainId: toChainId("Solana"),
      peerAddress: peer,
    });
    const parsed = parseAdmin(Buffer.from(hex, "hex"));
    expect(parsed.actionName).toBe("RegisterPeer");
    expect(parsed.targetAccount).toBe(manager);
    expect(parsed.chainId).toBe(toChainId("Solana"));
    expect(parsed.peerAddress).toBe(peer);
  });

  it("RegisterPeer accepts a 0x-prefixed peer address", () => {
    const peer =
      "bd9ea0c58c349b4c6768e005c0b794418c46c71a1953f59e089f181bf6d81457";
    const hex = buildRegisterPeerPayload({
      manager,
      peerChainId: 1,
      peerAddress: "0x" + peer,
    });
    const parsed = parseAdmin(Buffer.from(hex, "hex"));
    expect(parsed.peerAddress).toBe(peer);
  });

  it("rejects a peer address that is not 32 bytes", () => {
    expect(() =>
      buildRegisterPeerPayload({ manager, peerChainId: 1, peerAddress: "abcd" })
    ).toThrow();
  });

  it("RotateAdmin (0x02)", () => {
    const newAdmin = "rnv8uG8r7mewUqTZ7us3KESFE4cAEqsjm1";
    const hex = buildRotateAdminPayload({ manager, newAdmin });
    const parsed = parseAdmin(Buffer.from(hex, "hex"));
    expect(parsed.actionName).toBe("RotateAdmin");
    expect(parsed.targetAccount).toBe(manager);
    expect(parsed.newAdmin).toBe(newAdmin);
  });
});
