use std::fmt;

#[derive(Clone, Copy)]
struct Address {
    dapp_id: [u8; 32],
    account_id: [u8; 32],
}

fn encode_init(
    agent_key: [u8; 32],
    expires_at: u32,
    cap: u128,
    recipient: Address,
    method_id: u64,
    reserve_shells: u128,
) -> [u8; 405] {
    let mut bytes = [0_u8; 405];
    bytes[..32].copy_from_slice(&agent_key);
    bytes[32..36].copy_from_slice(&expires_at.to_le_bytes());
    bytes[36..52].copy_from_slice(&cap.to_le_bytes());
    bytes[52] = 1;
    bytes[53..85].copy_from_slice(&recipient.dapp_id);
    bytes[85..117].copy_from_slice(&recipient.account_id);
    bytes[117..125].copy_from_slice(&method_id.to_le_bytes());
    bytes[125..141].copy_from_slice(&reserve_shells.to_le_bytes());
    bytes
}

#[derive(Debug)]
enum ArgError {
    Usage,
    InvalidHex(&'static str),
    InvalidNumber(&'static str),
    InvalidValue(&'static str),
}

impl fmt::Display for ArgError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Usage => write!(formatter, "usage: stand-args <agent-hex> <expiry-u32> <cap-u128> <dapp-hex:account-hex> <method-u64> <reserve-u128>"),
            Self::InvalidHex(field) => write!(formatter, "{field} must contain exactly 64 hexadecimal digits"),
            Self::InvalidNumber(field) => write!(formatter, "{field} must be a valid unsigned decimal integer"),
            Self::InvalidValue(field) => write!(formatter, "{field} must be nonzero"),
        }
    }
}

fn parse_hex_32(value: &str, field: &'static str) -> Result<[u8; 32], ArgError> {
    if value.len() != 64 || !value.is_ascii() {
        return Err(ArgError::InvalidHex(field));
    }
    let mut bytes = [0_u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        let start = index * 2;
        *byte = u8::from_str_radix(&value[start..start + 2], 16)
            .map_err(|_| ArgError::InvalidHex(field))?;
    }
    Ok(bytes)
}

fn parse_address(value: &str) -> Result<Address, ArgError> {
    let (dapp_id, account_id) = value
        .split_once(':')
        .ok_or(ArgError::InvalidHex("recipient"))?;
    let dapp_id = parse_hex_32(dapp_id, "recipient DApp id")?;
    let account_id = parse_hex_32(account_id, "recipient account id")?;
    if dapp_id == [0; 32] || account_id == [0; 32] {
        return Err(ArgError::InvalidValue("recipient address"));
    }
    Ok(Address {
        dapp_id,
        account_id,
    })
}

fn run() -> Result<String, ArgError> {
    let args: Vec<String> = std::env::args().collect();
    let [_, agent, expiry, cap, recipient, method, reserve] = args.as_slice() else {
        return Err(ArgError::Usage);
    };
    let agent_key = parse_hex_32(agent, "agent key")?;
    if agent_key == [0; 32] {
        return Err(ArgError::InvalidValue("agent key"));
    }
    let expires_at = expiry
        .parse::<u32>()
        .map_err(|_| ArgError::InvalidNumber("expiry"))?;
    let cap = cap
        .parse::<u128>()
        .map_err(|_| ArgError::InvalidNumber("cap"))?;
    if cap == 0 {
        return Err(ArgError::InvalidValue("cap"));
    }
    let recipient = parse_address(recipient)?;
    let method_id = method
        .parse::<u64>()
        .map_err(|_| ArgError::InvalidNumber("method"))?;
    if method_id == 0 {
        return Err(ArgError::InvalidValue("method"));
    }
    let reserve_shells = reserve
        .parse::<u128>()
        .map_err(|_| ArgError::InvalidNumber("reserve"))?;
    let bytes = encode_init(
        agent_key,
        expires_at,
        cap,
        recipient,
        method_id,
        reserve_shells,
    );
    let mut encoded = String::from("\"0x");
    for byte in bytes {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded.push('"');
    Ok(encoded)
}

fn main() {
    match run() {
        Ok(encoded) => println!("{encoded}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{encode_init, Address};

    #[test]
    fn init_bytes_encode_one_fixed_recipient_and_zero_unused_slots() {
        let bytes = encode_init(
            [2; 32],
            0x0102_0304,
            1_000,
            Address {
                dapp_id: [3; 32],
                account_id: [4; 32],
            },
            7,
            5,
        );

        assert_eq!(&bytes[..32], &[2; 32]);
        assert_eq!(&bytes[32..36], &[4, 3, 2, 1]);
        assert_eq!(&bytes[36..38], &[0xe8, 0x03]);
        assert_eq!(bytes[52], 1);
        assert_eq!(&bytes[53..85], &[3; 32]);
        assert_eq!(&bytes[85..117], &[4; 32]);
        assert_eq!(bytes[117], 7);
        assert_eq!(bytes[125], 5);
        assert!(bytes[141..].iter().all(|byte| *byte == 0));
    }
}
