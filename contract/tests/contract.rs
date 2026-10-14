use ackivault::abi::{DEPOSIT_METHOD_ID, PAY_METHOD_ID, REVOKE_METHOD_ID, WITHDRAW_METHOD_ID};
use ackivault::state::decode_state;
use ackivault::AckiVault;
use avm_contract_sdk::{
    decode_message_input, Contract, CurrencyAmount, MessageOutput, StateUpdate,
};

#[allow(dead_code)]
mod support;
use support::*;

fn process(bytes: &[u8]) -> MessageOutput {
    let input = decode_message_input(bytes).expect("canonical fixture");
    AckiVault::process_message(input)
}

fn assert_effect_free(output: MessageOutput) {
    assert_ne!(output.status_code, 0);
    assert!(output.state_update.is_none());
    assert!(output.outbound_intents.is_empty());
    assert!(output.event_intents.is_empty());
    assert!(output.callback_intents.is_empty());
}

#[test]
fn funded_spent_grant_keeps_its_cap_and_rejects_active_owner_withdrawal() {
    let payment = process(&external_input(
        [2; 32],
        0,
        PAY_METHOD_ID,
        &pay_args(95),
        &vault_state(),
        99,
        100,
        0,
        0,
    ));
    assert_eq!(payment.status_code, 0);
    let Some(StateUpdate::FullReplace(spent)) = payment.state_update else {
        panic!("accepted payment must persist the exhausted cap");
    };
    let deposit = process(&internal_input(DEPOSIT_METHOD_ID, &[], &spent, 100, 0));
    assert_eq!(deposit.status_code, 0);
    assert_eq!(
        deposit.state_update,
        Some(StateUpdate::FullReplace(spent.clone()))
    );
    let payment = process(&external_input(
        [2; 32],
        1,
        PAY_METHOD_ID,
        &pay_args(1),
        &spent,
        99,
        100,
        0,
        0,
    ));
    assert_eq!(payment.status_code, 1024);
    assert_effect_free(payment);
    let recovery = process(&external_input(
        [1; 32],
        0,
        WITHDRAW_METHOD_ID,
        &withdraw_args(),
        &spent,
        99,
        100,
        0,
        0,
    ));
    assert_eq!(recovery.status_code, 1019);
    assert_effect_free(recovery);
    let expired = process(&external_input(
        [1; 32],
        0,
        WITHDRAW_METHOD_ID,
        &withdraw_args(),
        &spent,
        100,
        100,
        0,
        0,
    ));
    assert_eq!(expired.status_code, 0);
    let Some(StateUpdate::FullReplace(recovered)) = expired.state_update else {
        panic!("expired owner recovery must persist state");
    };
    assert_eq!(
        decode_state(&recovered).expect("canonical state").spent,
        100
    );
}

#[test]
fn malformed_state_cannot_produce_any_effects_even_for_deposits() {
    let state = vault_state();
    for length in 0..state.len() {
        assert_effect_free(process(&external_input(
            [2; 32],
            0,
            PAY_METHOD_ID,
            &pay_args(1),
            &state[..length],
            99,
            100,
            0,
            0,
        )));
        assert_effect_free(process(&internal_input(
            DEPOSIT_METHOD_ID,
            &[],
            &state[..length],
            20,
            0,
        )));
    }
}

#[test]
fn owner_inspection_reports_balance_and_only_advances_owner_nonce() {
    let original = vault_state();
    let output = process(&external_input(
        [1; 32],
        7,
        0xa228_6cd9_2c4d_5aac,
        &[],
        &original,
        99,
        1234,
        0,
        0,
    ));
    assert_eq!(output.status_code, 0);
    let Some(StateUpdate::FullReplace(bytes)) = output.state_update else {
        panic!("inspection must persist the owner nonce");
    };
    let mut expected = decode_state(&original).expect("valid original state");
    expected.owner_nonce_present = true;
    expected.owner_nonce = 7;
    assert_eq!(
        decode_state(&bytes).expect("valid inspected state"),
        expected
    );
    assert!(output.outbound_intents.is_empty());
    assert_eq!(output.event_intents.len(), 1);
    assert_eq!(output.event_intents[0].event_class, 0xd8b9_dbed_dc52_09b2);
    assert_eq!(output.event_intents[0].event_name, "ackivault.status");
    let mut fields = vec![1, 0, 0, 0, 14, 0, 4, 16, 0];
    fields.extend_from_slice(b"balance_shells");
    fields.extend_from_slice(&1234_u128.to_le_bytes());
    assert_eq!(output.event_intents[0].fields_binary, fields);

    for (key, nonce, body, status) in [
        ([2; 32], 8, &[][..], 1013),
        ([1; 32], 7, &[][..], 1015),
        ([1; 32], 6, &[][..], 1015),
        ([1; 32], 8, &[1][..], 1000),
    ] {
        let rejected = process(&external_input(
            key,
            nonce,
            0xa228_6cd9_2c4d_5aac,
            body,
            &bytes,
            99,
            1234,
            0,
            0,
        ));
        assert_eq!(rejected.status_code, status);
        assert_effect_free(rejected);
    }
    let revoked = process(&external_input(
        [1; 32],
        8,
        REVOKE_METHOD_ID,
        &[],
        &bytes,
        99,
        1234,
        0,
        0,
    ));
    assert_eq!(revoked.status_code, 0);
}

