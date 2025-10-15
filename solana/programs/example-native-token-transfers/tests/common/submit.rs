use solana_banks_interface::BanksTransactionResultWithSimulation;
use solana_program_test::{BanksClientError, ProgramTestBanksClientExt, ProgramTestContext};
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

    async fn simulate(
        self,
        ctx: &mut ProgramTestContext,
    ) -> Result<BanksTransactionResultWithSimulation, BanksClientError>
    where
        Self: Sized,
    {
        let no_signers: &[&Keypair] = &[];
        self.simulate_with_signers(no_signers, ctx).await
    }

    async fn simulate_with_signers<T: Signers + ?Sized>(
        self,
        signers: &T,
        ctx: &mut ProgramTestContext,
    ) -> Result<BanksTransactionResultWithSimulation, BanksClientError>;
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

        // force a new blockhash in case the transaction status is cached
        // this can occur when the same instruction has been executed recently
        if ctx
            .banks_client
            .get_transaction_status(transaction.signatures[0])
            .await
            .unwrap()
            .is_some()
        {
            let blockhash = ctx
                .banks_client
                .get_new_latest_blockhash(&blockhash)
                .await
                .unwrap();
            transaction.partial_sign(&[&ctx.payer], blockhash);
            transaction.partial_sign(signers, blockhash);
        }

        ctx.banks_client.process_transaction(transaction).await
    }

    async fn simulate_with_signers<T: Signers + ?Sized>(
        self,
        signers: &T,
        ctx: &mut ProgramTestContext,
    ) -> Result<BanksTransactionResultWithSimulation, BanksClientError> {
        let blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();

        let mut transaction = Transaction::new_with_payer(&[self], Some(&ctx.payer.pubkey()));
        transaction.partial_sign(&[&ctx.payer], blockhash);
        transaction.partial_sign(signers, blockhash);

        ctx.banks_client.simulate_transaction(transaction).await
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

        // force a new blockhash in case the transaction status is cached
        // this can occur when the same transaction has been executed recently
        if ctx
            .banks_client
            .get_transaction_status(self.signatures[0])
            .await
            .unwrap()
            .is_some()
        {
            let blockhash = ctx
                .banks_client
                .get_new_latest_blockhash(&blockhash)
                .await
                .unwrap();
            self.partial_sign(&[&ctx.payer], blockhash);
            self.partial_sign(signers, blockhash);
        }

        ctx.banks_client.process_transaction(self).await
    }

    async fn simulate_with_signers<T: Signers + ?Sized>(
        mut self,
        signers: &T,
        ctx: &mut ProgramTestContext,
    ) -> Result<BanksTransactionResultWithSimulation, BanksClientError> {
        let blockhash = ctx.banks_client.get_latest_blockhash().await.unwrap();

        self.partial_sign(&[&ctx.payer], blockhash);
        self.partial_sign(signers, blockhash);
        ctx.banks_client.simulate_transaction(self).await
    }
}
