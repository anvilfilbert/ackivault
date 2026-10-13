use std::{env, fs, io, path::Path};

use ackivault::abi::{
    DEPOSIT_METHOD_ID, INSPECT_METHOD_ID, PAY_METHOD_ID, REVOKE_METHOD_ID, WITHDRAW_METHOD_ID,
};

#[allow(dead_code)]
#[path = "../../contract/tests/support/mod.rs"]
mod support;
use support::*;

fn save(root: &Path, target: &str, name: &str, bytes: &[u8]) -> io::Result<()> {
    let directory = root.join(target);
    fs::create_dir_all(&directory)?;
    fs::write(directory.join(name), bytes)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = env::args()
        .nth(1)
        .ok_or("usage: seed <new-corpus-directory>")?;
    let root = Path::new(&root);
    if root.exists() {
        return Err("refusing to overwrite an existing corpus".into());
    }
    let state = vault_state();
    let args = init_args();
    let deployment = deployment_body(b"ackivault", b"local-fuzz", &args);
    save(root, "state_init", "state", &state)?;
    save(root, "state_init", "init", &args)?;
    save(root, "state_init", "deployment", &deployment)?;
    let mut all_recipients = args;
    all_recipients[52] = 4;
    for (index, reserve) in [0_u128, 1, 256, u128::MAX].into_iter().enumerate() {
        let start = 53 + index * 88;
        all_recipients[start..start + 32].fill(3 + u8::try_from(index)?);
        all_recipients[start + 32..start + 64].fill(9 + u8::try_from(index)?);
        all_recipients[start + 64..start + 72]
            .copy_from_slice(&(7 + u64::try_from(index)?).to_le_bytes());
        all_recipients[start + 72..start + 88].copy_from_slice(&reserve.to_le_bytes());
    }
    save(root, "state_init", "init-all-recipients", &all_recipients)?;
    save(
        root,
        "state_init",
        "deployment-all-recipients",
        &deployment_body(b"ackivault", b"four", &all_recipients),
    )?;
    save(
        root,
        "canonical_message",
        "deployment",
        &deployment_input([1; 32], &deployment, 10),
    )?;
    save(
        root,
        "canonical_message",
        "deposit",
        &internal_input(DEPOSIT_METHOD_ID, &[], &state, 20, 0),
    )?;
    for (name, key, method, body, time) in [
        ("pay", [2; 32], PAY_METHOD_ID, pay_args(10).to_vec(), 99),
        ("cap", [2; 32], PAY_METHOD_ID, pay_args(96).to_vec(), 99),
        (
            "expired",
            [2; 32],
            PAY_METHOD_ID,
            pay_args(10).to_vec(),
            100,
        ),
        ("inspect", [1; 32], INSPECT_METHOD_ID, vec![], 99),
        ("revoke", [1; 32], REVOKE_METHOD_ID, vec![], 99),
        (
            "withdraw",
            [1; 32],
            WITHDRAW_METHOD_ID,
            withdraw_args().to_vec(),
            100,
        ),
    ] {
        save(
            root,
            "canonical_message",
            name,
            &external_input(key, 7, method, &body, &state, time, 100, 0, 0),
        )?;
    }
    Ok(())
}
