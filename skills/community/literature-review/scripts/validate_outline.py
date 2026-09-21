#!/usr/bin/env scholarseed-skill-python
"""Validate a compact one/two-level outline and explicit user constraints.

Required node fields are section_id, title and description. Paper assignments,
figures and tables are optional. No chapter, subsection, asset or citation
quotas apply unless supplied through CLI flags or writing_request.json.
Existing richer outlines remain accepted. Editorial detail belongs to the
writer; this gate checks structure, identity and references that were supplied.
"""
from __future__ import annotations

# --- slr path bootstrap ---
import sys as _slr_sys, pathlib as _slr_pathlib
for _slr_anc in _slr_pathlib.Path(__file__).resolve().parents:
    if (_slr_anc / ".slr-home").is_file():
        _slr_sys.path.insert(0, str(_slr_anc / "lib"))
        break
else:
    raise RuntimeError("systematic-literature-review skill root not found above " + __file__)
# --- end slr path bootstrap ---

import argparse
import json
import re
import sys
from pathlib import Path

# Section-title vocabulary. The pipeline is bilingual, so every structural rule
# that keys on a section's role has to recognise both spellings.
_INTRO_WORDS = ("introduction", "引言", "绪论")
_CONCL_WORDS = ("conclusion", "总结", "结论", "展望")
_ABSTRACT_WORDS = ("abstract", "摘要")

# The keys an asset must carry. A *minimum*, not an exact set: the architect
# also writes what the figure is for and what it should draw, in prose, and
# `collect_figures.py` hands all of it to the figure planner. Demanding an
# exact key set would make richer description a validation error, which is the
# opposite of what the planner needs.
_FIGURE_KEYS = {"figure_id", "caption"}
_TABLE_KEYS = {"table_id", "caption"}



def _title_matches(title: str, words: tuple[str, ...]) -> bool:
    lowered = (title or "").lower()
    return any(w in lowered for w in words)


# ---------------------------------------------------------------------------
# Reader-facing title guidance is supplied by lib/writing_prompt_guidance.py.
# This validator keeps the identity checks needed to avoid ambiguous labels.
# ---------------------------------------------------------------------------

# A required-section title comes from the user's mouth and the section title
# comes from the architect's judgement, and they will not be byte-identical.
# "Threats to Validity", "Threats To Validity" and "Threats-to-Validity" are the
# same request; refusing the outline over a hyphen would teach the orchestrator
# to stop using the flag. So compare on a normalised form -- casefolded,
# punctuation flattened, whitespace collapsed, any leading section number
# dropped -- while every error message quotes the string the user actually
# wrote, because that is the one they can recognise.
_LEADING_NUMBER = re.compile(r"^\s*\d+(?:\.\d+)*[.)]?\s+")
_NON_WORD = re.compile(r"[^\w]+", re.UNICODE)


def _normalise_title(title: str) -> str:
    text = _LEADING_NUMBER.sub("", str(title or ""))
    return " ".join(_NON_WORD.sub(" ", text.casefold()).split())


def _role_of(section: dict) -> str:
    """Classify an L1 section so the placement rules can be applied.

    Abstract is identified by `section_id == "0"` as well as by title, because
    the generator has always reserved that id for it and downstream code
    (`collect_drafting_worklist`) special-cases the same id.
    """
    title = section.get("title", "")
    if str(section.get("section_id", "")).strip() == "0" or _title_matches(title, _ABSTRACT_WORDS):
        return "abstract"
    if _title_matches(title, _INTRO_WORDS):
        return "introduction"
    if _title_matches(title, _CONCL_WORDS):
        return "conclusion"
    return "body"


def _iter_assets(tree: list[dict], key: str):
    """Yield (owner_section_id, owner_role, asset) for every figure/table."""
    for section in tree:
        role = _role_of(section)
        for asset in section.get(key) or []:
            yield section.get("section_id"), role, asset
        for sub in section.get("subsections") or []:
            for asset in sub.get(key) or []:
                # A subsection inherits its parent's role for placement rules:
                # a figure under "Introduction > Scope" is still in the intro.
                yield sub.get("section_id"), role, asset


