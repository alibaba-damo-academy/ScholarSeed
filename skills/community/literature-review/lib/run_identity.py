"""Record Codex run identity and the exact skill version.

The pipeline owns a lightweight, filesystem-local audit trail because skill
workspaces may outlive the Codex task that created them. Each stage records the
version fingerprint and an optional task identifier supplied by the surrounding
environment. Missing task metadata never blocks a run.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

AUDIT_DIRNAME = "_audit"
RUN_FILENAME = "run.json"
STAGES_FILENAME = "stages.jsonl"


def session_id() -> str:
    """Optional Codex task identifier supplied by the host, or an empty value."""
    for name in ("CODEX_THREAD_ID", "CODEX_SESSION_ID"):
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def _git(home: Path, *args: str) -> str:
    try:
        out = subprocess.run(("git", "-C", str(home), *args),
                             capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


# What a fingerprint hashes. Everything here changes what the pipeline does:
# prose the agents read, prompts, scripts, schemas, stage wiring. Excluded are
# caches and vendored trees, which move for reasons unrelated to this skill's
# behaviour and would make every fingerprint unique for no information.
_FINGERPRINT_GLOBS = ("SKILL.md", "references/roles/*.md", "references/*.md",
                      "schema/**/*.json", "config/**/*.json",
                      "scripts/**/*.py", "scripts/**/*.sh", "scripts/**/*.cmd", "scripts/slr", "scripts/setup",
                      "lib/**/*.py")


_FINGERPRINT_CACHE: dict[str, str] = {}


def _fingerprint(home: Path) -> str:
    """A content hash of the files that decide what this skill does.

    The fallback identity when there is no git. It cannot be resolved back to a
    diff, but it answers the question a version string exists to answer: were
    these two runs the same code? Two runs sharing a fingerprint ran the same
    tree; two that differ did not, and an audit can say so.
    """
    import hashlib

    # Cached per process: `append_stage` calls this once per stage, and the
    # skill tree cannot change mid-run in a way this should report differently.
    key = str(home)
    if key in _FINGERPRINT_CACHE:
        return _FINGERPRINT_CACHE[key]

    digest = hashlib.sha256()
    seen: set[Path] = set()
    for pattern in _FINGERPRINT_GLOBS:
        for path in sorted(home.glob(pattern)):
            if not path.is_file() or path in seen:
                continue
            seen.add(path)
            digest.update(str(path.relative_to(home)).encode())
            try:
                digest.update(path.read_bytes())
            except OSError:
                return ""
    value = digest.hexdigest()[:12] if seen else ""
    _FINGERPRINT_CACHE[key] = value
    return value


def skill_version(home: Path) -> dict:
    """
    Identify the skill tree. Every field degrades rather than raising: an audit
    trail is worth having even from a tarball with no `.git`, and a run must
    never fail because bookkeeping could not identify itself.

    Two things here are narrower than they look, and both were wrong before:

    `git status --porcelain -- .` is scoped to the skill directory. Unscoped,
    it reports the whole repository, so an edit to an unrelated sibling skill
    marked this one dirty.

    `skill_dirty` is `None`, not `False`, when nothing identified the tree.
    `false` there reads as "clean, trust the commit" when it means "no git, no
    way to tell" — an audit of one run read exactly that way and had to be
    corrected by hand.
    """
    commit = _git(home, "rev-parse", "--short", "HEAD")
    # `-C home` makes `.` the skill directory even when the repo root is above.
    dirty = bool(_git(home, "status", "--porcelain", "--", ".")) if commit else None
    fingerprint = _fingerprint(home)
    return {
        "skill_home": str(home),
        "skill_commit": commit,
        "skill_branch": _git(home, "rev-parse", "--abbrev-ref", "HEAD"),
        # Uncommitted edits mean the commit above does NOT describe what ran.
        # Recorded rather than prevented: forcing a commit before every test run
        # would interrupt the loop this exists to serve.
        "skill_dirty": dirty,
        # Present whether or not there is a git checkout, and the only identity
        # when there is not. Also the tiebreaker when `skill_dirty` is true:
        # the commit no longer describes the tree, but this does.
        "skill_fingerprint": fingerprint,
        "skill_identified": bool(commit or fingerprint),
        "skill_identified_by": ("git" if commit
                                else "fingerprint" if fingerprint else ""),
    }


def audit_dir(workspace: Path) -> Path:
    return workspace / AUDIT_DIRNAME


def write_run_header(workspace: Path, home: Path, profile: str) -> None:
    """
    Create `_audit/run.json` the first time anything runs in this workspace.

    Written once and never rewritten. It is a header, not a ledger: if a second
    session resumes the same workspace, that shows up in `stages.jsonl`, whose
    every line carries its own session and commit. Overwriting the header would
    erase the fact that the run spanned two sessions, which is precisely the
    kind of thing an audit is looking for.
    """
    path = audit_dir(workspace) / RUN_FILENAME
    if path.exists():
        return
    payload = {
        "session_id": session_id(),
        "workspace": str(workspace),
        "launch_cwd": os.getcwd(),
        "profile": profile,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "client": os.environ.get("AI_AGENT", "codex"),
        **skill_version(home),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
                    encoding="utf-8")


def append_stage(workspace: Path, home: Path, record: dict) -> None:
    """
    Append one line to `_audit/stages.jsonl`.

    `record` is the status object `slr` already computed and printed, so this
    costs one file append and no extra work. Session and commit go on every
    line, not only in the header, so a workspace touched by two sessions or by
    two versions of the skill reads correctly instead of averagely.

    Never raises: a full disk must degrade the audit trail, not the run.
    """
    try:
        version = skill_version(home)
        line = {
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "session_id": session_id(),
            "skill_commit": version["skill_commit"],
            "skill_dirty": version["skill_dirty"],
            "skill_fingerprint": version["skill_fingerprint"],
            **record,
        }
        path = audit_dir(workspace) / STAGES_FILENAME
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(line, ensure_ascii=False) + "\n")
    except OSError:
        pass
