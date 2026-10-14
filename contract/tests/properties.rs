//! Generated guest-level invariants. These do not authenticate AVM host signatures.
use ackivault::grant::{inspect, pay, revoke, withdraw, Payment};
use ackivault::state::{decode_state, encode_state, Recipient, VaultError, VaultState};
use avm_contract_sdk::AccountAddress;
use proptest::prelude::*;

fn vault(reserves: &[u128], cap: u128, expires_at: u32) -> VaultState {
    VaultState {
        owner_key: [1; 32],
        agent_key: [2; 32],
        expires_at,
        cap,
        spent: 0,
        revoked: false,
        owner_nonce_present: false,
        owner_nonce: 0,
        agent_nonce_present: false,
        agent_nonce: 0,
        recipients: reserves
            .iter()
            .enumerate()
            .map(|(index, reserve)| Recipient {
                address: AccountAddress {
                    dapp_id: [3; 32],
                    account_id: [u8::try_from(index + 4).expect("at most four recipients"); 32],
                },
                method_id: u64::try_from(index + 7).expect("at most four methods"),
                reserve_shells: *reserve,
            })
            .collect(),
    }
}

fn nonzero_bytes() -> impl Strategy<Value = [u8; 32]> {
    (1_u8..=u8::MAX, prop::array::uniform31(any::<u8>())).prop_map(|(first, tail)| {
        let mut bytes = [0; 32];
        bytes[0] = first;
        bytes[1..].copy_from_slice(&tail);
        bytes
    })
}

fn recipients() -> impl Strategy<Value = Vec<Recipient>> {
    prop::collection::vec(
        (
            nonzero_bytes(),
            prop::array::uniform31(any::<u8>()),
            1_u64..=u64::MAX,
            any::<u128>(),
        ),
        1..=4,
    )
    .prop_map(|entries| {
        entries
            .into_iter()
            .enumerate()
            .map(|(index, (dapp_id, tail, method_id, reserve_shells))| {
                let mut account_id = [0; 32];
                // Distinct prefixes guarantee unique nonzero addresses without filtering.
                account_id[0] = u8::try_from(index + 1).expect("at most four recipients");
                account_id[1..].copy_from_slice(&tail);
                Recipient {
                    address: AccountAddress {
                        dapp_id,
                        account_id,
                    },
                    method_id,
                    reserve_shells,
                }
            })
            .collect()
    })
}

fn states() -> impl Strategy<Value = VaultState> {
    (
        recipients(),
        nonzero_bytes(),
        nonzero_bytes(),
        1_u128..=u128::MAX,
        any::<u128>(),
        1_u32..=u32::MAX,
        any::<bool>(),
        prop::option::of(any::<u64>()),
        prop::option::of(any::<u64>()),
    )
        .prop_map(
            |(
                recipients,
                owner_key,
                agent_key,
                cap,
                spent,
                expiry,
                revoked,
                owner_nonce,
                agent_nonce,
            )| VaultState {
                owner_key,
                agent_key,
                recipients,
                cap,
                expires_at: expiry,
                spent: spent.min(cap),
                revoked,
                owner_nonce_present: owner_nonce.is_some(),
                owner_nonce: owner_nonce.unwrap_or(0),
                agent_nonce_present: agent_nonce.is_some(),
                agent_nonce: agent_nonce.unwrap_or(0),
            },
        )
}

