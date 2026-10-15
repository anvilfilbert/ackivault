#!/usr/bin/env bash
set -euo pipefail
[[ $# == 2 ]] || { echo 'usage: verify-private-package.sh <package-directory> <sdk-directory>' >&2; exit 2; }
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Native Linux x86_64 required; no emulation or SDK substitution.' >&2; exit 2; }
libc=$(getconf GNU_LIBC_VERSION | cut -d' ' -f2)
[[ $(printf '%s\n' 2.39 "$libc" | sort -V | head -1) == 2.39 ]] || { echo 'glibc >= 2.39 required.' >&2; exit 2; }
/lib64/ld-linux-x86-64.so.2 --help | grep -Eq 'x86-64-v3 \(supported, searched\)' || { echo 'Native x86-64-v3 instruction support required.' >&2; exit 2; }
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major!==22||minor<18) throw Error("Node >=22.18 <23 required");'
package=$(realpath -e "$1")
sdk=$(realpath -e "$2")
cd "$package"
[[ -z $(find . -type l -print -quit) ]] || { echo 'Package must not contain symlinks.' >&2; exit 1; }
[[ -f FILES.sha256 && -f release.json ]] || { echo 'Package inventory and release provenance required.' >&2; exit 1; }
LC_ALL=C find . -type f ! -name FILES.sha256 -print | LC_ALL=C sort > /dev/null
node --input-type=module - "$package" "$sdk" <<'JS'
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [pkg,sdk] = process.argv.slice(2);
const lines = (await readFile(path.join(pkg,"FILES.sha256"),"utf8")).trimEnd().split("\n");
const listed = lines.map(line => {
  const match=/^[0-9a-f]{64}  (\.\/[a-zA-Z0-9@/_.+-]+)$/.exec(line);
  if (!match || match[1].split("/").some(part=>part==="..")) throw Error("Invalid package inventory path");
  return match[1];
});
async function files(directory) {
  const result=[];
  for (const entry of await readdir(path.join(pkg,directory),{withFileTypes:true})) {
    const item=path.posix.join(directory,entry.name);
    if(entry.isDirectory()) result.push(...await files(item));
    else if(entry.isFile() && item!=="FILES.sha256") result.push("./"+item);
    else if (!entry.isFile()) throw Error("Package contains a non-regular entry");
  }
  return result;
}
const actual=(await files("")).sort();
if(JSON.stringify([...listed].sort())!==JSON.stringify(actual)) throw Error("Package inventory does not match the exact file set");
JS
sha256sum --check --strict FILES.sha256 > /dev/null
node --input-type=module - "$package" "$sdk" <<'JS'
import path from "node:path";
import { pathToFileURL } from "node:url";
const [pkg,sdk] = process.argv.slice(2);
const {loadStandProvenance}=await import(pathToFileURL(path.join(pkg,"console/dist/src/journal.js")));
await loadStandProvenance(path.join(pkg,"release.json"),{sdkRoot:sdk,vaultArtifacts:path.join(pkg,"vault"),receiptArtifacts:path.join(pkg,"recipient"),stateParent:pkg});
console.log(JSON.stringify({event:"private_package_verified"}));
JS
