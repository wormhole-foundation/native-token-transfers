//! NOTE: currently the wormhole sdk does not expose instruction builders for
//! posting vaas, so we go through the CPI route for testing
//! TODO: remove this once the sdk supports posting vaas
//!
//! also, this whole module is a mess. this is way harder than it needs to be

use anchor_lang::prelude::*;
use libsecp256k1::{sign, Message};
use serde_wormhole::RawMessage;
use solana_program::{instruction::AccountMeta, sysvar};
use solana_program_test::ProgramTestContext;
use solana_sdk::{
    instruction::Instruction, secp256k1_instruction::new_secp256k1_instruction, signature::Keypair,
    signer::Signer, transaction::Transaction,
};
use wormhole_sdk::vaa::*;

use crate::{common::submit::Submittable, sdk::accounts::Wormhole};

// NOTE: assuming guardian set index 0 which has a single guardian (who is always the signer)
pub const GUARDIAN_SET_INDEX: u32 = 0;
pub const GUARDIAN_INDEX: u8 = 0;

pub const MAX_LEN_GUARDIAN_KEYS: usize = 19;

pub const GUARDIAN_SECRET_KEY: &str =
    "cfb12303a19cde580bb4dd771639b0d26bc68353645571a8cff516ab2ee113a0";

pub struct VerifySignatures {
    pub payer: Pubkey,
    pub signature_set: Pubkey,
}

pub async fn post_vaa<A: AnchorSerialize + Clone>(
    wh: &Wormhole,
    ctx: &mut ProgramTestContext,
    vaa: Vaa<A>,
) -> Pubkey {
    let signature_set = Keypair::new();

    let (verify_tx, post_ix, posted_vaa) = verify_signatures(
        wh,
        VerifySignatures {
            payer: ctx.payer.pubkey(),
            signature_set: signature_set.pubkey(),
        },
        vaa.clone(),
    );

    verify_tx
        .submit_with_signers(&[&signature_set], ctx)
        .await
        .unwrap();

    post_ix.submit(ctx).await.unwrap();

    posted_vaa
}

fn verify_signatures<A: AnchorSerialize + Clone>(
    wh: &Wormhole,
    accounts: VerifySignatures,
    vaa: Vaa<A>,
) -> (Transaction, Instruction, Pubkey) {
    let mut signers: [i8; MAX_LEN_GUARDIAN_KEYS] = [-1; 19];
    signers[0] = 0;

    let priv_key: libsecp256k1::SecretKey = libsecp256k1::SecretKey::parse(
        &hex::decode(GUARDIAN_SECRET_KEY)
            .unwrap()
            .try_into()
            .unwrap(),
    )
    .unwrap();

    let (header, body): (Header, Body<A>) = vaa.into();

    let serialized_body: Body<Box<RawMessage>> = Body {
        payload: Box::<RawMessage>::from(body.payload.try_to_vec().unwrap()),
        ..body
    };

    let digest = serialized_body.digest().unwrap().hash;

    let secp_ix = new_secp256k1_instruction(&priv_key, &digest);

    let verify_sigs_ix = Instruction {
        program_id: wh.program,
        accounts: vec![
            AccountMeta::new(accounts.payer, true),
            AccountMeta::new_readonly(wh.guardian_set(0), false),
            AccountMeta::new(accounts.signature_set, true),
            AccountMeta::new_readonly(sysvar::instructions::id(), false),
            AccountMeta::new_readonly(sysvar::rent::id(), false),
            AccountMeta::new_readonly(solana_program::system_program::id(), false),
        ],
        data: wormhole_anchor_sdk::wormhole::Instruction::VerifySignatures { signers }
            .try_to_vec()
            .unwrap(),
    };

    let posted_vaa = wh.posted_vaa(&digest);

    let post_vaa_ix = Instruction {
        program_id: wh.program,
        accounts: vec![
            AccountMeta::new_readonly(wh.guardian_set(0), false),
            AccountMeta::new_readonly(wh.bridge(), false),
            AccountMeta::new_readonly(accounts.signature_set, false),
            AccountMeta::new(posted_vaa, false),
            AccountMeta::new(accounts.payer, true),
            AccountMeta::new_readonly(sysvar::clock::id(), false),
            AccountMeta::new_readonly(sysvar::rent::id(), false),
            AccountMeta::new_readonly(solana_program::system_program::id(), false),
        ],
        data: wormhole_anchor_sdk::wormhole::Instruction::PostVAA {
            version: header.version,
            guardian_set_index: header.guardian_set_index,
            timestamp: body.timestamp,
            nonce: body.nonce,
            emitter_chain: body.emitter_chain.into(),
            emitter_address: body.emitter_address.0,
            sequence: body.sequence,
            consistency_level: body.consistency_level,
            payload: body.payload.try_to_vec().unwrap(),
        }
        .try_to_vec()
        .unwrap(),
    };

    // TODO: for some reason submitting the verification in the same ix as the
    // post vaa does not seem to work. why?
    (
        Transaction::new_with_payer(&[secp_ix, verify_sigs_ix], Some(&accounts.payer)),
        post_vaa_ix,
        posted_vaa,
    )
}

