use anchor_lang::prelude::{Error, Id, Pubkey};
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token::{Mint, Token},
};
use example_native_token_transfers::instructions::{InitializeArgs, SetPeerArgs};
use ntt_messages::{chain_id::ChainId, mode::Mode};
use solana_program::{bpf_loader_upgradeable::UpgradeableLoaderState, rent::Rent};
use solana_program_runtime::log_collector::log::{trace, warn};
use solana_program_test::{read_file, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account, signature::Keypair, signer::Signer, system_instruction,
    transaction::Transaction,
};
use std::path::PathBuf;
use wormhole_anchor_sdk::wormhole::{BridgeData, FeeCollector};

use crate::{
    common::{
        account_json_utils::{add_account_unchecked, AccountLoadable},
        fixtures::{
            TestData, ANOTHER_CHAIN, ANOTHER_MANAGER, INBOUND_LIMIT, MINT_AMOUNT, OTHER_CHAIN,
            OTHER_MANAGER, OTHER_TRANSCEIVER, OUTBOUND_LIMIT, THIS_CHAIN,
        },
        submit::Submittable,
    },
    sdk::{
        accounts::{good_ntt, Governance, NTTAccounts},
        instructions::{
            admin::{register_transceiver, set_peer, RegisterTransceiver, SetPeer},
            initialize::{initialize_with_token_program_id, Initialize},
        },
        transceivers::{
            accounts::{good_ntt_transceiver, NTTTransceiverAccounts},
            instructions::admin::{
                set_transceiver_peer, SetTransceiverPeer, SetTransceiverPeerArgs,
            },
        },
    },
};

pub async fn setup_with_extra_accounts(
    mode: Mode,
    accounts: &[(Pubkey, Account)],
) -> (ProgramTestContext, TestData) {
    let program_owner = Keypair::new();
    let mut program_test = setup_programs(program_owner.pubkey()).await.unwrap();

    for (pubkey, account) in accounts {
        program_test.add_account(*pubkey, account.clone());
    }

    let mut ctx = program_test.start_with_context().await;

    let test_data = setup_accounts(&mut ctx, program_owner).await;
    setup_ntt(&mut ctx, &test_data, mode).await;

    (ctx, test_data)
}

pub async fn setup_with_extra_accounts_with_transfer_fee(
    mode: Mode,
    accounts: &[(Pubkey, Account)],
) -> (ProgramTestContext, TestData) {
    let program_owner = Keypair::new();
    let mut program_test = setup_programs(program_owner.pubkey()).await.unwrap();

    for (pubkey, account) in accounts {
        program_test.add_account(*pubkey, account.clone());
    }

    let mut ctx = program_test.start_with_context().await;

    let test_data = setup_accounts_with_transfer_fee(&mut ctx, program_owner).await;
    setup_ntt_with_token_program_id(&mut ctx, &test_data, mode, &spl_token_2022::id()).await;

    (ctx, test_data)
}

pub async fn setup(mode: Mode) -> (ProgramTestContext, TestData) {
    setup_with_extra_accounts(mode, &[]).await
}

pub async fn setup_with_transfer_fee(mode: Mode) -> (ProgramTestContext, TestData) {
    setup_with_extra_accounts_with_transfer_fee(mode, &[]).await
}

fn prefer_bpf() -> bool {
    std::env::var("BPF_OUT_DIR").is_ok() || std::env::var("SBF_OUT_DIR").is_ok()
}