proptest! {
    #![proptest_config(proptest::test_runner::Config::with_failure_persistence(
        proptest::test_runner::FileFailurePersistence::WithSource("proptest-regressions")
    ))]

    // Break caught: field information lost between encoding and decoding.
    // The separate literal wire vector catches matching layout drift in both halves.
    #[test]
    fn state_codec_preserves_every_security_field(state in states()) {
        let bytes = encode_state(&state).expect("generated valid state");
        prop_assert_eq!(decode_state(&bytes), Ok(state));
    }

    // Break caught: accepting ambiguous flag encodings or hidden unused recipients.
    #[test]
    fn state_codec_rejects_noncanonical_flags_and_unused_slots(
        recipient_count in 1_usize..4,
        flag in prop::sample::select(vec![101_usize, 102, 111]),
        invalid in 2_u8..=u8::MAX,
        offset in 0_usize..88,
    ) {
        let state = vault(&vec![5; recipient_count], 100, 100);
        let bytes = encode_state(&state).expect("valid state");
        let mut bad_flag = bytes.clone();
        bad_flag[flag] = invalid;
        prop_assert_eq!(decode_state(&bad_flag), Err(VaultError::InvalidStateEncoding));
        let mut hidden_recipient = bytes;
        hidden_recipient[121 + recipient_count * 88 + offset] = invalid;
        prop_assert_eq!(decode_state(&hidden_recipient), Err(VaultError::InvalidStateEncoding));
    }

    // The independently budgeted payment list must succeed, then exhaust the allowance.
    // Breaks caught: omitted reserve, reset spent, wrong recipient, shared role nonce.
    #[test]
    fn payment_sequences_fill_exact_cap_without_replay_or_recipient_escape(
        reserves in prop::array::uniform4(0_u128..1_000_000),
        payments in prop::collection::vec((1_u128..1_000_000_000, 0_u8..4), 1..65),
    ) {
        let budget: u128 = payments.iter().map(|(amount, index)| amount + reserves[usize::from(*index)]).sum();
        let original = vault(&reserves, budget, 100);
        let mut state = original.clone();
        let mut remaining = budget;
        for (ordinal, (amount, index)) in payments.iter().enumerate() {
            let nonce = u64::try_from(ordinal).expect("bounded sequence");
            state = inspect(&state, [1; 32], nonce).expect("owner has its own nonce stream");
            let before = state.clone();
            let (next, dispatched) = pay(&state, [2; 32], nonce, *index, *amount, remaining, 99)
                .expect("pre-budgeted payment must be executable");
            remaining -= amount + reserves[usize::from(*index)];
            prop_assert_eq!(&state, &before);
            prop_assert_eq!(next.spent, budget - remaining);
            prop_assert_eq!(&next.recipients, &original.recipients);
            prop_assert_eq!(next.cap, original.cap);
            prop_assert_eq!(next.expires_at, original.expires_at);
            prop_assert_eq!(next.owner_key, original.owner_key);
            prop_assert_eq!(next.agent_key, original.agent_key);
            prop_assert_eq!(next.owner_nonce, nonce);
            prop_assert_eq!(next.agent_nonce, nonce);
            prop_assert!(next.agent_nonce_present && next.owner_nonce_present);
            let recipient = &original.recipients[usize::from(*index)];
            prop_assert_eq!(dispatched, Payment {
                destination: recipient.address,
                method_id: recipient.method_id,
                amount_shells: *amount,
                reserve_shells: recipient.reserve_shells,
            });
            prop_assert_eq!(pay(&next, [2; 32], nonce, *index, 1, budget, 99), Err(VaultError::InvalidAgentNonce));
            prop_assert_eq!(pay(&next, [1; 32], nonce + 1, *index, 1, budget, 99), Err(VaultError::UnauthorizedAgent));
            prop_assert_eq!(pay(&next, [2; 32], nonce + 1, 4, 1, budget, 99), Err(VaultError::RecipientNotAllowed));
            state = next;
        }
        prop_assert_eq!(state.spent, budget);
        // Replenishing balance cannot replenish the grant.
        prop_assert_eq!(pay(&state, [2; 32], 100, 0, 1, u128::MAX, 99), Err(VaultError::CapExceeded));
    }

    // Breaks caught: owner recovery resets spent or reopens a revoked/expired grant.
    #[test]
    fn revoke_withdraw_and_expiry_never_restore_agent_authority(
        amounts in prop::collection::vec(1_u128..1_000_000, 1..33),
        reserve in 0_u128..1000,
        stop in any::<usize>(),
    ) {
        let cap: u128 = amounts.iter().map(|amount| amount + reserve).sum::<u128>() + 100;
        let initial = vault(&[reserve], cap, 100);
        let count = stop % (amounts.len() + 1);
        let mut active = initial;
        for (index, amount) in amounts.iter().take(count).enumerate() {
            active = pay(&active, [2; 32], u64::try_from(index).expect("bounded sequence"), 0, *amount, cap, 99)
                .expect("prefix fits the cap").0;
        }
        let nonce = u64::try_from(count).expect("bounded sequence");
        prop_assert_eq!(pay(&active, [2; 32], nonce, 0, 1, cap, 100), Err(VaultError::GrantExpired));
        let recovery = Payment {
            destination: active.recipients[0].address,
            method_id: 7,
            amount_shells: 1,
            reserve_shells: 0,
        };
        prop_assert_eq!(withdraw(&active, [1; 32], 0, recovery, cap, 99), Err(VaultError::GrantActive));
        let expired = withdraw(&active, [1; 32], 0, recovery, cap, 100).expect("owner recovers at expiry").0;
        let expected_expired = VaultState { owner_nonce_present: true, owner_nonce: 0, ..active.clone() };
        prop_assert_eq!(&expired, &expected_expired);
        prop_assert_eq!(pay(&expired, [2; 32], nonce, 0, 1, u128::MAX, 100), Err(VaultError::GrantExpired));
        let revoked = revoke(&active, [1; 32], 0).expect("owner revokes");
        let recovered = withdraw(&revoked, [1; 32], 1, recovery, cap, 99).expect("owner recovers after revoke").0;
        prop_assert_eq!(recovered.spent, active.spent);
        prop_assert_eq!(recovered.agent_nonce, active.agent_nonce);
        prop_assert!(recovered.revoked);
        prop_assert_eq!(revoke(&recovered, [1; 32], 2), Err(VaultError::AlreadyRevoked));
        for index in 0..amounts.len() {
            prop_assert_eq!(pay(&recovered, [2; 32], nonce + u64::try_from(index).expect("bounded sequence"), 0, 1, u128::MAX, 99), Err(VaultError::GrantRevoked));
        }
    }

    // Break caught: unchecked overflow at either of the two addition boundaries.
    #[test]
    fn amount_and_accumulated_spend_overflow_both_fail_closed(reserve in 1_u128..=u64::MAX as u128) {
        let initial = vault(&[reserve], u128::MAX, 100);
        prop_assert_eq!(pay(&initial, [2; 32], 0, 0, u128::MAX, u128::MAX, 99), Err(VaultError::AmountOverflow));
        let nearly_full = VaultState { spent: u128::MAX - reserve, ..initial };
        prop_assert_eq!(pay(&nearly_full, [2; 32], 0, 0, 1, u128::MAX, 99), Err(VaultError::AmountOverflow));
    }
}

