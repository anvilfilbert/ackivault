use avm_contract_sdk::{
    encode_event_fields, Caller, CanonicalMessage, CurrencyAmount, EventField, EventIntent,
    EventKind, EventValue, ExternalMessage, MessageInput, MessageOutput, OutboundIntent,
    StateUpdate,
};

use crate::abi::{
    DEPOSIT_ACCEPTED_EVENT_CLASS, DEPOSIT_METHOD_ID, GRANT_REVOKED_EVENT_CLASS,
    OWNER_WITHDRAWAL_DISPATCHED_EVENT_CLASS, PAYMENT_DISPATCHED_EVENT_CLASS, PAY_METHOD_ID,
    REVOKE_METHOD_ID, WITHDRAW_METHOD_ID,
};
use crate::grant::{pay, revoke, withdraw, Payment};
use crate::initialization::initialize as initialize_state;
use crate::state::{decode_state, encode_state, VaultError};

const SHELL_CURRENCY_ID: u32 = 2;

pub(crate) fn initialize(input: MessageInput<'_>) -> MessageOutput {
    match initialize_result(input) {
        Ok(output) => output,
        Err(error) => MessageOutput::failure(error.status_code()),
    }
}

fn initialize_result(input: MessageInput<'_>) -> Result<MessageOutput, VaultError> {
    let (Caller::External(caller_key), CanonicalMessage::External(message)) =
        (input.caller, input.message)
    else {
        return Err(VaultError::InvalidCallerType);
    };
    if !message.is_deploy() || !input.state.is_empty() {
        return Err(VaultError::InvalidArguments);
    }
    require_signature(&message, caller_key)?;
    if message.value_main != 0 || !message.extra.is_empty() {
        return Err(VaultError::InvalidIncomingValue);
    }
    let state = initialize_state(caller_key, message.body, input.context.block_time)?;
    Ok(MessageOutput::success(StateUpdate::FullReplace(
        encode_state(&state)?,
    )))
}

pub(crate) fn process_message(input: MessageInput<'_>) -> MessageOutput {
    match process_message_result(input) {
        Ok(output) => output,
        Err(error) => MessageOutput::failure(error.status_code()),
    }
}

fn process_message_result(input: MessageInput<'_>) -> Result<MessageOutput, VaultError> {
    if input.message.is_deploy() {
        return Err(VaultError::InvalidCallerType);
    }
    let state = decode_state(input.state)?;
    match input.message.method_id() {
        DEPOSIT_METHOD_ID => accept_deposit(input),
        PAY_METHOD_ID => dispatch_payment(input, &state),
        REVOKE_METHOD_ID => revoke_grant(input, &state),
        WITHDRAW_METHOD_ID => dispatch_withdrawal(input, &state),
        _ => Err(VaultError::UnsupportedMessage),
    }
}

fn accept_deposit(input: MessageInput<'_>) -> Result<MessageOutput, VaultError> {
    let (Caller::Internal(_), CanonicalMessage::Internal(message)) = (input.caller, input.message)
    else {
        return Err(VaultError::InvalidCallerType);
    };
    if message.is_callback()
        || message.has_callback_request()
        || message.event_reads.is_some()
        || !message.body.is_empty()
    {
        return Err(VaultError::InvalidArguments);
    }
    let mut extra = message.extra.iter();
    let Some(currency) = extra.next() else {
        return Err(VaultError::InvalidIncomingValue);
    };
    if message.value_main != 0
        || currency.currency_id != SHELL_CURRENCY_ID
        || currency.amount == 0
        || extra.next().is_some()
    {
        return Err(VaultError::InvalidIncomingValue);
    }
    let mut output = MessageOutput::success(StateUpdate::FullReplace(input.state.to_vec()));
    output.event_intents = vec![event(
        DEPOSIT_ACCEPTED_EVENT_CLASS,
        "ackivault.deposit_accepted",
        &[EventField {
            name: "amount_shells".into(),
            value: EventValue::U128(currency.amount),
        }],
    )?];
    Ok(output)
}

fn dispatch_payment(
    input: MessageInput<'_>,
    state: &crate::state::VaultState,
) -> Result<MessageOutput, VaultError> {
    let message = signed_external(input)?;
    if message.body.len() != 17 {
        return Err(VaultError::InvalidArguments);
    }
    let amount = u128::from_le_bytes(
        message.body[1..17]
            .try_into()
            .map_err(|_| VaultError::InvalidArguments)?,
    );
    let (next, payment) = pay(
        state,
        message.pubkey,
        message.nonce,
        message.body[0],
        amount,
        shell_balance(input),
        input.context.block_time,
    )?;
    let mut output = MessageOutput::success(StateUpdate::FullReplace(encode_state(&next)?));
    output.outbound_intents = vec![outbound(payment)];
    output.event_intents = vec![event(
        PAYMENT_DISPATCHED_EVENT_CLASS,
        "ackivault.payment_dispatched",
        &[
            EventField {
                name: "amount_shells".into(),
                value: EventValue::U128(payment.amount_shells),
            },
            EventField {
                name: "destination".into(),
                value: EventValue::Address(payment.destination),
            },
            EventField {
                name: "spent_shells".into(),
                value: EventValue::U128(next.spent),
            },
        ],
    )?];
    Ok(output)
}

