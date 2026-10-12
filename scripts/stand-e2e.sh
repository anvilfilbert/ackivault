#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 4 ]]; then
  echo 'usage: stand-e2e.sh <sdk-root> <vault-artifacts-dir> <receipt-artifacts-dir> <output-dir>' >&2
  exit 2
fi

sdk_root="$1"
vault_artifacts_dir="$2"
receipt_artifacts_dir="$3"
output_dir="$4"
stand="${sdk_root}/bin/avm-local-stand"
profile="${sdk_root}/profiles/wasmtime-release-profile.v1"
state="${output_dir}/developer.state"
dapp_id='1111111111111111111111111111111111111111111111111111111111111111'
dummy_account='5555555555555555555555555555555555555555555555555555555555555555'
deposit_method='16807661482522038394'

for required_file in "$stand" "$profile" \
  "${vault_artifacts_dir}/contract.wasm" "${vault_artifacts_dir}/contract.acab" "${vault_artifacts_dir}/contract.descriptor" \
  "${receipt_artifacts_dir}/contract.wasm" "${receipt_artifacts_dir}/contract.acab" "${receipt_artifacts_dir}/contract.descriptor"; do
  if [[ ! -f "$required_file" ]]; then
    echo "required file missing: ${required_file}" >&2
    exit 2
  fi
done
if [[ -e "$state" ]]; then
  echo "refusing to reuse stand state: ${state}" >&2
  exit 2
fi

mkdir -p "$output_dir"
rustc --edition=2021 -D warnings tools/stand-args.rs -o "${output_dir}/stand-args"

"$stand" init --state "$state" --wasmtime-profile "$profile" --dapp-id "$dapp_id" > "${output_dir}/init.json"
package_owner_key="$(jq -er '.identities.package_owner' "${output_dir}/init.json")"
user_key="$(jq -er '.identities.user' "${output_dir}/init.json")"

deploy_contract() {
  local salt_hex="$1"
  local init_json="$2"
  local result_prefix="$3"
  local contract_artifacts="$4"
  local result_file="${output_dir}/${result_prefix}-funding-required.json"
  local exit_status
  local address

  set +e
  "$stand" deploy \
    --state "$state" --wasmtime-profile "$profile" \
    --wasm "${contract_artifacts}/contract.wasm" \
    --acab "${contract_artifacts}/contract.acab" \
    --descriptor "${contract_artifacts}/contract.descriptor" \
    --salt-hex "$salt_hex" --init-json "$init_json" \
    --block-time 1800000000 --created-at 1800000000 --expire-at 1800003600 \
    --fuel-fee-shells 1000 > "$result_file"
  exit_status="$?"
  set -e
  if [[ "$exit_status" -ne 2 ]] || ! jq -e '.error == "funding_required"' "$result_file" >/dev/null; then
    echo "expected funding_required for ${result_prefix}; got exit ${exit_status}" >&2
    exit 1
  fi
  address="$(jq -er '.address' "$result_file")"
  "$stand" fund-user --state "$state" --wasmtime-profile "$profile" \
    --address "$address" --shells 100000 > "${output_dir}/${result_prefix}-fund.json"
  if ! "$stand" deploy \
    --state "$state" --wasmtime-profile "$profile" \
    --wasm "${contract_artifacts}/contract.wasm" \
    --acab "${contract_artifacts}/contract.acab" \
    --descriptor "${contract_artifacts}/contract.descriptor" \
    --salt-hex "$salt_hex" --init-json "$init_json" \
    --block-time 1800000000 --created-at 1800000000 --expire-at 1800003600 \
    --fuel-fee-shells 1000 > "${output_dir}/${result_prefix}-deploy.json"; then
    echo "stand deployment failed for ${result_prefix}:" >&2
    jq . "${output_dir}/${result_prefix}-deploy.json" >&2
    return 1
  fi
  jq -e '.status == "ok"' "${output_dir}/${result_prefix}-deploy.json" >/dev/null
}

receiver_args="$("${output_dir}/stand-args" "$user_key" 1800007200 1000 "${dapp_id}:${dummy_account}" "$deposit_method" 5)"
deploy_contract '7265636569766572' "$receiver_args" receiver "$receipt_artifacts_dir"
receiver_address="$(jq -er '.address' "${output_dir}/receiver-funding-required.json")"
"$stand" inspect --state "$state" --wasmtime-profile "$profile" > "${output_dir}/receiver-inspect.json"
"$stand" events --state "$state" --wasmtime-profile "$profile" > "${output_dir}/receiver-events.json"
main_args="$("${output_dir}/stand-args" "$user_key" 1800007200 1000 "$receiver_address" "$deposit_method" 5)"
deploy_contract '6d61696e' "$main_args" main "$vault_artifacts_dir"
main_address="$(jq -er '.address' "${output_dir}/main-funding-required.json")"

forward_args="\"${main_address}\""
"$stand" call --state "$state" --wasmtime-profile "$profile" \
  --address "$receiver_address" --method stand.forward_deposit --args-json "$forward_args" \
  --identity user --value-main 0 --extra-currencies '' \
  --block-time 1800000005 --created-at 1800000004 --expire-at 1800003604 \
  --fuel-fee-shells 1000 > "${output_dir}/deposit.json"
jq -e '.status == "ok" and .raw_executor_output[8:16] == "00000000" and
  (.events | length) == 1' "${output_dir}/deposit.json" >/dev/null

