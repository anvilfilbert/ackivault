#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo 'usage: prepare-console-test-ca.sh <new-private-directory>' >&2
  exit 2
fi
if [ -e "$1" ]; then
  echo 'Test CA destination already exists; choose a fresh directory.' >&2
  exit 2
fi
umask 077
mkdir -p "$1"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -keyout "$1/server.key" -out "$1/ca.pem" -subj '/CN=localhost' \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' \
  -addext 'basicConstraints=critical,CA:TRUE' > "$1/generation.log" 2>&1
