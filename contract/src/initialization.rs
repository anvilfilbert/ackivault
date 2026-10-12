use crate::state::{decode_recipient, VaultError, VaultState, MAX_RECIPIENTS, RECIPIENT_BYTES};

const INIT_BYTES: usize = 405;
const RECIPIENTS_OFFSET: usize = 53;
const DEPLOY_HEADER_BYTES: usize = 288;

/// Reads the init argument section of the AVM ACDP deployment payload.
pub fn deployment_args(body: &[u8]) -> Result<&[u8], VaultError> {
    if body.len() < DEPLOY_HEADER_BYTES || body.get(..4) != Some(b"ACDP") {
        return Err(VaultError::InvalidArguments);
    }
    let salt_bytes = body
        .get(266..268)
        .and_then(|bytes| bytes.try_into().ok())
        .map(u16::from_le_bytes)
        .ok_or(VaultError::InvalidArguments)?;
    let args_bytes = body
        .get(268..272)
        .and_then(|bytes| bytes.try_into().ok())
        .map(u32::from_le_bytes)
        .ok_or(VaultError::InvalidArguments)?;
    if usize::try_from(args_bytes).map_err(|_| VaultError::InvalidArguments)? != INIT_BYTES {
        return Err(VaultError::InvalidArguments);
    }
    let args_start = DEPLOY_HEADER_BYTES
        .checked_add(usize::from(salt_bytes))
        .ok_or(VaultError::InvalidArguments)?;
    let args_end = args_start
        .checked_add(INIT_BYTES)
        .ok_or(VaultError::InvalidArguments)?;
    if args_end >= body.len() {
        return Err(VaultError::InvalidArguments);
    }
    body.get(args_start..args_end)
        .ok_or(VaultError::InvalidArguments)
}

pub fn initialize(
    owner_key: [u8; 32],
    args: &[u8],
    block_time: u32,
) -> Result<VaultState, VaultError> {
    if args.len() != INIT_BYTES {
        return Err(VaultError::InvalidArguments);
    }
    if owner_key == [0; 32] {
        return Err(VaultError::InvalidOwnerKey);
    }
    let agent_key: [u8; 32] = args[..32]
        .try_into()
        .map_err(|_| VaultError::InvalidArguments)?;
    if agent_key == [0; 32] {
        return Err(VaultError::InvalidAgentKey);
    }
    let expires_at = u32::from_le_bytes(
        args[32..36]
            .try_into()
            .map_err(|_| VaultError::InvalidArguments)?,
    );
    if expires_at <= block_time {
        return Err(VaultError::InvalidExpiry);
    }
    let cap = u128::from_le_bytes(
        args[36..52]
            .try_into()
            .map_err(|_| VaultError::InvalidArguments)?,
    );
    if cap == 0 {
        return Err(VaultError::InvalidCap);
    }
    let recipient_count = usize::from(args[52]);
    if !(1..=MAX_RECIPIENTS).contains(&recipient_count) {
        return Err(VaultError::InvalidRecipientCount);
    }
    let mut recipients = Vec::with_capacity(recipient_count);
    for index in 0..recipient_count {
        let start = RECIPIENTS_OFFSET + index * RECIPIENT_BYTES;
        let recipient = decode_recipient(&args[start..start + RECIPIENT_BYTES])?;
        if recipients
            .iter()
            .any(|prior: &crate::state::Recipient| prior.address == recipient.address)
        {
            return Err(VaultError::DuplicateRecipient);
        }
        recipients.push(recipient);
    }
    let unused_start = RECIPIENTS_OFFSET + recipient_count * RECIPIENT_BYTES;
    if args[unused_start..].iter().any(|byte| *byte != 0) {
        return Err(VaultError::InvalidArguments);
    }
    Ok(VaultState {
        owner_key,
        agent_key,
        expires_at,
        cap,
        spent: 0,
        revoked: false,
        owner_nonce_present: false,
        owner_nonce: 0,
        agent_nonce_present: false,
        agent_nonce: 0,
        recipients,
    })
}