pay_args='"0x000a000000000000000000000000000000"'
"$stand" call --state "$state" --wasmtime-profile "$profile" \
  --address "$main_address" --method ackivault.pay --args-json "$pay_args" \
  --identity user --value-main 0 --extra-currencies '' \
  --block-time 1800000010 --created-at 1800000009 --expire-at 1800003609 \
  --fuel-fee-shells 1000 > "${output_dir}/pay.json"
jq -e --arg owner "$package_owner_key" --arg agent "$user_key" \
  '.status == "ok" and .method == "ackivault.pay" and
  .raw_state[2:66] == $owner and .raw_state[66:130] == $agent and
  .raw_state[170:202] == "0f000000000000000000000000000000" and
  (.events | length) == 2' "${output_dir}/pay.json" >/dev/null

over_cap_args='"0x00da030000000000000000000000000000"'
"$stand" call --state "$state" --wasmtime-profile "$profile" \
  --address "$main_address" --method ackivault.pay --args-json "$over_cap_args" \
  --identity user --value-main 0 --extra-currencies '' \
  --block-time 1800000020 --created-at 1800000019 --expire-at 1800003619 \
  --fuel-fee-shells 1000 > "${output_dir}/over-cap.json"
jq -e --slurpfile pay "${output_dir}/pay.json" \
  '.status == "ok" and .raw_executor_output[8:16] == "00040000" and
  .raw_state == $pay[0].raw_state and (.events | length) == 0' \
  "${output_dir}/over-cap.json" >/dev/null

wrong_key_args='"0x0001000000000000000000000000000000"'
"$stand" call --state "$state" --wasmtime-profile "$profile" \
  --address "$main_address" --method ackivault.pay --args-json "$wrong_key_args" \
  --identity package-owner --value-main 0 --extra-currencies '' \
  --block-time 1800000030 --created-at 1800000029 --expire-at 1800003629 \
  --fuel-fee-shells 1000 > "${output_dir}/wrong-key.json"
jq -e --slurpfile pay "${output_dir}/pay.json" \
  '.status == "ok" and .raw_executor_output[8:16] == "f4030000" and
  .raw_state == $pay[0].raw_state and (.events | length) == 0' \
  "${output_dir}/wrong-key.json" >/dev/null

"$stand" call --state "$state" --wasmtime-profile "$profile" \
  --address "$main_address" --method ackivault.revoke --args-json null \
  --identity package-owner --value-main 0 --extra-currencies '' \
  --block-time 1800000040 --created-at 1800000039 --expire-at 1800003639 \
  --fuel-fee-shells 1000 > "${output_dir}/revoke.json"
jq -e '.status == "ok" and .raw_executor_output[8:16] == "00000000" and
  .raw_state[202:204] == "01" and (.events | length) == 1' \
  "${output_dir}/revoke.json" >/dev/null

"$stand" call --state "$state" --wasmtime-profile "$profile" \
  --address "$main_address" --method ackivault.pay --args-json "$wrong_key_args" \
  --identity user --value-main 0 --extra-currencies '' \
  --block-time 1800000050 --created-at 1800000049 --expire-at 1800003649 \
  --fuel-fee-shells 1000 > "${output_dir}/revoked-pay.json"
jq -e --slurpfile revoke "${output_dir}/revoke.json" \
  '.status == "ok" and .raw_executor_output[8:16] == "fa030000" and
  .raw_state == $revoke[0].raw_state and (.events | length) == 0' \
  "${output_dir}/revoked-pay.json" >/dev/null

withdraw_args="\"0x${receiver_address/:/}7ad0bd4a11cf40e90500000000000000000000000000000007000000000000000000000000000000\""
"$stand" call --state "$state" --wasmtime-profile "$profile" \
  --address "$main_address" --method ackivault.withdraw --args-json "$withdraw_args" \
  --identity package-owner --value-main 0 --extra-currencies '' \
  --block-time 1800000060 --created-at 1800000059 --expire-at 1800003659 \
  --fuel-fee-shells 1000 > "${output_dir}/withdraw.json"
jq -e '.status == "ok" and .raw_executor_output[8:16] == "00000000" and
  (.events | length) == 2' "${output_dir}/withdraw.json" >/dev/null

"$stand" inspect --state "$state" --wasmtime-profile "$profile" > "${output_dir}/inspect.json"
jq -e --arg receiver "$receiver_address" --arg main "$main_address" \
  '.status == "ok" and (.accounts | any(.address == $receiver)) and (.accounts | any(.address == $main))' \
  "${output_dir}/inspect.json" >/dev/null
receiver_before="$(jq -er --arg address "$receiver_address" \
  '.accounts[] | select(.address == $address) | .account_hash' "${output_dir}/receiver-inspect.json")"
receiver_after="$(jq -er --arg address "$receiver_address" \
  '.accounts[] | select(.address == $address) | .account_hash' "${output_dir}/inspect.json")"
if [[ "$receiver_before" == "$receiver_after" ]]; then
  echo 'recipient account did not change after dispatched payment' >&2
  exit 1
fi
"$stand" replay --state "$state" --wasmtime-profile "$profile" > "${output_dir}/replay.json"
jq -e '.status == "ok"' "${output_dir}/replay.json" >/dev/null
printf 'stand deploy and replay verified: %s %s\n' "$receiver_address" "$main_address"
