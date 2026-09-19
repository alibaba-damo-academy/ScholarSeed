"""Workspace I/O layer — isolated paths under ./07_verifier/fast_audit/.

The workspace defaults to the **current working directory** (no --workspace
argument, no snapshot copy). All paths below are relative to CWD.

Hard contract:
    INPUT (read-only):
        ./01_input/query.json                       (optional task metadata)
        ./05_generation/full_draft.tex              (the paper to audit)
        ./05_generation/citations.bib               (optional; citation_reality)
        ./05_generation/_internal/cite_keys.json    (optional; citation_reality)
        ./03_process/paper_cards.json               (optional; citation_reality)
        ./02_retrieval/selected_paper.json          (optional; citation_reality)
        ./07_verifier/input/                        (optional sub-inputs, SHARED
                                                     across future citation/
                                                     claim verifiers)
            experiment_data.json
            db_metadata.json
            coverage_input.json
            relevance_pairs.json

    OUTPUT (write — fast_audit-owned, isolated from other verifiers):
        ./07_verifier/fast_audit/tmp/
            citation_placeholder.json
            citation_crossfield.json
        ./07_verifier/fast_audit/output/
            content_quality_result.json
            integrity_result.json
            coverage_result.json
            relevance_result.json
            fast_audit_report.json
            aggregated_issues.json
            final_report.md
        ./07_verifier/fast_audit/status/
            <module>.status.json
            fast_audit.status.json

The subagent reads the upstream draft from 05_generation/ but writes nothing
outside 07_verifier/fast_audit/ — including not 06_output/, and not the
shared 07_verifier/input/ tree.
"""

import json
import re
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

_RE_INPUT = re.compile(r"\\(?:input|include|subfile)\s*\{([^{}\n]+?)\}")
_MAX_INCLUDE_DEPTH = 6


class StatusCode(str, Enum):
    SUCCESS = "SUCCESS"
    PARTIAL_SUCCESS = "PARTIAL_SUCCESS"
    REJECTED = "REJECTED"
    FAILED = "FAILED"
    SKIPPED = "SKIPPED"


# Default upstream input filenames (./05_generation/)
UPSTREAM_DRAFT_CANDIDATES = tuple(f"full_draft_v{v}.{ext}" for v in (3,2,1) for ext in ("md","tex")) + ("full_draft.tex", "full_draft.md", "full_draft.txt")
UPSTREAM_QUERY = "01_input/query.json"

# Sub-input filenames (./07_verifier/input/)
SUB_INPUT_FILES = {
    "experiment_data":  "experiment_data.json",
    "db_metadata":      "db_metadata.json",
    "coverage_input":   "coverage_input.json",
    "relevance_pairs":  "relevance_pairs.json",
}