def load_whitelist(workspace: Path) -> tuple[list[str], dict[str, str], str | None]:
    """`(allowed paper ids, {cite_key: paper_id}, note)`.

    `paper_cards.json` is a mapping of paper id -> card, and that key — plus the
    `paperId` field, which is a copy of it — is the only spelling this gate
    accepts. **Cite keys are deliberately NOT accepted.**

    That used to be the other way round: the whitelist was `cite_key or paperId
    or <key>`, dating from when `outline_digest.py` mislabelled paper ids as
    cite keys and no real cite key existed anywhere. Real ones exist now
    (`03_process/cite_keys.json`, minted by `build_bib.py`), and accepting them
    here would be actively harmful: `collect_drafting_worklist.py` resolves each
    outline id with `cite_keys.get(pid)` — keyed by paper id — and *silently
    skips* whatever misses. An outline spelled in cite keys would therefore
    validate, then draft every section with an empty `allowed_papers` list and
    produce a survey with no citations at all, with nothing anywhere reporting a
    fault.

    So the cite-key map is loaded, but only to recognise that mistake and name
    it. `validate()` turns a hit into an instruction rather than "unknown id".
    """
    path = workspace / "03_process" / "paper_cards.json"
    keys_path = workspace / "03_process" / "cite_keys.json"

    cite_index: dict[str, str] = {}
    if keys_path.is_file():
        try:
            raw_keys = json.loads(keys_path.read_text(encoding="utf-8"))
            if isinstance(raw_keys, dict):
                cite_index = {str(v): str(k) for k, v in raw_keys.items() if v}
        except (json.JSONDecodeError, OSError):
            cite_index = {}

    if not path.is_file():
        return [], cite_index, f"paper_cards.json not found at {path}"
    try:
        cards = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return [], cite_index, f"paper_cards.json unreadable: {exc}"
    if not isinstance(cards, dict):
        return [], cite_index, "paper_cards.json is not an object keyed by paper id"

    allowed: list[str] = []
    for pid, raw in cards.items():
        raw = raw or {}
        allowed.append(pid)
        alt = raw.get("paperId")
        if alt:
            allowed.append(str(alt))
    return allowed, cite_index, None


