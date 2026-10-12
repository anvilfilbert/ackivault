#![forbid(unsafe_code)]

use avm_contract_sdk::{Contract, MessageInput, MessageOutput};

pub mod abi;
mod adapter;
pub mod grant;
pub mod initialization;
pub mod state;

pub struct AckiVault;

impl Contract for AckiVault {
    fn init(input: MessageInput<'_>) -> MessageOutput {
        adapter::initialize(input)
    }

    fn process_message(input: MessageInput<'_>) -> MessageOutput {
        adapter::process_message(input)
    }
}

avm_contract_sdk::export_message_contract!(AckiVault, arena_bytes = 262_144);
