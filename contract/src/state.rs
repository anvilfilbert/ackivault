use avm_contract_sdk::AccountAddress;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Recipient {
    pub address: AccountAddress,
    pub method_id: u64,
    pub reserve_shells: u128,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultState {
    pub owner_key: [u8; 32],
    pub agent_key: [u8; 32],
    pub expires_at: u32,
    pub cap: u128,
    pub spent: u128,
    pub revoked: bool,
    pub owner_nonce_present: bool,
    pub owner_nonce: u64,
    pub agent_nonce_present: bool,
    pub agent_nonce: u64,
    pub recipients: Vec<Recipient>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VaultError {
    InvalidArguments = 1000,
    UnsupportedMessage = 1001,
    InvalidOwnerKey = 1002,
    InvalidAgentKey = 1003,
    InvalidExpiry = 1004,
    InvalidCap = 1005,
    InvalidRecipientCount = 1006,
    InvalidRecipient = 1007,
    DuplicateRecipient = 1008,
    InvalidStateLength = 1009,
    UnsupportedStateVersion = 1010,
    InvalidStateEncoding = 1011,
    UnauthorizedAgent = 1012,
    UnauthorizedOwner = 1013,
    InvalidAgentNonce = 1014,
    InvalidOwnerNonce = 1015,
    RecipientNotAllowed = 1016,
    GrantExpired = 1017,
    GrantRevoked = 1018,
    GrantActive = 1019,
    AlreadyRevoked = 1020,
    InvalidAmount = 1021,
    InvalidDestination = 1022,
    AmountOverflow = 1023,
    CapExceeded = 1024,
    InsufficientShellBalance = 1025,
    InvalidCallerType = 1026,
    InvalidIncomingValue = 1027,
    InvalidSignature = 1028,
    EventEncoding = 1029,
}

impl VaultError {
    pub const fn status_code(self) -> u32 {
        self as u32
    }
}

pub const RECIPIENT_BYTES: usize = 88;
pub const MAX_RECIPIENTS: usize = 4;
pub const STATE_BYTES: usize = 473;
const RECIPIENTS_OFFSET: usize = 121;

pub(crate) fn decode_recipient(bytes: &[u8]) -> Result<Recipient, VaultError> {
    if bytes.len() != RECIPIENT_BYTES {
        return Err(VaultError::InvalidRecipient);
    }
    let dapp_id: [u8; 32] = bytes[..32]
        .try_into()
        .map_err(|_| VaultError::InvalidRecipient)?;
    let account_id: [u8; 32] = bytes[32..64]
        .try_into()
        .map_err(|_| VaultError::InvalidRecipient)?;
    let method_id = u64::from_le_bytes(
        bytes[64..72]
            .try_into()
            .map_err(|_| VaultError::InvalidRecipient)?,
    );
    let reserve_shells = u128::from_le_bytes(
        bytes[72..88]
            .try_into()
            .map_err(|_| VaultError::InvalidRecipient)?,
    );
    if dapp_id == [0; 32] || account_id == [0; 32] || method_id == 0 {
        return Err(VaultError::InvalidRecipient);
    }
    Ok(Recipient {
        address: AccountAddress {
            dapp_id,
            account_id,
        },
        method_id,
        reserve_shells,
    })
}

fn valid_state(state: &VaultState) -> Result<(), VaultError> {
    if state.owner_key == [0; 32]
        || state.agent_key == [0; 32]
        || state.expires_at == 0
        || state.cap == 0
        || state.spent > state.cap
        || !state.owner_nonce_present && state.owner_nonce != 0
        || !state.agent_nonce_present && state.agent_nonce != 0
        || !(1..=MAX_RECIPIENTS).contains(&state.recipients.len())
    {
        return Err(VaultError::InvalidStateEncoding);
    }
    for (index, recipient) in state.recipients.iter().enumerate() {
        if recipient.address.dapp_id == [0; 32]
            || recipient.address.account_id == [0; 32]
            || recipient.method_id == 0
            || state.recipients[..index]
                .iter()
                .any(|prior| prior.address == recipient.address)
        {
            return Err(VaultError::InvalidStateEncoding);
        }
    }
    Ok(())
}

pub fn decode_state(bytes: &[u8]) -> Result<VaultState, VaultError> {
    if bytes.len() != STATE_BYTES {
        return Err(VaultError::InvalidStateLength);
    }
    if bytes[0] != 1 {
        return Err(VaultError::UnsupportedStateVersion);
    }
    let owner_key: [u8; 32] = bytes[1..33]
        .try_into()
        .map_err(|_| VaultError::InvalidStateEncoding)?;
    let agent_key: [u8; 32] = bytes[33..65]
        .try_into()
        .map_err(|_| VaultError::InvalidStateEncoding)?;
    let expires_at = u32::from_le_bytes(
        bytes[65..69]
            .try_into()
            .map_err(|_| VaultError::InvalidStateEncoding)?,
    );
    let cap = u128::from_le_bytes(
        bytes[69..85]
            .try_into()
            .map_err(|_| VaultError::InvalidStateEncoding)?,
    );
    let spent = u128::from_le_bytes(
        bytes[85..101]
            .try_into()
            .map_err(|_| VaultError::InvalidStateEncoding)?,
    );
    let revoked = decode_bool(bytes[101])?;
    let owner_nonce_present = decode_bool(bytes[102])?;
    let owner_nonce = u64::from_le_bytes(
        bytes[103..111]
            .try_into()
            .map_err(|_| VaultError::InvalidStateEncoding)?,
    );
    let agent_nonce_present = decode_bool(bytes[111])?;
    let agent_nonce = u64::from_le_bytes(
        bytes[112..120]
            .try_into()
            .map_err(|_| VaultError::InvalidStateEncoding)?,
    );
    let recipient_count = usize::from(bytes[120]);
    if !(1..=MAX_RECIPIENTS).contains(&recipient_count) {
        return Err(VaultError::InvalidStateEncoding);
    }
    let mut recipients = Vec::with_capacity(recipient_count);
    for index in 0..recipient_count {
        let start = RECIPIENTS_OFFSET + index * RECIPIENT_BYTES;
        let recipient = decode_recipient(&bytes[start..start + RECIPIENT_BYTES])
            .map_err(|_| VaultError::InvalidStateEncoding)?;
        recipients.push(recipient);
    }
    let unused_start = RECIPIENTS_OFFSET + recipient_count * RECIPIENT_BYTES;
    if bytes[unused_start..].iter().any(|byte| *byte != 0) {
        return Err(VaultError::InvalidStateEncoding);
    }
    let state = VaultState {
        owner_key,
        agent_key,
        expires_at,
        cap,
        spent,
        revoked,
        owner_nonce_present,
        owner_nonce,
        agent_nonce_present,
        agent_nonce,
        recipients,
    };
    valid_state(&state)?;
    Ok(state)
}

fn decode_bool(value: u8) -> Result<bool, VaultError> {
    match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(VaultError::InvalidStateEncoding),
    }
}

pub fn encode_state(state: &VaultState) -> Result<Vec<u8>, VaultError> {
    valid_state(state)?;
    let mut bytes = Vec::with_capacity(STATE_BYTES);
    bytes.push(1);
    bytes.extend_from_slice(&state.owner_key);
    bytes.extend_from_slice(&state.agent_key);
    bytes.extend_from_slice(&state.expires_at.to_le_bytes());
    bytes.extend_from_slice(&state.cap.to_le_bytes());
    bytes.extend_from_slice(&state.spent.to_le_bytes());
    bytes.push(u8::from(state.revoked));
    bytes.push(u8::from(state.owner_nonce_present));
    bytes.extend_from_slice(&state.owner_nonce.to_le_bytes());
    bytes.push(u8::from(state.agent_nonce_present));
    bytes.extend_from_slice(&state.agent_nonce.to_le_bytes());
    bytes.push(u8::try_from(state.recipients.len()).map_err(|_| VaultError::InvalidStateEncoding)?);
    for recipient in &state.recipients {
        bytes.extend_from_slice(&recipient.address.dapp_id);
        bytes.extend_from_slice(&recipient.address.account_id);
        bytes.extend_from_slice(&recipient.method_id.to_le_bytes());
        bytes.extend_from_slice(&recipient.reserve_shells.to_le_bytes());
    }
    bytes.resize(STATE_BYTES, 0);
    Ok(bytes)
}
