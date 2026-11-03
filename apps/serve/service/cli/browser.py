"""Fixed-kind opaque browser storage over a bounded private binary pipe."""

from __future__ import annotations

import errno
import json
import os
import re
import secrets
import struct
import sys
from dataclasses import dataclass
from enum import StrEnum
from hashlib import sha256
from typing import BinaryIO

from service import paths
from service.platform import storage

VERSION = 1
HEADER_BYTES = 16 * 1024
SLOT_BYTES = 1024 * 1024
MAX_TERMINALS = 64
MAX_CLEANUP = 64
MAX_PRIVATE_STAGE_BYTES = 8 * 1024 * 1024 * 1024
MAX_PRIVATE_STAGE_ENTRIES = 130
MAX_PRIVATE_RECEIPT_ENTRIES = 66
MAX_SEQUENCE = (1 << 53) - 1
MAX_IDENTIFIER = 128
RECEIPT_BYTES = 4 * 1024
CHUNK_BYTES = 1024 * 1024
PREFIX = struct.Struct("!I")
DIGEST_PATTERN = re.compile(r"[a-f0-9]{64}\Z")
IDENTIFIER_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
OWNED_PATTERN = re.compile(r"(?:stage|tombstone|slot)-[a-f0-9]{64}\Z")
SLOT_SUFFIX = ".json"
SERVICE_DIRNAME = paths.SERVICE_DIR.name
COMMON_FIELDS = frozenset(("version", "requestId", "verb", "profileId", "payloadLength"))
SESSION_FIELDS = frozenset(("sessionId", "kind"))
SLOT_FIELDS = frozenset(
    ("version", "kind", "settledThrough", "retiredThrough", "active", "terminals", "cleanup")
)
RECEIPT_FIELDS = frozenset(
    (
        "operationId",
        "sequence",
        "verb",
        "requestId",
        "before",
        "after",
        "owned",
        "phase",
        "beforePresence",
        "resultPresence",
    )
)
TERMINAL_FIELDS = frozenset(
    (
        "operationId",
        "sequence",
        "verb",
        "requestId",
        "outcome",
        "result",
        "durability",
        "resultPresence",
    )
)
SNAPSHOT_FIELDS = frozenset(("digest", "identity"))
OWNED_FIELDS = frozenset(("name", "snapshot"))
BUSY_ERRORS = frozenset((errno.EAGAIN, errno.EWOULDBLOCK))


class Kind(StrEnum):
    VAULT = "vault"
    DOWNLOADS = "downloads"


class Verb(StrEnum):
    HANDSHAKE = "handshake"
    READ = "read"
    REPLACE = "replace"
    REMOVE = "remove"


class Outcome(StrEnum):
    COMMITTED = "committed"
    ABORTED = "aborted"
    NOCHANGE = "nochange"


class Phase(StrEnum):
    PREPARED = "prepared"
    ATTEMPTING = "attempting"


class Presence(StrEnum):
    PRESENT = "present"
    ABSENT = "absent"


class Code(StrEnum):
    INVALID = "invalid"
    CONFLICT = "conflict"
    UNKNOWN = "unknown"
    QUOTA = "quota"
    UNAVAILABLE = "unavailable"
    BUSY = "busy"
    RETIRED = "result_retired"


KINDS = {
    Kind.VAULT: (paths.BROWSER_VAULT_FILENAME, 16 * 1024 * 1024),
    Kind.DOWNLOADS: (paths.BROWSER_DOWNLOADS_FILENAME, 4 * 1024 * 1024),
}
BUDGETS = {
    "version": VERSION,
    "headerBytes": HEADER_BYTES,
    "payloadBytes": {kind.value: specification[1] for kind, specification in KINDS.items()},
}
VERB_FIELDS = {
    Verb.HANDSHAKE: frozenset(),
    Verb.READ: SESSION_FIELDS | {"operationId", "sequence"},
    Verb.REPLACE: SESSION_FIELDS | {"expectedDigest", "token"},
    Verb.REMOVE: SESSION_FIELDS | {"expectedDigest", "confirmDigest", "token"},
}


class Rejected(Exception):
    def __init__(self, code: Code):
        self.code = code


