#!/usr/bin/env bash
set -e

sha256sum out/final.mp4 | awk '{print $1}' > out/final.mp4.sha256

jq \
  --arg sha "$(cat out/final.mp4.sha256)" \
  '.artifacts[0].sha256=$sha' \
  out/provenance.json \
  > out/provenance-with-sha.json

echo "checksums updated"