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
