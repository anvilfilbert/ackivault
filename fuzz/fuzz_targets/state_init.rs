#![no_main]

use ackivault::initialization::{deployment_args, initialize};
use ackivault::state::{decode_state, encode_state};
use libfuzzer_sys::fuzz_target;

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
        assert_eq!(state.owner_key, [1; 32]);
        assert_eq!(state.agent_key, bytes[..32]);
        assert_eq!(state.spent, 0);
        assert!(!state.revoked);
        assert!(!state.owner_nonce_present && !state.agent_nonce_present);
        assert_eq!((state.owner_nonce, state.agent_nonce), (0, 0));
        assert!(state.expires_at > 10);
        let encoded = encode_state(&state).expect("initialized state must encode");
        assert_eq!(
            decode_state(&encoded).expect("initialized state must decode"),
            state
        );
    }
    if let Ok(args) = deployment_args(bytes) {
        assert_eq!(args.len(), 405);
        let name = usize::from(u16::from_le_bytes([bytes[264], bytes[265]]));
        let salt = usize::from(u16::from_le_bytes([bytes[266], bytes[267]]));
        assert_eq!(args, &bytes[288 + name + salt..288 + name + salt + 405]);
        if let Ok(state) = initialize([1; 32], args, 10) {
            assert_eq!(state.agent_key, args[..32]);
            assert_eq!(state.spent, 0);
        }
    }
});
