#![no_main]

use ackivault::abi::{
    DEPOSIT_METHOD_ID, INSPECT_METHOD_ID, PAY_METHOD_ID, REVOKE_METHOD_ID, WITHDRAW_METHOD_ID,
};
use ackivault::state::decode_state;
use ackivault::AckiVault;
use avm_contract_sdk::{decode_message_input, Caller, CanonicalMessage, Contract, StateUpdate};
use libfuzzer_sys::fuzz_target;

// Canonical frames are untrusted host input; synthetic signatures do not test host crypto.
fuzz_target!(|bytes: &[u8]| {
    let Ok(input) = decode_message_input(bytes) else {
        return;
    };
    let output = if input.message.is_deploy() {
        AckiVault::init(input)
    } else {
        AckiVault::process_message(input)
    };
    assert!(output.callback_intents.is_empty());
    if output.status_code != 0 {
        assert!(output.state_update.is_none());
        assert!(output.outbound_intents.is_empty());
        assert!(output.event_intents.is_empty());
        return;
    }
    let Some(StateUpdate::FullReplace(next_bytes)) = output.state_update else {
        panic!("success must persist canonical state");
    };
    let next = decode_state(&next_bytes).expect("accepted state must remain valid");
    if input.message.is_deploy() {
        let Caller::External(key) = input.caller else {
            panic!("deployment must be external");
        };
        assert!(input.state.is_empty());
        assert_eq!(next.owner_key, key);
        assert_eq!(next.spent, 0);
        assert!(!next.revoked);
        assert!(output.outbound_intents.is_empty());
        assert!(output.event_intents.is_empty());
        return;
    }
    let before = decode_state(input.state).expect("accepted prior state must be valid");
    assert_eq!(next.owner_key, before.owner_key);
    assert_eq!(next.agent_key, before.agent_key);
    assert_eq!(next.expires_at, before.expires_at);
    assert_eq!(next.cap, before.cap);
    assert_eq!(next.recipients, before.recipients);
    assert_eq!(output.event_intents.len(), 1);
    if input.message.method_id() == DEPOSIT_METHOD_ID {
        assert_eq!(next_bytes, input.state);
        assert!(output.outbound_intents.is_empty());
        let CanonicalMessage::Internal(message) = input.message else {
            panic!("deposit must be internal");
        };
        assert!(!message.is_callback() && !message.has_callback_request());
        assert!(message.event_reads.is_none() && message.body.is_empty());
        return;
    }
    let (Caller::External(key), CanonicalMessage::External(message)) =
        (input.caller, input.message)
    else {
        panic!("privileged actions must be external");
    };
    assert_ne!(key, [0; 32]);
    assert_eq!(key, message.pubkey);
    assert_ne!(message.flags & 1, 0);
    assert_eq!(message.signature.len(), 64);
    assert_eq!(message.value_main, 0);
    assert!(message.extra.is_empty());
    if message.method_id == PAY_METHOD_ID {
        assert_eq!(key, before.agent_key);
        assert!(!before.revoked && input.context.block_time < before.expires_at);
        assert!(!before.agent_nonce_present || message.nonce > before.agent_nonce);
        assert_eq!(
            (next.owner_nonce_present, next.owner_nonce),
            (before.owner_nonce_present, before.owner_nonce)
        );
        assert!(next.agent_nonce_present);
        assert_eq!(next.agent_nonce, message.nonce);
        assert_eq!(message.body.len(), 17);
        let amount = u128::from_le_bytes(message.body[1..].try_into().unwrap());
        let recipient = &before.recipients[usize::from(message.body[0])];
        let cost = amount
            .checked_add(recipient.reserve_shells)
            .expect("accepted cost cannot overflow");
        assert!(amount > 0);
        assert_eq!(next.spent, before.spent.checked_add(cost).unwrap());
        assert!(next.spent <= before.cap);
        let balance = input
            .extra
            .iter()
            .find(|entry| entry.currency_id == 2)
            .map_or(0, |entry| entry.amount);
        assert!(cost <= balance);
        assert_eq!(output.outbound_intents.len(), 1);
        let intent = &output.outbound_intents[0];
        assert_eq!(intent.destination, recipient.address);
        assert_eq!(intent.method_id, recipient.method_id);
        assert_eq!(intent.fuel_fee_shells, recipient.reserve_shells);
        assert_eq!(intent.value_main, 0);
        assert!(intent.body.is_empty());
        assert_eq!(intent.extra.len(), 1);
        assert_eq!(
            (intent.extra[0].currency_id, intent.extra[0].amount),
            (2, amount)
        );
        assert_eq!(next.revoked, before.revoked);
    } else {
        assert_eq!(key, before.owner_key);
        assert!(!before.owner_nonce_present || message.nonce > before.owner_nonce);
        assert!(next.owner_nonce_present);
        assert_eq!(next.owner_nonce, message.nonce);
        assert_eq!(
            (next.agent_nonce_present, next.agent_nonce),
            (before.agent_nonce_present, before.agent_nonce)
        );
        assert_eq!(next.spent, before.spent);
        match message.method_id {
            REVOKE_METHOD_ID => {
                assert!(!before.revoked && next.revoked);
                assert!(output.outbound_intents.is_empty());
            }
            INSPECT_METHOD_ID => {
                assert_eq!(next.revoked, before.revoked);
                assert!(output.outbound_intents.is_empty());
            }
            WITHDRAW_METHOD_ID => {
                assert!(before.revoked || input.context.block_time >= before.expires_at);
                assert_eq!(next.revoked, before.revoked);
                assert_eq!(output.outbound_intents.len(), 1);
            }
            _ => panic!("unsupported method accepted"),
        }
    }
});
