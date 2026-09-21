#!/usr/bin/env scholarseed-skill-python
"""Download user-confirmed arXiv-backed PDFs directly from arXiv."""

from __future__ import annotations

import argparse
import errno
import hashlib
import ssl
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable


SKILL_DIR = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(SKILL_DIR / "scripts"))

from download_access import download_access
from io_utils import (  # noqa: E402
    atomic_write_json,
    read_json,
    title_pdf_relative_path,
    utc_now,
)
from progress import update_progress  # noqa: E402


DEFAULT_TIMEOUT_SECONDS = 80
DEFAULT_ATTEMPTS = 3
MAX_PDF_BYTES = 100 * 1024 * 1024
MIN_PDF_BYTES = 1024

PdfFetcher = Callable[[str], bytes]
ProgressReporter = Callable[[str], None]


class OpenDownloadRequestError(RuntimeError):
    """A download request failure with a machine-readable status and source."""

    def __init__(self, message: str, *, status: str, source: str) -> None:
        super().__init__(message)
        self.status = status
        self.source = source


def _error_chain(error: BaseException) -> list[BaseException]:
    pending = [error]
    result: list[BaseException] = []
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        result.append(current)
        # Traverse the current wrapped failure before historical context.
        for nested in (current.__context__, current.__cause__):
            if isinstance(nested, BaseException):
                pending.append(nested)
        if isinstance(current, urllib.error.URLError) and isinstance(current.reason, BaseException):
            pending.append(current.reason)
    return result


def classify_request_failure(error: BaseException) -> str:
    """Distinguish sandbox permission denial from a real transport failure."""
    permission_errnos = {errno.EPERM, errno.EACCES}
    permission_markers = ("operation not permitted", "permission denied")
    chain = _error_chain(error)
    # SSL error numbers belong to OpenSSL, not the operating-system errno
    # namespace (SSL_ERROR_SSL == EPERM == 1).
    for current in chain:
        if isinstance(current, ssl.SSLError):
            return "transport_error"
        if isinstance(current, PermissionError):
            return "execution_blocked"
        if getattr(current, "errno", None) in permission_errnos:
            return "execution_blocked"
        if any(marker in str(current).casefold() for marker in permission_markers):
            return "execution_blocked"
    return "transport_error"