pub async fn setup_programs(program_owner: Pubkey) -> Result<ProgramTest, Error> {
    let mut program_test = ProgramTest::default();
    add_program_upgradeable(
        &mut program_test,
        "example_native_token_transfers",
        example_native_token_transfers::ID,
        Some(program_owner),
    );

    add_program_upgradeable(
        &mut program_test,
        "wormhole_governance",
        wormhole_governance::ID,
        None,
    );

    add_program_upgradeable(
        &mut program_test,
        "mainnet_core_bridge",
        wormhole_anchor_sdk::wormhole::program::Wormhole::id(),
        None,
    );

    cfg_if! {
        if #[cfg(feature = "shim")] {
            use wormhole_svm_definitions::solana::{POST_MESSAGE_SHIM_PROGRAM_ID, VERIFY_VAA_SHIM_PROGRAM_ID};

            add_program_upgradeable(
                &mut program_test,
                "ntt_transceiver",
                ntt_transceiver::ID,
                Some(program_owner),
            );

            add_program_upgradeable(
                &mut program_test,
                "mainnet_wormhole_post_message_shim",
                POST_MESSAGE_SHIM_PROGRAM_ID,
                None,
            );

            add_program_upgradeable(
                &mut program_test,
                "mainnet_wormhole_verify_vaa_shim",
                VERIFY_VAA_SHIM_PROGRAM_ID,
                None,
            );
        }
    }

    BridgeData::add_account(
        &mut program_test,
        "../../tests/accounts/mainnet/core_bridge_config.json",
    )?;

    FeeCollector::add_account(
        &mut program_test,
        "../../tests/accounts/mainnet/core_bridge_fee_collector.json",
    )?;

    // TODO: GuardianSet struct is not exposed in the wormhole sdk
    add_account_unchecked(
        &mut program_test,
        "../../tests/accounts/mainnet/guardian_set_0.json",
    )?;

    Ok(program_test)
}

/// Set up test accounts, and mint MINT_AMOUNT to the user's token account
/// Set up the program for locking mode, and registers a peer
pub async fn setup_ntt(ctx: &mut ProgramTestContext, test_data: &TestData, mode: Mode) {
    setup_ntt_with_token_program_id(ctx, test_data, mode, &Token::id()).await;
}

pub async fn setup_ntt_with_token_program_id(
    ctx: &mut ProgramTestContext,
    test_data: &TestData,
    mode: Mode,
    token_program_id: &Pubkey,
) {
    if mode == Mode::Burning {
        // we set the mint authority to the ntt contract in burn/mint mode
        spl_token_2022::instruction::set_authority(
            token_program_id,
            &test_data.mint,
            Some(&good_ntt.token_authority()),
            spl_token_2022::instruction::AuthorityType::MintTokens,
            &test_data.mint_authority.pubkey(),
            &[],
        )
        .unwrap()
        .submit_with_signers(&[&test_data.mint_authority], ctx)
        .await
        .unwrap();
    }

    initialize_with_token_program_id(
        &good_ntt,
        Initialize {
            payer: ctx.payer.pubkey(),
            deployer: test_data.program_owner.pubkey(),
            mint: test_data.mint,
            multisig_token_authority: None,
        },
        InitializeArgs {
            // TODO: use sdk
            chain_id: THIS_CHAIN,
            limit: OUTBOUND_LIMIT,
            mode,
        },
        token_program_id,
    )
    .submit_with_signers(&[&test_data.program_owner], ctx)
    .await
    .unwrap();

    register_transceiver(
        &good_ntt,
        RegisterTransceiver {
            payer: ctx.payer.pubkey(),
            owner: test_data.program_owner.pubkey(),
            transceiver: good_ntt_transceiver.program(), // standalone shim transceiver
        },
    )
    .submit_with_signers(&[&test_data.program_owner], ctx)
    .await
    .unwrap();

    set_transceiver_peer(
        &good_ntt,
        &good_ntt_transceiver,
        SetTransceiverPeer {
            payer: ctx.payer.pubkey(),
            owner: test_data.program_owner.pubkey(),
        },
        SetTransceiverPeerArgs {
            chain_id: ChainId { id: OTHER_CHAIN },
            address: OTHER_TRANSCEIVER,
        },
    )
    .submit_with_signers(&[&test_data.program_owner], ctx)
    .await
    .unwrap();
    set_peer(
        &good_ntt,
        SetPeer {
            payer: ctx.payer.pubkey(),
            owner: test_data.program_owner.pubkey(),
        },
        SetPeerArgs {
            chain_id: ChainId { id: OTHER_CHAIN },
            address: OTHER_MANAGER,
            limit: INBOUND_LIMIT,
            token_decimals: 7,
        },
    )
    .submit_with_signers(&[&test_data.program_owner], ctx)
    .await
    .unwrap();

    set_peer(
        &good_ntt,
        SetPeer {
            payer: ctx.payer.pubkey(),
            owner: test_data.program_owner.pubkey(),
        },
        SetPeerArgs {
            chain_id: ChainId { id: ANOTHER_CHAIN },
            address: ANOTHER_MANAGER,
            limit: INBOUND_LIMIT,
            token_decimals: 7,
        },
    )
    .submit_with_signers(&[&test_data.program_owner], ctx)
    .await
    .unwrap();
}