#[test]
fn signed_external_initialization_sets_owner_and_grant() {
    let frame = deployment_input([1; 32], &deployment_body(b"", b"main", &init_args()), 10);
    let input = decode_message_input(&frame).expect("canonical signed deployment");
    let output = AckiVault::init(input);

    assert_eq!(output.status_code, 0);
    let Some(StateUpdate::FullReplace(bytes)) = output.state_update else {
        panic!("initialization must replace state");
    };
    let state = decode_state(&bytes).expect("valid state");
    assert_eq!(state.owner_key, [1; 32]);
    assert_eq!(state.agent_key, [2; 32]);
    assert_eq!(state.cap, 100);
}

#[test]
fn named_deployment_initializes_the_requested_grant() {
    let body = deployment_body(b"ackivault", b"main", &init_args());
    let frame = deployment_input([1; 32], &body, 10);
    let output = AckiVault::init(decode_message_input(&frame).expect("canonical deployment"));

    assert_eq!(output.status_code, 0);
    let Some(StateUpdate::FullReplace(bytes)) = output.state_update else {
        panic!("initialization must replace state");
    };
    let state = decode_state(&bytes).expect("valid state");
    assert_eq!(state.agent_key, [2; 32]);
    assert_eq!(state.cap, 100);
}

#[test]
fn deployment_using_published_code_accepts_arguments_without_inline_artifacts() {
    let mut body = deployment_body(b"", b"main", &init_args());
    body.truncate(body.len() - 4);
    let frame = deployment_input([1; 32], &body, 10);
    let output = AckiVault::init(decode_message_input(&frame).expect("canonical deployment"));

    assert_eq!(output.status_code, 0);
    let Some(StateUpdate::FullReplace(bytes)) = output.state_update else {
        panic!("initialization must replace state");
    };
    assert_eq!(decode_state(&bytes).expect("valid state").cap, 100);
}

#[test]
fn deployment_rejects_raw_or_malformed_envelopes() {
    let args = init_args();
    assert_effect_free(AckiVault::init(
        decode_message_input(&deployment_input([1; 32], &args, 10)).expect("canonical frame"),
    ));
    let mut malformed = deployment_body(b"", b"main", &args);
    malformed[266..268].copy_from_slice(&u16::MAX.to_le_bytes());
    assert_effect_free(AckiVault::init(
        decode_message_input(&deployment_input([1; 32], &malformed, 10)).expect("canonical frame"),
    ));
    let mut malformed = deployment_body(b"", b"main", &args);
    malformed[264..266].copy_from_slice(&u16::MAX.to_le_bytes());
    assert_effect_free(AckiVault::init(
        decode_message_input(&deployment_input([1; 32], &malformed, 10)).expect("canonical frame"),
    ));
}

#[test]
fn internal_shell_deposit_emits_acceptance_without_spending() {
    let initial = vault_state();
    let output = process(&internal_input(DEPOSIT_METHOD_ID, &[], &initial, 20, 0));

    assert_eq!(output.status_code, 0);
    assert!(output.outbound_intents.is_empty());
    assert_eq!(output.event_intents.len(), 1);
    assert_eq!(
        output.event_intents[0].event_name,
        "ackivault.deposit_accepted"
    );
    assert_eq!(output.state_update, Some(StateUpdate::FullReplace(initial)));
}

