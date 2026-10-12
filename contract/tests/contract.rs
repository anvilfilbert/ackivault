use ackivault::abi::{DEPOSIT_METHOD_ID, PAY_METHOD_ID, REVOKE_METHOD_ID, WITHDRAW_METHOD_ID};
use ackivault::initialization::initialize;
use ackivault::state::{decode_state, encode_state};
use ackivault::AckiVault;
use avm_contract_sdk::{
    decode_message_input, AccountAddress, Contract, CurrencyAmount, MessageOutput, StateUpdate,
};

fn address(dapp: u8, account: u8) -> AccountAddress {
    AccountAddress {
        dapp_id: [dapp; 32],
        account_id: [account; 32],
    }
}

fn init_args() -> [u8; 405] {
    let mut args = [0_u8; 405];
    args[..32].fill(2);
    args[32..36].copy_from_slice(&100_u32.to_le_bytes());
    args[36..52].copy_from_slice(&100_u128.to_le_bytes());
    args[52] = 1;
    args[53..85].fill(3);
    args[85..117].fill(4);
    args[117..125].copy_from_slice(&7_u64.to_le_bytes());
    args[125..141].copy_from_slice(&5_u128.to_le_bytes());
    args
}

fn vault_state() -> Vec<u8> {
    let state = initialize([1; 32], &init_args(), 10).expect("valid local state");
    encode_state(&state).expect("valid local encoding")
}

fn balance_bytes(balance_shells: u128) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&2_u32.to_le_bytes());
    bytes.extend_from_slice(&balance_shells.to_le_bytes());
    bytes
}

fn external_input(
    key: [u8; 32],
    nonce: u64,
    method_id: u64,
    body: &[u8],
    state: &[u8],
    block_time: u32,
    balance_shells: u128,
    value_main: u128,
    incoming_shells: u128,
) -> Vec<u8> {
    let destination = address(8, 9);
    let mut message = vec![0_u8; 208];
    message[0] = 1;
    message[1] = 1;
    message[2..4].copy_from_slice(&u16::from(incoming_shells > 0).to_le_bytes());
    message[4..8].copy_from_slice(&(body.len() as u32).to_le_bytes());
    message[8..16].copy_from_slice(&method_id.to_le_bytes());
    message[16..32].copy_from_slice(&value_main.to_le_bytes());
    message[32..48].copy_from_slice(&100_u128.to_le_bytes());
    message[48..56].copy_from_slice(&nonce.to_le_bytes());
    message[56..60].copy_from_slice(&(block_time - 1).to_le_bytes());
    message[60..64].copy_from_slice(&(block_time + 100).to_le_bytes());
    message[64..96].copy_from_slice(&destination.dapp_id);
    message[96..128].copy_from_slice(&destination.account_id);
    message[128..160].copy_from_slice(&key);
    message[160..162].copy_from_slice(&64_u16.to_le_bytes());
    if incoming_shells > 0 {
        message.extend_from_slice(&2_u32.to_le_bytes());
        message.extend_from_slice(&incoming_shells.to_le_bytes());
    }
    message.extend_from_slice(body);
    message.extend_from_slice(&[0xaa; 64]);

    let mut input = Vec::new();
    input.extend_from_slice(b"ACMI");
    input.extend_from_slice(&9_u64.to_le_bytes());
    input.extend_from_slice(&block_time.to_le_bytes());
    input.extend_from_slice(&11_u32.to_le_bytes());
    input.extend_from_slice(&[0x12; 32]);
    input.push(1);
    input.extend_from_slice(&[0; 7 + 64]);
    input.extend_from_slice(&key);
    input.extend_from_slice(&destination.dapp_id);
    input.extend_from_slice(&destination.account_id);
    input.extend_from_slice(&[0x44; 32]);
    input.push(0);
    input.extend_from_slice(&[0; 7]);
    input.extend_from_slice(&0_u128.to_le_bytes());
    input.extend_from_slice(&balance_bytes(balance_shells));
    input.extend_from_slice(&(state.len() as u32).to_le_bytes());
    input.extend_from_slice(state);
    input.extend_from_slice(&(message.len() as u32).to_le_bytes());
    input.extend_from_slice(&message);
    input.extend_from_slice(&0_u32.to_le_bytes());
    input
}

fn deployment_input(key: [u8; 32], body: &[u8], block_time: u32) -> Vec<u8> {
    let mut input = external_input(key, 0, 0, body, &[], block_time, 0, 0, 0);
    let message_offset = input.len() - 208 - body.len() - 64 - 4;
    input[message_offset + 1] = 3;
    input
}

