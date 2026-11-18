"""Bounded diagnostics from the current compiler invocation, not stale logs."""

import copy
import hashlib
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from evidence import save

BIB_ERROR = "BIBLIOGRAPHY_COMPILE_ERROR"
BIB_UNAVAILABLE = "BIBLIOGRAPHY_TOOL_UNAVAILABLE"
BIB_AUX_MISSING = "BIBLIOGRAPHY_AUX_MISSING"
LAYOUT_ERROR = "LATEX_LAYOUT_ERROR"
LAYOUT_TOLERANCE_PT = 1.0
FLOAT_OVERFLOW = re.compile(r"Float too large for page by ([0-9.]+)pt")
BOX_OVERFLOW = re.compile(r"Overfull \\([hv])box \(([0-9.]+)pt too (?:wide|high)\)")
MAX_DETAILS = 8
MAX_LINE = 1000
COMPILATION_DIRECTORY = "compilation"
COMPILATION_MANIFEST = "manifest.json"
LATEX_PASS = "latex"
BIBTEX_PASS = "bibtex"
PRECOMPILE_PHASE = "precompile"
PUBLICATION_PHASE = "publish"
BIB_MARKERS = (
    "Too many commas",
    "Repeated entry",
    "I was expecting",
    "I couldn't open",
    "Illegal",
    "You can't pop",
    "error message",
)


class CompilationRun:
    def __init__(self, workspace, source, phase):
        self.source = Path(source).resolve()
        identity = uuid4().hex
        self.folder = Path(workspace).resolve() / "_logs" / COMPILATION_DIRECTORY / identity
        self.record = {
            "invocation_id": identity,
            "phase": phase,
            "source": str(self.source),
            "main_source_sha256": hashlib.sha256(self.source.read_bytes()).hexdigest(),
            "source_hash_scope": "main_source_file_only",
            "started_at": datetime.now(timezone.utc).isoformat(),
            "manifest_path": str(self.folder / COMPILATION_MANIFEST),
            "passes": [],
        }
        save(self.folder / COMPILATION_MANIFEST, self.record)

    def origin(self):
        return copy.deepcopy(self.record)

    def run(self, kind, command, runner, engine_log=None):
        index = len(self.record["passes"]) + 1
        entry = {
            "pass_index": index,
            "kind": kind,
            "command": list(command),
            "started_at": datetime.now(timezone.utc).isoformat(),
            "returncode": None,
            "engine_log_path": None,
        }
        self.record["passes"].append(entry)
        save(self.folder / COMPILATION_MANIFEST, self.record)
        started = time.monotonic()
        previous = Path(engine_log).stat() if engine_log and Path(engine_log).is_file() else None
        result = None
        try:
            result = runner()
            entry["returncode"] = result.returncode
            return result
        except BaseException as error:
            entry["error_type"] = type(error).__name__
            if isinstance(getattr(error, "context", None), dict):
                error.context["compile"] = {"origin": self.record}
            raise
        finally:
            entry["elapsed_sec"] = round(time.monotonic() - started, 3)
            entry["finished_at"] = datetime.now(timezone.utc).isoformat()
            if result is not None:
                output = self.folder / f"{index}-{kind}.output.log"
                save(output, result.stdout + result.stderr)
                entry["output_log_path"] = str(output)
            if engine_log and Path(engine_log).is_file():
                current = Path(engine_log).stat()
                snapshot = self.folder / f"{index}-{kind}.engine.log"
                snapshot.write_bytes(Path(engine_log).read_bytes())
                entry.update(
                    engine_log_path=str(snapshot),
                    engine_log_mtime_ns=current.st_mtime_ns,
                    engine_log_changed=previous is None
                    or (previous.st_mtime_ns, previous.st_ctime_ns, previous.st_size)
                    != (current.st_mtime_ns, current.st_ctime_ns, current.st_size),
                )
            entry["main_source_unchanged"] = (
                hashlib.sha256(self.source.read_bytes()).hexdigest()
                == self.record["main_source_sha256"]
                if self.source.is_file()
                else False
            )
            save(self.folder / COMPILATION_MANIFEST, self.record)


def layout(text):
    """Material overflow is a publication defect even with a successful TeX exit."""
    lines = text.splitlines()
    issues = []
    for index, line in enumerate(lines):
        floating = FLOAT_OVERFLOW.search(line)
        box = BOX_OVERFLOW.search(line)
        if not floating and not box:
            continue
        points = float(floating[1] if floating else box[2])
        if points <= LAYOUT_TOLERANCE_PT:
            continue
        issues.append(
            {
                "kind": "float_too_large" if floating else "overfull_" + box[1] + "box",
                "overflow_pt": points,
                "message": line.strip(),
                "context": "\n".join(lines[index : index + 3])[:MAX_LINE],
            }
        )
    return {
        "status": "FAILED" if issues else "SUCCESS",
        "code": LAYOUT_ERROR if issues else None,
        "issues": issues[:MAX_DETAILS],
        "issues_truncated": len(issues) > MAX_DETAILS,
        "next_action": "Reflow the reported source within page and cell widths. Use an unboxed multipage longtable for an overheight table; preserve all rows, formulas and qualifications. Republish and inspect the affected pages.",
    }


def bibliography(required, available, aux_exists, result):
    if not required:
        return {"status": "NOT_REQUIRED", "returncode": None, "issues": []}
    if not available:
        return {
            "status": "FAILED",
            "code": BIB_UNAVAILABLE,
            "returncode": None,
            "issues": [],
            "next_action": "Restore the configured BibTeX tool; keep the manuscript and bibliography.",
        }
    if not aux_exists:
        return {
            "status": "FAILED",
            "code": BIB_AUX_MISSING,
            "returncode": None,
            "issues": [],
            "next_action": "Resolve the first LaTeX pass failure before running BibTeX.",
        }
    if result is None:
        return {
            "status": "FAILED",
            "code": BIB_ERROR,
            "returncode": None,
            "issues": [],
            "next_action": "Inspect the failed bibliography process; do not regenerate chapters.",
        }
    output = result.stdout + result.stderr
    lines = output.splitlines()
    issues = []
    for index, line in enumerate(lines):
        if any(marker in line for marker in BIB_MARKERS):
            context = "\n".join(lines[index : index + 2])[:MAX_LINE]
            key = re.search(r"for entry\s+(\S+)", line)
            issue = {"message": context}
            if key:
                issue["cite_key"] = key[1]
            if "Too many commas" in line:
                # BibTeX uses the same name parser for authors and editors.
                # This message alone does not identify which field failed.
                issue["field"] = "name"
                issue["possible_fields"] = ["author", "editor"]
            issues.append(issue)
    if result.returncode and not issues:
        issues = [{"message": "\n".join(lines[-MAX_DETAILS:])[:MAX_LINE]}]
    return {
        "status": "SUCCESS" if result.returncode == 0 else "FAILED",
        "code": None if result.returncode == 0 else BIB_ERROR,
        "returncode": result.returncode,
        "issues": issues[:MAX_DETAILS],
        "issues_truncated": len(issues) > MAX_DETAILS,
        "next_action": "Repair the named bibliography entries or style using verified metadata; keep cite keys and completed chapters, then republish.",
    }