#[test]
fn state_codec_matches_an_independent_canonical_wire_vector() {
    let mut state = vault(&[0x100f0e0d0c0b0a090807060504030201], 1000, 0x04030201);
    state.spent = 15;
    state.revoked = true;
    state.owner_nonce_present = true;
    state.owner_nonce = 0x0807060504030201;
    state.agent_nonce_present = true;
    state.agent_nonce = 0x1817161514131211;
    state.recipients[0].method_id = 0x2827262524232221;
    // Literal little-endian version-one layout, independent of codec helpers.
    let prefix = concat!(
        "01",
        "0101010101010101010101010101010101010101010101010101010101010101",
        "0202020202020202020202020202020202020202020202020202020202020202",
        "01020304",
        "e803000000000000",
        "0000000000000000",
        "0f00000000000000",
        "0000000000000000",
        "0101010203040506070801111213141516171801",
        "0303030303030303030303030303030303030303030303030303030303030303",
        "0404040404040404040404040404040404040404040404040404040404040404",
        "2122232425262728",
        "0102030405060708090a0b0c0d0e0f10",
    );
    let mut expected: Vec<u8> = prefix
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("ASCII vector"), 16)
                .expect("hex vector")
        })
        .collect();
    assert_eq!(expected.len(), 209);
    expected.resize(473, 0);
    assert_eq!(encode_state(&state).expect("valid state"), expected);
    assert_eq!(decode_state(&expected), Ok(state));
}

#[test]
fn maximum_role_nonces_do_not_wrap_or_block_the_other_role() {
    let initial = vault(&[5], 100, 100);
    let paid = pay(&initial, [2; 32], u64::MAX, 0, 1, 100, 99)
        .expect("last agent nonce")
        .0;
    for nonce in [0, 1, u64::MAX - 1, u64::MAX] {
        assert_eq!(
            pay(&paid, [2; 32], nonce, 0, 1, 100, 99),
            Err(VaultError::InvalidAgentNonce)
        );
    }
    let revoked = revoke(&paid, [1; 32], u64::MAX).expect("independent owner nonce");
    for nonce in [0, 1, u64::MAX - 1, u64::MAX] {
        assert_eq!(
            inspect(&revoked, [1; 32], nonce),
            Err(VaultError::InvalidOwnerNonce)
        );
    }
}