def _positive_int(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{label} must be an integer >= 1")
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be an integer >= 1") from exc
    if number < 1:
        raise ValueError(f"{label} must be an integer >= 1")
    return number


def require_under_run(run_dir: Path, path: Path, label: str) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(run_dir.resolve())
    except ValueError as exc:
        raise ValueError(f"{label} must stay inside the run directory: {resolved}") from exc
    return resolved


def resolve_under_run(run_dir: Path, value: str, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = run_dir / path
    return require_under_run(run_dir, path, label)


def arxiv_pdf_url(arxiv_id: str) -> str:
    """Return arXiv's public PDF URL, preserving legacy category-style IDs."""
    normalized = normalize_arxiv_id(arxiv_id)
    if not normalized:
        raise ValueError("arXiv PDF download requires a valid arXiv id")
    return f"https://arxiv.org/pdf/{urllib.parse.quote(normalized, safe='/')}"


def normalize_arxiv_id(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = value.strip()
    lowered = normalized.casefold()
    if lowered.startswith("arxiv:"):
        normalized = normalized.split(":", 1)[1].strip()
    else:
        parsed = urllib.parse.urlsplit(normalized)
        if parsed.scheme in {"http", "https"} and parsed.hostname == "arxiv.org":
            parts = parsed.path.strip("/").split("/")
            if len(parts) >= 2 and parts[0].casefold() in {"abs", "pdf"}:
                normalized = "/".join(parts[1:])
    if normalized.casefold().endswith(".pdf"):
        normalized = normalized[:-4]
    if not normalized or len(normalized) > 120 or any(char.isspace() for char in normalized):
        return None
    return normalized


def paper_arxiv_id(paper: dict[str, Any]) -> str | None:
    value = paper.get("arxiv_id") or paper.get("arxivId")
    if value:
        return normalize_arxiv_id(value)
    external = paper.get("external_ids") or paper.get("externalIds")
    if isinstance(external, dict):
        for key, candidate in external.items():
            if str(key).casefold() in {"arxiv", "arxiv_id", "arxivid"}:
                return normalize_arxiv_id(candidate)
    return None


def paper_is_arxiv_backed(paper: dict[str, Any]) -> bool:
    """Return whether the public arXiv PDF route can address this paper."""
    if str(paper.get("document_type", "")).strip().casefold() in {
        "blog", "documentation", "dataset", "web_page",
    }:
        return False
    return paper_arxiv_id(paper) is not None


def is_pdf_bytes(payload: bytes) -> bool:
    return len(payload) >= MIN_PDF_BYTES and payload[:1024].lstrip().startswith(b"%PDF-")


def download_arxiv_pdf(
    arxiv_id: str,
    *,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
    attempts: int = DEFAULT_ATTEMPTS,
) -> bytes:
    """Fetch and validate a bounded public arXiv PDF."""
    normalized = normalize_arxiv_id(arxiv_id)
    if not normalized:
        raise ValueError("arXiv PDF download requires a valid arXiv id")
    request = urllib.request.Request(
        arxiv_pdf_url(normalized),
        headers={"Accept": "application/pdf, application/octet-stream"},
    )
    last_error: BaseException | None = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
                payload = response.read(MAX_PDF_BYTES + 1)
            if len(payload) > MAX_PDF_BYTES:
                raise RuntimeError("arXiv PDF response exceeded 100 MB")
            if not is_pdf_bytes(payload):
                raise RuntimeError(
                    f"arXiv response was not a valid PDF for {normalized}"
                )
            return payload
        except RuntimeError:
            raise
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = exc
            status = classify_request_failure(exc)
            if status == "execution_blocked":
                raise OpenDownloadRequestError(
                    f"arXiv PDF request blocked by execution policy for {normalized}: {exc}",
                    status=status,
                    source="arxiv",
                ) from exc
            retryable = (
                not isinstance(exc, urllib.error.HTTPError)
                or exc.code in {500, 502, 503, 504}
            )
            if not retryable or attempt + 1 >= attempts:
                break
            time.sleep(0.5 * (2**attempt))
    detail = str(getattr(last_error, "reason", last_error) or "request failed")
    raise OpenDownloadRequestError(
        f"arXiv PDF download failed for {normalized}: {detail}",
        status="transport_error",
        source="arxiv",
    ) from last_error


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def download_path(
    run_dir: Path,
    title: str,
    paper_id: str,
    occupied: set[str] | None = None,
) -> tuple[Path, str]:
    relative = title_pdf_relative_path(title, paper_id, occupied)
    absolute = require_under_run(run_dir, run_dir / relative, "open PDF path")
    return absolute, relative.as_posix()


def summarize(papers: list[dict[str, Any]], selected_count: int) -> dict[str, int]:
    return {
        "selected": selected_count,
        "downloaded": sum(item["status"] == "downloaded" for item in papers),
        "action_required": sum(item["status"] == "action_required" for item in papers),
        "failed": sum(item["status"] == "failed" for item in papers),
        "skipped": sum(item["status"] == "skipped" for item in papers),
    }


def build_manifest(
    selection: dict[str, Any],
    metadata: dict[str, Any],
    run_dir: Path,
    fetcher: PdfFetcher,
    progress: ProgressReporter | None = None,
) -> dict[str, Any]:
    selected = selection.get("selected_paper_ids")
    if not isinstance(selected, list):
        raise ValueError("selection needs selected_paper_ids")
    raw_papers = metadata.get("papers")
    if not isinstance(raw_papers, list):
        raise ValueError("metadata papers must be an array")
    paper_by_id = {
        paper.get("id"): paper
        for paper in raw_papers
        if isinstance(paper, dict) and paper.get("id") is not None
    }
    emit = progress or (lambda _message: None)
    queued = sum(
        1
        for selected_id in selected
        if selection.get("download_open") is True
        and isinstance(paper_by_id.get(selected_id), dict)
        and paper_is_arxiv_backed(paper_by_id[selected_id])
    )
    emit(
        f"[DOWNLOAD STATUS] arXiv batch running: {queued} arXiv-backed paper(s) queued "
        f"from {len(selected)} selected."
    )
    update_progress(
        run_dir,
        stage="download",
        activity="Preparing arXiv downloads",
        current=0,
        total=len(selected),
        completed=0,
        emit=emit,
    )
    results: list[dict[str, Any]] = []
    # Title-only files (including legacy downloads) are not identity evidence.
    # Reserve every existing path and reuse only an identity + content binding.
    occupied_paths = {path.relative_to(run_dir).as_posix()
                      for path in (run_dir / "downloads/papers").glob("*")}
    index_path = require_under_run(run_dir, run_dir / "downloads/arxiv-files.json", "arXiv file index")
    file_index = read_json(index_path) if index_path.exists() else {"schema_version": "1.0", "files": {}}
    if (not isinstance(file_index, dict) or file_index.get("schema_version") != "1.0"
            or not isinstance(file_index.get("files"), dict)
            or any(not isinstance(entry, dict) for entry in file_index["files"].values())):
        raise ValueError("invalid arXiv file identity index")
    for index, selected_id in enumerate(selected, start=1):
        paper_id = str(selected_id)
        paper = paper_by_id.get(selected_id)
        progress_title = "Unknown selected paper"
        if isinstance(paper, dict):
            progress_title = " ".join(str(paper.get("title") or "Untitled").split())[:120]
        update_progress(
            run_dir,
            stage="download",
            activity=f"Downloading {progress_title} from arXiv",
            current=index,
            total=len(selected),
            completed=index - 1,
            emit=emit,
        )
        if paper is None:
            item = {
                "paper_id": paper_id,
                "title": "Unknown selected paper",
                **download_access(paper, "open-download"),
                "status": "failed",
                "file_path": None,
                "content_type": None,
                "verified_exists": False,
                "message": "Selected paper ID was not present in metadata.",
            }
            results.append(item)
            emit(
                f"[DOWNLOAD STATUS] arXiv {index}/{len(selected)} "
                f"Unknown selected paper: {item['status']}"
            )
            update_progress(
                run_dir,
                stage="download",
                activity="Processed unknown selected paper",
                current=index,
                total=len(selected),
                completed=index,
                emit=emit,
            )
            continue

        title = str(paper.get("title") or "Untitled")
        status = "failed"
        file_path: str | None = None
        message: str
        if selection.get("download_open") is not True:
            status = "skipped"
            message = "The arXiv route was not selected by the user."
        elif not paper_is_arxiv_backed(paper):
            status = "skipped"
            message = (
                "The arXiv route handles only arXiv-backed papers; this non-arXiv record "
                "was not downloaded."
            )
        else:
            arxiv_id = paper_arxiv_id(paper)
            assert arxiv_id is not None
            try:
                identity = hashlib.sha256(json.dumps([paper_id, arxiv_id]).encode()).hexdigest()
                binding = file_index["files"].get(identity, {})
                reusable = False
                if (binding.get("paper_id") == paper_id and binding.get("arxiv_id") == arxiv_id
                        and isinstance(binding.get("file_path"), str)):
                    bound_path = Path(binding["file_path"])
                    if bound_path.parent == Path("downloads/papers") and bound_path.suffix.lower() == ".pdf":
                        absolute = require_under_run(run_dir, run_dir / bound_path, "indexed arXiv PDF")
                        if absolute.is_file():
                            existing = absolute.read_bytes()
                            reusable = (is_pdf_bytes(existing) and
                                        hashlib.sha256(existing).hexdigest() == binding.get("sha256"))
                            relative = bound_path.as_posix()
                if reusable:
                    status = "downloaded"
                    file_path = relative
                    message = "Reused an identity-bound, SHA-256-verified arXiv PDF."
                else:
                    absolute, relative = download_path(run_dir, title, paper_id, occupied_paths)
                    occupied_paths.add(relative)
                    payload = fetcher(arxiv_id)
                    if not is_pdf_bytes(payload):
                        raise RuntimeError("The arXiv downloader returned a response that is not a valid PDF")
                    atomic_write_bytes(absolute, payload)
                    if not absolute.is_file() or not is_pdf_bytes(absolute.read_bytes()):
                        raise RuntimeError("Open PDF failed verification after writing")
                    file_index["files"][identity] = {
                        "paper_id": paper_id, "arxiv_id": arxiv_id, "file_path": relative,
                        "sha256": hashlib.sha256(payload).hexdigest(),
                    }
                    atomic_write_json(index_path, file_index)
                    status = "downloaded"
                    file_path = relative
                    message = f"Downloaded and verified the arXiv-backed PDF (arXiv:{arxiv_id})."
            except OpenDownloadRequestError as exc:
                if exc.status == "execution_blocked":
                    raise
                message = str(exc)
            except (OSError, RuntimeError, ValueError) as exc:
                message = str(exc)

        if status == "downloaded" and file_path:
            occupied_paths.add(file_path)

        verified = bool(
            file_path
            and (run_dir / file_path).is_file()
            and is_pdf_bytes((run_dir / file_path).read_bytes())
        )
        item = {
            "paper_id": paper_id,
            "title": title,
            **download_access(paper, "open-download"),
            "status": status,
            "file_path": file_path,
            "content_type": "application/pdf" if verified else None,
            "verified_exists": verified,
            "message": message,
        }
        results.append(item)
        display_title = " ".join(title.split())[:120] or "Untitled"
        emit(
            f"[DOWNLOAD STATUS] arXiv {index}/{len(selected)} "
            f"{display_title}: {status}"
        )
        update_progress(
            run_dir,
            stage="download",
            activity=f"Processed {display_title} via arXiv",
            current=index,
            total=len(selected),
            completed=index,
            emit=emit,
        )

    warnings = [
        "The arXiv route attempts only records with an arXiv ID; non-arXiv OA records are left for paper-dl."
    ]
    failed_count = sum(item["status"] == "failed" for item in results)
    if failed_count:
        warnings.append(
            f"{failed_count} selected paper(s) could not be downloaded from arXiv; inspect per-paper messages."
        )
    manifest = {
        "schema_version": "1.0",
        "run_id": selection.get("run_id", run_dir.name),
        "generated_at": utc_now(),
        "is_placeholder": False,
        "adapter": {"name": "arxiv", "mode": "direct"},
        "papers": results,
        "summary": summarize(results, len(selected)),
        "warnings": warnings,
    }
    summary = manifest["summary"]
    emit(
        "[DOWNLOAD COMPLETE] arXiv batch ended: "
        f"downloaded={summary['downloaded']} failed={summary['failed']} "
        f"skipped={summary['skipped']}"
    )
    update_progress(
        run_dir,
        stage="download",
        activity="arXiv batch completed",
        status="completed",
        current=len(selected),
        total=len(selected),
        completed=len(selected),
        emit=emit,
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--run-dir", required=True, type=Path)
    args = parser.parse_args()
    try:
        run_dir = args.run_dir.resolve()
        from stage_guard import require_download
        require_download(run_dir, args.input, "open-download")
        selection = read_json(args.input)
        if not isinstance(selection, dict) or selection.get("confirmed_by_user") is not True:
            raise ValueError("selection must be an object with confirmed_by_user=true")
        metadata_value = selection.get("metadata_path")
        if not isinstance(metadata_value, str) or not metadata_value.strip():
            raise ValueError("selection needs metadata_path")
        metadata = read_json(resolve_under_run(run_dir, metadata_value, "metadata_path"))
        if not isinstance(metadata, dict):
            raise ValueError("metadata must be a JSON object")
        timeout = _positive_int(
            os.environ.get("ARXIV_PDF_TIMEOUT", DEFAULT_TIMEOUT_SECONDS),
            "ARXIV_PDF_TIMEOUT",
        )
        attempts = _positive_int(
            os.environ.get("ARXIV_PDF_ATTEMPTS", DEFAULT_ATTEMPTS),
            "ARXIV_PDF_ATTEMPTS",
        )
        manifest = build_manifest(
            selection,
            metadata,
            run_dir,
            lambda arxiv_id: download_arxiv_pdf(
                arxiv_id,
                timeout_seconds=timeout,
                attempts=attempts,
            ),
            progress=lambda message: print(message, flush=True),
        )
        atomic_write_json(args.output, manifest)
    except OpenDownloadRequestError as exc:
        update_progress(
            args.run_dir.resolve(),
            stage="download",
            activity="arXiv download failed",
            status="failed",
            emit=lambda message: print(message, flush=True),
        )
        print(
            json.dumps(
                {
                    "status": exc.status,
                    "source": exc.source,
                    "error": str(exc),
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2
    except (OSError, RuntimeError, ValueError) as exc:
        if args.run_dir.is_dir():
            update_progress(
                args.run_dir.resolve(),
                stage="download",
                activity="arXiv download failed",
                status="failed",
                emit=lambda message: print(message, flush=True),
            )
        print(f"arXiv download failed for {args.input}: {exc}", file=sys.stderr)
        return 2
    print(
        f"arXiv download wrote {manifest['summary']['downloaded']} verified PDF(s): "
        f"{args.output}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