def validate(outline: dict, allowed: set[str], limits: dict,
             cite_index: dict[str, str] | None = None) -> tuple[list[str], dict]:
    """Return (errors, stats). An empty error list means the contract holds.

    `cite_index` is `{cite_key: paper_id}` and is used only to tell the two
    kinds of bad id apart: a cite key written where a paper id belongs is a
    mechanical, one-substitution fix, and saying so saves a repair round that
    would otherwise be spent re-deriving which id the outline should have used.
    """
    errors: list[str] = []
    cite_index = cite_index or {}

    def bad_ids(where: str, unknown: list[str]) -> list[str]:
        """Both classes are reported. A section that mixes a swapped cite key
        with a genuinely invented id has two different problems, and collapsing
        them into one message would send the architect back for a second round
        over the half it was not told about."""
        swapped = [u for u in unknown if u in cite_index]
        invented = [u for u in unknown if u not in cite_index]
        out: list[str] = []
        if swapped:
            pairs = ", ".join(f"{k!r} -> {cite_index[k]!r}" for k in swapped[:3])
            out.append(
                f"{where} cites CITE KEYS where paper_ids belong: {pairs}. "
                f"paper_ids must be the ids from `outline_digest.py --ids-only` "
                f"(the bolded token in the digest), not the BibTeX keys — "
                f"drafting resolves paper_ids through cite_keys.json and drops "
                f"anything that misses, so this would silently produce sections "
                f"with no citations"
            )
        if invented:
            out.append(
                f"{where} cites paper_ids absent from paper_cards.json: "
                f"{invented[:3]} — use only ids from `outline_digest.py --ids-only`"
            )
        return out

    if not isinstance(outline, dict):
        return ["outline must be a JSON object"], {}
    tree = outline.get("outline_tree")
    if not isinstance(tree, list) or (not tree and not outline.get("description")):
        return ["outline_tree is missing or empty — the outline has no sections"], {}

    for field in (("survey_title", "topic") if tree else ("topic", "description")):
        if not isinstance(outline.get(field), str) or not outline[field].strip():
            errors.append(f"top-level field '{field}' is missing or empty — add it")

    # Validate types before traversing so malformed input produces a report,
    # rather than a traceback from a downstream dictionary/list operation.
    nodes = []
    for section in tree:
        if not isinstance(section, dict):
            errors.append("each outline_tree entry must be an object")
            continue
        nodes.append((section, None))
        subs = section.get("subsections", [])
        if not isinstance(subs, list):
            errors.append(f"section {section.get('section_id')} subsections must be an array")
            continue
        for sub in subs:
            if not isinstance(sub, dict):
                errors.append("each subsection must be an object")
            else:
                nodes.append((sub, section))
    if errors:
        return errors, {}

    seen_ids, seen_titles = set(), {}
    for node, parent in nodes:
        sid = str(node.get("section_id", ""))
        valid_path = (re.fullmatch(r"\d+", sid) if parent is None else
                      re.fullmatch(re.escape(str(parent.get("section_id"))) + r"\.\d+", sid))
        if not valid_path or sid in seen_ids:
            errors.append(f"section ID {sid!r} must be unique and follow its numeric parent path (for example 3 or 3.1)")
        seen_ids.add(sid)
        for field in ("title", "description"):
            if not isinstance(node.get(field), str) or not node[field].strip():
                errors.append(f"section {sid} has no non-empty {field}")
        if parent is None:
            language=str(node.get('language','default')).strip().lower()
            if language not in {'default','chinese','english'}:
                errors.append(f"section {sid} language must be default, chinese or english")
        elif 'language' in node:
            errors.append(f"subsection {sid} must inherit its top-level chapter language; omit the language key entirely (including default, null or the parent value)")
        title = str(node.get("title") or "").strip().casefold()
        if title in seen_titles:
            errors.append(f"section {sid} repeats the title already used by section {seen_titles[title]}")
        seen_titles[title] = sid
        if parent is not None and "subsections" in node:
            if not isinstance(node["subsections"], list):
                errors.append(f"subsection {sid} subsections must be an array when supplied")
            elif node["subsections"]:
                errors.append(f"subsection {sid} contains a third outline level; use only L1 and L2")
        for field in ("paper_ids", "cite_keys", "figures", "tables"):
            if field in node and not isinstance(node[field], list):
                errors.append(f"section {sid} {field} must be an array when supplied")
        for key in ("figures", "tables"):
            for asset in node.get(key, []) if isinstance(node.get(key, []), list) else []:
                if not isinstance(asset, dict):
                    errors.append(f"section {sid} {key} entries must be objects")
                else:
                    for field in ("paper_ids", "cite_keys"):
                        if field in asset and not isinstance(asset[field], list):
                            errors.append(f"section {sid} asset {field} must be an array when supplied")
    if errors:
        return errors, {}

    def check_references(node, where):
        pids = node.get("paper_ids", [])
        if any(not isinstance(p, str) for p in pids):
            errors.append(f"{where} paper_ids must contain strings")
        else:
            errors.extend(bad_ids(where, [p for p in pids if p not in allowed]))
        keys = node.get("cite_keys", [])
        unknown = [k for k in keys if not isinstance(k, str) or k not in cite_index]
        if unknown:
            errors.append(f"{where} cite_keys absent from cite_keys.json: {unknown[:3]}")

    def check_bounds(count, label, minimum, maximum):
        lo, hi = limits.get(minimum), limits.get(maximum)
        if lo is not None and count < lo:
            errors.append(f"{label} has {count}; this run requires at least {lo}")
        if hi is not None and count > hi:
            errors.append(f"{label} has {count}; this run allows at most {hi}")

    roles = [_role_of(s) for s in tree]
    l1_count = sum(r != "abstract" for r in roles)
    total_l2 = sum(len(s.get("subsections", [])) for s in tree)
    for node, parent in nodes:
        sid = node["section_id"]
        check_references(node, f"section {sid}")
        if parent is not None:
            check_bounds(len(set(p for p in node.get("paper_ids", []) if isinstance(p, str))), f"subsection {sid} papers",
                         "min_papers_per_subsection", "max_papers_per_subsection")

    if errors:
        return errors, {}

    # ---- papers reachable from an L1 body section ------------------------
    #
    # Count the union of direct L1 assignments and its subsections. The same
    # paper assigned twice cannot satisfy an explicit minimum twice.
    #
    # Abstract, Introduction and Conclusion are exempt. They legitimately carry
    # no papers of their own -- the Introduction's subsections are scope and
    # motivation, not a survey of anything -- and holding them to a corpus floor
    # would force the architect to pad them with citations it does not need.
    floor = limits.get("min_papers_per_section")
    if floor:
        for section, role in zip(tree, roles):
            if role != "body":
                continue
            sid = str(section.get("section_id") or "?")
            title = str(section.get("title") or sid)
            reachable = {
                p
                for sub in [section, *(section.get("subsections") or [])]
                for p in (sub.get("paper_ids") or [])
            }
            if len(reachable) < floor:
                errors.append(
                    f"L1 section {sid} '{title}' reaches {len(reachable)} distinct "
                    f"papers across its subsections; this run requires at least "
                    f"{floor}. Either move papers into its subsections from a "
                    f"section that has spare, or merge it into a neighbouring "
                    f"section — do not duplicate an id, the count is of distinct "
                    f"papers"
                )

    # ---- sections the user demanded exist -------------------------------
    #
    # Checked against L1 titles only, and against the L1 sequence with the
    # Abstract removed, so "first" means the first section after the Abstract.
    ordered = [s for s, r in zip(tree, roles) if r != "abstract"]
    ordered_norm = [_normalise_title(s.get("title")) for s in ordered]
    for spec in limits.get("required_sections") or []:
        want, position = spec["title"], spec.get("position", "any")
        # An explicit request for front matter must be checkable too. "First"
        # for ordinary body sections still means after an optional abstract.
        ordered = tree if _title_matches(want, _ABSTRACT_WORDS) else [s for s,r in zip(tree,roles) if r!='abstract']
        ordered_norm = [_normalise_title(s.get('title')) for s in ordered]
        target = _normalise_title(want)
        if target not in ordered_norm:
            errors.append(
                f"no L1 section matching the required title '{want}' — the user "
                f"asked for it explicitly, so add an L1 section titled '{want}' "
                f"(wording may differ, meaning may not)"
            )
            continue
        index = ordered_norm.index(target)
        found = str(ordered[index].get("title") or want)
        if position == "first" and index != 0:
            errors.append(
                f"required section '{want}' is at position {index + 1} of "
                f"{len(ordered)}; the user asked for it FIRST — move '{found}' "
                f"to the top of outline_tree, after the Abstract"
            )
        elif position == "last" and index != len(ordered) - 1:
            errors.append(
                f"required section '{want}' is at position {index + 1} of "
                f"{len(ordered)}; the user asked for it LAST — move '{found}' "
                f"to the end of outline_tree"
            )
        elif position.startswith("after:"):
            anchor = position[len("after:"):].strip()
            anchor_norm = _normalise_title(anchor)
            if anchor_norm not in ordered_norm:
                errors.append(
                    f"required section '{want}' must come after '{anchor}', but "
                    f"no L1 section matches '{anchor}' — add that section too, "
                    f"or the ordering cannot be satisfied"
                )
            elif ordered_norm.index(anchor_norm) >= index:
                anchor_at = ordered_norm.index(anchor_norm) + 1
                errors.append(
                    f"required section '{want}' is at position {index + 1} but "
                    f"'{anchor}' is at position {anchor_at}; the user asked for "
                    f"'{want}' to come AFTER '{anchor}' — reorder outline_tree "
                    f"so it does"
                )

    # All asset definitions are validated from the authoritative outline.
    from asset_plan import owners as asset_owners, plan_errors
    asset_errors=plan_errors(outline,allowed)
    errors.extend(asset_errors)
    figures=[asset for n in asset_owners(outline) for asset in (n.get('figures',[]) if isinstance(n.get('figures',[]),list) else []) if isinstance(asset,dict)]
    tables=[asset for n in asset_owners(outline) for asset in (n.get('tables',[]) if isinstance(n.get('tables',[]),list) else []) if isinstance(asset,dict)]
    n_fig,n_tab=len(figures),len(tables)
    check_bounds(n_fig,'figures','min_figures','max_figures')
    check_bounds(n_tab,'tables','min_tables','max_tables')
    for asset in [*figures,*tables]:
        if isinstance(asset.get('paper_ids'),list) and isinstance(asset.get('cite_keys',[]),list):
            check_references(asset,asset.get('figure_id') or asset.get('table_id'))

    # `papers_per_body_section` is reported whether or not a floor was asked
    # for, because it is the number that decides whether a floor is *reachable*
    # at all. "10 subsections need 4 papers each, the corpus has 22" is a
    # retrieval problem wearing an outline problem's clothes, and this stat plus
    # `corpus_size` is what lets the orchestrator tell the two apart.
    per_body = {
        str(s.get("section_id") or "?"): len({
            p for sub in [s, *(s.get("subsections") or [])] for p in (sub.get("paper_ids") or [])
        })
        for s, r in zip(tree, roles) if r == "body"
    }
    stats = {
        "l1_sections": l1_count,
        "l2_subsections": total_l2,
        "figures": n_fig,
        "tables": n_tab,
        "distinct_papers_cited": len({
            p
            for s in tree
            for sub in [s, *(s.get("subsections") or [])]
            for p in (sub.get("paper_ids") or [])
        }),
        "papers_per_body_section": per_body,
        "thinnest_body_section": min(per_body.values()) if per_body else 0,
    }
    return errors, stats


