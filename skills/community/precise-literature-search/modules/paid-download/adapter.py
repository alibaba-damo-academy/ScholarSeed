#!/usr/bin/env scholarseed-skill-python
"""Adapt a user-provided paper-dl CLI to the paid-download contract."""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
from importlib.util import find_spec
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.parse import quote, urlparse
from urllib.request import ProxyHandler, Request, build_opener

SKILL_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILL_DIR / "scripts"))

from download_access import download_access
from filesystem import (  # noqa: E402
    WINDOWS,
    WINDOWS_PATH_BUDGET,
    canonical_path,
    filesystem_path,
    ordinary_windows_path,
    path_exists,
    windows_worst_path_length,
)
from io_utils import (  # noqa: E402
    atomic_write_json,
    atomic_write_text,
    read_json,
    title_pdf_relative_path,
    utc_now,
)
from platform_support import executable_command, venv_executable
from post_open_gate import paid_pending, paper_arxiv_id  # noqa: E402
from process_control import ChildProcessCancelled  # noqa: E402
from progress import update_progress  # noqa: E402
from stage_guard import require_download  # noqa: E402
from browser_pool import (  # noqa: E402
    BrowserPool, abandon, cancellation_signals, run_lock, validate_config,
)


AUTODEV_SKIPPED_REASONS = {
    "blocked_captcha_or_cloudflare",
    "needs_manual_solve",
    "needs_institutional_login",
    "institute_no_access",
    "skipped_by_user",
}

INTERACTIVE_ACTION_REASONS = {
    "blocked_captcha_or_cloudflare",
    "needs_manual_solve",
    "needs_institutional_login",
    "viewer_open_capture_failed",
}

INTERACTIVE_SKIPPED_REASONS = {
    "institute_no_access",
    "skipped_by_user",
}

MODES = {"interactive", "autodev"}
ZOTERO_MODES = {"off", "fallback", "desktop-first"}
BUNDLED_WHEEL_NAME = "paper_fulltext_dl-0.1.3-py3-none-any.whl"
# The downloader writes its library with native Win32 paths (vendor
# paper_dl/storage.py), so the cache lives at a short per-user root instead of
# inside the unbounded-depth run directory, mirroring the browser pool's home
# placement. Slugs are capped by the vendor (models.py: 100 readable chars +
# "--" + a 16-hex digest; 120 for legacy unhashed folders).
LIBRARY_HOME_PARTS = (".paper-dl", "library")
PAPER_DL_MAX_SLUG = 120
LONG_PATH_STATE = "long_path_blocked"
# Env var the ScholarSeed host injects to pin the product interpreter; its
# presence means this adapter already runs under that interpreter.
PRODUCT_PYTHON_ENV = "SCHOLARSEED_PYTHON"

# These are sign-in starting points only.  They are deliberately generic and
# never receive an identifier, account detail, cookie, or session token.
COMMON_PUBLISHER_PORTALS = [
    {
        "name": "IEEE Xplore",
        "url": "https://ieeexplore.ieee.org/",
        "hint": "Use your institution's normal IEEE Xplore sign-in, then open the article link above.",
    },
    {
        "name": "ScienceDirect (Elsevier)",
        "url": "https://www.sciencedirect.com/",
        "hint": "Use your institution's normal ScienceDirect sign-in, then open the article link above.",
    },
    {
        "name": "Springer Nature Link",
        "url": "https://link.springer.com/",
        "hint": "Use your institution's normal Springer Nature sign-in, then open the article link above.",
    },
]