pub async fn setup_accounts(ctx: &mut ProgramTestContext, program_owner: Keypair) -> TestData {
    // create mint
    let mint = Keypair::new();
    let mint_authority = Keypair::new();

    let bad_mint = Keypair::new();
    let bad_mint_authority = Keypair::new();

    let user = Keypair::new();
    let payer = ctx.payer.pubkey();

    create_mint(ctx, &mint, &mint_authority.pubkey(), 9)
        .await
        .submit_with_signers(&[&mint], ctx)
        .await
        .unwrap();

    create_mint(ctx, &bad_mint, &bad_mint_authority.pubkey(), 9)
        .await
        .submit_with_signers(&[&bad_mint], ctx)
        .await
        .unwrap();

    // create associated token account for user
    let user_token_account =
        get_associated_token_address_with_program_id(&user.pubkey(), &mint.pubkey(), &Token::id());

    spl_associated_token_account::instruction::create_associated_token_account(
        &payer,
        &user.pubkey(),
        &mint.pubkey(),
        &Token::id(),
    )
    .submit(ctx)
    .await
    .unwrap();

    let bad_user_token_account = get_associated_token_address_with_program_id(
        &user.pubkey(),
        &bad_mint.pubkey(),
        &Token::id(),
    );

    spl_associated_token_account::instruction::create_associated_token_account(
        &payer,
        &user.pubkey(),
        &bad_mint.pubkey(),
        &Token::id(),
    )
    .submit(ctx)
    .await
    .unwrap();

    spl_token::instruction::mint_to(
        &Token::id(),
        &mint.pubkey(),
        &user_token_account,
        &mint_authority.pubkey(),
        &[],
        MINT_AMOUNT,
    )
    .unwrap()
    .submit_with_signers(&[&mint_authority], ctx)
    .await
    .unwrap();

    spl_token::instruction::mint_to(
        &Token::id(),
        &bad_mint.pubkey(),
        &bad_user_token_account,
        &bad_mint_authority.pubkey(),
        &[],
        MINT_AMOUNT,
    )
    .unwrap()
    .submit_with_signers(&[&bad_mint_authority], ctx)
    .await
    .unwrap();

    TestData {
        governance: Governance {
            program: wormhole_governance::ID,
        },
        program_owner,
        mint_authority,
        mint: mint.pubkey(),
        bad_mint_authority,
        bad_mint: bad_mint.pubkey(),
        user,
        user_token_account,
        bad_user_token_account,
    }
}

pub async fn setup_accounts_with_transfer_fee(
    ctx: &mut ProgramTestContext,
    program_owner: Keypair,
) -> TestData {
    // create mint
    let mint = Keypair::new();
    let mint_authority = Keypair::new();

    let bad_mint = Keypair::new();
    let bad_mint_authority = Keypair::new();

    let user = Keypair::new();
    let payer = ctx.payer.pubkey();

    create_mint_with_transfer_fee(ctx, &mint, &mint_authority.pubkey(), 9, 500, 5000)
        .await
        .submit_with_signers(&[&mint], ctx)
        .await
        .unwrap();

    create_mint_with_transfer_fee(ctx, &bad_mint, &bad_mint_authority.pubkey(), 9, 500, 5000)
        .await
        .submit_with_signers(&[&bad_mint], ctx)
        .await
        .unwrap();

    // create associated token account for user
    let user_token_account = get_associated_token_address_with_program_id(
        &user.pubkey(),
        &mint.pubkey(),
        &spl_token_2022::id(),
    );

    spl_associated_token_account::instruction::create_associated_token_account(
        &payer,
        &user.pubkey(),
        &mint.pubkey(),
        &spl_token_2022::id(),
    )
    .submit(ctx)
    .await
    .unwrap();

    let bad_user_token_account = get_associated_token_address_with_program_id(
        &user.pubkey(),
        &bad_mint.pubkey(),
        &spl_token_2022::id(),
    );

    spl_associated_token_account::instruction::create_associated_token_account(
        &payer,
        &user.pubkey(),
        &bad_mint.pubkey(),
        &spl_token_2022::id(),
    )
    .submit(ctx)
    .await
    .unwrap();

    spl_token_2022::instruction::mint_to(
        &spl_token_2022::id(),
        &mint.pubkey(),
        &user_token_account,
        &mint_authority.pubkey(),
        &[],
        MINT_AMOUNT,
    )
    .unwrap()
    .submit_with_signers(&[&mint_authority], ctx)
    .await
    .unwrap();

    spl_token_2022::instruction::mint_to(
        &spl_token_2022::id(),
        &bad_mint.pubkey(),
        &bad_user_token_account,
        &bad_mint_authority.pubkey(),
        &[],
        MINT_AMOUNT,
    )
    .unwrap()
    .submit_with_signers(&[&bad_mint_authority], ctx)
    .await
    .unwrap();

    TestData {
        governance: Governance {
            program: wormhole_governance::ID,
        },
        program_owner,
        mint_authority,
        mint: mint.pubkey(),
        bad_mint_authority,
        bad_mint: bad_mint.pubkey(),
        user,
        user_token_account,
        bad_user_token_account,
    }
}

