from __future__ import annotations

import json
import uuid
from pathlib import Path

from service.persistence.project import transaction
from service.translation.providers import PROVIDERS, TranslationFailure

DEFAULT_PREFERENCES = {"toolbar": True, "selectionAutomatic": False}


class TranslationStore:
    def __init__(self, path: Path):
        self.path = path
        with transaction(path, private=True) as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS translation_credentials (provider TEXT PRIMARY KEY, generation TEXT NOT NULL, credentials TEXT)"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS translation_preferences (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)))"
            )

    def preferences(self) -> dict[str, bool]:
        with transaction(self.path, private=True) as connection:
            values = dict(connection.execute("SELECT name, enabled FROM translation_preferences"))
        return {
            name: bool(values.get(name, default)) for name, default in DEFAULT_PREFERENCES.items()
        }

    def save_preferences(self, changes: dict[str, bool]) -> dict[str, bool]:
        if any(
            name not in DEFAULT_PREFERENCES or not isinstance(value, bool)
            for name, value in changes.items()
        ):
            raise ValueError("invalid translation preferences")
        with transaction(self.path, private=True) as connection:
            connection.executemany(
                "INSERT INTO translation_preferences(name, enabled) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET enabled=excluded.enabled",
                list(changes.items()),
            )
            values = dict(connection.execute("SELECT name, enabled FROM translation_preferences"))
        return {
            name: bool(values.get(name, default)) for name, default in DEFAULT_PREFERENCES.items()
        }

    def statuses(self) -> dict[str, str]:
        with transaction(self.path, private=True) as connection:
            configured = {
                row[0]
                for row in connection.execute(
                    "SELECT provider FROM translation_credentials WHERE credentials IS NOT NULL"
                )
            }
        return {
            provider: "configured" if provider in configured else "unconfigured"
            for provider in PROVIDERS
        }

    def begin(self, provider: str) -> str:
        if provider not in PROVIDERS:
            raise TranslationFailure("required")
        generation = uuid.uuid4().hex
        with transaction(self.path, private=True) as connection:
            connection.execute(
                "INSERT INTO translation_credentials(provider, generation, credentials) VALUES (?, ?, NULL) ON CONFLICT(provider) DO UPDATE SET generation=excluded.generation, credentials=NULL",
                (provider, generation),
            )
        return generation

    def configuration(self) -> dict[str, dict[str, str]]:
        with transaction(self.path, private=True) as connection:
            rows = connection.execute(
                "SELECT provider, credentials FROM translation_credentials WHERE credentials IS NOT NULL"
            ).fetchall()
        return {
            provider: {
                name: value
                for name, value in json.loads(credentials).items()
                if name in PROVIDERS[provider].public_fields
            }
            for provider, credentials in rows
            if provider in PROVIDERS
        }

    def finish(self, provider: str, generation: str, fields: dict[str, str]) -> bool:
        with transaction(self.path, private=True) as connection:
            return (
                connection.execute(
                    "UPDATE translation_credentials SET credentials=? WHERE provider=? AND generation=?",
                    (json.dumps(fields), provider, generation),
                ).rowcount
                == 1
            )

    def credentials(self, provider: str) -> dict[str, str]:
        with transaction(self.path, private=True) as connection:
            row = connection.execute(
                "SELECT credentials FROM translation_credentials WHERE provider=?", (provider,)
            ).fetchone()
        if row is None or row[0] is None:
            raise TranslationFailure("unconfigured")
        return json.loads(row[0])
