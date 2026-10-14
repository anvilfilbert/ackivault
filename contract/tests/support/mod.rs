use ackivault::initialization::initialize;
use ackivault::state::encode_state;
use avm_contract_sdk::AccountAddress;

pub fn address(dapp: u8, account: u8) -> AccountAddress {
    AccountAddress {
        dapp_id: [dapp; 32],
        account_id: [account; 32],
    }
}

pub fn init_args() -> [u8; 405] {
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

pub fn vault_state() -> Vec<u8> {
    let state = initialize([1; 32], &init_args(), 10).expect("valid local state");
    encode_state(&state).expect("valid local encoding")
}

pub fn balance_bytes(balance_shells: u128) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&2_u32.to_le_bytes());
    bytes.extend_from_slice(&balance_shells.to_le_bytes());
    bytes
}

pub fn external_input(
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

pub fn deployment_input(key: [u8; 32], body: &[u8], block_time: u32) -> Vec<u8> {
    let mut input = external_input(key, 0, 0, body, &[], block_time, 0, 0, 0);
    let message_offset = input.len() - 208 - body.len() - 64 - 4;
    input[message_offset + 1] = 3;
    input
}

pub fn deployment_body(name: &[u8], salt: &[u8], args: &[u8]) -> Vec<u8> {
    let mut body = vec![0_u8; 288];
    body[..4].copy_from_slice(b"ACDP");
    body[264..266].copy_from_slice(&u16::try_from(name.len()).expect("short name").to_le_bytes());
    body[266..268].copy_from_slice(&(salt.len() as u16).to_le_bytes());
    body[268..272].copy_from_slice(&(args.len() as u32).to_le_bytes());
    body.extend_from_slice(name);
    body.extend_from_slice(salt);
    body.extend_from_slice(args);
    body.extend_from_slice(b"\0asm");
    body
}

pub fn internal_input(
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

pub fn pay_args(amount: u128) -> [u8; 17] {
    let mut args = [0_u8; 17];
    args[1..].copy_from_slice(&amount.to_le_bytes());
    args
}

pub fn withdraw_args() -> [u8; 104] {
    let mut args = [0_u8; 104];
    args[..32].fill(6);
    args[32..64].fill(7);
    args[64..72].copy_from_slice(&9_u64.to_le_bytes());
    args[72..88].copy_from_slice(&2_u128.to_le_bytes());
    args[88..104].copy_from_slice(&10_u128.to_le_bytes());
    args
}
