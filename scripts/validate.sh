#!/usr/bin/env bash
set -e

test -f out/provenance-with-sha.json

jq '
has("schema_version")
and has("run_id")
and has("seed")
and has("artifacts")
' out/provenance-with-sha.json

echo "schema validation ok"

EXPECTED=$(jq -r '.artifacts[0].sha256' out/provenance-with-sha.json)
ACTUAL=$(sha256sum out/final.mp4 | awk '{print $1}')

if [ "$EXPECTED" != "$ACTUAL" ]; then
  echo "checksum mismatch"
  exit 1
fi

echo "checksum validation ok"