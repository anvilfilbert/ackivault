use ackivault::grant::{pay, revoke, withdraw, Payment};
use ackivault::state::{Recipient, VaultError, VaultState};
use avm_contract_sdk::AccountAddress;

fn vault() -> VaultState {
    VaultState {
        owner_key: [1; 32],
        agent_key: [2; 32],
        expires_at: 100,
        cap: 100,
        spent: 0,
        revoked: false,
        owner_nonce_present: false,
        owner_nonce: 0,
        agent_nonce_present: false,
        agent_nonce: 0,
        recipients: vec![Recipient {
            address: AccountAddress {
                dapp_id: [3; 32],
                account_id: [4; 32],
            },
            method_id: 7,
            reserve_shells: 5,
        }],
    }
}

fn withdrawal_destination() -> AccountAddress {
    AccountAddress {
        dapp_id: [6; 32],
        account_id: [7; 32],
    }
}

fn withdrawal_payment() -> Payment {
    Payment {
        destination: withdrawal_destination(),
        method_id: 9,
        amount_shells: 10,
        reserve_shells: 2,
    }
}

#[test]
fn agent_payment_counts_amount_and_fixed_reserve_at_exact_cap() {
    let initial = vault();
    let (next, payment) = pay(&initial, [2; 32], 0, 0, 95, 100, 99).expect("authorized payment");

    assert_eq!(initial.spent, 0);
    assert_eq!(next.spent, 100);
    assert!(next.agent_nonce_present);
    assert_eq!(next.agent_nonce, 0);
    assert_eq!(payment.destination, initial.recipients[0].address);
    assert_eq!(payment.method_id, 7);
    assert_eq!(payment.amount_shells, 95);
    assert_eq!(payment.reserve_shells, 5);
}

#[test]
fn agent_payment_rejects_cap_plus_one_and_short_balance() {
    assert_eq!(
        pay(&vault(), [2; 32], 0, 0, 96, 101, 99),
        Err(VaultError::CapExceeded)
    );
    assert_eq!(
        pay(&vault(), [2; 32], 0, 0, 95, 99, 99),
        Err(VaultError::InsufficientShellBalance)
    );
    assert!(pay(&vault(), [2; 32], 0, 0, 95, 100, 99).is_ok());
}

#[test]
fn agent_payment_rejects_wrong_role_nonce_and_recipient() {
    assert_eq!(
        pay(&vault(), [1; 32], 0, 0, 1, 100, 99),
        Err(VaultError::UnauthorizedAgent)
    );
    assert_eq!(
        pay(&vault(), [2; 32], 0, 1, 1, 100, 99),
        Err(VaultError::RecipientNotAllowed)
    );
    let (next, _) = pay(&vault(), [2; 32], 0, 0, 1, 100, 99).expect("first nonce");
    assert_eq!(
        pay(&next, [2; 32], 0, 0, 1, 100, 99),
        Err(VaultError::InvalidAgentNonce)
    );
    assert!(pay(&next, [2; 32], 1, 0, 1, 100, 99).is_ok());
}

#[test]
fn agent_payment_rejects_expiry_revocation_zero_and_overflow() {
    assert_eq!(
        pay(&vault(), [2; 32], 0, 0, 1, 100, 100),
        Err(VaultError::GrantExpired)
    );
    assert_eq!(
        pay(&vault(), [2; 32], 0, 0, 0, 100, 99),
        Err(VaultError::InvalidAmount)
    );

    let revoked = revoke(&vault(), [1; 32], 0).expect("owner revocation");
    assert_eq!(
        pay(&revoked, [2; 32], 0, 0, 1, 100, 99),
        Err(VaultError::GrantRevoked)
    );

    let mut overflow = vault();
    overflow.cap = u128::MAX;
    overflow.recipients[0].reserve_shells = u128::MAX;
    assert_eq!(
        pay(&overflow, [2; 32], 0, 0, 1, u128::MAX, 99),
        Err(VaultError::AmountOverflow)
    );
}

#[test]
fn owner_revocation_is_permanent_and_nonce_checked() {
    assert_eq!(
        revoke(&vault(), [2; 32], 0),
        Err(VaultError::UnauthorizedOwner)
    );
    let revoked = revoke(&vault(), [1; 32], 0).expect("owner revocation");
    assert!(revoked.revoked);
    assert!(revoked.owner_nonce_present);
    assert_eq!(revoked.owner_nonce, 0);
    assert_eq!(
        revoke(&revoked, [1; 32], 0),
        Err(VaultError::InvalidOwnerNonce)
    );
    assert_eq!(
        revoke(&revoked, [1; 32], 1),
        Err(VaultError::AlreadyRevoked)
    );
}

#[test]
fn owner_withdrawal_requires_revocation_or_expiry() {
    assert_eq!(
        withdraw(&vault(), [1; 32], 0, withdrawal_payment(), 12, 99),
        Err(VaultError::GrantActive)
    );
    let (expired, payment) = withdraw(&vault(), [1; 32], 0, withdrawal_payment(), 12, 100)
        .expect("withdrawal at expiry");
    assert_eq!(expired.spent, 0);
    assert!(expired.owner_nonce_present);
    assert_eq!(payment.destination, withdrawal_destination());
    assert_eq!(payment.method_id, 9);
    assert_eq!(payment.amount_shells, 10);
    assert_eq!(payment.reserve_shells, 2);

    let revoked = revoke(&vault(), [1; 32], 0).expect("owner revocation");
    assert!(withdraw(&revoked, [1; 32], 1, withdrawal_payment(), 12, 99).is_ok());
}

#[test]
fn owner_withdrawal_rejects_wrong_role_replay_destination_and_balance() {
    let revoked = revoke(&vault(), [1; 32], 0).expect("owner revocation");
    assert_eq!(
        withdraw(&revoked, [2; 32], 1, withdrawal_payment(), 12, 99),
        Err(VaultError::UnauthorizedOwner)
    );
    assert_eq!(
        withdraw(&revoked, [1; 32], 0, withdrawal_payment(), 12, 99),
        Err(VaultError::InvalidOwnerNonce)
    );
    let mut invalid_destination = withdrawal_payment();
    invalid_destination.destination = AccountAddress {
        dapp_id: [0; 32],
        account_id: [0; 32],
    };
    assert_eq!(
        withdraw(&revoked, [1; 32], 1, invalid_destination, 12, 99),
        Err(VaultError::InvalidDestination)
    );
    assert_eq!(
        withdraw(&revoked, [1; 32], 1, withdrawal_payment(), 11, 99),
        Err(VaultError::InsufficientShellBalance)
    );
    assert!(withdraw(&revoked, [1; 32], 1, withdrawal_payment(), 12, 99).is_ok());
}
