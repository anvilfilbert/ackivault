use ackivault::initialization::initialize;
use ackivault::state::{decode_state, encode_state, VaultError};

const INIT_BYTES: usize = 405;
const STATE_BYTES: usize = 473;
const FIRST_SLOT: usize = 53;
const SLOT_BYTES: usize = 88;

fn valid_args() -> [u8; INIT_BYTES] {
    let mut args = [0_u8; INIT_BYTES];
    args[..32].fill(2);
    args[32..36].copy_from_slice(&100_u32.to_le_bytes());
    args[36..52].copy_from_slice(&1_000_u128.to_le_bytes());
    args[52] = 1;
    args[FIRST_SLOT..FIRST_SLOT + 32].fill(3);
    args[FIRST_SLOT + 32..FIRST_SLOT + 64].fill(4);
    args[FIRST_SLOT + 64..FIRST_SLOT + 72].copy_from_slice(&7_u64.to_le_bytes());
    args[FIRST_SLOT + 72..FIRST_SLOT + 88].copy_from_slice(&5_u128.to_le_bytes());
    args
}

#[test]
fn valid_initialization_round_trips_exact_state() {
    let state = initialize([1; 32], &valid_args(), 99).expect("valid initialization");

    assert_eq!(state.owner_key, [1; 32]);
    assert_eq!(state.agent_key, [2; 32]);
    assert_eq!(state.expires_at, 100);
    assert_eq!(state.cap, 1_000);
    assert_eq!(state.spent, 0);
    assert!(!state.revoked);
    assert!(!state.owner_nonce_present);
    assert!(!state.agent_nonce_present);
    assert_eq!(state.recipients.len(), 1);
    assert_eq!(state.recipients[0].address.dapp_id, [3; 32]);
    assert_eq!(state.recipients[0].address.account_id, [4; 32]);
    assert_eq!(state.recipients[0].method_id, 7);
    assert_eq!(state.recipients[0].reserve_shells, 5);

    let encoded = encode_state(&state).expect("valid state encoding");
    assert_eq!(encoded.len(), STATE_BYTES);
    assert_eq!(decode_state(&encoded), Ok(state));
}

#[test]
fn initialization_rejects_zero_owner_and_agent_keys() {
    assert_eq!(
        initialize([0; 32], &valid_args(), 99),
        Err(VaultError::InvalidOwnerKey)
    );

    let mut args = valid_args();
    args[..32].fill(0);
    assert_eq!(
        initialize([1; 32], &args, 99),
        Err(VaultError::InvalidAgentKey)
    );
}

#[test]
fn initialization_rejects_expiry_at_or_before_block_time() {
    assert_eq!(
        initialize([1; 32], &valid_args(), 100),
        Err(VaultError::InvalidExpiry)
    );
    assert_eq!(
        initialize([1; 32], &valid_args(), 101),
        Err(VaultError::InvalidExpiry)
    );
}

#[test]
fn initialization_rejects_zero_cap_and_bad_recipient_counts() {
    let mut args = valid_args();
    args[36..52].fill(0);
    assert_eq!(initialize([1; 32], &args, 99), Err(VaultError::InvalidCap));

    let mut args = valid_args();
    args[52] = 0;
    assert_eq!(
        initialize([1; 32], &args, 99),
        Err(VaultError::InvalidRecipientCount)
    );

    args[52] = 5;
    assert_eq!(
        initialize([1; 32], &args, 99),
        Err(VaultError::InvalidRecipientCount)
    );
}

#[test]
fn initialization_rejects_duplicate_address_even_with_different_method() {
    let mut args = valid_args();
    args[52] = 2;
    let second = FIRST_SLOT + SLOT_BYTES;
    args[second..second + 64].copy_from_slice(&valid_args()[FIRST_SLOT..FIRST_SLOT + 64]);
    args[second + 64..second + 72].copy_from_slice(&8_u64.to_le_bytes());
    args[second + 72..second + 88].copy_from_slice(&9_u128.to_le_bytes());

    assert_eq!(
        initialize([1; 32], &args, 99),
        Err(VaultError::DuplicateRecipient)
    );
}

#[test]
fn initialization_rejects_zero_destination_and_method() {
    let mut args = valid_args();
    args[FIRST_SLOT..FIRST_SLOT + 64].fill(0);
    assert_eq!(
        initialize([1; 32], &args, 99),
        Err(VaultError::InvalidRecipient)
    );

    let mut args = valid_args();
    args[FIRST_SLOT + 64..FIRST_SLOT + 72].fill(0);
    assert_eq!(
        initialize([1; 32], &args, 99),
        Err(VaultError::InvalidRecipient)
    );
}

#[test]
fn initialization_rejects_truncated_and_noncanonical_arguments() {
    let args = valid_args();
    assert_eq!(
        initialize([1; 32], &args[..INIT_BYTES - 1], 99),
        Err(VaultError::InvalidArguments)
    );

    let mut args = valid_args();
    args[FIRST_SLOT + SLOT_BYTES] = 1;
    assert_eq!(
        initialize([1; 32], &args, 99),
        Err(VaultError::InvalidArguments)
    );
}

#[test]
fn state_decoder_rejects_truncation_version_and_unused_slot_data() {
    let state = initialize([1; 32], &valid_args(), 99).expect("valid initialization");
    let encoded = encode_state(&state).expect("valid state encoding");
    assert_eq!(
        decode_state(&encoded[..STATE_BYTES - 1]),
        Err(VaultError::InvalidStateLength)
    );

    let mut bad_version = encoded.clone();
    bad_version[0] = 2;
    assert_eq!(
        decode_state(&bad_version),
        Err(VaultError::UnsupportedStateVersion)
    );

    let mut unused_slot = encoded;
    unused_slot[STATE_BYTES - 1] = 1;
    assert_eq!(
        decode_state(&unused_slot),
        Err(VaultError::InvalidStateEncoding)
    );
}

#[test]
fn state_encoder_rejects_spent_above_cap() {
    let mut state = initialize([1; 32], &valid_args(), 99).expect("valid initialization");
    state.spent = 1_001;

    assert_eq!(encode_state(&state), Err(VaultError::InvalidStateEncoding));
}