def reject(condition: bool, code: Code = Code.INVALID) -> None:
    if condition:
        raise Rejected(code)


def object_pairs(pairs):
    result = {}
    for key, value in pairs:
        reject(key in result)
        result[key] = value
    return result


def decode(raw: bytes):
    try:
        return json.loads(
            raw.decode("utf-8", errors="strict"),
            object_pairs_hook=object_pairs,
            parse_constant=lambda value: (_ for _ in ()).throw(Rejected(Code.INVALID)),
        )
    except (ValueError, UnicodeError):
        raise Rejected(Code.INVALID) from None


def encode(value) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def valid_identifier(value) -> bool:
    return isinstance(value, str) and IDENTIFIER_PATTERN.fullmatch(value) is not None


def valid_digest(value) -> bool:
    return value is None or isinstance(value, str) and DIGEST_PATTERN.fullmatch(value) is not None


def read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        piece = stream.read(min(CHUNK_BYTES, size - len(chunks)))
        if not piece:
            raise EOFError
        chunks.extend(piece)
    return bytes(chunks)


def read_request(stream: BinaryIO):
    prefix = stream.read(PREFIX.size)
    if not prefix:
        return None
    if len(prefix) != PREFIX.size:
        prefix += read_exact(stream, PREFIX.size - len(prefix))
    length = PREFIX.unpack(prefix)[0]
    reject(length < 1 or length > HEADER_BYTES)
    header = decode(read_exact(stream, length))
    reject(not isinstance(header, dict))
    try:
        verb = Verb(header.get("verb"))
    except ValueError:
        raise Rejected(Code.INVALID) from None
    required = COMMON_FIELDS | (frozenset() if verb == Verb.HANDSHAKE else SESSION_FIELDS)
    if verb in (Verb.REPLACE, Verb.REMOVE):
        required |= {"expectedDigest", "token"}
    if verb == Verb.REMOVE:
        required |= {"confirmDigest"}
    reject(not required <= header.keys() or header.keys() - COMMON_FIELDS - VERB_FIELDS[verb])
    reject(type(header["version"]) is not int or header["version"] != VERSION)
    reject(
        not valid_identifier(header["requestId"])
        or not isinstance(header["profileId"], str)
        or not DIGEST_PATTERN.fullmatch(header["profileId"])
    )
    size = header["payloadLength"]
    reject(type(size) is not int or size < 0)
    maximum = 0
    if verb != Verb.HANDSHAKE:
        try:
            kind = Kind(header["kind"])
        except ValueError:
            raise Rejected(Code.INVALID) from None
        reject(not valid_identifier(header["sessionId"]))
        maximum = KINDS[kind][1] if verb == Verb.REPLACE else 0
    reject(size > maximum)
    if verb in (Verb.REPLACE, Verb.REMOVE):
        reject(not valid_digest(header["expectedDigest"]) or not valid_identifier(header["token"]))
    if verb == Verb.REMOVE:
        reject(
            not valid_digest(header["confirmDigest"])
            or header["confirmDigest"] != header["expectedDigest"]
        )
    if verb == Verb.READ:
        query = "operationId" in header or "sequence" in header
        reject(
            query
            and (
                not valid_identifier(header.get("operationId"))
                or type(header.get("sequence")) is not int
                or header["sequence"] < 1
            )
        )
    return header, read_exact(stream, size)


def write_response(stream: BinaryIO, request_id: str, fields: dict, payload: bytes = b"") -> None:
    if "result" in fields and fields["result"]["identity"] is not None:
        fields = {
            **fields,
            "result": {
                **fields["result"],
                "identity": [format(part, "x") for part in fields["result"]["identity"]],
            },
        }
    header = encode(
        {**fields, "version": VERSION, "requestId": request_id, "payloadLength": len(payload)}
    )
    reject(len(header) > HEADER_BYTES)
    stream.write(PREFIX.pack(len(header)) + header + payload)
    stream.flush()


