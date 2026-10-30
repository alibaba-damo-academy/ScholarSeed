"""Project package registration into display-only skill attribution."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from service.platform.storage import filesystem_path

REGISTRATION_FILE_NAME = "registry.json"
MAX_REGISTRATION_BYTES = 64 * 1024
ATTRIBUTION_READY = "ready"
ATTRIBUTION_MISSING = "missing"
ATTRIBUTION_INVALID = "invalid"
ATTRIBUTION_UNAVAILABLE = "unavailable"
SOURCE_KINDS = frozenset({"original", "imported", "adapted"})
GITHUB_ORIGIN = "https://github.com"
GITHUB_REPOSITORY_PATH = re.compile(r"/([A-Za-z0-9-]+)/([A-Za-z0-9_.-]+)/?\Z")


def unavailable_attribution(status: str) -> dict[str, Any]:
    return {"attribution": None, "attributionStatus": status}


def parse_attribution(payload: bytes | None, name: str) -> dict[str, Any]:
    if payload is None:
        return unavailable_attribution(ATTRIBUTION_MISSING)
    if len(payload) > MAX_REGISTRATION_BYTES:
        return unavailable_attribution(ATTRIBUTION_INVALID)
    try:
        record = json.loads(payload)
        if not isinstance(record, dict) or record.get("slug") != name:
            raise ValueError("registration identity mismatch")
        authors = record.get("authors", [])
        source = record.get("source", {})
        if not isinstance(authors, list) or not all(
            isinstance(author, str) and author.strip() for author in authors
        ):
            raise ValueError("invalid authors")
        if not isinstance(source, dict):
            raise ValueError("invalid source")
        kind = source.get("kind", "")
        if kind and kind not in SOURCE_KINDS:
            raise ValueError("invalid source kind")
        repository_url = source.get("repository_url")
        repository_name = ""
        if repository_url is not None:
            if not isinstance(repository_url, str) or any(
                character.isspace() or ord(character) < 32 for character in repository_url
            ):
                raise ValueError("invalid repository URL")
            parsed = urlsplit(repository_url)
            match = GITHUB_REPOSITORY_PATH.fullmatch(parsed.path)
            if (
                parsed.scheme != "https"
                or parsed.netloc.lower() != "github.com"
                or parsed.query
                or parsed.fragment
                or not match
            ):
                raise ValueError("invalid GitHub repository URL")
            owner, repository = match.groups()
            repository = repository.removesuffix(".git")
            if repository in {"", ".", ".."}:
                raise ValueError("invalid repository name")
            repository_name = f"{owner}/{repository}"
            repository_url = f"{GITHUB_ORIGIN}/{repository_name}"
        path, revision = source.get("path") or "", source.get("revision") or ""
        if not isinstance(path, str) or not isinstance(revision, str):
            raise ValueError("invalid source reference")
        return {
            "attributionStatus": ATTRIBUTION_READY,
            "attribution": {
                "authors": list(dict.fromkeys(author.strip() for author in authors)),
                "repository_url": repository_url,
                "repository_name": repository_name,
                "path": path,
                "revision": revision,
                "kind": kind,
            },
        }
    except (ValueError, TypeError, RecursionError):
        return unavailable_attribution(ATTRIBUTION_INVALID)


def read_attribution(directory: Path, name: str) -> dict[str, Any]:
    path = filesystem_path(directory / REGISTRATION_FILE_NAME)
    try:
        if path.is_symlink():
            return unavailable_attribution(ATTRIBUTION_INVALID)
        if path.exists() and not path.is_file():
            return unavailable_attribution(ATTRIBUTION_INVALID)
        with path.open("rb") as stream:
            payload = stream.read(MAX_REGISTRATION_BYTES + 1)
    except FileNotFoundError:
        return unavailable_attribution(ATTRIBUTION_MISSING)
    except OSError:
        return unavailable_attribution(ATTRIBUTION_UNAVAILABLE)
    return parse_attribution(payload, name)
