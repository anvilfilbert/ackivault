#!/usr/bin/env bash
set -euo pipefail
[[ $# == 3 ]] || { echo 'usage: archive-private-package.sh <verified-package> <verified-sdk> <new-output-directory>' >&2; exit 2; }
package=$(realpath -e "$1")
sdk=$(realpath -e "$2")
output=$(realpath -m "$3")
[[ ! -e "$output" && ! -L "$output" ]] || { echo 'A new archive output directory is required.' >&2; exit 2; }
case "$output/" in "$package/"*|"$sdk/"*) echo 'Archive output must be outside the package and SDK.' >&2; exit 2;; esac
verifier="$(dirname "$(realpath -e "$0")")/verify-private-package.sh"
bash "$verifier" "$package" "$sdk"
while IFS= read -r member; do
  case "$member" in
    ./LICENSE|./release.json|./console/package.json|./console/package-lock.json|\
    ./console/public/index.html|./console/public/styles.css|\
    ./console/dist/src/*.js|./console/dist/browser/*.js|\
    ./console/node_modules/.package-lock.json|./console/node_modules/jose/*|./console/node_modules/zod/*|\
    ./vault/contract.wasm|./vault/contract.acab|./vault/contract.descriptor|\
    ./recipient/contract.wasm|./recipient/contract.acab|./recipient/contract.descriptor|\
    ./deploy/ackivault.service.in|./scripts/verify-private-package.sh) ;;
    *) printf 'Package member is not approved for publication: %s\n' "$member" >&2; exit 1;;
  esac
done < <(cut -c67- "$package/FILES.sha256")
umask 077
mkdir "$output"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -czf "$output/ackivault-application.tar.gz" -C "$package" .
cd "$output"
sha256sum ackivault-application.tar.gz > ackivault-application.tar.gz.sha256
sha256sum --check --strict ackivault-application.tar.gz.sha256
mkdir verified-package
tar -xzf ackivault-application.tar.gz --no-same-owner -C verified-package
bash "$verifier" "$output/verified-package" "$sdk"
