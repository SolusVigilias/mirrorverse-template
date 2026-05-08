#!/usr/bin/env bash
set -euo pipefail

python - <<'PY'
import json
import hashlib

with open("out/final.mp4", "rb") as f:
    sha = hashlib.sha256(f.read()).hexdigest()

with open("out/final.mp4.sha256", "w") as f:
    f.write(sha)

with open("out/provenance.json") as f:
    prov = json.load(f)

prov["artifacts"][0]["sha256"] = sha

with open("out/provenance-with-sha.json", "w") as f:
    json.dump(prov, f, indent=2)

print("checksums updated")
PY