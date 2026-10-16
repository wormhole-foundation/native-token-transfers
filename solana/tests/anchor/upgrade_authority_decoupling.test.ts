import * as anchor from "@coral-xyz/anchor";
import * as spl from "@solana/spl-token";
import {
  AccountAddress,
  ChainContext,
  Signer,
  Wormhole,
  contracts,
} from "@wormhole-foundation/sdk";
import {
  Ntt,
  register as registerDefinitionsNtt,
} from "@wormhole-foundation/sdk-definitions-ntt";
import {
  SolanaAddress,
  SolanaPlatform,
  getSolanaSignAndSendSigner,
} from "@wormhole-foundation/sdk-solana";
import { IdlVersion } from "../../ts/index.js";
import {
  SolanaNtt,
  register as registerSolanaNtt,
} from "../../ts/sdk/index.js";
import { TestHelper, TestMint, signSendWait } from "./utils/helpers.js";
import {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  programDataAddress,
} from "../../ts/lib/utils.js";
import { fileURLToPath } from "url";

registerDefinitionsNtt();
registerSolanaNtt();

// Native ESM (jest useESM) has no __dirname; derive it from import.meta.url.
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SOLANA_ROOT_DIR = `${__dirname}/../../`;
const VERSION: IdlVersion = "4.0.0";
const TOKEN_PROGRAM = spl.TOKEN_2022_PROGRAM_ID;
const CORE_BRIDGE_ADDRESS = contracts.coreBridge("Mainnet", "Solana");
const NTT_ADDRESS: anchor.web3.PublicKey =
  anchor.workspace.ExampleNativeTokenTransfers.programId;
const WH_TRANSCEIVER_ADDRESS: anchor.web3.PublicKey =
  anchor.workspace.NttTransceiver.programId;
const SOLANA_WORMHOLE_SHIMS: Ntt.Contracts["svmShims"] = {};

const $ = new TestHelper("confirmed", TOKEN_PROGRAM);
const payer = $.keypair.read(`${SOLANA_ROOT_DIR}/keys/test.json`);
const payerAddress = new SolanaAddress(payer.publicKey);

const w = new Wormhole("Devnet", [SolanaPlatform], {
  chains: { Solana: { contracts: { coreBridge: CORE_BRIDGE_ADDRESS } } },
});
const ctx: ChainContext<"Devnet", "Solana"> = w
  .getPlatform("Solana")
  .getChain("Solana", $.connection);

/**
 * Decode the upgrade-authority address out of the BPF-loader-upgradeable
 * `program_data` account. Layout (Solana 1.x bpf_loader_upgradeable):
 *   - 4 bytes  state discriminator
 *   - 8 bytes  slot (u64 LE)
 *   - 1 byte   `Option<Pubkey>` tag
 *   - 32 bytes pubkey when tag == 1
 */
async function readProgramUpgradeAuthority(
  connection: anchor.web3.Connection,
  programId: anchor.web3.PublicKey
): Promise<anchor.web3.PublicKey | null> {
  const programData = programDataAddress(programId);
  const info = await connection.getAccountInfo(programData);
  if (info === null) {
    throw new Error(
      `program_data account not found for ${programId.toBase58()}`
    );
  }
  // Sanity: the program_data account is owned by the BPF loader upgradeable.
  expect(info.owner.toBase58()).toEqual(
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID.toBase58()
  );
  const optionTag = info.data.readUInt8(4 + 8);
  if (optionTag === 0) return null;
  return new anchor.web3.PublicKey(
    info.data.subarray(4 + 8 + 1, 4 + 8 + 1 + 32)
  );
}

/**
 * v4 ownership-decoupling regression test.
 *
 * In v3 the singleton `transfer_ownership` instruction also performed a CPI
 * into the BPF-loader-upgradeable program to hand the program upgrade
 * authority over to (or via) the `[b"upgrade_lock"]` PDA. v4 deliberately
 * decouples instance ownership from the program upgrade authority — instance
 * ownership transfers are pure data mutations on the `Config` account.
 *
 * This test asserts that calling `transferOwnership` does NOT touch the
 * `program_data` account's upgrade_authority_address.
 */
describe("v4 upgrade authority decoupling", () => {
  let signer: Signer;
  let sender: AccountAddress<"Solana">;
  const mintAuthority = $.keypair.generate();
  const instanceKeypair = $.keypair.generate();
  let testMint: TestMint;
  let ntt: SolanaNtt<"Devnet", "Solana">;

  beforeAll(async () => {
    signer = await getSolanaSignAndSendSigner($.connection, payer);
    sender = Wormhole.parseAddress("Solana", signer.address());

    testMint = await TestMint.create(
      $.connection,
      payer,
      mintAuthority,
      9,
      TOKEN_PROGRAM,
      spl.ASSOCIATED_TOKEN_PROGRAM_ID
    );

    ntt = new SolanaNtt(
      "Devnet",
      "Solana",
      $.connection,
      {
        ...ctx.config.contracts,
        ntt: {
          token: testMint.address.toBase58(),
          manager: NTT_ADDRESS.toBase58(),
          instance: instanceKeypair.publicKey.toBase58(),
          transceiver: { wormhole: WH_TRANSCEIVER_ADDRESS.toBase58() },
          svmShims: SOLANA_WORMHOLE_SHIMS,
        },
      },
      VERSION
    );

    const multisigTokenAuthority = await $.multisig.create(payer, 1, [
      mintAuthority.publicKey,
      ntt.pdas.tokenAuthority(),
    ]);
    await testMint.setMintAuthority(
      payer,
      multisigTokenAuthority,
      mintAuthority
    );

    await signSendWait(
      ctx,
      ntt.initialize(sender, {
        mint: testMint.address,
        outboundLimit: 1_000_000n,
        mode: "burning",
        multisigTokenAuthority,
        instance: instanceKeypair,
      }),
      signer
    );
  });

  it("transferOwnership does not touch the program upgrade authority", async () => {
    const before = await readProgramUpgradeAuthority($.connection, NTT_ADDRESS);

    const newOwner = $.keypair.generate();
    await signSendWait(
      ctx,
      ntt.setOwner(newOwner.publicKey, payerAddress),
      signer
    );

    const after = await readProgramUpgradeAuthority($.connection, NTT_ADDRESS);

    // The instance owner has been queued for transfer (pending_owner is set),
    // but the program upgrade authority must be byte-identical.
    if (before === null) {
      expect(after).toBeNull();
    } else {
      expect(after).not.toBeNull();
      expect(after!.toBase58()).toEqual(before.toBase58());
    }

    // And the on-chain Instance shows the pending owner.
    const cfg = await ntt.getConfig();
    expect(cfg.pendingOwner?.toBase58()).toEqual(newOwner.publicKey.toBase58());
  });
});
