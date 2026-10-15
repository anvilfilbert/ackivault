#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 3 || ${CI:-} != true || ${GITHUB_ACTIONS:-} != true || ${RUNNER_ENVIRONMENT:-} != github-hosted || ${GITHUB_REPOSITORY:-} != anvilfilbert/ackivault ]]; then
  echo 'Refusing service lifecycle test: requires the disposable GitHub-hosted AckiVault CI runner and three explicit paths.' >&2
  exit 2
fi
[[ $(uname -s) == Linux && $(id -u) != 0 && -d /run/systemd/system ]] || { echo 'Native non-root Linux/systemd runner required.' >&2; exit 2; }
package=$(realpath -e "$1")
sdk=$(realpath -e "$2")
root=$(realpath -m "$3")
[[ "$root" == "$GITHUB_WORKSPACE/.stand/private-service" && ! -e "$root" ]] || { echo 'Lifecycle test root must be the new, exact CI private-service directory.' >&2; exit 2; }
[[ -f "$package/release.json" ]] || { echo 'Verified private package is missing.' >&2; exit 1; }
umask 077
mkdir "$root"
node console/dist/test/hosted-service.js "$package" "$sdk" "$root"
