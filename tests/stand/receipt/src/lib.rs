#![forbid(unsafe_code)]

use avm_contract_sdk::{
    encode_event_fields, Caller, CanonicalMessage, Contract, EventField, EventIntent, EventKind,
    EventValue, MessageInput, MessageOutput, StateUpdate,
};

const STATE_BYTES: usize = 24;
const DEPOSIT_METHOD_ID: u64 = 0xe940_cf11_4abd_d07a;
const INIT_PROBE_EVENT_CLASS: u64 = 0x363f_1a15_5926_06bd;
const SHELL_CURRENCY_ID: u32 = 2;

struct Receipt;

impl Contract for Receipt {
    fn init(input: MessageInput<'_>) -> MessageOutput {
        let body = input.message.body();
        let raw_offset = body.windows(32).position(|window| window == [0x55; 32]);
        let ascii_offset = body.windows(64).position(|window| window == [b'5'; 64]);
        let window_start = 0;
        let window_end = body.len().min(window_start + 192);
        let mut window = vec![0_u8; 192];
        window[..window_end - window_start].copy_from_slice(&body[window_start..window_end]);
        let Ok(body_len) = u64::try_from(body.len()) else {
            return MessageOutput::failure(1000);
        };
        let Ok(raw_offset) = u64::try_from(raw_offset.unwrap_or(usize::MAX)) else {
            return MessageOutput::failure(1000);
        };
        let Ok(ascii_offset) = u64::try_from(ascii_offset.unwrap_or(usize::MAX)) else {
            return MessageOutput::failure(1000);
        };
        let Ok(fields_binary) = encode_event_fields(&[
            EventField {
                name: "ascii_offset".into(),
                value: EventValue::U64(ascii_offset),
            },
            EventField {
                name: "body_len".into(),
                value: EventValue::U64(body_len),
            },
            EventField {
                name: "raw_offset".into(),
                value: EventValue::U64(raw_offset),
            },
            EventField {
                name: "window".into(),
                value: EventValue::Data(window),
            },
        ]) else {
            return MessageOutput::failure(1005);
        };
        let mut output = MessageOutput::success(StateUpdate::FullReplace(vec![0; STATE_BYTES]));
        output.event_intents = vec![EventIntent {
            input_index: 0,
            kind: EventKind::External,
            event_class: INIT_PROBE_EVENT_CLASS,
            event_name: "stand.init_probe".into(),
            topics: Vec::new(),
            fields_binary,
        }];
        output
    }

    fn process_message(input: MessageInput<'_>) -> MessageOutput {
        if input.state.len() != STATE_BYTES || input.message.method_id() != DEPOSIT_METHOD_ID {
            return MessageOutput::failure(1000);
        }
        let (Caller::Internal(_), CanonicalMessage::Internal(message)) =
            (input.caller, input.message)
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
        if currency.currency_id != SHELL_CURRENCY_ID
            || currency.amount == 0
            || extra.next().is_some()
        {
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
        MessageOutput::success(StateUpdate::FullReplace(state))
    }
}

avm_contract_sdk::export_message_contract!(Receipt, arena_bytes = 262_144);
