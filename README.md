# MirrorVerse Minimal Reproducible Release

A minimal deterministic publishing pipeline for:

- simulation outputs
- trajectory logs
- provenance capture
- reproducible PDF reports

## Quick Start

```bash
python scripts/generate_demo.py
bash scripts/checksum.sh
bash scripts/validate.sh