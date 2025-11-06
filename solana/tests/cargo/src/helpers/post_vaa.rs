use anchor_lang::AnchorSerialize;
use solana_program::pubkey::Pubkey;
use solana_program_test::ProgramTestContext;
use std::sync::atomic::AtomicU64;
use wormhole_sdk::{Address, Chain, Vaa};

cfg_if! {
    if #[cfg(feature = "shim")] {
        use crate::sdk::{transceivers::accounts::NTTTransceiver,
            instructions::post_vaa::{
                get_guardian_signature, post_signatures, GUARDIAN_INDEX, GUARDIAN_SET_INDEX,
            }
        };
        use solana_sdk::{signature::Keypair, signer::Signer};

        pub async fn post_vaa_helper<A: AnchorSerialize + Clone>(
            ntt_transceiver: &NTTTransceiver,
            emitter_chain: Chain,
            emitter_address: Address,
            msg: A,
            ctx: &mut ProgramTestContext,
        ) -> (Pubkey, u32, Vec<u8>) {
            static I: AtomicU64 = AtomicU64::new(0);

            let sequence = I.fetch_add(1, std::sync::atomic::Ordering::Acquire);

            let mut vaa = Vaa {
                version: 1,
                guardian_set_index: GUARDIAN_SET_INDEX,
                signatures: vec![],
                timestamp: 123232,
                nonce: 0,
                emitter_chain,
                emitter_address,
                sequence,
                consistency_level: 0,
                payload: msg,
            };
            vaa.signatures
                .push(get_guardian_signature(vaa.clone(), GUARDIAN_INDEX));

            let guardian_signatures = Keypair::new();
            post_signatures(ntt_transceiver, ctx, &guardian_signatures, &vaa).await;

            (
                guardian_signatures.pubkey(),
                GUARDIAN_SET_INDEX,
                vaa_body(&vaa),
            )
        }

        fn vaa_body<A: AnchorSerialize + Clone>(vaa: &Vaa<A>) -> Vec<u8> {
            let mut bytes = Vec::new();
            bytes.extend_from_slice(&vaa.timestamp.to_be_bytes());
            bytes.extend_from_slice(&vaa.nonce.to_be_bytes());
            bytes.extend_from_slice(&u16::from(vaa.emitter_chain).to_be_bytes());
            bytes.extend_from_slice(&vaa.emitter_address.0);
            bytes.extend_from_slice(&vaa.sequence.to_be_bytes());
            bytes.push(vaa.consistency_level);
            let payload_bytes = vaa.payload.try_to_vec().unwrap();
            bytes.extend_from_slice(&payload_bytes);
            bytes
        }
    } else {
        use crate::sdk::{instructions::post_vaa::post_vaa, accounts::NTT};

        pub async fn post_vaa_helper<A: AnchorSerialize + Clone>(
            ntt: &NTT,
            emitter_chain: Chain,
            emitter_address: Address,
            msg: A,
            ctx: &mut ProgramTestContext,
        ) -> Pubkey {
            static I: AtomicU64 = AtomicU64::new(0);

            let sequence = I.fetch_add(1, std::sync::atomic::Ordering::Acquire);

            let vaa = Vaa {
                version: 1,
                guardian_set_index: 0,
                signatures: vec![],
                timestamp: 123232,
                nonce: 0,
                emitter_chain,
                emitter_address,
                sequence,
                consistency_level: 0,
                payload: msg,
            };

            post_vaa(&ntt.wormhole(), ctx, vaa).await
        }
    }
}