pub fn get_guardian_signature<A: AnchorSerialize + Clone>(vaa: Vaa<A>, index: u8) -> Signature {
    let priv_key: libsecp256k1::SecretKey = libsecp256k1::SecretKey::parse(
        &hex::decode(GUARDIAN_SECRET_KEY)
            .unwrap()
            .try_into()
            .unwrap(),
    )
    .unwrap();

    let (_, body): (Header, Body<A>) = vaa.into();
    let serialized_body: Body<Box<RawMessage>> = Body {
        payload: Box::<RawMessage>::from(body.payload.try_to_vec().unwrap()),
        ..body
    };
    let digest = serialized_body.digest().unwrap().secp256k_hash;
    let msg = Message::parse(&digest);

    let (sig, recovery_id) = sign(&msg, &priv_key);

    let mut signature = [0u8; 65];
    signature[..64].copy_from_slice(&sig.serialize());
    signature[64] = recovery_id.serialize();

    Signature { index, signature }
}

cfg_if! {
    if #[cfg(feature = "shim")] {
        use wormhole_svm_shim::verify_vaa::{
            CloseSignatures, CloseSignaturesAccounts, PostSignatures, PostSignaturesAccounts,
            PostSignaturesData,
        };
        use crate::sdk::transceivers::accounts::NTTTransceiver;

        pub async fn post_signatures<A: AnchorSerialize + Clone>(
            ntt_transceiver: &NTTTransceiver,
            ctx: &mut ProgramTestContext,
            guardian_signatures: &Keypair,
            vaa: &Vaa<A>,
        ) {
            PostSignatures {
                program_id: &ntt_transceiver.verify_vaa_shim_shim(),
                accounts: PostSignaturesAccounts {
                    payer: &ctx.payer.pubkey(),
                    guardian_signatures: &guardian_signatures.pubkey(),
                },
                data: PostSignaturesData::new(
                    vaa.guardian_set_index,
                    u8::try_from(vaa.signatures.len()).unwrap(),
                    &vaa.signatures
                        .iter()
                        .map(|sig| {
                            let mut buf = [0u8; 66];
                            buf[0] = sig.index;
                            buf[1..].copy_from_slice(&sig.signature);
                            buf
                        })
                        .collect::<Vec<[u8; 66]>>(),
                ),
            }
            .instruction()
            .submit_with_signers(&[guardian_signatures], ctx)
            .await
            .unwrap();
        }

        pub async fn close_signatures(
            ntt_transceiver: &NTTTransceiver,
            ctx: &mut ProgramTestContext,
            guardian_signatures: &Pubkey,
        ) {
            CloseSignatures {
                program_id: &ntt_transceiver.verify_vaa_shim_shim(),
                accounts: CloseSignaturesAccounts {
                    guardian_signatures,
                    refund_recipient: &ctx.payer.pubkey(),
                },
            }
            .instruction()
            .submit(ctx)
            .await
            .unwrap();
        }
    }
}
