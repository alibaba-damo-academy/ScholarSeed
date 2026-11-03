"""Exercise product native directory policy before expensive packaging work."""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "serve"))

from service.platform.storage import (
    DarwinDirectoryNative,
    LinuxDirectoryNative,
    WindowsDirectoryNative,
)


def main() -> None:
    native_type = {
        "darwin": DarwinDirectoryNative,
        "win32": WindowsDirectoryNative,
        "linux": LinuxDirectoryNative,
    }[sys.platform]
    native = native_type()
    for root in sys.argv[1:]:
        pin = native.pin(root, False)
        native.release(pin)
    print(json.dumps({"status": "passed", "platform": sys.platform, "roots": sys.argv[1:]}))


if __name__ == "__main__":
    main()