pub async fn create_mint(
    ctx: &mut ProgramTestContext,
    mint: &Keypair,
    mint_authority: &Pubkey,
    decimals: u8,
) -> Transaction {
    let rent = ctx.banks_client.get_rent().await.unwrap();
    let mint_rent = rent.minimum_balance(Mint::LEN);

    let blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();

    Transaction::new_signed_with_payer(
        &[
            system_instruction::create_account(
                &ctx.payer.pubkey(),
                &mint.pubkey(),
                mint_rent,
                Mint::LEN as u64,
                &spl_token::ID,
            ),
            spl_token::instruction::initialize_mint2(
                &spl_token::ID,
                &mint.pubkey(),
                mint_authority,
                None,
                decimals,
            )
            .unwrap(),
        ],
        Some(&ctx.payer.pubkey()),
        &[&ctx.payer, mint],
        blockhash,
    )
}

pub async fn create_mint_with_transfer_fee(
    ctx: &mut ProgramTestContext,
    mint: &Keypair,
    mint_authority: &Pubkey,
    decimals: u8,
    transfer_fee_basis_points: u16,
    maximum_fee: u64,
) -> Transaction {
    let rent = ctx.banks_client.get_rent().await.unwrap();
    let extension_types = vec![spl_token_2022::extension::ExtensionType::TransferFeeConfig];
    let space = spl_token_2022::extension::ExtensionType::try_calculate_account_len::<
        spl_token_2022::state::Mint,
    >(&extension_types)
    .unwrap();
    let mint_rent = rent.minimum_balance(space);

    let blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();

    Transaction::new_signed_with_payer(
        &[
            system_instruction::create_account(
                &ctx.payer.pubkey(),
                &mint.pubkey(),
                mint_rent,
                space as u64,
                &spl_token_2022::id(),
            ),
            spl_token_2022::extension::transfer_fee::instruction::initialize_transfer_fee_config(
                &spl_token_2022::id(),
                &mint.pubkey(),
                None,
                None,
                transfer_fee_basis_points,
                maximum_fee,
            )
            .unwrap(),
            spl_token_2022::instruction::initialize_mint2(
                &spl_token_2022::id(),
                &mint.pubkey(),
                mint_authority,
                None,
                decimals,
            )
            .unwrap(),
        ],
        Some(&ctx.payer.pubkey()),
        &[&ctx.payer, &mint],
        blockhash,
    )
}

// TODO: upstream this to solana-program-test