#[test]
fn agent_payment_dispatches_only_shell_to_immutable_recipient() {
    let frame = external_input(
        [2; 32],
        0,
        PAY_METHOD_ID,
        &pay_args(10),
        &vault_state(),
        99,
        100,
        0,
        0,
    );
    let output = process(&frame);

    assert_eq!(output.status_code, 0);
    let Some(StateUpdate::FullReplace(bytes)) = &output.state_update else {
        panic!("payment must replace state");
    };
    assert_eq!(decode_state(bytes).expect("valid state").spent, 15);
    assert_eq!(output.outbound_intents.len(), 1);
    let outbound = &output.outbound_intents[0];
    assert_eq!(outbound.destination, address(3, 4));
    assert_eq!(outbound.method_id, 7);
    assert_eq!(outbound.value_main, 0);
    assert_eq!(outbound.fuel_fee_shells, 5);
    assert_eq!(
        outbound.extra,
        vec![CurrencyAmount {
            currency_id: 2,
            amount: 10
        }]
    );
    assert!(outbound.body.is_empty());
    assert_eq!(
        output.event_intents[0].event_name,
        "ackivault.payment_dispatched"
    );
}

#[test]
fn replayed_agent_nonce_is_effect_free_after_accepted_payment() {
    let first = process(&external_input(
        [2; 32],
        7,
        PAY_METHOD_ID,
        &pay_args(10),
        &vault_state(),
        99,
        100,
        0,
        0,
    ));
    assert_eq!(first.status_code, 0);
    let Some(StateUpdate::FullReplace(state)) = first.state_update else {
        panic!("accepted payment must replace state");
    };
    let replay = process(&external_input(
        [2; 32],
        7,
        PAY_METHOD_ID,
        &pay_args(10),
        &state,
        99,
        100,
        0,
        0,
    ));
    assert_eq!(replay.status_code, 1014);
    assert_effect_free(replay);
}

#[test]
fn rejected_messages_have_no_state_or_outbound_effects() {
    let state = vault_state();
    assert_effect_free(process(&external_input(
        [9; 32],
        0,
        PAY_METHOD_ID,
        &pay_args(10),
        &state,
        99,
        100,
        0,
        0,
    )));
    assert_effect_free(process(&external_input(
        [2; 32],
        0,
        PAY_METHOD_ID,
        &pay_args(10),
        &state,
        99,
        100,
        1,
        0,
    )));
    assert_effect_free(process(&external_input(
        [2; 32],
        0,
        PAY_METHOD_ID,
        &pay_args(10),
        &state,
        99,
        100,
        0,
        1,
    )));
    assert_effect_free(process(&external_input(
        [2; 32],
        0,
        PAY_METHOD_ID,
        &[0],
        &state,
        99,
        100,
        0,
        0,
    )));
    assert_effect_free(process(&internal_input(
        PAY_METHOD_ID,
        &pay_args(10),
        &state,
        10,
        0,
    )));
    assert_effect_free(process(&external_input(
        [1; 32],
        0,
        DEPOSIT_METHOD_ID,
        &[],
        &state,
        99,
        100,
        0,
        0,
    )));
    assert_effect_free(process(&internal_input(
        DEPOSIT_METHOD_ID,
        &[],
        &state,
        20,
        1,
    )));
}

#[test]
fn owner_revoke_and_withdraw_dispatch_without_changing_agent_spent() {
    let revoke_frame = external_input(
        [1; 32],
        0,
        REVOKE_METHOD_ID,
        &[],
        &vault_state(),
        99,
        100,
        0,
        0,
    );
    let revoke_output = process(&revoke_frame);
    assert_eq!(revoke_output.status_code, 0);
    let Some(StateUpdate::FullReplace(revoked_bytes)) = revoke_output.state_update else {
        panic!("revocation must replace state");
    };
    assert!(decode_state(&revoked_bytes).expect("valid state").revoked);
    assert_effect_free(process(&external_input(
        [2; 32],
        0,
        PAY_METHOD_ID,
        &pay_args(10),
        &revoked_bytes,
        99,
        100,
        0,
        0,
    )));

    let withdrawal = external_input(
        [1; 32],
        1,
        WITHDRAW_METHOD_ID,
        &withdraw_args(),
        &revoked_bytes,
        99,
        100,
        0,
        0,
    );
    let output = process(&withdrawal);
    assert_eq!(output.status_code, 0);
    let Some(StateUpdate::FullReplace(bytes)) = &output.state_update else {
        panic!("withdrawal must replace state");
    };
    assert_eq!(decode_state(bytes).expect("valid state").spent, 0);
    assert_eq!(output.outbound_intents.len(), 1);
    assert_eq!(output.outbound_intents[0].destination, address(6, 7));
    assert_eq!(
        output.outbound_intents[0].extra,
        vec![CurrencyAmount {
            currency_id: 2,
            amount: 10
        }]
    );
    assert_eq!(
        output.event_intents[0].event_name,
        "ackivault.owner_withdrawal_dispatched"
    );
}
