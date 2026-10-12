#![forbid(unsafe_code)]

use avm_contract_sdk::{
    Caller, CanonicalMessage, Contract, MessageInput, MessageOutput, StateUpdate,
};

const STATE_BYTES: usize = 160;
const DEPOSIT_METHOD_ID: u64 = 0xe940_cf11_4abd_d07a;
const SHELL_CURRENCY_ID: u32 = 2;

struct Receipt;

impl Contract for Receipt {
    fn init(input: MessageInput<'_>) -> MessageOutput {
        let Ok(body_len) = u32::try_from(input.message.body().len()) else {
            return MessageOutput::failure(1);
        };
        let Ok(state_len) = u32::try_from(input.state.len()) else {
            return MessageOutput::failure(1);
        };
        let mut state = vec![0_u8; STATE_BYTES];
        state[2] = u8::from(input.message.is_deploy());
        state[4..8].copy_from_slice(&body_len.to_le_bytes());
        state[8..12].copy_from_slice(&state_len.to_le_bytes());
        state[12..16].copy_from_slice(&input.context.block_time.to_le_bytes());
        match input.caller {
            Caller::External(key) => {
                state[0] = 1;
                state[16..48].copy_from_slice(&key);
            }
            Caller::Internal(address) => {
                state[0] = 2;
                state[16..48].copy_from_slice(&address.account_id);
            }
        }
        match input.message {
            CanonicalMessage::External(message) => {
                state[1] = 1;
                state[3] = message.flags;
                state[48..80].copy_from_slice(&message.pubkey);
                state[80..88].copy_from_slice(&(message.signature.len() as u64).to_le_bytes());
                state[88..104].copy_from_slice(&message.value_main.to_le_bytes());
                let prefix_len = message.body.len().min(16);
                state[104..104 + prefix_len].copy_from_slice(&message.body[..prefix_len]);
                state[120] = u8::from(message.extra.iter().next().is_some());
            }
            CanonicalMessage::Internal(message) => {
                state[1] = 2;
                state[3] = message.flags;
                state[88..104].copy_from_slice(&message.value_main.to_le_bytes());
                let prefix_len = message.body.len().min(16);
                state[104..104 + prefix_len].copy_from_slice(&message.body[..prefix_len]);
                state[120] = u8::from(message.extra.iter().next().is_some());
            }
        }
        MessageOutput::success(StateUpdate::FullReplace(state))
    }

    fn process_message(input: MessageInput<'_>) -> MessageOutput {
        if input.state.len() != STATE_BYTES || input.message.method_id() != DEPOSIT_METHOD_ID {
            return MessageOutput::failure(1);
        }
        let (Caller::Internal(_), CanonicalMessage::Internal(message)) =
            (input.caller, input.message)
        else {
            return MessageOutput::failure(2);
        };
        if message.value_main != 0 || !message.body.is_empty() {
            return MessageOutput::failure(3);
        }
        let mut extra = message.extra.iter();
        let Some(currency) = extra.next() else {
            return MessageOutput::failure(4);
        };
        if currency.currency_id != SHELL_CURRENCY_ID
            || currency.amount == 0
            || extra.next().is_some()
        {
            return MessageOutput::failure(4);
        }
        let Ok(received_bytes) = input.state[128..144].try_into() else {
            return MessageOutput::failure(1);
        };
        let Ok(count_bytes) = input.state[144..152].try_into() else {
            return MessageOutput::failure(1);
        };
        let received = u128::from_le_bytes(received_bytes);
        let count = u64::from_le_bytes(count_bytes);
        let Some(next_received) = received.checked_add(currency.amount) else {
            return MessageOutput::failure(5);
        };
        let Some(next_count) = count.checked_add(1) else {
            return MessageOutput::failure(5);
        };
        let mut state = input.state.to_vec();
        state[128..144].copy_from_slice(&next_received.to_le_bytes());
        state[144..152].copy_from_slice(&next_count.to_le_bytes());
        MessageOutput::success(StateUpdate::FullReplace(state))
    }
}

avm_contract_sdk::export_message_contract!(Receipt, arena_bytes = 262_144);
