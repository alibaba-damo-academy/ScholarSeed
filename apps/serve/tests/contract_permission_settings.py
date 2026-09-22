"""Contract coverage for durable defaults used by newly created sessions."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from service.chat.service import settings as settings_module
from service.chat.service.settings import SettingsService


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="permission-settings-") as temporary:
        original = settings_module.SERVE_SETTINGS_FILE
        settings_module.SERVE_SETTINGS_FILE = Path(temporary) / "settings.json"
        try:
            settings = SettingsService(environ={})
            assert settings.permission_mode() == "safe_auto"

            for mode in ("safe_auto", "bypassPermissions", "ask"):
                assert settings.set_permission_mode(mode) == mode
                assert SettingsService(environ={}).permission_mode() == mode

            document = json.loads(settings_module.SERVE_SETTINGS_FILE.read_text(encoding="utf-8"))
            assert document["default_permission_mode"] == "ask"

            try:
                settings.set_permission_mode("unknown")
            except ValueError:
                pass
            else:
                raise AssertionError("unsupported permission default was accepted")
        finally:
            settings_module.SERVE_SETTINGS_FILE = original
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
