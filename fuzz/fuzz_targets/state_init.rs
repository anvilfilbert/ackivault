#![no_main]

use ackivault::initialization::{deployment_args, initialize};
use ackivault::state::{decode_state, encode_state, VaultState};
use libfuzzer_sys::fuzz_target;

// Compare directly with the wire input; do not derive expectations through production codecs.
fn assert_initialized(state: &VaultState, args: &[u8]) {
    assert_eq!(args.len(), 405);
    assert_eq!(state.owner_key, [1; 32]);
    assert_eq!(state.agent_key, args[..32]);
    assert_eq!(state.expires_at.to_le_bytes(), args[32..36]);
    assert_eq!(state.cap.to_le_bytes(), args[36..52]);
    assert_eq!(state.recipients.len(), usize::from(args[52]));
    for (index, recipient) in state.recipients.iter().enumerate() {
        let start = 53 + index * 88;
        assert_eq!(recipient.address.dapp_id, args[start..start + 32]);
        assert_eq!(recipient.address.account_id, args[start + 32..start + 64]);
        assert_eq!(
            recipient.method_id.to_le_bytes(),
            args[start + 64..start + 72]
        );
        assert_eq!(
            recipient.reserve_shells.to_le_bytes(),
            args[start + 72..start + 88]
        );
    }
    assert_eq!(state.spent, 0);
    assert!(!state.revoked);
    assert!(!state.owner_nonce_present && !state.agent_nonce_present);
    assert_eq!((state.owner_nonce, state.agent_nonce), (0, 0));
    assert!(state.expires_at > 10);
    let encoded = encode_state(state).expect("initialized state must encode");
    assert_eq!(
        &decode_state(&encoded).expect("initialized state must decode"),
        state
    );
}

// Detect panics, noncanonical acceptance, and loss of initialized security fields.
fuzz_target!(|bytes: &[u8]| {
    if let Ok(state) = decode_state(bytes) {
        assert_eq!(
            encode_state(&state).expect("accepted state must encode"),
            bytes
        );
        assert!(state.spent <= state.cap);
        assert_ne!(state.owner_key, [0; 32]);
        assert_ne!(state.agent_key, [0; 32]);
    }
    if let Ok(state) = initialize([1; 32], bytes, 10) {
        assert_initialized(&state, bytes);
    }
    if let Ok(args) = deployment_args(bytes) {
        assert_eq!(args.len(), 405);
        let name = usize::from(u16::from_le_bytes([bytes[264], bytes[265]]));
        let salt = usize::from(u16::from_le_bytes([bytes[266], bytes[267]]));
        assert_eq!(args, &bytes[288 + name + salt..288 + name + salt + 405]);
        if let Ok(state) = initialize([1; 32], args, 10) {
            assert_initialized(&state, args);
        }
    }
});
