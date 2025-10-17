use anchor_lang::{prelude::Pubkey, AccountDeserialize};
use solana_program_test::{BanksClient, ProgramTestContext};

// These are all partial functions, but we use them in a non-result context (in tests) so
// just unwrap inline here.
// Might revisit this later.

pub trait GetAccountDataAnchor {
    async fn get_account_data_anchor<T: AccountDeserialize>(&mut self, pubkey: Pubkey) -> T;

    async fn get_account_data_anchor_unchecked<T: AccountDeserialize>(
        &mut self,
        pubkey: Pubkey,
    ) -> T;
}

impl GetAccountDataAnchor for BanksClient {
    async fn get_account_data_anchor<T: AccountDeserialize>(&mut self, pubkey: Pubkey) -> T {
        let data = self.get_account(pubkey).await.unwrap().unwrap();
        T::try_deserialize(&mut data.data.as_ref()).unwrap()
    }

    async fn get_account_data_anchor_unchecked<T: AccountDeserialize>(
        &mut self,
        pubkey: Pubkey,
    ) -> T {
        let data = self.get_account(pubkey).await.unwrap().unwrap();
        T::try_deserialize_unchecked(&mut data.data.as_ref()).unwrap()
    }
}

impl GetAccountDataAnchor for ProgramTestContext {
    async fn get_account_data_anchor<T: AccountDeserialize>(&mut self, pubkey: Pubkey) -> T {
        self.banks_client.get_account_data_anchor::<T>(pubkey).await
    }

    async fn get_account_data_anchor_unchecked<T: AccountDeserialize>(
        &mut self,
        pubkey: Pubkey,
    ) -> T {
        self.banks_client
            .get_account_data_anchor_unchecked::<T>(pubkey)
            .await
    }
}
