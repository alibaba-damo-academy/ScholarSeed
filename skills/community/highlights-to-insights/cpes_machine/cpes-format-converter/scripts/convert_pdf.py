#!/usr/bin/env scholarseed-skill-python
from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cpes_format_converter.cli import main


if __name__ == "__main__":
    raise SystemExit(main())
