use anchor_lang::prelude::error_code;
use ntt_messages::errors::ScalingError;

#[error_code]
// TODO(csongor): rename
#[derive(PartialEq)]
pub enum NTTError {
    #[msg("CantReleaseYet")]
    CantReleaseYet,
    #[msg("InvalidPendingOwner")]
    InvalidPendingOwner,
    #[msg("InvalidChainId")]
    InvalidChainId,
    #[msg("InvalidRecipientAddress")]
    InvalidRecipientAddress,
    #[msg("InvalidTransceiverPeer")]
    InvalidTransceiverPeer,
    #[msg("InvalidNttManagerPeer")]
    InvalidNttManagerPeer,
    #[msg("InvalidRecipientNttManager")]
    InvalidRecipientNttManager,
    #[msg("TransferAlreadyRedeemed")]
    TransferAlreadyRedeemed,
    #[msg("TransferCannotBeRedeemed")]
    TransferCannotBeRedeemed,
    #[msg("TransferNotApproved")]
    TransferNotApproved,
    #[msg("MessageAlreadySent")]
    MessageAlreadySent,
    #[msg("InvalidMode")]
    InvalidMode,
    #[msg("InvalidMintAuthority")]
    InvalidMintAuthority,
    #[msg("TransferExceedsRateLimit")]
    TransferExceedsRateLimit,
    #[msg("Paused")]
    Paused,
    #[msg("DisabledTransceiver")]
    DisabledTransceiver,
    #[msg("InvalidDeployer")]
    InvalidDeployer,
    #[msg("BadAmountAfterTransfer")]
    BadAmountAfterTransfer,
    #[msg("BadAmountAfterBurn")]
    BadAmountAfterBurn,
    #[msg("ZeroThreshold")]
    ZeroThreshold,
    #[msg("OverflowExponent")]
    OverflowExponent,
    #[msg("OverflowScaledAmount")]
    OverflowScaledAmount,
    #[msg("BitmapIndexOutOfBounds")]
    BitmapIndexOutOfBounds,
    #[msg("NoRegisteredTransceivers")]
    NoRegisteredTransceivers,
    #[msg("NotPaused")]
    NotPaused,
    #[msg("InvalidPendingTokenAuthority")]
    InvalidPendingTokenAuthority,
    #[msg("IncorrectRentPayer")]
    IncorrectRentPayer,
    #[msg("InvalidMultisig")]
    InvalidMultisig,
    #[msg("ThresholdTooHigh")]
    ThresholdTooHigh,
    #[msg("InvalidTransceiverProgram")]
    InvalidTransceiverProgram,
}

impl From<ScalingError> for NTTError {
    fn from(e: ScalingError) -> Self {
        match e {
            ScalingError::OverflowScaledAmount => NTTError::OverflowScaledAmount,
            ScalingError::OverflowExponent => NTTError::OverflowExponent,
        }
    }
}