/// Add a SBF program to the test environment. (copied from solana_program_test
/// `add_program`, but the owner is bpf_loader_upgradeable)
///
/// `program_name` will also be used to locate the SBF shared object in the current or fixtures
/// directory.
///
/// If `process_instruction` is provided, the natively built-program may be used instead of the
/// SBF shared object depending on the `BPF_OUT_DIR` environment variable.
pub fn add_program_upgradeable(
    program_test: &mut ProgramTest,
    program_name: &str,
    program_id: Pubkey,
    upgrade_authority_address: Option<Pubkey>,
) {
    let add_bpf = |this: &mut ProgramTest, program_file: PathBuf| {
        let elf = read_file(program_file);

        let (programdata_address, _) = Pubkey::find_program_address(
            &[program_id.as_ref()],
            &solana_sdk::bpf_loader_upgradeable::id(),
        );
        let mut program_data = bincode::serialize(&UpgradeableLoaderState::ProgramData {
            slot: 0,
            upgrade_authority_address: upgrade_authority_address
                .or_else(|| Some(Pubkey::default())),
        })
        .unwrap();
        program_data.extend_from_slice(&elf);

        this.add_account(
            programdata_address,
            Account {
                lamports: Rent::default().minimum_balance(program_data.len()).max(1),
                data: program_data,
                owner: solana_sdk::bpf_loader_upgradeable::id(),
                executable: false,
                rent_epoch: 0,
            },
        );

        let data = bincode::serialize(&UpgradeableLoaderState::Program {
            programdata_address,
        })
        .unwrap();

        this.add_account(
            program_id,
            Account {
                lamports: Rent::default().minimum_balance(data.len()).max(1),
                data,
                owner: solana_sdk::bpf_loader_upgradeable::id(),
                executable: true,
                rent_epoch: 0,
            },
        );
    };
    let warn_invalid_program_name = || {
        let valid_program_names = default_shared_object_dirs()
            .iter()
            .filter_map(|dir| dir.read_dir().ok())
            .flat_map(|read_dir| {
                read_dir.filter_map(|entry| {
                    let path = entry.ok()?.path();
                    if !path.is_file() {
                        return None;
                    }
                    match path.extension()?.to_str()? {
                        "so" => Some(path.file_stem()?.to_os_string()),
                        _ => None,
                    }
                })
            })
            .collect::<Vec<_>>();

        if valid_program_names.is_empty() {
            // This should be unreachable as `test-bpf` should guarantee at least one shared
            // object exists somewhere.
            warn!("No SBF shared objects found.");
            return;
        }

        warn!(
            "Possible bogus program name. Ensure the program name ({}) \
                matches one of the following recognizable program names:",
            program_name,
        );
        for name in valid_program_names {
            warn!(" - {}", name.to_str().unwrap());
        }
    };

    let program_file = find_file(&format!("{program_name}.so"));

    #[allow(clippy::panic)]
    match (prefer_bpf(), program_file) {
        // If SBF is preferred (i.e., `test-sbf` is invoked) and a BPF shared object exists,
        // use that as the program data.
        (true, Some(file)) => add_bpf(program_test, file),

        // Invalid: `test-sbf` invocation with no matching SBF shared object.
        (true, None) => {
            warn_invalid_program_name();
            if true {
                panic!(
                    "{:?} curr: {:?}, bpf {:?}; sbf {:?}",
                    default_shared_object_dirs(),
                    std::env::current_dir().unwrap(),
                    std::env::var("BPF_OUT_DIR"),
                    std::env::var("SBF_OUT_DIR"),
                );
            }
            panic!("Program file data not available for {program_name} ({program_id})");
        }

        // Invalid: regular `test` invocation without a processor.
        (false, _) => {
            panic!("Program processor not available for {program_name} ({program_id})");
        }
    }
}

pub fn find_file(filename: &str) -> Option<PathBuf> {
    for dir in default_shared_object_dirs() {
        let candidate = dir.join(filename);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn default_shared_object_dirs() -> Vec<PathBuf> {
    let mut search_path = vec![];
    if let Ok(bpf_out_dir) = std::env::var("BPF_OUT_DIR") {
        search_path.push(PathBuf::from(bpf_out_dir));
    } else if let Ok(bpf_out_dir) = std::env::var("SBF_OUT_DIR") {
        search_path.push(PathBuf::from(bpf_out_dir));
    }
    search_path.push(PathBuf::from("../../tests/fixtures"));
    if let Ok(dir) = std::env::current_dir() {
        search_path.push(dir);
    }
    trace!("SBF .so search path: {:?}", search_path);
    search_path
}
