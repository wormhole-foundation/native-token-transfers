use anchor_lang::{prelude::Pubkey, AnchorDeserialize};
use base64::Engine;
use serde::{Deserialize, Serialize};
use solana_program_test::ProgramTest;
use std::{io::Error, str::FromStr};

#[derive(Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Account<A> {
    pub pubkey: String,
    pub account: AccountData<A>,
}

#[derive(Deserialize, Serialize, Debug)]
// camelcase
#[serde(rename_all = "camelCase")]
pub struct AccountData<A> {
    pub lamports: u64,
    pub data: A,
    pub owner: String,
    pub executable: bool,
    pub rent_epoch: u64,
    pub space: u64,
}

pub trait AccountLoadable: AnchorDeserialize {
    fn add_account(program_test: &mut ProgramTest, path: &str) -> Result<Account<Self>, Error>;
}

impl<T: AnchorDeserialize> AccountLoadable for T {
    fn add_account(program_test: &mut ProgramTest, path: &str) -> Result<Account<Self>, Error> {
        let account = add_account_unchecked(program_test, path)?;
        let decoded = AnchorDeserialize::deserialize(&mut account.account.data.as_slice())?;
        Ok(Account {
            pubkey: account.pubkey,
            account: AccountData {
                data: decoded,
                ..account.account
            },
        })
    }
}

/// Adds an account to the program test without checking the account data.
/// Returns the account data as a byte array.
pub fn add_account_unchecked(
    program_test: &mut ProgramTest,
    path: &str,
) -> Result<Account<Vec<u8>>, Error> {
    let account =
        serde_json::from_str::<Account<(String, String)>>(&std::fs::read_to_string(path)?)?;
    if account.account.data.1 != "base64" {
        return Err(Error::new(
            std::io::ErrorKind::InvalidData,
            "Expected base64 account data",
        ));
    }
    program_test.add_account_with_base64_data(
        Pubkey::from_str(&account.pubkey).map_err(|e| {
            Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Failed to parse pubkey: {}", e),
            )
        })?,
        account.account.lamports,
        Pubkey::from_str(&account.account.owner).map_err(|e| {
            Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Failed to parse owner: {}", e),
            )
        })?,
        &account.account.data.0,
    );

    let decoded = base64::engine::general_purpose::STANDARD
        .decode(account.account.data.0.as_bytes())
        .map_err(|e| {
            Error::new(
                std::io::ErrorKind::InvalidData,
                format!("Failed to decode base64 account data: {}", e),
            )
        })?;

    let result = Account {
        pubkey: account.pubkey,
        account: AccountData {
            data: decoded,
            ..account.account
        },
    };
    Ok(result)
}
