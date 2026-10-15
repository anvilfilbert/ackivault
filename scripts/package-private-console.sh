#!/usr/bin/env bash
set -euo pipefail
[[ $# == 2 && -n ${ACKIVAULT_SDK_ROOT:-} ]] || { echo 'usage: ACKIVAULT_SDK_ROOT=<verified-sdk> package-private-console.sh <source-root> <new-output-directory>' >&2; exit 2; }
source_root=$(realpath -e "$1")
sdk=$(realpath -e "$ACKIVAULT_SDK_ROOT")
output=$(realpath -m "$2")
[[ ! -e "$output" && ! -L "$output" && -z $(git -C "$source_root" status --porcelain) ]] || { echo 'Clean source and a new package output directory required.' >&2; exit 2; }
commit=$(git -C "$source_root" rev-parse HEAD)
printf '%s  %s\n' '2599204d32a8100847a086c95e16f589589644bf6072496cc19c1e172fb7f586' "$sdk/bin/avm-local-stand" | sha256sum --check
printf '%s  %s\n' 'd2814c83958f9681845708516e7408fd7e9166c269737c66fbc112f7ea13c49e' "$sdk/bin/avm-contract-build" | sha256sum --check
printf '%s  %s\n' 'eafd9ee1589b24c8fba8f5212c0571bd796bfc127aeae0edfb5697bd477b39d8' "$sdk/profiles/wasmtime-release-profile.v1" | sha256sum --check
build_root=$(mktemp -d /tmp/ackivault-package-source.XXXXXXXX)
cleanup_source() { rm -rf -- "$build_root"; }
trap cleanup_source EXIT
git -C "$source_root" archive --format=tar "$commit" | tar -xf - -C "$build_root"
cd "$build_root/console"
npm ci
npm run build
cd "$build_root"
"$sdk/bin/avm-contract-build" build --manifest-path contract/Cargo.toml
"$sdk/bin/avm-contract-build" build --manifest-path tests/stand/receipt/Cargo.toml
[[ -z $(git -C "$source_root" status --porcelain) ]] || { echo 'Source changed during build; refusing package.' >&2; exit 1; }
umask 022
mkdir -p "$output/console/dist" "$output/console/public" "$output/deploy" "$output/scripts" "$output/vault" "$output/recipient"
cp -R console/dist/src console/dist/browser "$output/console/dist/"
cp console/public/index.html console/public/styles.css "$output/console/public/"
cp console/package.json console/package-lock.json "$output/console/"
npm ci --prefix "$output/console" --omit=dev --ignore-scripts
find "$output/console/node_modules" -depth -type d -empty -delete
for artifact in contract.wasm contract.acab contract.descriptor; do
  cp "contract/target/avm/$artifact" "$output/vault/"
  cp "tests/stand/receipt/target/avm/$artifact" "$output/recipient/"
done
cp LICENSE "$output/"
cp deploy/private-console/ackivault.service.in "$output/deploy/"
cp scripts/verify-private-package.sh "$output/scripts/"
node --input-type=module - "$output" "$sdk" "$commit" <<'JS'
import {readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";
const [pkg,sdk,commit]=process.argv.slice(2);
const {artifactHashes,provenanceSchema}=await import(pathToFileURL(path.join(pkg,"console/dist/src/journal.js")));
const source=JSON.parse(await readFile(path.join(sdk,"BUILD-MANIFEST.json"),"utf8"));
const manifest=provenanceSchema.parse({applicationCommit:commit,sdkCommit:source.sdk_commit,runtimeCommit:source.ackinacki_commit,
  profileSha256:source.wasmtime_profile_sha256,vaultArtifactSha256:await artifactHashes(path.join(pkg,"vault")),recipientArtifactSha256:await artifactHashes(path.join(pkg,"recipient"))});
await writeFile(path.join(pkg,"release.json"),JSON.stringify(manifest)+"\n",{flag:"wx",mode:0o644});
JS
cd "$output"
LC_ALL=C find . -type f ! -name FILES.sha256 -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > FILES.sha256
chmod -R a-w "$output"
bash "$build_root/scripts/verify-private-package.sh" "$output" "$sdk"