def resolve_under_run(run_dir: Path, value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else run_dir / path


def require_under_run(run_dir: Path, path: Path, label: str) -> Path:
    """Containment-checked identity in ordinary form; I/O wraps at the boundary."""
    resolved = canonical_path(path)
    try:
        resolved.relative_to(canonical_path(run_dir))
    except ValueError as exc:
        raise ValueError(f"{label} must stay inside the run directory: {resolved}") from exc
    return resolved


def paper_dl_library_root() -> Path:
    """Short by-construction root for the paper-dl library cache.

    The downloader writes this tree with native Win32 calls, so it must never be
    derived from the run directory, whose depth is unbounded. Mirrors the
    browser pool's home placement.
    """
    return Path.home().joinpath(*LIBRARY_HOME_PARTS)


def ensure_paper_dl_paths_fit_budget(storage_dir: Path, attempt_root: Path) -> None:
    """Fail fast before any browser or downloader process starts.

    The external downloader writes and reads its paths with native Win32 calls
    and does not use extended-length prefixes, so every native path it can
    require (including atomic-write temp forms) must fit the Windows budget.
    POSIX has no such limit and the check is a no-op there.
    """
    if not WINDOWS:
        return
    slug = "i" * PAPER_DL_MAX_SLUG
    checked = (
        (storage_dir / slug, "metadata.json"),
        (attempt_root, "input.txt"),
        (attempt_root, "zotero-desktop-first.yaml"),
        (attempt_root / "output", "report.json"),
    )
    longest = max(windows_worst_path_length(directory, name) for directory, name in checked)
    if longest > WINDOWS_PATH_BUDGET:
        raise ValueError(
            f"{LONG_PATH_STATE}: a path the external downloader writes with native "
            f"Windows calls needs up to {longest} characters, past the "
            f"{WINDOWS_PATH_BUDGET}-character limit (LongPathsEnabled is off). Move "
            "the project workspace to a shallower location such as C:\\work\\papers, "
            "or ask an administrator to enable LongPathsEnabled, then resume this "
            "run. download_recovery.py skip-and-read can also complete the run "
            "without this download batch."
        )


def normalize_identifier(value: str) -> str:
    normalized = value.strip().lower()
    normalized = re.sub(r"^https?://(?:dx\.)?doi\.org/", "", normalized)
    normalized = re.sub(r"^doi:\s*", "", normalized)
    return normalized.rstrip("/")


def paper_needs_paid_download(paper: dict[str, Any]) -> bool:
    """Route everything except confirmed arXiv OA into paper-dl."""
    if str(paper.get("document_type", "")).strip().casefold() in {
        "blog", "documentation", "dataset", "web_page",
    }:
        return False
    confirmed_oa = str(paper.get("open_access", "")).strip().casefold() == "yes"
    return not (confirmed_oa and paper_arxiv_id(paper) is not None)


def paper_identifier(paper: dict[str, Any]) -> str | None:
    doi = paper.get("doi")
    if isinstance(doi, str) and doi.strip():
        return normalize_identifier(doi)
    arxiv_id = paper_arxiv_id(paper)
    if arxiv_id:
        return arxiv_id
    url = paper.get("url")
    if isinstance(url, str) and url.startswith(("http://", "https://")):
        return url.strip()
    paper_id = paper.get("id")
    if isinstance(paper_id, str):
        if paper_id.startswith(("http://", "https://")):
            return paper_id
        if paper_id.lower().startswith("doi:"):
            return normalize_identifier(paper_id)
        if paper_id.lower().startswith("arxiv:"):
            return paper_id.split(":", 1)[1].strip()
    return None


def paper_action_url(paper: dict[str, Any]) -> str | None:
    """Return a non-secret article URL the user can open in the CDP browser."""
    doi = paper.get("doi")
    if isinstance(doi, str) and doi.strip():
        return f"https://doi.org/{normalize_identifier(doi)}"
    arxiv_id = paper_arxiv_id(paper)
    if arxiv_id:
        return f"https://arxiv.org/abs/{arxiv_id}"
    url = paper.get("url")
    if isinstance(url, str):
        parsed = urlparse(url.strip())
        if parsed.scheme in {"http", "https"} and parsed.hostname:
            return parsed._replace(query="", fragment="").geturl()
    paper_id = paper.get("id")
    if isinstance(paper_id, str) and paper_id.lower().startswith("doi:"):
        return f"https://doi.org/{normalize_identifier(paper_id)}"
    if isinstance(paper_id, str) and paper_id.lower().startswith("arxiv:"):
        arxiv_id = paper_id.split(":", 1)[1].strip()
        if arxiv_id:
            return f"https://arxiv.org/abs/{arxiv_id}"
    return None


def action_papers(papers: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Build safe direct article links for a user-facing action payload."""
    links: list[dict[str, str]] = []
    for paper in papers:
        url = paper_action_url(paper)
        if not url:
            candidate = paper.get("action_url") or paper.get("url")
            if isinstance(candidate, str):
                parsed = urlparse(candidate.strip())
                if parsed.scheme in {"http", "https"} and parsed.hostname:
                    url = parsed._replace(query="", fragment="").geturl()
        if not url:
            continue
        title = " ".join(str(paper.get("title") or "Untitled").split())[:240]
        links.append({
            "paper_id": str(paper.get("paper_id", paper.get("id", "unknown"))),
            "title": title or "Untitled",
            "url": url,
        })
    return links


def action_papers_from_manifest(items: dict[str, dict[str, Any]]) -> list[dict[str, str]]:
    """Return direct links for papers that still require user intervention."""
    return action_papers([
        item for item in items.values()
        if item.get("status") == "action_required"
    ])


def has_institutional_login_action(items: dict[str, dict[str, Any]]) -> bool:
    return any(
        item.get("status") == "action_required"
        and item.get("action_reason") == "needs_institutional_login"
        for item in items.values()
    )


def bundled_wheel_path() -> Path:
    return SKILL_DIR / "vendor" / BUNDLED_WHEEL_NAME


def installed_venv_executable() -> Path:
    return venv_executable(SKILL_DIR / ".venv", "paper-dl")


def resolve_paper_dl() -> tuple[list[str], Path | None, str]:
    configured = os.getenv("PAPER_DL_EXECUTABLE")
    if configured:
        candidate = Path(configured).expanduser()
        if not candidate.is_absolute():
            found = shutil.which(configured)
            if found:
                candidate = Path(found)
        if not candidate.is_file():
            raise ValueError(f"PAPER_DL_EXECUTABLE does not name a file: {configured}")
        candidate = candidate.resolve()
        command = executable_command([candidate])
        return command, None, str(candidate)

    root_value = os.getenv("PAPER_DL_ROOT")
    if root_value:
        root = Path(root_value).expanduser().resolve()
        if not (root / "pyproject.toml").is_file():
            raise ValueError(f"PAPER_DL_ROOT is not a paper-dl source tree: {root}")
        source_executable = venv_executable(root / ".venv", "paper-dl")
        if source_executable.is_file():
            return [str(source_executable)], root, str(source_executable)
        uv = shutil.which("uv")
        if uv:
            return [uv, "run", "--project", str(root), "paper-dl"], root, f"uv project {root}"
        raise ValueError(
            f"paper-dl executable is missing at {source_executable} and uv is unavailable under PAPER_DL_ROOT: {root}"
        )

    # Product path: paper_dl is provisioned into this host-pinned interpreter.
    # Use the module entry — the pip-generated `paper-dl` console script carries
    # a build-machine-absolute shebang that breaks once the bundle is relocated.
    if os.getenv(PRODUCT_PYTHON_ENV):
        if find_spec("paper_dl") is None:
            raise ValueError(
                "paper_dl is not importable by the active product interpreter; the "
                f"bundled runtime for {bundled_wheel_path()} is missing. Report an "
                "environment blocker; do not install dependencies or switch "
                "environments during the run."
            )
        return [sys.executable, "-m", "paper_dl"], None, f"{sys.executable} -m paper_dl"

    local_executable = installed_venv_executable()
    if local_executable.is_file():
        local_executable = local_executable.resolve()
        return [str(local_executable)], None, str(local_executable)

    found = shutil.which("paper-dl")
    if found:
        return [found], None, found
    raise ValueError(
        "paper-dl is unavailable; install and configure "
        f"the runtime for {bundled_wheel_path()} and expose it through "
        "the Skill .venv, PATH, or PAPER_DL_EXECUTABLE. "
        "Report an environment blocker; do not install dependencies during the run."
    )


def _optional_file_env(name: str) -> Path | None:
    value = os.getenv(name)
    if not value:
        return None
    path = Path(value).expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"{name} does not name a file: {path}")
    return path


def paid_download_mode() -> str:
    mode = os.getenv("PAPER_DL_MODE", "interactive").strip().lower()
    if mode not in MODES:
        raise ValueError("PAPER_DL_MODE must be interactive or autodev")
    return mode


def paid_download_zotero_mode(mode: str) -> str:
    """Resolve the explicit Zotero integration policy for a paper-dl run."""
    configured = os.getenv("PAPER_DL_ZOTERO_MODE")
    if configured is None or not configured.strip():
        zotero_mode = "off"
    else:
        zotero_mode = configured.strip().lower()
    if zotero_mode not in ZOTERO_MODES:
        raise ValueError(
            "PAPER_DL_ZOTERO_MODE must be off, fallback, or desktop-first"
        )
    if mode == "autodev" and zotero_mode != "off":
        raise ValueError(
            "PAPER_DL_ZOTERO_MODE fallback/desktop-first requires interactive CDP mode; "
            "use PAPER_DL_ZOTERO_MODE=off with PAPER_DL_MODE=autodev"
        )
    return zotero_mode


def open_action_papers_in_cdp(
    endpoint: str,
    papers: list[dict[str, str]],
    timeout: float = 2.0,
) -> tuple[list[str], list[str]]:
    """Open action-required article pages in the already verified CDP browser."""
    opener = build_opener(ProxyHandler({}))
    opened_ids: list[str] = []
    errors: list[str] = []
    seen_urls: set[str] = set()
    for paper in papers[:25]:
        paper_id = str(paper.get("paper_id") or "unknown")
        url = paper.get("url")
        if not isinstance(url, str) or url in seen_urls:
            continue
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            continue
        seen_urls.add(url)
        request = Request(
            f"{endpoint}/json/new?{quote(url, safe='')}",
            headers={"Accept": "application/json"},
            method="PUT",
        )
        try:
            with opener.open(request, timeout=timeout) as response:
                payload = json.loads(response.read(64 * 1024).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("CDP did not return a target object")
            opened_ids.append(paper_id)
        except (OSError, URLError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            errors.append(f"{paper_id}: {exc}")
    if len(papers) > 25:
        errors.append(f"Only the first 25 of {len(papers)} action pages were opened.")
    return opened_ids, errors


def cdp_setup_action(
    endpoint: str,
    action_type: str = "browser_intervention",
    zotero_mode: str = "off",
    papers: list[dict[str, Any]] | None = None,
    include_publisher_portals: bool = False,
) -> dict[str, Any]:
    instructions = [
        "Use the browser window assigned to this run by the browser pool; do not start another browser or use your daily profile."
    ]
    if zotero_mode != "off":
        instructions.extend([
            "Zotero Desktop and Connector must already be installed; report an environment blocker if either is unavailable.",
            "Start Zotero Desktop and enable Settings > Advanced > Allow other applications on this computer to communicate with Zotero.",
        ])
    instructions.extend([
        "Complete institutional login/SSO in that browser if the selected publishers require it.",
        "Keep the browser window open, then resume this run after the local CDP endpoint is ready.",
        (
            "If a CAPTCHA or Zotero item selector appears during download, resolve it manually; paper-dl will continue automatically."
            if zotero_mode != "off"
            else "If a CAPTCHA appears during download, resolve it manually; paper-dl will continue automatically."
        ),
    ])
    action: dict[str, Any] = {
        "type": action_type,
        "title": (
            "Authorized Chrome or Edge and Zotero Desktop access are required for paper-dl candidates"
            if zotero_mode != "off"
            else "Authorized browser access is required for paper-dl candidates"
        ),
        "endpoint": endpoint,
        "browser_pool_managed": True,
        "zotero_mode": zotero_mode,
        "requires_zotero_desktop": zotero_mode != "off",
        "instructions": instructions,
        "safe_to_close_cdp_browser": False,
        "safe_to_close_zotero_desktop": zotero_mode == "off",
    }
    if papers:
        action["papers"] = action_papers(papers)
    if include_publisher_portals:
        action["common_publisher_portals"] = COMMON_PUBLISHER_PORTALS
    return action


def build_external_command(
    base_command: list[str],
    identifiers_path: Path,
    storage_dir: Path,
    report_dir: Path,
    paper_timeout: float,
    mode: str,
    zotero_mode: str,
    endpoint: str | None = None,
    config: Path | None = None,
) -> list[str]:
    command = base_command + [
        "--input", str(identifiers_path),
        "--storage", str(storage_dir),
        "--out", str(report_dir),
        "--paper-timeout", str(paper_timeout),
        "--prefer-oa",
    ]
    if zotero_mode == "off":
        command.append("--no-zotero")
    elif zotero_mode == "fallback":
        command.append("--zotero-save")
    elif zotero_mode == "desktop-first":
        if config is None:
            raise ValueError("desktop-first Zotero mode requires an adapter-generated config")
    else:
        raise ValueError(f"unsupported Zotero mode: {zotero_mode}")
    if not endpoint:
        raise ValueError("paper-dl/non-arXiv download requires a browser-pool CDP endpoint")
    command.extend(["--connect-cdp", endpoint, "--no-headless", "--keep-open"])
    if mode == "autodev":
        command.append("--autodev")
    if config:
        command.extend(["--config", str(config)])
    email = os.getenv("PAPER_DL_EMAIL")
    if email:
        command.extend(["--email", email])
    return command


def summarize(items: list[dict[str, Any]], selected_count: int) -> dict[str, int]:
    return {
        "selected": selected_count,
        "downloaded": sum(item["status"] == "downloaded" for item in items),
        "action_required": sum(item["status"] == "action_required" for item in items),
        "failed": sum(item["status"] == "failed" for item in items),
        "skipped": sum(item["status"] == "skipped" for item in items),
    }


def refresh_existing_access(existing: dict[str, dict[str, Any]],
                            papers_by_id: dict[str, dict[str, Any]]) -> None:
    # Older manifests used the module name as access evidence. Refresh only
    # these descriptive fields; verified files and resume state stay intact.
    for existing_id, item in existing.items():
        paper = papers_by_id.get(existing_id)
        route = item.get("download_route")
        if route == "paid-download" or (route is None and paper and paper_arxiv_id(paper) is None and paper_needs_paid_download(paper)):
            evidence = download_access(paper, "paid-download")
            if route == "paid-download" and item.get("access_type") == "open":
                evidence["access_type"] = "open"
            item.update(evidence)


def pdf_sha256(path: Path) -> str:
    with filesystem_path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def paper_file_binding(paper: dict[str, Any], run_dir: Path) -> tuple[Path, dict, str, str]:
    """Load the run-local write-ahead identity ledger; never infer from titles."""
    path = require_under_run(run_dir, run_dir / "downloads/paper-dl-files.json", "paper-dl file index")
    ledger = read_json(path) if path_exists(path) else {"schema_version": "1.0", "files": {}}
    if (not isinstance(ledger, dict) or ledger.get("schema_version") != "1.0"
            or not isinstance(ledger.get("files"), dict)
            or any(not isinstance(value, dict) for value in ledger["files"].values())):
        raise ValueError("invalid paper-dl file identity index")
    # Hash identifiers so URL query strings or credentials are not copied here.
    identifier_hash = hashlib.sha256(str(paper_identifier(paper) or paper.get("id")).encode()).hexdigest()
    key = hashlib.sha256(json.dumps([str(paper.get("id", "unknown")), identifier_hash]).encode()).hexdigest()
    return path, ledger, key, identifier_hash


def result_item(
    paper: dict[str, Any],
    external: dict[str, Any] | None,
    run_dir: Path,
    mode: str = "autodev",
    occupied_paths: set[str] | None = None,
    preferred_path: str | None = None,
    claimed_paths: set[str] | None = None,
) -> dict[str, Any]:
    paper_id = str(paper.get("id", "unknown"))
    title = str(paper.get("title") or (external or {}).get("title") or "Untitled")
    if external is None:
        return {
            "paper_id": paper_id, "title": title, **download_access(paper, "paid-download", external),
            "status": "failed", "file_path": None, "content_type": None,
            "verified_exists": False,
            "message": "paper-dl report did not contain a result for this identifier.",
        }
    status = external.get("status")
    reason = str(external.get("reason") or "unknown_error")
    action_reason = str(external.get("action_reason") or reason)
    if (
        mode == "interactive"
        and str(external.get("institution_access_state") or "").strip().casefold()
        == "needs_login"
    ):
        action_reason = "needs_institutional_login"
    if status not in {"success", "cached"}:
        if mode == "interactive" and (
            action_reason in INTERACTIVE_ACTION_REASONS
            or reason in INTERACTIVE_ACTION_REASONS
            or external.get("manual_challenge") is True
        ):
            if action_reason == "viewer_open_capture_failed":
                target = title_pdf_relative_path(
                    title,
                    paper_id,
                    occupied_paths or set(),
                    preferred_path,
                ).as_posix()
                safe_url = paper_action_url(paper)
                message = (
                    "The PDF opened successfully in the dedicated browser viewer, "
                    "but automatic byte capture failed. Save the displayed PDF to "
                    f"{(run_dir / target).resolve()}, then run the existing manual "
                    "download verification step; it will require a %PDF- signature."
                )
            elif action_reason == "needs_institutional_login":
                message = (
                    "Institutional login is required. Complete SSO/login in the dedicated "
                    "CDP browser, keep it open, then resume this run."
                )
            else:
                message = (
                    "A CAPTCHA or human-verification step still needs attention. Solve it "
                    "in the dedicated CDP browser, keep it open, then resume this run."
                )
            return {
                "paper_id": paper_id, "title": title, **download_access(paper, "paid-download", external),
                "status": "action_required", "file_path": None,
                "content_type": None, "verified_exists": False,
                "message": f"{message} paper-dl reason: {reason}.",
                "action_url": safe_url if action_reason == "viewer_open_capture_failed"
                else paper_action_url(paper),
                "action_reason": action_reason,
                **(
                    {
                        "target_file": target,
                        "verification": (
                            "Run download_recovery.py verify-manual; the target "
                            "must stay inside this run and start with %PDF-."
                        ),
                    }
                    if action_reason == "viewer_open_capture_failed"
                    else {}
                ),
            }
        skipped_reasons = (
            AUTODEV_SKIPPED_REASONS if mode == "autodev" else INTERACTIVE_SKIPPED_REASONS
        )
        skipped = reason in skipped_reasons
        prefix = (
            "Skipped in paper-dl --autodev"
            if skipped and mode == "autodev"
            else "Skipped by interactive paper-dl"
            if skipped
            else "paper-dl failed"
        )
        return {
            "paper_id": paper_id, "title": title, **download_access(paper, "paid-download", external),
            "status": "skipped" if skipped else "failed", "file_path": None,
            "content_type": None, "verified_exists": False,
            "message": f"{prefix}: {reason}.",
        }
    if external.get("content_type", "pdf") != "pdf":
        return {
            "paper_id": paper_id, "title": title, **download_access(paper, "paid-download", external),
            "status": "failed", "file_path": None, "content_type": None,
            "verified_exists": False,
            "message": "paper-dl returned non-PDF full text, which this reader contract does not accept.",
        }

    chosen: Path | None = None
    run_root = canonical_path(run_dir)
    for key in ("original_path",):
        value = external.get(key)
        if not isinstance(value, str) or not value:
            continue
        try:
            candidate = Path(value).expanduser()
            if not candidate.is_absolute():
                candidate = run_root / candidate
            candidate = canonical_path(candidate)
            # The external downloader may only feed this adapter from the run
            # area or from the library root this adapter selected for it.
            if not (
                candidate.is_relative_to(run_root)
                or candidate.is_relative_to(canonical_path(paper_dl_library_root()))
            ):
                continue
            candidate_file = filesystem_path(candidate)
            if not candidate_file.is_file():
                continue
            with candidate_file.open("rb") as handle:
                signature = handle.read(5)
            if signature == b"%PDF-":
                chosen = candidate
                break
        except (OSError, ValueError):
            continue
    if chosen is None:
        # Recover a moved file only with this paper's persisted identity/hash.
        try:
            _, ledger, key, identifier_hash = paper_file_binding(paper, run_dir)
            binding = ledger["files"].get(key, {})
            relative = binding.get("file_path")
            if (binding.get("paper_id") == paper_id
                    and binding.get("identifier_sha256") == identifier_hash
                    and isinstance(relative, str)
                    and Path(relative).parent == Path("downloads/papers")
                    and Path(relative).suffix.casefold() == ".pdf"
                    and relative not in (claimed_paths or set())):
                destination = require_under_run(run_dir, run_dir / relative, "bound paper-dl PDF")
                with filesystem_path(destination).open("rb") as handle:
                    valid_pdf = handle.read(5) == b"%PDF-"
                if valid_pdf and pdf_sha256(destination) == binding.get("sha256"):
                    return {
                        "paper_id": paper_id, "title": title, **download_access(paper, "paid-download", external),
                        "status": "downloaded", "file_path": relative,
                        "content_type": "application/pdf", "verified_exists": True,
                        "message": "Verified identity and SHA-256 of the paper-dl PDF already present after its source was moved.",
                    }
        except (OSError, ValueError):
            pass
        return {
            "paper_id": paper_id, "title": title, **download_access(paper, "paid-download", external),
            "status": "failed", "file_path": None, "content_type": None,
            "verified_exists": False,
            "message": "paper-dl reported success but no identity-bound verified PDF existed inside the run directory; retry acquisition or use explicit manual recovery.",
        }
    # Existing unbound files remain intact, including files from older rounds.
    occupied = set(occupied_paths or set()) | {
        Path(ordinary_windows_path(entry)).relative_to(run_dir).as_posix()
        for entry in filesystem_path(run_dir / "downloads/papers").glob("*")
    }
    if chosen.is_relative_to(run_root):
        occupied.discard(chosen.relative_to(run_root).as_posix())
    relative_path = title_pdf_relative_path(
        title,
        paper_id,
        occupied,
        preferred=preferred_path,
    )
    destination = require_under_run(
        run_dir,
        run_dir / relative_path,
        "title-based paper PDF path",
    )
    copied_source = False
    cleanup_messages: list[str] = []
    try:
        index_path, ledger, key, identifier_hash = paper_file_binding(paper, run_dir)
        source_hash = pdf_sha256(chosen)
        ledger["files"][key] = {
            "paper_id": paper_id, "identifier_sha256": identifier_hash,
            "file_path": relative_path.as_posix(), "sha256": source_hash,
        }
        # Persist before os.replace so a crash after the move remains recoverable.
        atomic_write_json(index_path, ledger)
        if canonical_path(chosen) != canonical_path(destination):
            filesystem_path(destination.parent).mkdir(parents=True, exist_ok=True)
            try:
                os.replace(filesystem_path(chosen), filesystem_path(destination))
            except OSError as exc:
                if exc.errno != errno.EXDEV:
                    raise
                staging: Path | None = None
                try:
                    with tempfile.NamedTemporaryFile(
                        dir=filesystem_path(destination.parent),
                        prefix=f".{destination.name}.staging-",
                        delete=False,
                    ) as staging_handle:
                        staging = Path(staging_handle.name)
                        with filesystem_path(chosen).open("rb") as source_handle:
                            shutil.copyfileobj(source_handle, staging_handle)
                    os.replace(filesystem_path(staging), filesystem_path(destination))
                    copied_source = True
                finally:
                    if staging is not None:
                        try:
                            filesystem_path(staging).unlink(missing_ok=True)
                        except OSError as cleanup_exc:
                            cleanup_messages.append(f"Temporary PDF cleanup failed: {cleanup_exc}.")
        with filesystem_path(destination).open("rb") as handle:
            if handle.read(5) != b"%PDF-":
                raise OSError("moved paper-dl PDF failed verification")
        if pdf_sha256(destination) != source_hash:
            raise OSError("moved paper-dl PDF content hash changed")
    except (OSError, ValueError) as exc:
        return {
            "paper_id": paper_id, "title": title, **download_access(paper, "paid-download", external),
            "status": "failed", "file_path": None, "content_type": None,
            "verified_exists": False,
            "message": " ".join([
                f"paper-dl PDF could not be moved into downloads/papers: {exc}",
                *cleanup_messages,
            ]),
        }
    if copied_source:
        try:
            filesystem_path(chosen).unlink(missing_ok=True)
        except OSError as exc:
            cleanup_messages.append(f"Verified PDF delivered; source cache cleanup failed: {exc}.")
    relative = relative_path.as_posix()
    return {
        "paper_id": paper_id, "title": title, **download_access(paper, "paid-download", external),
        "status": "downloaded", "file_path": relative,
        "content_type": "application/pdf", "verified_exists": True,
        "message": " ".join([
            f"Downloaded by paper-dl in {mode} mode ({status}) and moved to the papers directory.",
            *cleanup_messages,
        ]),
    }


def verified_manifest_download(item: Any, run_dir: Path) -> bool:
    """Return true only for a still-valid downloaded PDF inside this run."""
    if not isinstance(item, dict):
        return False
    if item.get("status") != "downloaded" or item.get("verified_exists") is not True:
        return False
    file_value = item.get("file_path")
    if not isinstance(file_value, str) or not file_value:
        return False
    try:
        candidate = require_under_run(
            run_dir,
            resolve_under_run(run_dir, file_value),
            "existing downloaded file",
        )
        if not filesystem_path(candidate).is_file():
            return False
        with filesystem_path(candidate).open("rb") as handle:
            return handle.read(5) == b"%PDF-"
    except (OSError, ValueError):
        return False


def make_manifest(
    selection: dict[str, Any],
    items_by_id: dict[str, dict[str, Any]],
    is_placeholder: bool,
    warnings: list[str],
    status: str,
    mode: str,
    zotero_mode: str,
    external_report: str | None = None,
) -> dict[str, Any]:
    items = list(items_by_id.values())
    manifest: dict[str, Any] = {
        "schema_version": "1.0",
        "run_id": selection.get("run_id", "unknown"),
        "generated_at": utc_now(),
        "is_placeholder": is_placeholder,
        "status": status,
        "papers": items,
        "summary": summarize(items, len(selection.get("selected_paper_ids", []))),
        "warnings": warnings,
        "adapter": {
            "name": "paper-dl",
            "mode": mode,
            "autodev": mode == "autodev",
            "cdp": True,
            "zotero_mode": zotero_mode,
        },
    }
    if external_report:
        manifest["external_report"] = external_report
    return manifest


def _run_locked(args: argparse.Namespace, run_dir: Path) -> int:
    lease = None
    paused = False
    try:
        require_download(run_dir, args.input, "paid-download")
        mode = paid_download_mode()
        zotero_mode = paid_download_zotero_mode(mode)
        endpoint = None
        validate_config()
        selection_path = require_under_run(run_dir, args.input, "selection input")
        output_path = require_under_run(run_dir, args.output, "paid output")
        selection = read_json(selection_path)
        if not isinstance(selection, dict) or selection.get("confirmed_by_user") is not True:
            raise ValueError("paper-dl/non-arXiv download requires a user-confirmed selection")
        if args.resume and selection.get("download_paid") is not True:
            raise ValueError("resume refused because download_paid is not enabled")
        metadata_value = selection.get("metadata_path")
        selected = selection.get("selected_paper_ids")
        if not isinstance(metadata_value, str) or not isinstance(selected, list):
            raise ValueError("selection needs metadata_path and selected_paper_ids")
        update_progress(
            run_dir,
            stage="download",
            activity="Preparing paper-dl/non-arXiv downloads",
            current=0,
            total=len(selected),
            completed=0,
            emit=lambda message: print(message, flush=True),
        )
        metadata_path = require_under_run(
            run_dir, resolve_under_run(run_dir, metadata_value), "selection metadata"
        )
        metadata = read_json(metadata_path)
        if not isinstance(metadata, dict) or not isinstance(metadata.get("papers"), list):
            raise ValueError("selection metadata must contain a papers array")
        papers_by_id = {
            str(paper.get("id")): paper
            for paper in metadata["papers"]
            if isinstance(paper, dict) and paper.get("id") is not None
        }
        existing: dict[str, dict[str, Any]] = {}
        existing_placeholder = False
        output_file = filesystem_path(output_path)
        if output_file.is_file() and output_file.stat().st_size:
            previous = read_json(output_path)
            existing_placeholder = bool(previous.get("is_placeholder"))
            existing = {
                str(item.get("paper_id")): item
                for item in previous.get("papers", [])
                if isinstance(item, dict) and item.get("paper_id") is not None
            }
        refresh_existing_access(existing, papers_by_id)
        candidates: list[dict[str, Any]] = []
        for paper_id in selected:
            paper = papers_by_id.get(str(paper_id))
            if paper is None:
                existing[str(paper_id)] = {
                    "paper_id": str(paper_id), "title": "Unknown selected paper",
                    **download_access(paper, "paid-download"), "status": "failed", "file_path": None,
                    "content_type": None, "verified_exists": False,
                    "message": "Selected paper ID was not present in metadata.",
                }
            elif paid_pending(existing.get(str(paper_id))):
                # Only papers serve already reported as unsuccessful for a granted
                # acquisition may reach paper-dl; a terminal skip is never a target.
                candidates.append(paper)

        pending_candidates = [
            paper
            for paper in candidates
            if not verified_manifest_download(existing.get(str(paper["id"])), run_dir)
        ]
        preserved_downloads = len(candidates) - len(pending_candidates)
        papers_root = run_dir / "downloads" / "papers"
        occupied_pdf_paths = {
            Path(ordinary_windows_path(entry)).relative_to(run_dir).as_posix()
            for entry in filesystem_path(papers_root).glob("*.pdf")
            if entry.is_file()
        }
        claimed_pdf_paths = {
            str(item.get("file_path"))
            for item in existing.values()
            if verified_manifest_download(item, run_dir)
        }
        for paper in pending_candidates:
            previous_path = existing.get(str(paper["id"]), {}).get("file_path")
            if isinstance(previous_path, str):
                occupied_pdf_paths.discard(previous_path)

        placeholder_input = any(bool(paper.get("is_placeholder")) for paper in candidates)
        is_placeholder = existing_placeholder or placeholder_input
        if not selection.get("download_paid"):
            for paper in pending_candidates:
                existing[str(paper["id"])] = {
                    "paper_id": str(paper["id"]), "title": str(paper.get("title", "Untitled")),
                    **download_access(paper, "paid-download"), "status": "skipped", "file_path": None,
                    "content_type": None, "verified_exists": False,
                    "message": "The authorized paper-dl flow was not selected by the user.",
                }
            manifest = make_manifest(
                selection, existing, is_placeholder, [], "completed", mode, zotero_mode
            )
            if mode == "interactive":
                abandon(run_dir)
            atomic_write_json(output_path, manifest)
            update_progress(
                run_dir,
                stage="download",
                activity="paper-dl/non-arXiv route skipped by selection",
                status="completed",
                current=len(selected),
                total=len(selected),
                completed=len(selected),
                emit=lambda message: print(message, flush=True),
            )
            print(f"paper-dl/non-arXiv download skipped by selection: {output_path}")
            return 0

        eligible: list[tuple[dict[str, Any], str]] = []
        for paper in pending_candidates:
            paper_id = str(paper["id"])
            identifier = paper_identifier(paper)
            if paper.get("is_placeholder"):
                existing[paper_id] = {
                    "paper_id": paper_id, "title": str(paper.get("title", "Untitled")),
                    **download_access(paper, "paid-download"), "status": "skipped", "file_path": None,
                    "content_type": None, "verified_exists": False,
                    "message": "Refused to send placeholder metadata to the real paper-dl CLI.",
                }
            elif not identifier:
                existing[paper_id] = {
                    "paper_id": paper_id, "title": str(paper.get("title", "Untitled")),
                    **download_access(paper, "paid-download"), "status": "skipped", "file_path": None,
                    "content_type": None, "verified_exists": False,
                    "message": "No DOI, URL, or arXiv identifier was available for paper-dl.",
                }
            else:
                eligible.append((paper, identifier))

        warnings: list[str] = []
        if preserved_downloads:
            warnings.append(
                f"Preserved {preserved_downloads} previously verified downloaded PDF(s) without retrying them."
            )
        external_report_relative: str | None = None
        if eligible:
            logs_root = run_dir / "downloads" / "paper-dl-logs"
            storage_dir = paper_dl_library_root()
            warnings.append(
                "paper-dl library cache root: "
                f"{storage_dir} (kept outside the run directory for native Windows path limits)"
            )
            attempt_root = logs_root / "paper-dl-attempts" / uuid.uuid4().hex[:12]
            report_dir = attempt_root / "output"
            identifiers_path = attempt_root / "input.txt"
            ensure_paper_dl_paths_fit_budget(storage_dir, attempt_root)
            last_wait_notice = [0.0]
            def waiting_for_slot():
                if time.monotonic() - last_wait_notice[0] >= 10:
                    update_progress(
                        run_dir, stage="download", status="running",
                        activity="Waiting for an available non-arXiv browser slot",
                        needs_user_action=False,
                        emit=lambda message: print(message, flush=True),
                    )
                    last_wait_notice[0] = time.monotonic()
            lease = BrowserPool().acquire(run_dir, on_wait=waiting_for_slot)
            startup_timeout = float(os.getenv("PAPER_DL_CDP_STARTUP_TIMEOUT", "15"))
            if not math.isfinite(startup_timeout) or startup_timeout <= 0:
                raise ValueError("PAPER_DL_CDP_STARTUP_TIMEOUT must be a positive number")
            lease.ensure_browser(timeout=startup_timeout)
            endpoint = lease.endpoint
            if mode == "interactive":
                warnings.append(
                    "paper-dl used a user-controlled local CDP browser; login/CAPTCHA steps require manual authorized interaction and are never bypassed."
                )
                if zotero_mode != "off":
                    warnings.append(
                        f"Zotero Desktop mode {zotero_mode} may create or reuse Zotero library items; successful attachments are copied into this run."
                    )
            else:
                warnings.append(
                    "paper-dl used the shared local CDP browser with --autodev; human-verification/login items were skipped, never bypassed."
                )
            configured_paper_dl_config = _optional_file_env("PAPER_DL_CONFIG")
            if zotero_mode == "desktop-first" and configured_paper_dl_config is not None:
                raise ValueError(
                    "PAPER_DL_ZOTERO_MODE=desktop-first cannot currently be combined with "
                    "PAPER_DL_CONFIG because the adapter must supply its deterministic Zotero config"
                )
            base_command, cwd, command_label = resolve_paper_dl()
            filesystem_path(attempt_root).mkdir(parents=True, exist_ok=False)
            paper_dl_config = configured_paper_dl_config
            if zotero_mode == "desktop-first":
                paper_dl_config = attempt_root / "zotero-desktop-first.yaml"
                atomic_write_text(
                    paper_dl_config,
                    "zotero:\n  enabled: true\n  silent: true\n",
                )
            atomic_write_text(
                identifiers_path,
                "\n".join(identifier for _, identifier in eligible) + "\n",
            )
            try:
                default_paper_timeout = "300" if mode == "interactive" else "180"
                paper_timeout = float(
                    os.getenv("PAPER_DL_PAPER_TIMEOUT", default_paper_timeout)
                )
                if not math.isfinite(paper_timeout) or paper_timeout <= 0:
                    raise ValueError
            except ValueError as exc:
                raise ValueError("PAPER_DL_PAPER_TIMEOUT must be a positive number") from exc
            command = build_external_command(
                base_command,
                identifiers_path,
                storage_dir,
                report_dir,
                paper_timeout,
                mode,
                zotero_mode,
                endpoint,
                paper_dl_config,
            )
            batch_timeout_value = os.getenv("PAPER_DL_BATCH_TIMEOUT")
            if batch_timeout_value is None and mode == "autodev":
                batch_timeout_value = str((paper_timeout + 30) * len(eligible) + 30)
            batch_timeout: float | None = None
            if batch_timeout_value is not None:
                try:
                    batch_timeout = float(batch_timeout_value)
                except ValueError as exc:
                    raise ValueError("PAPER_DL_BATCH_TIMEOUT must be a positive number") from exc
                if not math.isfinite(batch_timeout) or batch_timeout <= 0:
                    raise ValueError("PAPER_DL_BATCH_TIMEOUT must be a positive number")
            print(
                f"paper-dl adapter: executable={command_label} items={len(eligible)} "
                f"mode={mode} zotero={zotero_mode}",
                flush=True,
            )
            print(
                f"[DOWNLOAD STATUS] paper-dl/non-arXiv batch running: {len(eligible)} paper(s) queued.",
                flush=True,
            )
            update_progress(
                run_dir,
                stage="download",
                activity="Running paper-dl/non-arXiv batch",
                current=1,
                total=len(eligible),
                completed=0,
                emit=lambda message: print(message, flush=True),
            )
            print(f"[CDP READY] Connected workflow will use {endpoint}.", flush=True)
            if mode == "interactive":
                if zotero_mode != "off":
                    print(
                        f"[ZOTERO READY] Zotero Desktop mode is {zotero_mode}; keep Desktop and Connector available.",
                        flush=True,
                    )
                print("[REMINDER] Keep the dedicated browser open. If CAPTCHA/login or a Zotero selector appears, resolve it manually; paper-dl will continue or report action_required.", flush=True)
            else:
                print("[AUTODEV] Login/CAPTCHA/manual-solve items will be skipped; no user intervention is requested.", flush=True)
            try:
                completed = lease.run_download(
                    command, cwd=cwd, timeout=batch_timeout,
                )
            except ChildProcessCancelled as exc:
                update_progress(
                    run_dir,
                    stage="download",
                    activity="paper-dl/non-arXiv download cancelled",
                    status="cancelled",
                    total=len(eligible),
                    emit=lambda message: print(message, flush=True),
                )
                print(
                    f"paid-download cancelled by signal {exc.signum}; paper-dl process tree stopped",
                    file=sys.stderr,
                    flush=True,
                )
                return 128 + exc.signum
            except subprocess.TimeoutExpired as exc:
                raise ValueError(
                    f"paper-dl exceeded batch timeout ({batch_timeout:.0f}s)"
                ) from exc
            external_report = report_dir / "report.json"
            if completed.returncode not in {0, 1}:
                detail = (
                    completed.stderr or completed.stdout or "see the streamed paper-dl output"
                ).strip()
                detail = re.sub(r"https?://\S+", "[url]", detail)[:1200]
                raise ValueError(
                    f"paper-dl exited {completed.returncode}: {detail}"
                )
            report = read_json(external_report)
            if not isinstance(report, dict) or not isinstance(report.get("results"), list):
                raise ValueError(f"paper-dl report has no results array: {external_report}")
            result_by_identifier: dict[str, dict[str, Any]] = {}
            for result in report["results"]:
                if not isinstance(result, dict):
                    continue
                ident = result.get("identifier")
                value = ident.get("value") if isinstance(ident, dict) else None
                if isinstance(value, str):
                    result_by_identifier[normalize_identifier(value)] = result
            for index, (paper, identifier) in enumerate(eligible, start=1):
                external = result_by_identifier.get(normalize_identifier(identifier))
                previous_item = existing.get(str(paper["id"]), {})
                previous_path = previous_item.get("file_path")
                existing[str(paper["id"])] = result_item(
                    paper,
                    external,
                    run_dir,
                    mode,
                    occupied_pdf_paths,
                    previous_path if isinstance(previous_path, str) else None,
                    claimed_pdf_paths,
                )
                downloaded_path = existing[str(paper["id"])].get("file_path")
                if (
                    existing[str(paper["id"])].get("status") == "downloaded"
                    and isinstance(downloaded_path, str)
                ):
                    occupied_pdf_paths.add(downloaded_path)
                    claimed_pdf_paths.add(downloaded_path)
                title = " ".join(str(paper.get("title") or "Untitled").split())[:120]
                print(
                    f"[DOWNLOAD STATUS] paper-dl/non-arXiv {index}/{len(eligible)} {title or 'Untitled'}: "
                    f"{existing[str(paper['id'])]['status']}",
                    flush=True,
                )
                update_progress(
                    run_dir,
                    stage="download",
                    activity=f"Processed {title or 'Untitled'} via paper-dl/non-arXiv",
                    current=index,
                    total=len(eligible),
                    completed=index,
                    emit=lambda message: print(message, flush=True),
                )
            if completed.returncode == 1:
                warnings.append("paper-dl returned a partial-failure exit code; per-paper results were preserved.")
            external_report_relative = external_report.resolve().relative_to(run_dir).as_posix()
        elif pending_candidates:
            warnings.append("paper-dl was not invoked because no eligible real identifier remained.")

        overall_status = (
            "action_required"
            if any(item.get("status") == "action_required" for item in existing.values())
            else "completed"
        )
        manifest = make_manifest(
            selection,
            existing,
            is_placeholder,
            warnings,
            overall_status,
            mode,
            zotero_mode,
            external_report_relative,
        )
        if mode == "interactive" and overall_status == "action_required":
            intervention = "CAPTCHA or institutional login"
            if zotero_mode != "off":
                intervention += ", or a Zotero selection"
            intervention_papers = action_papers_from_manifest(existing)
            viewer_actions = [
                {
                    "paper_id": str(item.get("paper_id") or "unknown"),
                    "title": str(item.get("title") or "Untitled"),
                    "url": item.get("action_url"),
                    "target_file": str(item.get("target_file") or ""),
                    "target_path": str(
                        (run_dir / str(item.get("target_file") or "")).resolve()
                    ),
                    "instructions": (
                        "Use the open browser PDF viewer's Save/Download control, "
                        "save to target_path, then run download_recovery.py "
                        "verify-manual. Verification requires the file to remain "
                        "inside this run and begin with %PDF-."
                    ),
                }
                for item in existing.values()
                if item.get("status") == "action_required"
                and item.get("action_reason") == "viewer_open_capture_failed"
            ]
            action = cdp_setup_action(
                endpoint,
                "browser_intervention",
                zotero_mode,
                intervention_papers,
                has_institutional_login_action(existing),
            )
            action["opened_in_dedicated_chrome"] = []
            action["all_action_pages_opened"] = False
            if viewer_actions:
                action["manual_downloads"] = viewer_actions
            only_viewer_recovery = (
                bool(viewer_actions)
                and len(viewer_actions) == len(intervention_papers)
            )
            if only_viewer_recovery:
                action["type"] = "manual_pdf_recovery"
                action["title"] = (
                    "The authorized PDF is visible; save it to the run target"
                )
                action["instructions"] = [
                    "Open the listed safe article URL in the dedicated browser if its PDF viewer is not already open.",
                    "Use the viewer's Save/Download control and save each PDF to its exact target_path.",
                    "Run download_recovery.py verify-manual for this run; only an in-run file beginning with %PDF- is accepted.",
                    "This recovery does not indicate missing entitlement and does not require a login retry unless the publisher explicitly shows a login wall.",
                ]
            manifest.update({
                "action_type": (
                    "manual_pdf_recovery"
                    if only_viewer_recovery
                    else "browser_intervention"
                ),
                "action": action,
                "message": (
                    "The PDF viewer opened with authorized content, but automatic "
                    "capture failed. Save the visible PDF to the exact target path "
                    "and verify its %PDF- signature with the existing recovery command."
                    if only_viewer_recovery
                    else f"One or more papers still require {intervention}. Resolve the listed "
                    "papers in the dedicated CDP browser, keep the required apps open, then resume."
                ),
                "resume_token": (
                    "paper-dl-viewer-manual-save"
                    if only_viewer_recovery
                    else "paper-dl-cdp-intervention-complete"
                ),
            })
            # Persist a complete, valid action manifest before browser setup:
            # Chrome may have exited while paper-dl was returning its report.
            # Retry must still see this batch's successes and pending actions.
            atomic_write_json(output_path, manifest)
            try:
                lease.verify_browser()
                opened_paper_ids, open_errors = open_action_papers_in_cdp(
                    endpoint,
                    intervention_papers,
                )
            except (OSError, ValueError) as exc:
                manifest["warnings"].append(f"Results preserved; browser intervention setup failed: {exc}")
                manifest["message"] = (
                    "Download results were saved, but browser intervention setup failed. "
                    "After browser cleanup, retry this run; verified downloads will be preserved."
                )
                action["instructions"] = [
                    "The successful PDFs and pending manual actions are saved in this run's manifest.",
                    "After the adapter stops, run browser_pool.py abandon --run-dir for this run if cleanup is still needed, then retry the same run.",
                    "Use the listed safe article links and any manual download targets for manual recovery when needed.",
                ]
                atomic_write_json(output_path, manifest)
                raise
            action["opened_in_dedicated_chrome"] = opened_paper_ids
            action["all_action_pages_opened"] = len(opened_paper_ids) == len(intervention_papers)
            if open_errors:
                manifest["warnings"].extend(
                    f"Could not open an action page in the dedicated CDP browser: {error}"
                    for error in open_errors
                )
        else:
            # Preserve verified results even if browser cleanup subsequently fails.
            # A successful cleanup notice is added only after verified release.
            atomic_write_json(output_path, manifest)
            if lease:
                lease.release()
                lease.close()
                lease = None
            else:
                abandon(run_dir)
            manifest["completion_notice"] = {
                "type": "paid_download_finished",
                "title": "Paper-dl/non-arXiv download finished",
                "message": "The browser pool finished cleanup and released this run's slot. No browser action is needed.",
                "browser_pool_released": True,
                "safe_to_close_cdp_browser": False,
                "safe_to_close_zotero_desktop": False,
            }
        atomic_write_json(output_path, manifest)
        if manifest["status"] == "action_required":
            if lease:
                lease.pause()
                paused = True
            update_progress(
                run_dir,
                stage="download",
                activity="Waiting for CAPTCHA/login in the dedicated browser",
                status="action_required",
                total=len(candidates),
                completed=manifest["summary"]["downloaded"],
                needs_user_action=True,
                action="Resolve the displayed prompt in the dedicated browser, then tell the host to continue.",
                emit=lambda message: print(message, flush=True),
            )
        else:
            update_progress(
                run_dir,
                stage="download",
                activity="paper-dl/non-arXiv batch completed",
                status="completed",
                current=len(candidates),
                total=len(candidates),
                completed=len(candidates),
                emit=lambda message: print(message, flush=True),
            )
    except (OSError, ValueError) as exc:
        update_progress(
            run_dir,
            stage="download",
            activity="paper-dl/non-arXiv download failed",
            status="failed",
            emit=lambda message: print(message, flush=True),
        )
        print(f"paid-download adapter failed for {args.input}: {exc}", file=sys.stderr)
        return 2
    finally:
        if lease:
            try:
                if not paused:
                    lease.release()
            except (OSError, ValueError) as cleanup_error:
                print(f"Browser slot retained: {cleanup_error}. Use browser_pool.py abandon --run-dir {run_dir}", file=sys.stderr)
            finally:
                lease.close()
    if mode == "interactive" and manifest["status"] == "action_required":
        if manifest.get("action_type") == "manual_pdf_recovery":
            print(
                "[ACTION REQUIRED] The PDF is visible in the browser but automatic capture failed; save it to the exact target path.",
                flush=True,
            )
            print(
                "[NEXT ACTION] Save the visible PDF, then run download_recovery.py verify-manual so the in-run path and %PDF- signature are checked.",
                flush=True,
            )
        else:
            print("[ACTION REQUIRED] CAPTCHA/login still needs attention in the dedicated CDP browser. Keep it open, resolve the prompt, then --resume.", flush=True)
            print(
                "[NEXT ACTION] Resolve the displayed CAPTCHA/login in the dedicated browser, then tell the host to continue. "
                "An empty response does not mark the intervention resolved.",
                flush=True,
            )
    else:
        print("[DOWNLOAD COMPLETE] paper-dl/non-arXiv batch has ended. The browser pool released this run's slot; no browser action is needed.", flush=True)
        print(
            "[NEXT ACTION] Review failed/skipped papers for an optional manual retry, or explicitly choose to continue to PDF reading.",
            flush=True,
        )
    print(f"paper-dl {mode} manifest written: {output_path}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--resume", action="store_true")
    args = parser.parse_args()
    try:
        run_dir = args.run_dir.resolve()
        if not filesystem_path(run_dir).is_dir():
            raise ValueError(f"run directory does not exist: {run_dir}")
        with cancellation_signals(), run_lock(run_dir):
            return _run_locked(args, run_dir)
    except ChildProcessCancelled as exc:
        print("paid-download cancelled; any unverified browser cleanup remains reserved", file=sys.stderr)
        return 128 + exc.signum
    except (OSError, ValueError) as exc:
        print(f"paid-download adapter failed for {args.input}: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