def validate_snapshot(value) -> bool:
    if (
        not isinstance(value, dict)
        or value.keys() != SNAPSHOT_FIELDS
        or not valid_digest(value["digest"])
    ):
        return False
    identity = value["identity"]
    return (identity is None and value["digest"] is None) or (
        value["digest"] is not None
        and isinstance(identity, list)
        and len(identity) == 2
        and all(type(part) is int and part >= 0 for part in identity)
    )


def validate_owned(value) -> bool:
    return (
        isinstance(value, dict)
        and value.keys() == OWNED_FIELDS
        and isinstance(value["name"], str)
        and OWNED_PATTERN.fullmatch(value["name"]) is not None
        and validate_snapshot(value["snapshot"])
        and value["snapshot"]["digest"] is not None
    )


def empty_snapshot():
    return {"digest": None, "identity": None}


def presence(snapshot):
    return Presence.ABSENT if snapshot["digest"] is None else Presence.PRESENT


@dataclass(frozen=True)
class Mutation:
    operation_id: str
    sequence: int
    digest: str | None


class Store:
    def __init__(self):
        self._root: storage.DirectoryHandle | None = None
        self._stages: storage.DirectoryHandle | None = None
        self._receipts: storage.DirectoryHandle | None = None
        self.profile = paths.storage_instance_id()
        self.session = secrets.token_hex(32)
        self.tokens: dict[Kind, tuple[str, Mutation]] = {}

    @property
    def root(self) -> storage.DirectoryHandle:
        if self._root is None:
            raise Rejected(Code.UNAVAILABLE)
        return self._root

    @property
    def stages(self) -> storage.DirectoryHandle:
        if self._stages is None:
            raise Rejected(Code.UNAVAILABLE)
        return self._stages

    @property
    def receipts(self) -> storage.DirectoryHandle:
        if self._receipts is None:
            raise Rejected(Code.UNAVAILABLE)
        return self._receipts

    def open(self):
        try:
            self._root = storage.open_private_directory(
                paths.SCHOLARSEED_HOME, (SERVICE_DIRNAME, paths.BROWSER_DIRNAME)
            )
            self._stages = storage.open_private_directory(
                paths.SCHOLARSEED_HOME,
                (SERVICE_DIRNAME, paths.BROWSER_DIRNAME, paths.BROWSER_STAGES_DIRNAME),
            )
            self._receipts = storage.open_private_directory(
                paths.SCHOLARSEED_HOME,
                (SERVICE_DIRNAME, paths.BROWSER_DIRNAME, paths.BROWSER_RECEIPTS_DIRNAME),
            )
        except BaseException:
            self.close()
            raise

    def close(self):
        errors = []
        for directory in (self._receipts, self._stages, self._root):
            if directory is not None:
                try:
                    directory.close()
                except BaseException as error:
                    errors.append(error)
        self._root = self._stages = self._receipts = None
        if errors:
            raise BaseExceptionGroup("store close failures", errors)

    def read_leaf(self, directory, name, maximum):
        try:
            descriptor = directory.open_private(name, os.O_RDONLY)
        except FileNotFoundError:
            return empty_snapshot(), b""
        try:
            before = os.fstat(descriptor)
            reject(before.st_size > maximum, Code.QUOTA)
            body = bytearray()
            while len(body) <= maximum:
                piece = os.read(descriptor, min(CHUNK_BYTES, maximum + 1 - len(body)))
                if not piece:
                    break
                body.extend(piece)
            reject(len(body) > maximum, Code.QUOTA)
            after = os.fstat(descriptor)
            current_descriptor = directory.open_private(name, os.O_RDONLY)
            try:
                current = os.fstat(current_descriptor)
            finally:
                os.close(current_descriptor)
            reject(not storage.stable_read_matches(before, after, current, len(body)), Code.UNKNOWN)
            return {
                "digest": sha256(body).hexdigest(),
                "identity": [after.st_dev, after.st_ino],
            }, bytes(body)
        finally:
            os.close(descriptor)

    def write_leaf(self, directory, name, body):
        descriptor = directory.open_private(name, os.O_RDWR | os.O_CREAT | os.O_EXCL)
        try:
            offset = 0
            while offset < len(body):
                written = os.write(descriptor, body[offset : offset + CHUNK_BYTES])
                reject(written <= 0, Code.UNKNOWN)
                offset += written
            os.fsync(descriptor)
            identity = os.fstat(descriptor)
            return {
                "digest": sha256(body).hexdigest(),
                "identity": [identity.st_dev, identity.st_ino],
            }
        finally:
            os.close(descriptor)

    def load_slot(self, kind):
        snapshot, body = self.read_leaf(self.receipts, kind + SLOT_SUFFIX, SLOT_BYTES)
        if snapshot["digest"] is None:
            return {
                "version": VERSION,
                "kind": kind,
                "settledThrough": 0,
                "retiredThrough": 0,
                "active": None,
                "terminals": [],
                "cleanup": [],
            }
        slot = decode(body)
        reject(not isinstance(slot, dict) or slot.keys() != SLOT_FIELDS, Code.UNKNOWN)
        reject(
            slot["version"] != VERSION or type(slot["version"]) is not int or slot["kind"] != kind,
            Code.UNKNOWN,
        )
        settled, retired = slot["settledThrough"], slot["retiredThrough"]
        reject(
            type(settled) is not int
            or type(retired) is not int
            or not 0 <= retired <= settled <= MAX_SEQUENCE
            or settled - retired > MAX_TERMINALS,
            Code.UNKNOWN,
        )
        reject(
            not isinstance(slot["terminals"], list) or not isinstance(slot["cleanup"], list),
            Code.UNKNOWN,
        )
        reject(
            len(slot["terminals"]) > MAX_TERMINALS or len(slot["cleanup"]) > MAX_CLEANUP,
            Code.UNKNOWN,
        )
        sequences = []
        for terminal in slot["terminals"]:
            reject(
                not isinstance(terminal, dict) or terminal.keys() != TERMINAL_FIELDS, Code.UNKNOWN
            )
            reject(
                not valid_identifier(terminal["operationId"])
                or not valid_identifier(terminal["requestId"])
                or terminal["verb"] not in (Verb.REPLACE, Verb.REMOVE)
                or terminal["outcome"] not in tuple(Outcome)
                or terminal["durability"] not in (storage.NAMESPACE_SYNCED, storage.FILE_FLUSHED)
                or not validate_snapshot(terminal["result"]),
                Code.UNKNOWN,
            )
            reject(terminal["resultPresence"] != presence(terminal["result"]), Code.UNKNOWN)
            sequence = terminal["sequence"]
            reject(type(sequence) is not int or not retired < sequence <= settled, Code.UNKNOWN)
            sequences.append(sequence)
        reject(sequences != list(range(retired + 1, settled + 1)), Code.UNKNOWN)
        reject(any(not validate_owned(owned) for owned in slot["cleanup"]), Code.UNKNOWN)
        active = slot["active"]
        if active is not None:
            reject(not isinstance(active, dict) or active.keys() != RECEIPT_FIELDS, Code.UNKNOWN)
            reject(
                type(active["sequence"]) is not int
                or active["sequence"] != settled + 1
                or not valid_identifier(active["operationId"])
                or not valid_identifier(active["requestId"])
                or active["verb"] not in (Verb.REPLACE, Verb.REMOVE)
                or active["phase"] not in tuple(Phase)
                or not validate_snapshot(active["before"])
                or not validate_snapshot(active["after"])
                or not validate_owned(active["owned"]),
                Code.UNKNOWN,
            )
            reject(
                active["beforePresence"] != presence(active["before"])
                or active["resultPresence"] != presence(active["after"]),
                Code.UNKNOWN,
            )
            reject(
                active["verb"] == Verb.REMOVE
                and (
                    active["after"] != empty_snapshot()
                    or active["owned"]["snapshot"] != active["before"]
                ),
                Code.UNKNOWN,
            )
            reject(
                active["verb"] == Verb.REPLACE and active["after"] != active["owned"]["snapshot"],
                Code.UNKNOWN,
            )
        return slot

    def save_slot(self, kind, slot):
        body = encode(slot)
        reject(len(body) > SLOT_BYTES, Code.QUOTA)
        self.receipts.private_usage(
            MAX_PRIVATE_RECEIPT_ENTRIES, MAX_PRIVATE_RECEIPT_ENTRIES * SLOT_BYTES
        )
        name = "slot-" + secrets.token_hex(32)
        self.write_leaf(self.receipts, name, body)
        return self.receipts.replace_private(name, kind + SLOT_SUFFIX)

    def settle(self, kind, slot, active, outcome, result, cleanup):
        terminal = {
            "operationId": active["operationId"],
            "sequence": active["sequence"],
            "requestId": active["requestId"],
            "verb": active["verb"],
            "outcome": outcome,
            "result": result,
            "resultPresence": presence(result),
            "durability": (
                storage.FILE_FLUSHED
                if os.name == storage.WINDOWS_PLATFORM
                else storage.NAMESPACE_SYNCED
            ),
        }
        slot["active"] = None
        slot["settledThrough"] = active["sequence"]
        slot["terminals"].append(terminal)
        if len(slot["terminals"]) > MAX_TERMINALS:
            retired = slot["terminals"].pop(0)
            slot["retiredThrough"] = retired["sequence"]
        if cleanup:
            reject(len(slot["cleanup"]) >= MAX_CLEANUP, Code.QUOTA)
            slot["cleanup"].append(active["owned"])
        self.save_slot(kind, slot)
        return terminal

    def recover(self, kind, slot):
        active = slot["active"]
        if active is None:
            return
        current, _ = self.read_leaf(self.root, KINDS[kind][0], KINDS[kind][1])
        owned, _ = self.read_leaf(self.stages, active["owned"]["name"], KINDS[kind][1])
        if active["verb"] == Verb.REPLACE:
            if current == active["before"] and owned == active["owned"]["snapshot"]:
                self.settle(kind, slot, active, Outcome.ABORTED, current, True)
                return
            if current == active["after"] and owned == empty_snapshot():
                self.root.sync()
                self.settle(kind, slot, active, Outcome.COMMITTED, current, False)
                return
        else:
            if current == active["before"] and owned == empty_snapshot():
                self.settle(kind, slot, active, Outcome.ABORTED, current, False)
                return
            if current == empty_snapshot() and owned == active["before"]:
                self.root.sync()
                self.settle(kind, slot, active, Outcome.COMMITTED, current, True)
                return
        raise Rejected(Code.UNKNOWN)

    def cleanup(self, kind, slot):
        remaining = []
        for owned in slot["cleanup"]:
            try:
                current, _ = self.read_leaf(self.stages, owned["name"], KINDS[kind][1])
                if current == empty_snapshot():
                    continue
                if current != owned["snapshot"]:
                    remaining.append(owned)
                    continue
                self.stages.remove_private(owned["name"])
            except (OSError, Rejected):
                remaining.append(owned)
        if remaining != slot["cleanup"]:
            slot["cleanup"] = remaining
            self.save_slot(kind, slot)

    def dispatch(self, header, payload):
        reject(header["profileId"] != self.profile)
        verb = Verb(header["verb"])
        if verb == Verb.HANDSHAKE:
            reject(self._root is not None)
            self.open()
            return {
                "sessionId": self.session,
                "profileId": self.profile,
                "budgets": BUDGETS,
            }, b""
        reject(header["sessionId"] != self.session or self._root is None)
        kind = Kind(header["kind"])
        with self.root.arbitration(paths.BROWSER_LOCK_FILENAME):
            slot = self.load_slot(kind)
            self.recover(kind, slot)
            self.cleanup(kind, slot)
            if verb == Verb.READ and "operationId" in header:
                sequence = header["sequence"]
                if sequence <= slot["retiredThrough"]:
                    raise Rejected(Code.RETIRED)
                for terminal in slot["terminals"]:
                    if (
                        terminal["sequence"] == sequence
                        and terminal["operationId"] == header["operationId"]
                    ):
                        return terminal, b""
                raise Rejected(Code.UNKNOWN)
            current, body = self.read_leaf(self.root, KINDS[kind][0], KINDS[kind][1])
            if verb == Verb.READ:
                token = secrets.token_hex(32)
                intent = Mutation(
                    secrets.token_hex(32), slot["settledThrough"] + 1, current["digest"]
                )
                self.tokens[kind] = token, intent
                return {
                    "digest": current["digest"],
                    "token": token,
                    "operationId": intent.operation_id,
                    "sequence": intent.sequence,
                }, body
            issued = self.tokens.get(kind)
            if issued is None:
                raise Rejected(Code.CONFLICT)
            reject(not secrets.compare_digest(issued[0], header["token"]), Code.CONFLICT)
            intent = issued[1]
            reject(
                intent.sequence != slot["settledThrough"] + 1
                or intent.digest != current["digest"]
                or header["expectedDigest"] != current["digest"],
                Code.CONFLICT,
            )
            self.tokens.pop(kind)
            reject(len(slot["cleanup"]) >= MAX_CLEANUP, Code.QUOTA)
            self.stages.private_usage(
                MAX_PRIVATE_STAGE_ENTRIES, MAX_PRIVATE_STAGE_BYTES - len(payload)
            )
            reject(slot["settledThrough"] >= MAX_SEQUENCE, Code.QUOTA)
            active = {
                "operationId": intent.operation_id,
                "sequence": intent.sequence,
                "requestId": header["requestId"],
                "verb": verb,
                "before": current,
                "after": empty_snapshot(),
                "owned": None,
                "phase": Phase.PREPARED,
                "beforePresence": presence(current),
                "resultPresence": Presence.ABSENT,
            }
            if (
                verb == Verb.REPLACE
                and current["digest"] == sha256(payload).hexdigest()
                or verb == Verb.REMOVE
                and current["digest"] is None
            ):
                terminal = self.settle(kind, slot, active, Outcome.NOCHANGE, current, False)
                return terminal, b""
            name = ("stage-" if verb == Verb.REPLACE else "tombstone-") + secrets.token_hex(32)
            after = (
                self.write_leaf(self.stages, name, payload)
                if verb == Verb.REPLACE
                else empty_snapshot()
            )
            active["after"] = after
            active["resultPresence"] = presence(after)
            active["owned"] = {"name": name, "snapshot": after if verb == Verb.REPLACE else current}
            reject(len(encode(active)) > RECEIPT_BYTES, Code.QUOTA)
            slot["active"] = active
            self.save_slot(kind, slot)
            checked, _ = self.read_leaf(self.root, KINDS[kind][0], KINDS[kind][1])
            reject(checked != current, Code.UNKNOWN)
            active["phase"] = Phase.ATTEMPTING
            self.save_slot(kind, slot)
            if verb == Verb.REPLACE:
                self.stages.replace_private(
                    name,
                    KINDS[kind][0],
                    exclusive=current["digest"] is None,
                    destination_directory=self.root,
                )
            else:
                self.root.replace_private(
                    KINDS[kind][0], name, exclusive=True, destination_directory=self.stages
                )
            final, _ = self.read_leaf(self.root, KINDS[kind][0], KINDS[kind][1])
            reject(final != after, Code.UNKNOWN)
            terminal = self.settle(
                kind, slot, active, Outcome.COMMITTED, after, verb == Verb.REMOVE
            )
            return terminal, b""


def main() -> int:
    if len(sys.argv) != 1:
        return 2
    store = Store()
    request_id = "invalid"
    try:
        while True:
            try:
                request = read_request(sys.stdin.buffer)
            except (Rejected, EOFError):
                return 2
            if request is None:
                return 0
            header, payload = request
            request_id = header["requestId"]
            try:
                fields, body = store.dispatch(header, payload)
                write_response(sys.stdout.buffer, request_id, fields, body)
            except Rejected as error:
                write_response(sys.stdout.buffer, request_id, {"code": error.code})
            except OSError as error:
                code = (
                    Code.BUSY
                    if error.errno in BUSY_ERRORS or getattr(error, "winerror", None) == 33
                    else Code.QUOTA if error.errno == errno.ENOSPC else Code.UNKNOWN
                )
                write_response(sys.stdout.buffer, request_id, {"code": code})
    except Exception:
        sys.stderr.write(Code.UNAVAILABLE + "\n")
        return 2
    finally:
        try:
            store.close()
        except BaseException:
            sys.stderr.write(Code.UNAVAILABLE + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