class WorkspaceIO:
    """Thin filesystem facade rooted at the current working directory."""

    def __init__(self, workspace: str | Path | None = None):
        self.workspace = Path(workspace).resolve() if workspace else Path.cwd().resolve()
        if not self.workspace.exists():
            raise FileNotFoundError(f"Workspace does not exist: {self.workspace}")
        if not self.workspace.is_dir():
            raise NotADirectoryError(f"Workspace is not a directory: {self.workspace}")
        # verifier_root = the umbrella 07_verifier/ shared by all verifiers.
        # fa_root = fast_audit-owned subtree under it. input/ lives under
        # verifier_root (shared); tmp/output/status live under fa_root (isolated).
        self.verifier_root = self.workspace / "07_verifier"
        self.input_dir = self.verifier_root / "input"
        self.fa_root = self.verifier_root / "fast_audit"
        self.tmp_dir = self.fa_root / "tmp"
        self.output_dir = self.fa_root / "output"
        self.status_dir = self.fa_root / "status"
        # read_draft() is called once per module runner (≥6× per cmd_run).
        # Drafts are 100–500 KB; cache the decoded text for the lifetime of
        # this WorkspaceIO instance to avoid repeated read_text() round-trips.
        self._draft_cache: str | None = None
        self._draft_path: Path | None = None
        self._full_draft_cache: str | None = None

    # ── setup ──────────────────────────────────────────────────────
    def ensure(self) -> None:
        for d in (self.input_dir, self.tmp_dir, self.output_dir, self.status_dir):
            d.mkdir(parents=True, exist_ok=True)

    # ── upstream reads ─────────────────────────────────────────────
    def read_draft(self) -> str:
        if self._draft_cache is not None:
            return self._draft_cache
        from task_contract import read_request, publication_view
        spec = publication_view(read_request(self.workspace))
        name = 'survey.md' if spec['format']=='markdown' else 'survey.tex'
        survey = self.workspace/'06_output'/name
        if survey.exists():
            self._draft_cache=survey.read_text(encoding='utf-8',errors='replace')
            self._draft_path=survey
            return self._draft_cache
        gen = self.workspace / "05_generation"
        if not gen.exists():
            raise FileNotFoundError(
                f"Missing 06_output/survey.tex and 05_generation/ in {self.workspace}"
            )
        for name in UPSTREAM_DRAFT_CANDIDATES:
            p = gen / name
            if p.exists():
                self._draft_cache = p.read_text(encoding="utf-8", errors="replace")
                self._draft_path = p
                return self._draft_cache
        raise FileNotFoundError(
            f"No 06_output/survey.tex and no full_draft.{{tex,md,txt}} in {gen}"
        )

    def read_full_draft(self) -> str:
        """Like read_draft() but recursively splices in `\\input`/`\\include`/
        `\\subfile` bodies so cite-keys and content inside table/figure
        subfiles are visible to scanners that only look at one text blob.
        Cycle-safe via a visited set; depth-capped at _MAX_INCLUDE_DEPTH."""
        if self._full_draft_cache is not None:
            return self._full_draft_cache
        text = self.read_draft()
        root = self._draft_path
        if root is None:
            self._full_draft_cache = text
            return self._full_draft_cache
        visited = {root.resolve()}
        self._full_draft_cache = self._expand_includes(text, root, visited, 0)
        return self._full_draft_cache

    def _expand_includes(
        self, text: str, includer_path: Path, visited: set[Path], depth: int,
    ) -> str:
        if depth >= _MAX_INCLUDE_DEPTH:
            return text
        # Splice in reverse order so earlier match offsets stay valid.
        for m in reversed(list(_RE_INPUT.finditer(text))):
            arg = m.group(1).strip()
            candidate = self._resolve_include(arg, includer_path)
            if candidate is None:
                continue
            resolved = candidate.resolve()
            if resolved in visited:
                continue
            visited.add(resolved)
            try:
                sub = candidate.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            sub = self._expand_includes(sub, candidate, visited, depth + 1)
            text = text[:m.start()] + sub + text[m.end():]
        return text

    def _resolve_include(
        self, arg: str, includer_path: Path,
    ) -> Path | None:
        """Resolve an `\\input{<arg>}` argument to an on-disk path. Tries the
        includer's directory first, then a sibling-tree swap between
        06_output ↔ 05_generation (the survey pipeline mirrors table/figure
        subfiles across both). Appends `.tex` if no suffix is given."""
        arg_path = Path(arg)
        if not arg_path.suffix:
            arg_path = arg_path.with_suffix(".tex")
        direct = includer_path.parent / arg_path
        if direct.exists():
            return direct
        parts = direct.parts
        for src, dst in (("06_output", "05_generation"),
                         ("05_generation", "06_output")):
            if src in parts:
                swapped = Path(*[dst if p == src else p for p in parts])
                if swapped.exists():
                    return swapped
        return None

    def read_query(self) -> dict | None:
        from task_contract import read_query
        return read_query(self.workspace)

    def read_subinput(self, kind: str):
        """Return parsed JSON if the optional sub-input exists, else None."""
        if kind not in SUB_INPUT_FILES:
            raise KeyError(f"Unknown sub-input kind: {kind}")
        p = self.input_dir / SUB_INPUT_FILES[kind]
        if not p.exists():
            return None
        return json.loads(p.read_text(encoding="utf-8"))

    # ── upstream reads for citation_reality_offline ────────────────
    # All return None on miss; the citation_reality module degrades gracefully.
    def read_bib(self) -> str | None:
        """Return raw `05_generation/citations.bib` text, or None if absent."""
        p = self.workspace / "05_generation" / "citations.bib"
        if not p.exists():
            return None
        try:
            return p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None

    def read_cite_keys_map(self) -> dict | None:
        """Return `05_generation/_internal/cite_keys.json` (paper_id → cite_key)."""
        p = self.workspace / "05_generation" / "_internal" / "cite_keys.json"
        if not p.exists():
            return None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        return data if isinstance(data, dict) else None

    def read_paper_cards(self) -> dict | None:
        """Return `03_process/paper_cards.json` (paper_id → card dict)."""
        p = self.workspace / "03_process" / "paper_cards.json"
        if not p.exists():
            return None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        return data if isinstance(data, dict) else None

    def read_selected_paper(self) -> dict | None:
        """Return `02_retrieval/selected_paper.json` (paper_id → record).
        Currently used only as an optional extension hook; the citation_reality
        module degrades to None when absent."""
        p = self.workspace / "02_retrieval" / "selected_paper.json"
        if not p.exists():
            return None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        return data if isinstance(data, dict) else None

    # ── tmp / output / status ──────────────────────────────────────
    def exists(self, subdir: str, filename: str) -> bool:
        return (self._dir(subdir) / filename).exists()

    def read_json(self, subdir: str, filename: str):
        p = self._dir(subdir) / filename
        return json.loads(p.read_text(encoding="utf-8"))

    def write_json(self, subdir: str, filename: str, payload) -> Path:
        d = self._dir(subdir)
        d.mkdir(parents=True, exist_ok=True)
        p = d / filename
        p.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        return p

    def write_status(self, module: str, status: StatusCode, **fields) -> Path:
        payload = {
            "module": module,
            "status": status.value,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **fields,
        }
        return self.write_json("status", f"{module}.status.json", payload)

    # ── internal ───────────────────────────────────────────────────
    def _dir(self, subdir: str) -> Path:
        if subdir == "tmp":
            return self.tmp_dir
        if subdir == "output":
            return self.output_dir
        if subdir == "status":
            return self.status_dir
        if subdir == "input":
            return self.input_dir
        raise ValueError(f"Unknown subdir: {subdir}")

    # Convenience for cli.py
    def relpath(self, p: Path) -> str:
        try:
            return str(p.relative_to(self.workspace))
        except ValueError:
            return str(p)
