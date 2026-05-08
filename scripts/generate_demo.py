import json
import hashlib
import uuid
import platform
from datetime import datetime, timezone
import random
from pathlib import Path

SEED = 12345
random.seed(SEED)

Path("out").mkdir(exist_ok=True)

# fake trajectory
with open("out/tracks.ndjson", "w") as f:
    for t in range(120):
        point = {
            "type": "point",
            "track_id": 1,
            "t_frame": t,
            "pts_us": t * 33333,
            "x": random.random() * 100,
            "y": random.random() * 100,
            "vx": random.random(),
            "confidence": 0.9
        }
        f.write(json.dumps(point) + "\n")

# fake binary artifact
payload = b"mirrorverse-demo"
with open("out/final.mp4", "wb") as f:
    f.write(payload)

provenance = {
    "schema_version": "mirrorverse-v1",
    "run_id": str(uuid.uuid4()),
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "seed": SEED,
    "kernel": platform.platform(),
    "container": "ghcr.io/your-org/mirrorverse-smoke-ci:2026-05-06",
    "chrome_revision": "1140000",
    "frames": 120,
    "fps": 30,
    "artifacts": [
        {
            "path": "out/final.mp4",
            "sha256": None
        }
    ],
    "tracks": "out/tracks.ndjson"
}

with open("out/provenance.json", "w") as f:
    json.dump(provenance, f, indent=2)