fn deployment_body(salt: &[u8], args: &[u8]) -> Vec<u8> {
    let mut body = vec![0_u8; 288];
    body[..4].copy_from_slice(b"ACDP");
    body[266..268].copy_from_slice(&(salt.len() as u16).to_le_bytes());
    body[268..272].copy_from_slice(&(args.len() as u32).to_le_bytes());
    body.extend_from_slice(salt);
    body.extend_from_slice(args);
    body.extend_from_slice(b"\0asm");
    body
}

fn internal_input(
    method_id: u64,
    body: &[u8],
    state: &[u8],
    shell_amount: u128,
    value_main: u128,
) -> Vec<u8> {
    let source = address(6, 7);
    let destination = address(8, 9);
    let mut message = vec![0_u8; 192];
    message[0] = 0;
    message[2..4].copy_from_slice(&1_u16.to_le_bytes());
    message[4..8].copy_from_slice(&(body.len() as u32).to_le_bytes());
    message[8..16].copy_from_slice(&method_id.to_le_bytes());
    message[16..32].copy_from_slice(&value_main.to_le_bytes());
    message[48..56].copy_from_slice(&1_u64.to_le_bytes());
    message[56..60].copy_from_slice(&10_u32.to_le_bytes());
    message[64..96].copy_from_slice(&source.dapp_id);
    message[96..128].copy_from_slice(&source.account_id);
    message[128..160].copy_from_slice(&destination.dapp_id);
    message[160..192].copy_from_slice(&destination.account_id);
    message.extend_from_slice(&2_u32.to_le_bytes());
    message.extend_from_slice(&shell_amount.to_le_bytes());
    message.extend_from_slice(body);

    let mut input = Vec::new();
    input.extend_from_slice(b"ACMI");
    input.extend_from_slice(&9_u64.to_le_bytes());
    input.extend_from_slice(&10_u32.to_le_bytes());
    input.extend_from_slice(&11_u32.to_le_bytes());
    input.extend_from_slice(&[0x12; 32]);
    input.push(0);
    input.extend_from_slice(&[0; 7]);
    input.extend_from_slice(&source.dapp_id);
    input.extend_from_slice(&source.account_id);
    input.extend_from_slice(&[0; 32]);
    input.extend_from_slice(&destination.dapp_id);
    input.extend_from_slice(&destination.account_id);
    input.extend_from_slice(&[0x44; 32]);
    input.push(0);
    input.extend_from_slice(&[0; 7]);
    input.extend_from_slice(&0_u128.to_le_bytes());
    input.extend_from_slice(&balance_bytes(shell_amount));
    input.extend_from_slice(&(state.len() as u32).to_le_bytes());
    input.extend_from_slice(state);
    input.extend_from_slice(&(message.len() as u32).to_le_bytes());
    input.extend_from_slice(&message);
    input.extend_from_slice(&0_u32.to_le_bytes());
    input
}

fn pay_args(amount: u128) -> [u8; 17] {
    let mut args = [0_u8; 17];
    args[1..].copy_from_slice(&amount.to_le_bytes());
    args
}

fn withdraw_args() -> [u8; 104] {
    let mut args = [0_u8; 104];
    args[..32].fill(6);
    args[32..64].fill(7);
    args[64..72].copy_from_slice(&9_u64.to_le_bytes());
    args[72..88].copy_from_slice(&2_u128.to_le_bytes());
    args[88..104].copy_from_slice(&10_u128.to_le_bytes());
    args
}

fn process(bytes: &[u8]) -> MessageOutput {
    let input = decode_message_input(bytes).expect("canonical fixture");
    AckiVault::process_message(input)
}

fn assert_effect_free(output: MessageOutput) {
    assert_ne!(output.status_code, 0);
    assert!(output.state_update.is_none());
    assert!(output.outbound_intents.is_empty());
    assert!(output.event_intents.is_empty());
}

#[test]
fn signed_external_initialization_sets_owner_and_grant() {
    let frame = deployment_input([1; 32], &deployment_body(b"main", &init_args()), 10);
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
fn deployment_rejects_raw_or_malformed_envelopes() {
    let args = init_args();
    assert_effect_free(AckiVault::init(
        decode_message_input(&deployment_input([1; 32], &args, 10)).expect("canonical frame"),
    ));
    let mut malformed = deployment_body(b"main", &args);
    malformed[266..268].copy_from_slice(&u16::MAX.to_le_bytes());
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
