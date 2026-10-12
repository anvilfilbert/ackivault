#[path = "../contract/src/abi.rs"]
mod abi;

use std::fs;
use std::path::Path;

fn method_id(artifact: &[u8], name: &str) -> Result<u64, String> {
    if artifact.get(..4) != Some(b"ACAB") {
        return Err("ACAB artifact has an invalid header".to_owned());
    }
    let positions: Vec<usize> = artifact
        .windows(name.len())
        .enumerate()
        .filter_map(|(index, bytes)| {
            (bytes == name.as_bytes()
                && index >= 2
                && u16::from_le_bytes([artifact[index - 2], artifact[index - 1]])
                    == name.len() as u16)
                .then_some(index)
        })
        .collect();
    let [position] = positions.as_slice() else {
        return Err(format!("method {name} must appear exactly once in ACAB"));
    };
    let Some(prefix) = position.checked_sub(16) else {
        return Err(format!("method {name} has no ACAB metadata prefix"));
    };
    let Some(id_bytes) = artifact.get(prefix..prefix + 8) else {
        return Err(format!("method {name} has a truncated ACAB method ID"));
    };
    let Some(name_len_bytes) = artifact.get(position - 2..*position) else {
        return Err(format!("method {name} has a truncated ACAB name length"));
    };
    let name_len = u16::from_le_bytes(
        name_len_bytes.try_into().map_err(|_| format!("method {name} has invalid name length"))?,
    );
    if usize::from(name_len) != name.len() {
        return Err(format!("method {name} has inconsistent ACAB name length"));
    }
    Ok(u64::from_le_bytes(
        id_bytes.try_into().map_err(|_| format!("method {name} has invalid ID length"))?,
    ))
}

fn event_class(artifact: &[u8], name: &str) -> Result<u64, String> {
    if artifact.get(..4) != Some(b"ACAB") {
        return Err("ACAB artifact has an invalid header".to_owned());
    }
    let positions: Vec<usize> = artifact
        .windows(name.len())
        .enumerate()
        .filter_map(|(index, bytes)| {
            (bytes == name.as_bytes()
                && index >= 2
                && u16::from_le_bytes([artifact[index - 2], artifact[index - 1]])
                    == name.len() as u16)
                .then_some(index)
        })
        .collect();
    let [position] = positions.as_slice() else {
        return Err(format!("event {name} must appear exactly once in ACAB"));
    };
    let Some(prefix) = position.checked_sub(14) else {
        return Err(format!("event {name} has no ACAB metadata prefix"));
    };
    let Some(id_bytes) = artifact.get(prefix..prefix + 8) else {
        return Err(format!("event {name} has a truncated ACAB class ID"));
    };
    let Some(name_len_bytes) = artifact.get(position - 2..*position) else {
        return Err(format!("event {name} has a truncated ACAB name length"));
    };
    let name_len = u16::from_le_bytes(
        name_len_bytes.try_into().map_err(|_| format!("event {name} has invalid name length"))?,
    );
    if usize::from(name_len) != name.len() {
        return Err(format!("event {name} has inconsistent ACAB name length"));
    }
    Ok(u64::from_le_bytes(
        id_bytes.try_into().map_err(|_| format!("event {name} has invalid ID length"))?,
    ))
}

fn verify(artifact: &[u8]) -> Result<(), String> {
    for (name, expected) in [
        ("ackivault.deposit", abi::DEPOSIT_METHOD_ID),
        ("ackivault.pay", abi::PAY_METHOD_ID),
        ("ackivault.revoke", abi::REVOKE_METHOD_ID),
        ("ackivault.withdraw", abi::WITHDRAW_METHOD_ID),
    ] {
        let actual = method_id(artifact, name)?;
        if actual != expected {
            return Err(format!(
                "ACAB method {name} ID mismatch: expected {expected:#018x}, got {actual:#018x}"
            ));
        }
    }
    for (name, expected) in [
        ("ackivault.deposit_accepted", abi::DEPOSIT_ACCEPTED_EVENT_CLASS),
        ("ackivault.payment_dispatched", abi::PAYMENT_DISPATCHED_EVENT_CLASS),
        ("ackivault.grant_revoked", abi::GRANT_REVOKED_EVENT_CLASS),
        ("ackivault.owner_withdrawal_dispatched", abi::OWNER_WITHDRAWAL_DISPATCHED_EVENT_CLASS),
    ] {
        let actual = event_class(artifact, name)?;
        if actual != expected {
            return Err(format!(
                "ACAB event {name} class mismatch: expected {expected:#018x}, got {actual:#018x}"
            ));
        }
    }
    Ok(())
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let [_, path] = args.as_slice() else {
        return Err("usage: check-abi-ids <contract.acab>".to_owned());
    };
    let artifact = fs::read(Path::new(path))
        .map_err(|error| format!("cannot read ACAB artifact {path}: {error}"))?;
    verify(&artifact)
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
