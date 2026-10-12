use avm_contract_sdk::AccountAddress;

use crate::state::{VaultError, VaultState};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Payment {
    pub destination: AccountAddress,
    pub method_id: u64,
    pub amount_shells: u128,
    pub reserve_shells: u128,
}

pub fn pay(
    state: &VaultState,
    caller: [u8; 32],
    nonce: u64,
    index: u8,
    amount: u128,
    balance_shells: u128,
    block_time: u32,
) -> Result<(VaultState, Payment), VaultError> {
    if caller != state.agent_key {
        return Err(VaultError::UnauthorizedAgent);
    }
    if state.agent_nonce_present && nonce <= state.agent_nonce {
        return Err(VaultError::InvalidAgentNonce);
    }
    if state.revoked {
        return Err(VaultError::GrantRevoked);
    }
    if block_time >= state.expires_at {
        return Err(VaultError::GrantExpired);
    }
    if amount == 0 {
        return Err(VaultError::InvalidAmount);
    }
    let recipient = state
        .recipients
        .get(usize::from(index))
        .ok_or(VaultError::RecipientNotAllowed)?;
    let total = amount
        .checked_add(recipient.reserve_shells)
        .ok_or(VaultError::AmountOverflow)?;
    let next_spent = state
        .spent
        .checked_add(total)
        .ok_or(VaultError::AmountOverflow)?;
    if next_spent > state.cap {
        return Err(VaultError::CapExceeded);
    }
    if balance_shells < total {
        return Err(VaultError::InsufficientShellBalance);
    }
    let mut next = state.clone();
    next.spent = next_spent;
    next.agent_nonce_present = true;
    next.agent_nonce = nonce;
    Ok((
        next,
        Payment {
            destination: recipient.address,
            method_id: recipient.method_id,
            amount_shells: amount,
            reserve_shells: recipient.reserve_shells,
        },
    ))
}

pub fn revoke(state: &VaultState, caller: [u8; 32], nonce: u64) -> Result<VaultState, VaultError> {
    if caller != state.owner_key {
        return Err(VaultError::UnauthorizedOwner);
    }
    if state.owner_nonce_present && nonce <= state.owner_nonce {
        return Err(VaultError::InvalidOwnerNonce);
    }
    if state.revoked {
        return Err(VaultError::AlreadyRevoked);
    }
    let mut next = state.clone();
    next.revoked = true;
    next.owner_nonce_present = true;
    next.owner_nonce = nonce;
    Ok(next)
}

pub fn withdraw(
    state: &VaultState,
    caller: [u8; 32],
    nonce: u64,
    payment: Payment,
    balance_shells: u128,
    block_time: u32,
) -> Result<(VaultState, Payment), VaultError> {
    if caller != state.owner_key {
        return Err(VaultError::UnauthorizedOwner);
    }
    if state.owner_nonce_present && nonce <= state.owner_nonce {
        return Err(VaultError::InvalidOwnerNonce);
    }
    if !state.revoked && block_time < state.expires_at {
        return Err(VaultError::GrantActive);
    }
    if payment.destination.dapp_id == [0; 32]
        || payment.destination.account_id == [0; 32]
        || payment.method_id == 0
    {
        return Err(VaultError::InvalidDestination);
    }
    if payment.amount_shells == 0 {
        return Err(VaultError::InvalidAmount);
    }
    let total = payment
        .amount_shells
        .checked_add(payment.reserve_shells)
        .ok_or(VaultError::AmountOverflow)?;
    if balance_shells < total {
        return Err(VaultError::InsufficientShellBalance);
    }
    let mut next = state.clone();
    next.owner_nonce_present = true;
    next.owner_nonce = nonce;
    Ok((next, payment))
}
