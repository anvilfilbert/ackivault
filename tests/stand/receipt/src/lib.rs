#![forbid(unsafe_code)]

use avm_contract_sdk::{
    encode_event_fields, AccountAddress, Caller, CanonicalMessage, Contract, CurrencyAmount,
    EventField, EventIntent, EventKind, EventValue, MessageInput, MessageOutput, OutboundIntent,
    StateUpdate,
};

const STATE_BYTES: usize = 24;
const DEPOSIT_METHOD_ID: u64 = 0xe940_cf11_4abd_d07a;
const FORWARD_DEPOSIT_METHOD_ID: u64 = 0x453c_5457_6719_a1b4;
const SNAPSHOT_METHOD_ID: u64 = 0x7a92_36e9_9b7a_e9dd;
const DEPOSIT_RECEIVED_EVENT_CLASS: u64 = 0x1b72_8f6b_f27d_9c25;
const SHELL_CURRENCY_ID: u32 = 2;

struct Receipt;

impl Contract for Receipt {
    fn init(_input: MessageInput<'_>) -> MessageOutput {
        MessageOutput::success(StateUpdate::FullReplace(vec![0; STATE_BYTES]))
    }

    fn process_message(input: MessageInput<'_>) -> MessageOutput {
        if input.state.len() != STATE_BYTES {
            return MessageOutput::failure(1000);
        }
        match input.message.method_id() {
            DEPOSIT_METHOD_ID => receive_deposit(input),
            FORWARD_DEPOSIT_METHOD_ID => forward_deposit(input),
            SNAPSHOT_METHOD_ID => snapshot(input),
            _ => MessageOutput::failure(1000),
        }
    }
}

fn receive_deposit(input: MessageInput<'_>) -> MessageOutput {
    let (Caller::Internal(_), CanonicalMessage::Internal(message)) = (input.caller, input.message)
    else {
        return MessageOutput::failure(1001);
    };
    if message.value_main != 0 || !message.body.is_empty() {
        return MessageOutput::failure(1002);
    }
    let mut extra = message.extra.iter();
    let Some(currency) = extra.next() else {
        return MessageOutput::failure(1003);
    };
    if currency.currency_id != SHELL_CURRENCY_ID || currency.amount == 0 || extra.next().is_some() {
        return MessageOutput::failure(1003);
    }
    let Ok(received_bytes) = input.state[..16].try_into() else {
        return MessageOutput::failure(1000);
    };
    let Ok(count_bytes) = input.state[16..24].try_into() else {
        return MessageOutput::failure(1000);
    };
    let received = u128::from_le_bytes(received_bytes);
    let count = u64::from_le_bytes(count_bytes);
    let Some(next_received) = received.checked_add(currency.amount) else {
        return MessageOutput::failure(1004);
    };
    let Some(next_count) = count.checked_add(1) else {
        return MessageOutput::failure(1004);
    };
    let mut state = input.state.to_vec();
    state[..16].copy_from_slice(&next_received.to_le_bytes());
    state[16..24].copy_from_slice(&next_count.to_le_bytes());
    let Ok(fields_binary) = encode_event_fields(&[
        EventField {
            name: "receipt_count".into(),
            value: EventValue::U64(next_count),
        },
        EventField {
            name: "received_shells".into(),
            value: EventValue::U128(next_received),
        },
    ]) else {
        return MessageOutput::failure(1005);
    };
    let mut output = MessageOutput::success(StateUpdate::FullReplace(state));
    output.event_intents = vec![EventIntent {
        input_index: 0,
        kind: EventKind::External,
        event_class: DEPOSIT_RECEIVED_EVENT_CLASS,
        event_name: "stand.deposit_received".into(),
        topics: Vec::new(),
        fields_binary,
    }];
    output
}

fn forward_deposit(input: MessageInput<'_>) -> MessageOutput {
    let (Caller::External(_), CanonicalMessage::External(message)) = (input.caller, input.message)
    else {
        return MessageOutput::failure(1001);
    };
    if message.body.len() != 64 || message.value_main != 0 || !message.extra.is_empty() {
        return MessageOutput::failure(1002);
    }
    let Ok(dapp_id) = message.body[..32].try_into() else {
        return MessageOutput::failure(1002);
    };
    let Ok(account_id) = message.body[32..64].try_into() else {
        return MessageOutput::failure(1002);
    };
    let destination = AccountAddress {
        dapp_id,
        account_id,
    };
    if destination.dapp_id == [0; 32] || destination.account_id == [0; 32] {
        return MessageOutput::failure(1002);
    }
    let mut output = MessageOutput::success(StateUpdate::FullReplace(input.state.to_vec()));
    output.outbound_intents = vec![OutboundIntent {
        input_index: 0,
        destination,
        value_main: 0,
        fuel_fee_shells: 0,
        extra: vec![CurrencyAmount {
            currency_id: SHELL_CURRENCY_ID,
            amount: 100,
        }],
        method_id: DEPOSIT_METHOD_ID,
        body: Vec::new(),
    }];
    output
}

fn snapshot(input: MessageInput<'_>) -> MessageOutput {
    let (Caller::External(_), CanonicalMessage::External(message)) = (input.caller, input.message)
    else {
        return MessageOutput::failure(1001);
    };
    if !message.body.is_empty() || message.value_main != 0 || !message.extra.is_empty() {
        return MessageOutput::failure(1002);
    }
    MessageOutput::success(StateUpdate::FullReplace(input.state.to_vec()))
}

avm_contract_sdk::export_message_contract!(Receipt, arena_bytes = 262_144);