_POSITIONS = ("first", "last", "any")


def parse_required_section(spec: str) -> dict:
    """`"TITLE"`, `"TITLE@first"`, `"TITLE@last"`, `"TITLE@after:Other Title"`.

    The suffix is optional and split from the right, so a title containing an
    `@` still works as long as the tail is not one of the position words. An
    unrecognised suffix is treated as part of the title rather than rejected:
    guessing wrong about a literal `@` is recoverable, refusing to run is not.
    """
    title, _, tail = str(spec).rpartition("@")
    if not title:                       # no '@' at all
        return {"title": spec.strip(), "position": "any"}
    tail = tail.strip()
    if tail in _POSITIONS:
        return {"title": title.strip(), "position": tail}
    if tail.startswith("after:") and tail[len("after:"):].strip():
        return {"title": title.strip(), "position": "after:" + tail[len("after:"):].strip()}
    return {"title": str(spec).strip(), "position": "any"}


def derive_from_task(path: Path) -> tuple[dict, list[str]]:
    """Compile the one task contract into supported outline checks."""
    from task_contract import read_request, constraints, structural_contract
    request = read_request(path)
    doc = {'constraints': constraints(request)}
    derived: dict = {}
    notes: list[dict] = []

    def note(keys, text):
        notes.append({"keys": list(keys), "text": text})

    for req in doc.get("constraints") or []:
        if not isinstance(req, dict):
            continue
        enforcement = req.get("enforcement") or {}
        if enforcement.get("mode") != "validator":
            continue
        if "outline" not in (enforcement.get("where") or []):
            continue

        rid, kind, value = req.get("id", "?"), req.get("kind"), req.get("value")
        if kind == "forbidden_section":
            derived.setdefault("forbidden_sections", []).append(value)
        elif kind == "min_papers_per_section" and isinstance(value, int):
            derived["min_papers_per_section"] = value
            note(["min_papers_per_section"],
                 f"{rid}: --min-papers-per-section {value}")
        elif kind == "required_section" and isinstance(value, dict):
            entry = {"title": str(value.get("title", "")).strip(),
                     "position": str(value.get("position") or "any")}
            if entry["title"]:
                derived.setdefault("required_sections", []).append(entry)
                note(["required_sections"],
                     f"{rid}: --required-section "
                     f"\"{entry['title']}@{entry['position']}\"")
        elif kind == "table_count" and isinstance(value, dict):
            if isinstance(value.get("min"), int):
                derived["min_tables"] = value["min"]
            if isinstance(value.get("max"), int):
                derived["max_tables"] = value["max"]
            note(["min_tables", "max_tables"],
                 f"{rid}: --min-tables {derived.get('min_tables')} "
                 f"--max-tables {derived.get('max_tables')}")
        elif kind == "figure_count" and isinstance(value, dict):
            if isinstance(value.get("min"), int):
                derived["min_figures"] = value["min"]
            if isinstance(value.get("max"), int):
                derived["max_figures"] = value["max"]
            note(["min_figures", "max_figures"],
                 f"{rid}: --min-figures {derived.get('min_figures')} "
                 f"--max-figures {derived.get('max_figures')}")
        else:
            # A `validator`/`outline` requirement of a kind this script has no
            # gate for is exactly the broken promise task_contract.py
            # exists to catch. Say it out loud rather than ignoring the entry.
            note([], f"{rid}: kind {kind!r} is marked validator@outline but "
                     f"validate_outline.py has no gate for it — nothing "
                     f"enforces this requirement")
    derived["required_sections"] = structural_contract(request)["required_sections"]
    return derived, notes


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("workspace", nargs="?", default=".", help="run workspace (default: cwd)")
    # Numeric limits default to None so an explicitly passed value is
    # distinguishable from an unset one; the real defaults are applied after
    # task constraints have been applied.
    ap.add_argument("--min-figures", type=int, default=None)
    ap.add_argument("--max-figures", type=int, default=None)
    ap.add_argument("--min-tables", type=int, default=None)
    ap.add_argument("--max-tables", type=int, default=None)
    ap.add_argument("--min-papers-per-subsection", type=int, default=None,
                    help="raise when the user wants each subsection cited more deeply")
    ap.add_argument("--max-papers-per-subsection", type=int, default=None)
    ap.add_argument("--min-papers-per-section", type=int, default=None,
                    help="floor on the distinct papers an L1 body section reaches "
                         "through its subsections; Abstract/Introduction/Conclusion "
                         "are exempt")
    ap.add_argument("--required-section", action="append", default=[],
                    metavar='"TITLE[@first|@last|@after:OTHER]"',
                    help="assert an L1 section with this title exists, optionally "
                         "at a position; repeatable")
    ap.add_argument("--json", action="store_true", help="emit the report as JSON")
    args = ap.parse_args()

    workspace = Path(args.workspace).resolve()
    outline_path = workspace / "04_outline" / "outline.json"
    if not outline_path.is_file():
        print(f"[FAIL] outline.json not found at {outline_path}", file=sys.stderr)
        return 2
    try:
        outline = json.loads(outline_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"[FAIL] outline.json is not readable JSON: {exc}", file=sys.stderr)
        return 2

    try:
        derived, derivation_notes = derive_from_task(workspace)
    except (ValueError, OSError) as exc:
        print(f'[FAIL] invalid writing task: {exc}', file=sys.stderr)
        return 2

    from writing_contract import read_request, select_outline
    request = read_request(workspace)
    outline = select_outline(outline, request)
    allowed_list, cite_index, whitelist_note = load_whitelist(workspace)

    # Diagnostic flags may tighten a check, never weaken the task contract.
    def pick(flag_value, key, fallback):
        bound=derived.get(key,fallback)
        if flag_value is None: return bound
        if bound is None: return flag_value
        return max(flag_value,bound) if key.startswith('min_') else min(flag_value,bound)

    limits = {
        # Asset and reference counts are constraints only when requested.
        "min_figures": pick(args.min_figures, "min_figures", None),
        "max_figures": pick(args.max_figures, "max_figures", None),
        "min_tables": pick(args.min_tables, "min_tables", None),
        "max_tables": pick(args.max_tables, "max_tables", None),
        "min_papers_per_subsection": pick(args.min_papers_per_subsection,
                                          "min_papers_per_subsection", None),
        "max_papers_per_subsection": pick(args.max_papers_per_subsection,
                                          "max_papers_per_subsection", None),
        "min_papers_per_section": pick(args.min_papers_per_section,
                                       "min_papers_per_section", None),
        # An explicit --required-section replaces the derived list rather than
        # adding to it, so a repair round can narrow the demand to the one rule
        # it is retrying without the others firing again.
        "required_sections": derived.get("required_sections", []) + [parse_required_section(s) for s in args.required_section],
    }
    limits["output_scope"] = request["output_scope"]
    limits["forbidden_sections"] = derived.get("forbidden_sections",[])
    errors, stats = validate(outline, set(allowed_list), limits, cite_index)
    from structure_checks import outline_structure_errors
    errors.extend(outline_structure_errors(request,outline))
    if request['writing_strategy']=='chapter_delta' and not errors:
        from chapter_plan import compile_plan
        try:stats['chapter_jobs']=len(compile_plan(outline,set(allowed_list))['jobs'])
        except (ValueError,KeyError,TypeError) as exc:errors.append(str(exc))

    report = {
        "valid": not errors,
        "errors": errors,
        "stats": stats,
        "limits": limits,
        "outline": str(outline_path),
    }
    overridden = {
        key for key, flag in (
            ("min_figures", args.min_figures),
            ("max_figures", args.max_figures),
            ("min_tables", args.min_tables),
            ("max_tables", args.max_tables),
            ("min_papers_per_subsection", args.min_papers_per_subsection),
            ("max_papers_per_subsection", args.max_papers_per_subsection),
            ("min_papers_per_section", args.min_papers_per_section),
        ) if flag is not None and key in derived
    }
    if args.required_section and "required_sections" in derived:
        overridden.add("required_sections")

    # An outline without assignments can be checked before cards are available.
    # Supplied references still fail membership checks when no whitelist exists.
    if whitelist_note:
        report["warning"] = f"{whitelist_note} — no paper_id whitelist is available; supplied paper_ids cannot validate"

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        # Print what was derived before the verdict. An orchestrator reading a
        # failure needs to know which gates were even active -- "it passed" and
        # "it passed because no gate was switched on" look identical otherwise.
        for note in derivation_notes:
            beaten = note["keys"] and set(note["keys"]) <= overridden
            suffix = "   (OVERRIDDEN by an explicit flag)" if beaten else ""
            print(f"[REQ] {note['text']}{suffix}")
        if whitelist_note:
            print(f"[WARN] {report['warning']}")
        if errors:
            print(f"[FAIL] outline violates {len(errors)} contract rule(s):")
            for err in errors:
                print(f"  - {err}")
        else:
            print("[OK] outline satisfies the contract: " + ", ".join(
                f"{k}={v}" for k, v in stats.items() if not isinstance(v, dict)))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
