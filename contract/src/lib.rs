#![forbid(unsafe_code)]

use avm_contract_sdk::{Contract, MessageInput, MessageOutput};

pub mod abi;
pub mod grant;
pub mod initialization;
pub mod state;

struct AckiVault;

impl Contract for AckiVault {
    fn init(_input: MessageInput<'_>) -> MessageOutput {
        MessageOutput::failure(1000)
    }

    fn process_message(_input: MessageInput<'_>) -> MessageOutput {
        MessageOutput::failure(1001)
    }
}

avm_contract_sdk::export_message_contract!(AckiVault, arena_bytes = 262_144);
