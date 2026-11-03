"""Enabled component admission and durable, revision-pinned conversation bindings."""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping
from uuid import uuid4

from service.capabilities.service.descriptor import (
    HOST_COMPONENT_PLUGIN,
    PUBLIC_COMPONENT_SLOTS,
    validate_component_value,
)
from service.capabilities.service.ui import (
    UI_CATALOG_UNAVAILABLE,
    UI_COMPATIBILITY,
    UI_RESOURCE_PREFIX,
    UI_UNAVAILABLE,
    public_snapshot,
    read_catalog,
    resolve_ui,
)
from service.persistence.project import transaction

COMPONENT_PENDING = "pending"
COMPONENT_RESOLVED = "resolved"
COMPONENT_OBJECT_SCHEMA = {"type": "object"}
COMPONENT_PLUGIN_UNAVAILABLE = "component_plugin_unavailable"
UI_REVISION_INVALID = "ui_revision_invalid"
COMPONENT_COPY_MAX_BYTES = 64 * 1024
COMPONENT_COPY_SCHEMA = {
    "type": "object",
    "required": ["text"],
    "properties": {"text": {"type": "string", "minLength": 1}, "markdown": {"type": "string"}},
    "additionalProperties": False,
}
SLOT_OCCUPIED = "occupied"
SLOT_RESERVED = "reserved"
logger = logging.getLogger(__name__)
COMPONENT_SCHEMA = (
    "CREATE TABLE IF NOT EXISTS component_revisions (fingerprint TEXT PRIMARY KEY, plugin TEXT NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS component_slots (slot TEXT PRIMARY KEY, plugin TEXT NOT NULL, component TEXT NOT NULL, fingerprint TEXT NOT NULL REFERENCES component_revisions(fingerprint))",
    "CREATE TABLE IF NOT EXISTS component_bindings (binding TEXT PRIMARY KEY, plugin TEXT NOT NULL, component TEXT NOT NULL, fingerprint TEXT NOT NULL REFERENCES component_revisions(fingerprint), session_id TEXT NOT NULL, turn_id TEXT NOT NULL, user_id TEXT NOT NULL, data TEXT, state TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS component_unavailable (plugin TEXT PRIMARY KEY)",
    "CREATE TABLE IF NOT EXISTS component_copies (binding TEXT PRIMARY KEY REFERENCES component_bindings(binding), revision INTEGER NOT NULL, content TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS system_ui (compatibility TEXT PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL)",
)


class ComponentConflict(ValueError):
    def __init__(self, slot: str, owners: list[str]) -> None:
        super().__init__("component_slot_conflict")
        self.detail = {"code": str(self), "slot": slot, "plugins": owners}


