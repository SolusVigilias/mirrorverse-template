#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
import json
import hashlib
import sys

with open("provenance/provenance-with-sha.json") as f:
    prov = json.load(f)

expected = prov["artifacts"][0]["sha256"]

with open("out/final.mp4", "rb") as f:
    actual = hashlib.sha256(f.read()).hexdigest()

if expected != actual:
    print("checksum mismatch")
    sys.exit(1)

print("validation ok")
PY