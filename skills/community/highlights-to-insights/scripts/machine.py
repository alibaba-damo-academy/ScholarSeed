#!/usr/bin/env scholarseed-skill-python
"""Explicit entry into HINT's bundled CPES Figure V33 / Table V18 runtime."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cpes_machine
from cpes.entry_cli import main

if __name__ == '__main__':
    raise SystemExit(main())