fn revoke_grant(
    input: MessageInput<'_>,
    state: &crate::state::VaultState,
) -> Result<MessageOutput, VaultError> {
    let message = signed_external(input)?;
    if !message.body.is_empty() {
        return Err(VaultError::InvalidArguments);
    }
    let next = revoke(state, message.pubkey, message.nonce)?;
    let mut output = MessageOutput::success(StateUpdate::FullReplace(encode_state(&next)?));
    output.event_intents = vec![event(
        GRANT_REVOKED_EVENT_CLASS,
        "ackivault.grant_revoked",
        &[EventField {
            name: "nonce".into(),
            value: EventValue::U64(message.nonce),
        }],
    )?];
    Ok(output)
}

fn dispatch_withdrawal(
    input: MessageInput<'_>,
    state: &crate::state::VaultState,
) -> Result<MessageOutput, VaultError> {
    let message = signed_external(input)?;
    if message.body.len() != 104 {
        return Err(VaultError::InvalidArguments);
    }
    let body = message.body;
    let payment = Payment {
        destination: avm_contract_sdk::AccountAddress {
            dapp_id: body[..32]
                .try_into()
                .map_err(|_| VaultError::InvalidArguments)?,
            account_id: body[32..64]
                .try_into()
                .map_err(|_| VaultError::InvalidArguments)?,
        },
        method_id: u64::from_le_bytes(
            body[64..72]
                .try_into()
                .map_err(|_| VaultError::InvalidArguments)?,
        ),
        reserve_shells: u128::from_le_bytes(
            body[72..88]
                .try_into()
                .map_err(|_| VaultError::InvalidArguments)?,
        ),
        amount_shells: u128::from_le_bytes(
            body[88..104]
                .try_into()
                .map_err(|_| VaultError::InvalidArguments)?,
        ),
    };
    let (next, payment) = withdraw(
        state,
        message.pubkey,
        message.nonce,
        payment,
        shell_balance(input),
        input.context.block_time,
    )?;
    let mut output = MessageOutput::success(StateUpdate::FullReplace(encode_state(&next)?));
    output.outbound_intents = vec![outbound(payment)];
    output.event_intents = vec![event(
        OWNER_WITHDRAWAL_DISPATCHED_EVENT_CLASS,
        "ackivault.owner_withdrawal_dispatched",
        &[
            EventField {
                name: "amount_shells".into(),
                value: EventValue::U128(payment.amount_shells),
            },
            EventField {
                name: "destination".into(),
                value: EventValue::Address(payment.destination),
            },
        ],
    )?];
    Ok(output)
}

fn signed_external(input: MessageInput<'_>) -> Result<ExternalMessage<'_>, VaultError> {
    let (Caller::External(caller_key), CanonicalMessage::External(message)) =
        (input.caller, input.message)
    else {
        return Err(VaultError::InvalidCallerType);
    };
    require_signature(&message, caller_key)?;
    if message.value_main != 0 || !message.extra.is_empty() {
        return Err(VaultError::InvalidIncomingValue);
    }
    Ok(message)
}

fn require_signature(
    message: &ExternalMessage<'_>,
    caller_key: [u8; 32],
) -> Result<(), VaultError> {
    if message.flags & 1 == 0
        || message.signature.len() != 64
        || caller_key == [0; 32]
        || caller_key != message.pubkey
    {
        return Err(VaultError::InvalidSignature);
    }
    Ok(())
}

fn shell_balance(input: MessageInput<'_>) -> u128 {
    input
        .extra
        .iter()
        .find(|currency| currency.currency_id == SHELL_CURRENCY_ID)
        .map_or(0, |currency| currency.amount)
}

fn outbound(payment: Payment) -> OutboundIntent {
    OutboundIntent {
        input_index: 0,
        destination: payment.destination,
        value_main: 0,
        fuel_fee_shells: payment.reserve_shells,
        extra: vec![CurrencyAmount {
            currency_id: SHELL_CURRENCY_ID,
            amount: payment.amount_shells,
        }],
        method_id: payment.method_id,
        body: Vec::new(),
    }
}

fn event(class: u64, name: &str, fields: &[EventField]) -> Result<EventIntent, VaultError> {
    let fields_binary = encode_event_fields(fields).map_err(|_| VaultError::EventEncoding)?;
    Ok(EventIntent {
        input_index: 0,
        kind: EventKind::External,
        event_class: class,
        event_name: name.into(),
        topics: Vec::new(),
        fields_binary,
    })
}
