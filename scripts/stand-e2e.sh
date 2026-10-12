#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo 'usage: stand-e2e.sh <sdk-root> <artifacts-dir> <output-dir>' >&2
  exit 2
fi

sdk_root="$1"
artifacts_dir="$2"
output_dir="$3"
stand="${sdk_root}/bin/avm-local-stand"
profile="${sdk_root}/profiles/wasmtime-release-profile.v1"
state="${output_dir}/developer.state"
dapp_id='1111111111111111111111111111111111111111111111111111111111111111'
dummy_account='5555555555555555555555555555555555555555555555555555555555555555'
deposit_method='16807661482522038394'

for required_file in "$stand" "$profile" "${artifacts_dir}/contract.wasm" "${artifacts_dir}/contract.acab" "${artifacts_dir}/contract.descriptor"; do
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
developer_key="$(jq -er '.identities.developer' "${output_dir}/init.json")"
user_key="$(jq -er '.identities.user' "${output_dir}/init.json")"

deploy_vault() {
  local salt_hex="$1"
  local init_json="$2"
  local result_prefix="$3"
  local result_file="${output_dir}/${result_prefix}-funding-required.json"
  local exit_status
  local address

  set +e
  "$stand" deploy \
    --state "$state" --wasmtime-profile "$profile" \
    --wasm "${artifacts_dir}/contract.wasm" \
    --acab "${artifacts_dir}/contract.acab" \
    --descriptor "${artifacts_dir}/contract.descriptor" \
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
    --wasm "${artifacts_dir}/contract.wasm" \
    --acab "${artifacts_dir}/contract.acab" \
    --descriptor "${artifacts_dir}/contract.descriptor" \
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
deploy_vault '7265636569766572' "$receiver_args" receiver
receiver_address="$(jq -er '.address' "${output_dir}/receiver-funding-required.json")"
main_args="$("${output_dir}/stand-args" "$user_key" 1800007200 1000 "$receiver_address" "$deposit_method" 5)"
deploy_vault '6d61696e' "$main_args" main
main_address="$(jq -er '.address' "${output_dir}/main-funding-required.json")"

"$stand" inspect --state "$state" --wasmtime-profile "$profile" > "${output_dir}/inspect.json"
jq -e --arg receiver "$receiver_address" --arg main "$main_address" \
  '.status == "ok" and (.accounts | any(.address == $receiver)) and (.accounts | any(.address == $main))' \
  "${output_dir}/inspect.json" >/dev/null
"$stand" replay --state "$state" --wasmtime-profile "$profile" > "${output_dir}/replay.json"
jq -e '.status == "ok"' "${output_dir}/replay.json" >/dev/null
printf 'stand deploy and replay verified: %s %s\n' "$receiver_address" "$main_address"
