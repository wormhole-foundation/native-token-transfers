use solana_program_test::{BanksClientError, ProgramTestContext};
use solana_sdk::{
    instruction::Instruction, signature::Keypair, signer::Signer, signers::Signers,
    transaction::Transaction,
};

pub trait Submittable {
    async fn submit(self, ctx: &mut ProgramTestContext) -> Result<(), BanksClientError>
    where
        Self: Sized,
    {
        let no_signers: &[&Keypair] = &[];
        self.submit_with_signers(no_signers, ctx).await
    }

    async fn submit_with_signers<T: Signers + ?Sized>(
        self,
        signers: &T,
        ctx: &mut ProgramTestContext,
    ) -> Result<(), BanksClientError>;
}

impl Submittable for Instruction {
    async fn submit_with_signers<T: Signers + ?Sized>(
        self,
        signers: &T,
        ctx: &mut ProgramTestContext,
    ) -> Result<(), BanksClientError> {
        let blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();

        let mut transaction = Transaction::new_with_payer(&[self], Some(&ctx.payer.pubkey()));
        transaction.partial_sign(&[&ctx.payer], blockhash);
        transaction.partial_sign(signers, blockhash);

        ctx.banks_client.process_transaction(transaction).await
    }
}

impl Submittable for Transaction {
    async fn submit_with_signers<T: Signers + ?Sized>(
        mut self,
        signers: &T,
        ctx: &mut ProgramTestContext,
    ) -> Result<(), BanksClientError> {
        let blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();

        self.partial_sign(&[&ctx.payer], blockhash);
        self.partial_sign(signers, blockhash);
        ctx.banks_client.process_transaction(self).await
    }
}