class ComponentRegistry:
    def __init__(self, path: Path, *, authorize: Callable[[str, str], bool] | None = None) -> None:
        self.path = path
        self.authorize = authorize or (lambda _plugin, _user: True)
        self.mutation = asyncio.Lock()
        self._changing = False
        self._ready = False
        self._blocked = False
        self.ui_error: str | None = None

    def invalidate(self) -> None:
        self._ready = False
        self._blocked = True

    @contextmanager
    def changing(self) -> Iterator[None]:
        if self._changing:
            raise ValueError("component_registry_updating")
        self._changing = True
        try:
            yield
        finally:
            self._changing = False

    @contextmanager
    def _database(self) -> Iterator[Any]:
        with transaction(self.path, immediate=True) as connection:
            for statement in COMPONENT_SCHEMA:
                connection.execute(statement)
            yield connection

    def check(self, snapshots: list[dict[str, Any]]) -> dict[str, tuple[str, str, str]]:
        slots: dict[str, tuple[str, str, str]] = {}
        for snapshot in snapshots:
            plugin = snapshot["descriptor"]["id"]
            if plugin == HOST_COMPONENT_PLUGIN:
                raise ValueError("component_plugin_reserved")
            for component in snapshot["descriptor"]["components"]:
                slot = component.get("slot")
                if component.get("public"):
                    if slot not in PUBLIC_COMPONENT_SLOTS:
                        raise ValueError("component_public_invalid")
                    if component.get("entry"):
                        implementation = next(
                            (
                                item
                                for item in snapshot.get("ui", {}).get("components", [])
                                if item["slot"] == slot
                            ),
                            None,
                        )
                        if (
                            implementation is None
                            or component["entry"] != UI_RESOURCE_PREFIX + implementation["entry"]
                        ):
                            raise ValueError("component_public_invalid")
                    continue
                if slot in PUBLIC_COMPONENT_SLOTS:
                    raise ValueError("component_slot_reserved")
                if not slot:
                    continue
                if slot in slots:
                    raise ComponentConflict(slot, [slots[slot][0], plugin])
                slots[slot] = (plugin, component["id"], snapshot["fingerprint"])
        return slots

    def _ui(self, connection: Any) -> dict[str, Any] | None:
        row = connection.execute(
            "SELECT body,digest FROM system_ui WHERE compatibility=?", (UI_COMPATIBILITY,)
        ).fetchone()
        if row is None:
            return None
        if sha256(row["body"].encode()).hexdigest() != row["digest"]:
            raise ValueError(UI_REVISION_INVALID)
        return json.loads(row["body"])

    def _available_ui(self, connection: Any) -> dict[str, Any] | None:
        try:
            return self._ui(connection)
        except ValueError as error:
            self.ui_error = UI_REVISION_INVALID
            logger.warning("ui_dependency_unavailable failure_type=%s", type(error).__name__)
            return None

    def active_ui(self) -> dict[str, Any] | None:
        with self._database() as connection:
            return self._available_ui(connection)

    def ui_status(self) -> dict[str, Any]:
        ui = self.active_ui()
        return {
            "available": ui is not None,
            "error": None if ui is not None else self.ui_error or UI_UNAVAILABLE,
            "fingerprint": ui["fingerprint"] if ui is not None else None,
            "version": ui["version"] if ui is not None else None,
        }

    def ui_catalog(self) -> dict[str, Any]:
        if self._changing or self._blocked:
            raise ValueError("component_registry_updating")
        ui = self.active_ui()
        catalog = read_catalog(ui) if ui is not None else None
        return {
            "available": catalog is not None,
            "authorized": False,
            "error": None if catalog is not None else self.ui_error or UI_CATALOG_UNAVAILABLE,
            "fingerprint": ui["fingerprint"] if ui is not None else None,
            "catalog": catalog,
        }

    def dependencies(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        return resolve_ui(snapshot, self.active_ui())

    def install_ui(self, ui: dict[str, Any], *, initialize: bool = False) -> None:
        with self._database() as connection:
            previous = self._ui(connection)
            if previous is not None and initialize and previous["fingerprint"] == ui["fingerprint"]:
                return
            if previous is not None:
                if not set(previous["exports"]).issubset(ui["exports"]):
                    raise ValueError("ui_export_missing")
                for component in previous["components"]:
                    replacement = next(
                        (item for item in ui["components"] if item["slot"] == component["slot"]),
                        None,
                    )
                    if replacement is None or replacement["actions"] != component["actions"]:
                        raise ValueError("ui_component_incompatible")
            snapshots = [
                resolve_ui(self._revision(connection, row["fingerprint"]), ui)
                for row in connection.execute(
                    "SELECT DISTINCT fingerprint FROM component_slots"
                ).fetchall()
            ]
            slots = self.check(snapshots)
            body = json.dumps(ui, sort_keys=True, ensure_ascii=False, allow_nan=False)
            connection.execute(
                "INSERT INTO system_ui(compatibility,body,digest) VALUES(?,?,?) ON CONFLICT(compatibility) DO UPDATE SET body=excluded.body,digest=excluded.digest",
                (ui["compatibility"], body, sha256(body.encode()).hexdigest()),
            )
            for snapshot in snapshots:
                self._retain(connection, snapshot)
            for slot, owner in slots.items():
                connection.execute(
                    "UPDATE component_slots SET plugin=?,component=?,fingerprint=? WHERE slot=?",
                    (*owner, slot),
                )
        self.ui_error = None

    def publish(
        self, snapshots: list[dict[str, Any]], *, unavailable: frozenset[str] = frozenset()
    ) -> None:
        if HOST_COMPONENT_PLUGIN in unavailable:
            raise ValueError("component_plugin_reserved")
        with self._database() as connection:
            ui = self._available_ui(connection)
            snapshots = [
                (
                    snapshot
                    if snapshot["descriptor"]["id"] in unavailable
                    else resolve_ui(snapshot, ui)
                )
                for snapshot in snapshots
            ]
            slots = self.check(snapshots)
            for snapshot in snapshots:
                self._retain(connection, snapshot)
            connection.execute("DELETE FROM component_slots")
            connection.executemany(
                "INSERT INTO component_slots(slot,plugin,component,fingerprint) VALUES(?,?,?,?)",
                [(slot, *owner) for slot, owner in slots.items()],
            )
            connection.execute("DELETE FROM component_unavailable")
            connection.executemany(
                "INSERT INTO component_unavailable(plugin) VALUES(?)",
                [(plugin,) for plugin in sorted(unavailable)],
            )
        self._ready = True
        self._blocked = False

    def enabled_snapshots(self) -> list[dict[str, Any]]:
        with self._database() as connection:
            return [
                self._revision(connection, row["fingerprint"])
                for row in connection.execute(
                    "SELECT DISTINCT fingerprint FROM component_slots"
                ).fetchall()
            ]

    def has_claim(self, plugin: str) -> bool:
        with self._database() as connection:
            return (
                connection.execute(
                    "SELECT slot FROM component_slots WHERE plugin=? LIMIT 1", (plugin,)
                ).fetchone()
                is not None
            )

    def _retain(self, connection: Any, snapshot: dict[str, Any]) -> None:
        body = json.dumps(snapshot, sort_keys=True, ensure_ascii=False, allow_nan=False)
        digest = sha256(body.encode()).hexdigest()
        previous = connection.execute(
            "SELECT digest FROM component_revisions WHERE fingerprint=?", (snapshot["fingerprint"],)
        ).fetchone()
        if previous is not None and previous["digest"] != digest:
            raise ValueError("component_revision_changed")
        connection.execute(
            "INSERT OR IGNORE INTO component_revisions(fingerprint,plugin,body,digest) VALUES(?,?,?,?)",
            (snapshot["fingerprint"], snapshot["descriptor"]["id"], body, digest),
        )

    def preflight(self, slots: list[str]) -> dict[str, Any]:
        if self._changing or self._blocked:
            raise ValueError("component_registry_updating")
        if not self._ready:
            raise ValueError("component_registry_unavailable")
        result = []
        with self._database() as connection:
            for slot in dict.fromkeys(slots):
                occupied = (
                    connection.execute(
                        "SELECT 1 FROM component_slots WHERE slot=?", (slot,)
                    ).fetchone()
                    is not None
                )
                reason = (
                    SLOT_RESERVED
                    if slot in PUBLIC_COMPONENT_SLOTS
                    else SLOT_OCCUPIED if occupied else None
                )
                result.append({"slot": slot, "available": reason is None, "reason": reason})
        return {"slots": result, "authorized": False, "reserved": False}

    def catalog(self, *, user_id: str) -> list[dict[str, Any]]:
        if self._changing or self._blocked:
            raise ValueError("component_registry_updating")
        with self._database() as connection:
            rows = (
                connection.execute(
                    "SELECT * FROM component_slots WHERE plugin NOT IN "
                    "(SELECT plugin FROM component_unavailable) ORDER BY slot"
                ).fetchall()
                if self._ready
                else []
            )
            result = []
            for row in rows:
                if not self.authorize(row["plugin"], user_id):
                    continue
                snapshot = self._revision(connection, row["fingerprint"])
                component = next(
                    item
                    for item in snapshot["descriptor"]["components"]
                    if item["id"] == row["component"]
                )
                result.append({"plugin": row["plugin"], **component})
            return result + [
                {"plugin": HOST_COMPONENT_PLUGIN, "id": slot, "slot": slot, "public": True}
                for slot in sorted(PUBLIC_COMPONENT_SLOTS)
            ]

    def resolve(
        self, slot: str, *, session_id: str, turn_id: str, user_id: str, interaction_id: str = ""
    ) -> dict[str, str] | None:
        binding = (
            sha256(json.dumps([session_id, turn_id, interaction_id]).encode()).hexdigest()
            if interaction_id
            else uuid4().hex
        )
        with self._database() as connection:
            previous = connection.execute(
                "SELECT * FROM component_bindings WHERE binding=?", (binding,)
            ).fetchone()
            if previous is not None:
                old = self._revision(connection, previous["fingerprint"])
                component = next(
                    item
                    for item in old["descriptor"]["components"]
                    if item["id"] == previous["component"]
                )
                if component.get("slot") != slot or previous["user_id"] != user_id:
                    raise ValueError("component_binding_invalid")
                if not self.authorize(previous["plugin"], user_id):
                    raise ValueError("component_permission_denied")
                return {
                    key: previous[key] for key in ("plugin", "component", "fingerprint", "binding")
                }
            if self._changing or self._blocked:
                raise ValueError("component_registry_updating")
            if slot in PUBLIC_COMPONENT_SLOTS:
                snapshot = public_snapshot(slot, self._available_ui(connection))
                self._retain(connection, snapshot)
                row = {
                    "plugin": HOST_COMPONENT_PLUGIN,
                    "component": slot,
                    "fingerprint": snapshot["fingerprint"],
                }
            else:
                if not self._ready:
                    raise ValueError("component_registry_unavailable")
                row = connection.execute(
                    "SELECT * FROM component_slots WHERE slot=?", (slot,)
                ).fetchone()
            if row is None:
                return None
            if (
                connection.execute(
                    "SELECT plugin FROM component_unavailable WHERE plugin=?", (row["plugin"],)
                ).fetchone()
                is not None
            ):
                raise ValueError(COMPONENT_PLUGIN_UNAVAILABLE)
            if not self.authorize(row["plugin"], user_id):
                raise ValueError("component_permission_denied")
            connection.execute(
                "INSERT INTO component_bindings(binding,plugin,component,fingerprint,session_id,turn_id,user_id,data,state,revision,status) VALUES(?,?,?,?,?,?,?,NULL,?,0,?)",
                (
                    binding,
                    row["plugin"],
                    row["component"],
                    row["fingerprint"],
                    session_id,
                    turn_id,
                    user_id,
                    "{}",
                    COMPONENT_PENDING,
                ),
            )
            return {
                "plugin": row["plugin"],
                "component": row["component"],
                "fingerprint": row["fingerprint"],
                "binding": binding,
            }

    def _binding(self, connection: Any, reference: Mapping[str, Any], user_id: str) -> Any:
        row = connection.execute(
            "SELECT * FROM component_bindings WHERE binding=?", (str(reference.get("binding", "")),)
        ).fetchone()
        if (
            row is None
            or row["user_id"] != user_id
            or any(row[key] != reference.get(key) for key in ("plugin", "component", "fingerprint"))
        ):
            raise ValueError("component_binding_invalid")
        if not self.authorize(row["plugin"], user_id):
            raise ValueError("component_permission_denied")
        return row

    def _revision(self, connection: Any, fingerprint: str) -> dict[str, Any]:
        row = connection.execute(
            "SELECT body,digest FROM component_revisions WHERE fingerprint=?", (fingerprint,)
        ).fetchone()
        if row is None or sha256(row["body"].encode()).hexdigest() != row["digest"]:
            raise ValueError("component_revision_invalid")
        return json.loads(row["body"])

    def snapshot(self, reference: Mapping[str, Any], *, user_id: str) -> dict[str, Any]:
        with self._database() as connection:
            row = self._binding(connection, reference, user_id)
            result = self._revision(connection, row["fingerprint"])
            result["interaction"] = {
                "data": json.loads(row["data"]) if row["data"] is not None else None,
                "state": json.loads(row["state"]),
                "revision": row["revision"],
                "status": row["status"],
                "session_id": row["session_id"],
                "turn_id": row["turn_id"],
            }
            return result

    def validate(self, reference: Mapping[str, Any], *, session_id: str, user_id: str) -> None:
        with self._database() as connection:
            row = self._binding(connection, reference, user_id)
            if row["session_id"] != session_id:
                raise ValueError("component_binding_invalid")
            if row["status"] != COMPONENT_PENDING:
                raise ValueError("component_interaction_finished")
            self._revision(connection, row["fingerprint"])

    def bind_data(self, reference: Mapping[str, Any], data: Mapping[str, Any]) -> None:
        validate_component_value(COMPONENT_OBJECT_SCHEMA, data)
        encoded = json.dumps(data, sort_keys=True, ensure_ascii=False, allow_nan=False)
        with self._database() as connection:
            row = connection.execute(
                "SELECT * FROM component_bindings WHERE binding=?", (reference.get("binding"),)
            ).fetchone()
            if (
                row is None
                or any(
                    row[key] != reference.get(key) for key in ("plugin", "component", "fingerprint")
                )
                or (row["data"] is not None and row["data"] != encoded)
            ):
                raise ValueError("component_data_changed")
            connection.execute(
                "UPDATE component_bindings SET data=? WHERE binding=?",
                (encoded, reference["binding"]),
            )

    def draft(
        self,
        reference: Mapping[str, Any],
        *,
        session_id: str,
        user_id: str,
        values: Mapping[str, Any],
        expected_revision: int,
    ) -> dict[str, Any]:
        validate_component_value(COMPONENT_OBJECT_SCHEMA, values)
        self.validate(reference, session_id=session_id, user_id=user_id)
        with self._database() as connection:
            row = self._binding(connection, reference, user_id)
            if row["revision"] != expected_revision or row["status"] != COMPONENT_PENDING:
                raise ValueError("component_state_changed")
            revision = expected_revision + 1
            connection.execute(
                "UPDATE component_bindings SET state=?,revision=? WHERE binding=?",
                (json.dumps(values, allow_nan=False), revision, reference["binding"]),
            )
            connection.execute(
                "DELETE FROM component_copies WHERE binding=?", (reference["binding"],)
            )
            return {"state": dict(values), "revision": revision}

    def copy_content(
        self,
        reference: Mapping[str, Any],
        *,
        session_id: str,
        user_id: str,
        content: Mapping[str, str] | None = None,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        if content is not None:
            validate_component_value(COMPONENT_COPY_SCHEMA, content)
            encoded = json.dumps(content, ensure_ascii=False, allow_nan=False)
            if not content["text"].strip() or len(encoded.encode()) > COMPONENT_COPY_MAX_BYTES:
                raise ValueError("component_copy_invalid")
        with self._database() as connection:
            row = self._binding(connection, reference, user_id)
            if row["session_id"] != session_id:
                raise ValueError("component_binding_invalid")
            if content is not None:
                if type(expected_revision) is not int or row["revision"] != expected_revision:
                    raise ValueError("component_state_changed")
                connection.execute(
                    "INSERT INTO component_copies(binding,revision,content) VALUES(?,?,?) ON CONFLICT(binding) DO UPDATE SET revision=excluded.revision,content=excluded.content",
                    (reference["binding"], expected_revision, encoded),
                )
            saved = connection.execute(
                "SELECT content FROM component_copies WHERE binding=? AND revision=?",
                (reference["binding"], row["revision"]),
            ).fetchone()
            return {
                "content": json.loads(saved["content"]) if saved else None,
                "revision": row["revision"],
                "data": json.loads(row["data"]) if row["data"] is not None else None,
                "state": json.loads(row["state"]),
            }

    def finish(self, reference: Mapping[str, Any]) -> None:
        with self._database() as connection:
            connection.execute(
                "UPDATE component_bindings SET status=? WHERE binding=? AND fingerprint=?",
                (COMPONENT_RESOLVED, reference.get("binding"), reference.get("fingerprint")),
            )
