"""Local reading packets and paragraph provenance. No model or network calls.

Inspired by CPES's native text indexing and prepare/assemble boundary. The
existing HINT readers remain responsible for annotation and application formats.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from pathlib import Path
import re
import sys

from contextlib import nullcontext

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cpes_machine import native_lines, PDFDocument, Rect, engine_versions, render_page

from pdf_sources import build_bundle, fingerprint
from packet_selection import block_texts, infer_sections, plan_packet, section_sources
from paper_scope import infer_scope
from source_ids import build_source_aliases, canonical_source_id

VERSION = "hint-reading-v7"
NOTE_HEADING_PREFIX = "#### "
SECTION_HEADING_PREFIX = "##### "
BIBLIOGRAPHY_SEPARATOR = " · "


def text_hash(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def value_hash(value):
    return text_hash(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def read_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key}")
            result[key] = value
        return result
    return json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=unique)


def source_bindings(pdf, notes, visual, scope=None):
    values = [("pdf", pdf), *(("note", p) for p in notes)]
    if visual:
        values.append(("visual_review", visual))
    if scope:
        values.append(("scope_review", scope))
    return [{"role": role, "path": str(Path(p).expanduser().resolve()), "sha256": fingerprint(Path(p).expanduser())}
            for role, p in values]


def reader_code_hashes():
    root = Path(__file__).resolve().parent
    hashes = {name: fingerprint(root / name) for name in ("reading.py", "reading_pipeline.py", "pdf_sources.py", "packet_selection.py", "paper_scope.py", "packet_format.py", "object_policy.py", "source_ids.py")}
    for name in ("cpes_machine/__init__.py", "cpes_machine/cpes-format-converter/cpes_format_converter/native.py",
                 "cpes_machine/cpes-format-converter/cpes_format_converter/scope.py",
                 "cpes_machine/cpes-format-converter/cpes_format_converter/pdf.py"):
        hashes[name] = fingerprint(root.parent / name)
    return hashes


def load_index(path):
    index = read_json(path)
    if index.get("version") != VERSION:
        raise ValueError("Reading version changed; prepare a fresh directory.")
    original = {k: v for k, v in index.items() if k != "fingerprint"}
    if value_hash(original) != index.get("fingerprint"):
        raise ValueError("Prepared index changed.")
    if index.get("code_hashes") != reader_code_hashes():
        raise ValueError("Reader code changed; prepare a fresh directory.")
    if index.get("engines") != engine_versions():
        raise ValueError("PDF engine versions changed; prepare a fresh directory.")
    for item in index["bindings"]:
        if fingerprint(item["path"]) != item["sha256"]:
            raise ValueError(f"Original input changed: {item['path']}")
    packet = Path(path).resolve().parent / "packet.md"
    if not packet.is_file() or fingerprint(packet) != index["packet_sha256"]:
        raise ValueError("Prepared packet changed or missing.")
    return index


def native_index(pdf, document=None):
    pages, lines, catalog = [], [], []
    with (nullcontext(document) if document is not None else PDFDocument(pdf)) as doc:
        for page in doc:
            unrotated = page.native_rect
            page_info = {"page": page.number + 1, "page_label": page.label,
                         "width": unrotated.width, "height": unrotated.height, "rotation": page.rotation,
                         "media_box": list(page.mediabox), "crop_box": list(page.cropbox)}
            from object_policy import native_object_regions
            page_info["object_regions"], page_info["object_region_issues"] = native_object_regions(page)
            pages.append(page_info)
            blocks = {}
            for row in native_lines(page, page.rect.width * 2, page.rect.height * 2):
                block_id = row["source_line_id"].rsplit("-l", 1)[0]
                blocks.setdefault(block_id, []).append(row)
            for block_id, block_rows in blocks.items():
                ids = []
                box = Rect(block_rows[0]["bbox_points"])
                for row in block_rows:
                    box |= Rect(row["bbox_points"])
                    identifier = f"L{len(lines) + 1:06d}"
                    ids.append(identifier)
                    lines.append({"id": identifier, "page": page.number + 1,
                                  "source_line_id": row["source_line_id"], "font_size": row["font_size"], "bold": row["bold"],
                                  "text": row["text"], "rect": row["bbox_points"], "extraction_method": "native"})
                if ids:
                    catalog.append({"id": f"B{len(catalog) + 1:05d}", "kind": "paper_text", "identity": "paper",
                                    "page": page.number + 1, "line_ids": ids, "rects": [list(box)],
                                    "record_ids": [], "context_ids": [], "association": "explicit"})
    return pages, lines, catalog


def note_passages(body):
    rows = body.splitlines()
    start = 0
    while start < len(rows):
        while start < len(rows) and not rows[start].strip():
            start += 1
        end = start
        while end < len(rows) and rows[end].strip():
            end += 1
        if end > start:
            yield start + 1, end
        start = end


def context_ids(record, blocks):
    candidates = [b for b in blocks if b["page"] == record["page"]]
    boxes = [Rect(r) for r in record["rects"]]
    overlapping = [b["id"] for b in candidates if any(
        (Rect(b["rects"][0]) & r).get_area() > 0 for r in boxes)]
    if overlapping:
        return overlapping
    near = record.get("anchor", {}).get("candidates", [])
    if near:
        return [b["id"] for b in candidates if any(
            (Rect(b["rects"][0]) & Rect(n["rect"])).get_area() > 0 for n in near)]
    return []


def add_signals(bundle, catalog):
    blocks = list(catalog)
    a_count = n_count = 0
    for record in bundle["records"]:
        if record["source"] == "external_note":
            reference = record["source_refs"][0]
            for start, end in note_passages(record["text"]):
                n_count += 1
                catalog.append({"id": f"N{n_count:05d}", "kind": "external_note", "identity": "reader_note",
                                "page": None, "record_ids": [record["id"]], "rects": [], "context_ids": [],
                                "association": "user_supplied_with_this_paper", "note_file": reference["path"],
                                "note_lines": {"start": start, "end": end}})
            # Retain a supplied empty note as an explicit source requiring a decision.
            if not record["text"].strip():
                n_count += 1
                catalog.append({"id": f"N{n_count:05d}", "kind": "external_note", "identity": "reader_note",
                                "page": None, "record_ids": [record["id"]], "rects": [], "context_ids": [],
                                "association": "user_supplied_with_this_paper", "note_file": reference["path"],
                                "note_lines": {"start": 1, "end": 0}})
            continue
        a_count += 1
        quote = record["comment"] or (record["text"] if record["source"] == "embedded_note" else None)
        catalog.append({"id": f"A{a_count:05d}", "kind": record["source"],
                        "identity": "reader_comment" if quote else "paper",
                        "page": record["page"], "record_ids": [record["id"]], "rects": record["rects"],
                        "context_ids": context_ids(record, blocks),
                        "association": record["anchor"]["status"]})
    aliases = {rid: s["id"] for s in catalog for rid in s["record_ids"]}
    for source in catalog:
        if source["record_ids"]:
            record = next(r for r in bundle["records"] if r["id"] == source["record_ids"][0])
            if record["target_id"] in aliases:
                source["target_source_id"] = aliases[record["target_id"]]


def resolve(index, identifier):
    identifier = canonical_source_id(index, identifier)
    source = next((s for s in index["catalog"] if s["id"] == identifier), None)
    if source is None:
        raise ValueError(f"Unknown source: {identifier}")
    source = copy.deepcopy(source)
    if source["kind"] == "paper_text":
        lines = {r["id"]: r for r in index["lines"]}
        source["text"] = "\n".join(lines[i]["text"] for i in source["line_ids"])
        source["location"] = f"Text block {identifier}; {source['line_ids'][0]}–{source['line_ids'][-1]}"
    else:
        record = next(r for r in index["records"] if r["id"] == source["record_ids"][0])
        if source["kind"] == "external_note":
            scope = source["note_lines"]
            source["text"] = "\n".join(record["text"].splitlines()[scope["start"] - 1:scope["end"]])
            source["reader_source_quote"] = source["text"]
            source["location"] = f"{source['note_file']}:{scope['start']}–{scope['end']}"
        else:
            source["text"] = record["text"]
            source["comment"] = record["comment"]
            source["location"] = f"{record['source']} / {record['kind']} / {identifier}"
            if record["comment"] or record["source"] == "embedded_note":
                source["reader_source_quote"] = record["comment"] or record["text"]
            source["channels"] = list(dict.fromkeys(r["channel"] for r in record["source_refs"]))
    return source


def make_packet(index):
    from packet_format import render_packet
    sources = {s["id"]: resolve(index, s["id"]) for s in index["catalog"]}
    return render_packet(index, sources)


def write_new_directory(out, files):
    out = Path(out).expanduser().resolve()
    if out.exists():
        raise ValueError("Output already exists; choose a fresh directory.")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.mkdir()
    for name, body in files.items():
        with (out / name).open("x", encoding="utf-8") as stream:
            stream.write(body)


def prepare(pdf, out, notes=(), visual=None, goal="", scope=None):
    out = Path(out).expanduser().resolve()
    pdf = Path(pdf).expanduser().resolve()
    notes = list(dict.fromkeys(Path(n).expanduser().resolve() for n in notes))
    bindings = source_bindings(pdf, notes, visual, scope)
    if out.exists():
        index = load_index(out / "reading.json")
        if index["bindings"] != bindings or index["goal"] != goal or index["engines"] != engine_versions():
            raise ValueError("Prepared inputs, goal or extractor changed; use a fresh directory.")
        reused = True
    else:
        with PDFDocument(pdf) as document:
            bundle = build_bundle(pdf, notes, visual, document=document)
            pages, lines, catalog = native_index(pdf, document)
        add_signals(bundle, catalog)
        index = {"schema_version": 1, "version": VERSION, "engines": engine_versions(),
                 "document": bundle["document"], "bindings": bindings, "code_hashes": reader_code_hashes(), "goal": goal,
                 "pages": pages, "lines": lines, "catalog": catalog, "records": bundle["records"],
                 "attachments": bundle["attachments"], "conflicts": bundle["conflicts"], "coverage": bundle["coverage"]}
        index["source_aliases"] = build_source_aliases(index["catalog"])
        index["sections"] = infer_sections(index)
        index["paper_scope"] = infer_scope(index, block_texts(index), read_json(scope) if scope else None)
        index["packet_selection"] = plan_packet(index)
        packet = make_packet(index)
        index["packet_sha256"] = text_hash(packet)
        index["stats"] = {"native_lines": len(lines), "paper_characters": sum(len(l["text"]) for l in lines),
                          "packet_characters": len(packet), "source_units": len(catalog),
                          "selected_paper_blocks": index["packet_selection"]["selected_paper_blocks"],
                          "selected_paper_characters": index["packet_selection"]["selected_paper_characters"],
                          "scope_status": index["paper_scope"]["status"],
                          "visual_units_to_check": len(index["packet_selection"]["visual_requirements"]),
                          "pages_without_native_text": [p["page"] for p in pages if not any(l["page"] == p["page"] for l in lines)]}
        index["fingerprint"] = value_hash(index)
        # Freeze only if the source files are still identical after extraction.
        if source_bindings(pdf, notes, visual, scope) != bindings:
            raise ValueError("Input changed during preparation.")
        write_new_directory(out, {"reading.json": json.dumps(index, ensure_ascii=False, indent=2) + "\n", "packet.md": packet})
        reused = False
    return {"ok": True, "index": str(out / "reading.json"), "packet": str(out / "packet.md"),
            "reused": reused, "model_calls": 0, **index["stats"]}


def show(path, identifiers, with_context=False, max_chars=12000, sections=()):
    if max_chars < 1:
        raise ValueError("max_chars must be positive.")
    index = load_index(path)
    identifiers = list(dict.fromkeys([*identifiers, *section_sources(index, sections)]))
    if not identifiers:
        raise ValueError("Choose source or section IDs.")
    if with_context:
        identifiers += [c for sid in list(identifiers) for c in resolve(index, sid)["context_ids"] if c not in identifiers]
        identifiers = list(dict.fromkeys(identifiers))
    sources, remaining = [], max_chars
    for sid in identifiers:
        source = resolve(index, sid)
        # The reader quote is already present in text/comment; retain it in the
        # assembled provenance, not as a duplicate in model-facing lookups.
        source.pop("reader_source_quote", None)
        for field in ("text", "comment"):
            if field in source:
                raw = source[field]
                source[field] = raw[:remaining]
                if len(raw) > remaining:
                    source[field + "_truncated"] = True
                remaining = max(0, remaining - len(source[field]))
        sources.append(source)
    return {"ok": True, "sources": sources, "max_characters": max_chars,
            "truncated": any(k.endswith("_truncated") for s in sources for k in s), "model_calls": 0}


def search(path, query, limit=8):
    if not isinstance(query, str) or not query.strip() or not 1 <= limit <= 50:
        raise ValueError("Use a nonempty query and a limit of 1..50.")
    index = load_index(path)
    terms = set(re.findall(r'\w+', query.casefold()))
    if not terms:
        raise ValueError("Query needs searchable words.")
    matches = []
    for item in index["catalog"]:
        source = resolve(index, item["id"])
        text = source["text"] + ("\n" + source["comment"] if source.get("comment") else "")
        lower = text.casefold()
        hits = [word for word in terms if word in lower]
        if not hits:
            continue
        start = max(0, min(lower.find(word) for word in hits) - 80)
        matches.append({"id": source["id"], "kind": source["kind"], "page": source["page"],
                        "score": len(hits) + 2 * (query.casefold() in lower),
                        "excerpt": text[start:start + 280], "excerpt_only": True})
    matches.sort(key=lambda s: -s["score"])
    return {"ok": True, "matches": matches[:limit], "total_matches": len(matches),
            "query": query, "model_calls": 0}


def scope_summary(path):
    index = load_index(path)
    scope = index["paper_scope"]
    regions = [{"id": r["id"], "role": r["role"], "pages": r["pages"],
                "first_source_id": r["source_ids"][0], "last_source_id": r["source_ids"][-1],
                "source_count": len(r["source_ids"])} for r in scope["regions"]]
    return {"ok": True, "pdf_sha256": index["document"]["sha256"], "native_index_sha256": scope["native_index_sha256"], "status": scope["status"],
            "regions": regions, "boundary_candidates": scope["boundary_candidates"],
            "warnings": scope["warnings"], "model_calls": 0}


def crop(path, out, source_id=None, page_number=None, rect=None, dpi=140, padding=12):
    index = load_index(path)
    if not 36 <= dpi <= 300 or not math.isfinite(padding) or padding < 0:
        raise ValueError("Use DPI 36..300 and nonnegative finite padding.")
    association = "explicit_region"
    expanded_line_ids = []
    crop_scope = "explicit_region"
    if source_id:
        source = resolve(index, source_id)
        source_id = source["id"]
        if source["page"] is None:
            raise ValueError("Source has no PDF page; inspect its original note text instead.")
        page_number = source["page"]
        association = source["association"]
        crop_scope = "source_context"
        boxes = list(source["rects"])
        for cid in source["context_ids"]:
            boxes += resolve(index, cid)["rects"]
        if not boxes:
            units = index["packet_selection"]["visual_requirements"]
            if any(source_id in u["source_ids"] and u["kind"] == "unlocated_mark" for u in units):
                info = index["pages"][page_number - 1]
                boxes = [[0, 0, info["width"], info["height"]]]
            else:
                raise ValueError("Source has no region; use an explicit page and rectangle.")
        rect = list(Rect(boxes[0]))
        for box in boxes[1:]:
            rect = list(Rect(rect) | Rect(box))
        # Formulas can occupy several native blocks. Include complete nearby
        # lines, using the original window so expansion cannot chain across a
        # column. This is geometric context, not an asserted semantic target.
        original = Rect(rect)
        # Native layout engines may split one formula into many short blocks.
        # Use the original vertical window and a supported column boundary,
        # rather than letting the new fragment width clip the expression.
        info = index["pages"][page_number - 1]
        middle = info["width"] / 2
        body_lines = [line for line in index["lines"] if line["page"] == page_number and len(line["text"]) >= 45]
        columns = (sum(line["rect"][2] < middle + 8 for line in body_lines) >= 2
                   and sum(line["rect"][0] > middle - 8 for line in body_lines) >= 2)
        left, right = ((middle, info["width"]) if original.x0 >= middle else (0, middle)) if columns else (0, info["width"])
        for line in index["lines"]:
            if line["page"] != page_number:
                continue
            box = Rect(line["rect"])
            if (box.y1 > original.y0 - 6 and box.y0 < original.y1 + 6
                    and box.x0 >= left and box.x1 <= right):
                rect = list(Rect(rect) | box)
                expanded_line_ids.append(line["id"])
        units = index["packet_selection"]["visual_requirements"]
        source_ids = {source_id, *source["context_ids"]}
        page_unit = any(u["page"] == page_number and u["kind"] in {"figure", "table", "unlocated_mark"}
                        and source_ids.intersection(u["source_ids"]) for u in units)
        if index["pages"][page_number - 1]["rotation"] and source["kind"].startswith("embedded") and not page_unit:
            raise ValueError("Rotated application coordinates require visual checking and an explicit region.")
        if page_unit:
            info = index["pages"][page_number - 1]
            rect = [0, 0, info["width"], info["height"]]
            crop_scope = "page_for_visual_unit"
    if not isinstance(page_number, int) or not 1 <= page_number <= index["document"]["page_count"]:
        raise ValueError("Invalid physical PDF page.")
    if not rect or len(rect) != 4 or not all(math.isfinite(v) for v in rect) or rect[0] >= rect[2] or rect[1] >= rect[3]:
        raise ValueError("Use a nonempty finite rectangle x0 y0 x1 y1 in unrotated PDF points.")
    destination = Path(out).expanduser().resolve()
    if destination.exists():
        raise ValueError("Crop output already exists.")
    with PDFDocument(index["document"]["path"]) as doc:
        page = doc[page_number-1]
        box=(Rect(rect)+(-padding,-padding,padding,padding)) & page.native_rect
        if box.is_empty:raise ValueError("Crop is outside the page.")
        displayed=page.display_rect(box)
        image=render_page(index["document"]["path"],page_number-1,scale=dpi/72,region=displayed,annotations=True)
        destination.parent.mkdir(parents=True,exist_ok=True)
        with destination.open("xb") as stream:image.save(stream,format='PNG')
    return {"ok": True, "image": str(destination), "page": page_number, "source_id": source_id,
            "clip_pdf_points": list(box), "association": association, "dpi": dpi,
            "expanded_line_ids": expanded_line_ids,
            "crop_scope": crop_scope,
            "width": image.width, "height": image.height, "annotations_rendered": True,
            "visual_review_status": "pending", "model_calls": 0}


def clean_title(value):
    if not isinstance(value, str) or not value.strip() or "\n" in value or "<!--" in value:
        raise ValueError("Titles must be nonempty single-line strings.")
    return value.strip()


def assemble(path, draft_path, out):
    index = load_index(path)
    draft = read_json(draft_path)
    title = clean_title(draft["title"])
    catalog = {s["id"]: s for s in index["catalog"]}
    sections = draft.get("sections")
    if not isinstance(sections, list) or not sections:
        raise ValueError("Draft needs sections with paragraphs.")
    lines, paragraphs, used = [NOTE_HEADING_PREFIX + title, ""], [], {}
    identities = {"paper_summary", "mixed", "reader_thought", "model_explanation", "model_suggestion"}
    for section_number, section in enumerate(sections):
        if section_number != 0 or section.get("title") != "":
            lines += [SECTION_HEADING_PREFIX + clean_title(section["title"]), ""]
        if not isinstance(section.get("paragraphs"), list) or not section["paragraphs"]:
            raise ValueError("Each section needs paragraphs.")
        for paragraph_number, para in enumerate(section["paragraphs"]):
            text, ids = para.get("text"), para.get("source_ids")
            if isinstance(text, str):
                text_lines = text.strip().splitlines()
                if (section_number == 0 and paragraph_number == 0 and not section.get("title")
                        and len(text_lines) == 2 and BIBLIOGRAPHY_SEPARATOR in text_lines[1]):
                    text_lines[0] = text_lines[0].rstrip() + "  "
                text = "\n".join(text_lines)
            if not isinstance(text, str) or not text or any(not line.strip() for line in text.splitlines()) or "<!--" in text or "[^" in text:
                raise ValueError("Each text must be one paragraph without injected IDs or footnotes.")
            if not isinstance(ids, list) or not ids or any(not isinstance(s, str) for s in ids) or len(set(ids)) != len(ids):
                raise ValueError("Each paragraph needs distinct source_ids.")
            ids = [canonical_source_id(index, sid) for sid in ids]
            if len(set(ids)) != len(ids):
                raise ValueError("Each paragraph needs distinct source_ids after alias resolution.")
            for sid in ids:
                if sid not in catalog:
                    raise ValueError(f"Unknown source: {sid}")
            identity = para.get("identity", "paper_summary")
            if identity not in identities:
                raise ValueError("Unknown paragraph identity.")
            if identity == "reader_thought" and not any(resolve(index, s).get("reader_source_quote") for s in ids):
                raise ValueError("Reader thoughts require actual supplied reader words.")
            pid = f"p{len(paragraphs) + 1:02d}"
            start = len(lines) + 1
            lines += text.splitlines()
            end = len(lines)
            lines.append("")
            paragraphs.append({"paragraph_id": pid, "order": len(paragraphs) + 1, "source_ids": ids,
                               "markdown_lines": {"start": start, "end": end}, "text_sha256": text_hash(text),
                               "identity": identity, "explanation": para.get("explanation")})
            for sid in ids:
                used.setdefault(sid, []).append(pid)
    omissions = draft.get("omissions", [])
    if not isinstance(omissions, list):
        raise ValueError("Omissions must be a list.")
    omitted, omission_entries, warnings = set(), [], []
    for item in omissions:
        if not isinstance(item, dict) or not isinstance(item.get("reason"), str):
            raise ValueError("Omission entries need a source_id and string reason.")
        sid = canonical_source_id(index, item.get("source_id"))
        if sid not in catalog:
            raise ValueError(f"Unknown source in omissions: {sid}")
        for condition, code, message in (
                (sid in used, "used_source_listed_as_omitted", "A cited source is also listed as omitted."),
                (sid in omitted, "duplicate_omission", "An omission source is listed more than once."),
                (not item["reason"].strip(), "omission_reason_missing", "An omission has no explanation.")):
            if condition:
                warnings.append({"code": code, "source_ids": [sid], "message": message})
        omitted.add(sid)
        omission_entries.append({"source_id": sid, "record_ids": catalog[sid]["record_ids"], "reason": item["reason"]})
    uncovered = [s["id"] for s in catalog.values() if s["record_ids"] and s["id"] not in used and s["id"] not in omitted]
    if uncovered:
        warnings.append({"code": "unaccounted_reading_signals", "source_ids": uncovered,
                         "message": "These reading signals were not cited and have no omission explanation."})
    note = "\n".join(lines)
    entries = []
    for sid, pids in used.items():
        source = resolve(index, sid)
        source["excerpt"] = source.pop("text")
        source["used_in"] = pids
        entries.append(source)
    mapping = {"schema_version": 2, "document": index["document"], "page_numbering": "physical 1-based",
               "note": {"file": "note.md", "sha256": text_hash(note)},
               "coordinates": {"unit": "PDF points", "origin": "top-left", "rotation": "unrotated", "reference_box": "CropBox", "rect_format": "x0,y0,x1,y1"},
               "paragraphs": paragraphs, "entries": entries, "records": index["records"], "pages": index["pages"],
               "source_aliases": index["source_aliases"],
               "coverage": index["coverage"], "conflicts": index["conflicts"],
               "omissions": omission_entries, "validation": {"warnings": warnings},
               "preparation": {"version": VERSION, "fingerprint": index["fingerprint"], "index_path": str(Path(path).resolve()),
                               "initial_packet_scope": {k: index["packet_selection"][k] for k in
                                                        ("mode", "source_ids", "selected_paper_blocks", "available_paper_blocks", "body_scope_status",
                                                         "visual_requirements", "unresolved_cross_references", "object_filter", "scope")},
                               "draft_sha256": fingerprint(draft_path), "semantic_quality": "not_verified_by_structural_checks"}}
    write_new_directory(out, {"note.md": note, "source-map.json": json.dumps(mapping, ensure_ascii=False, indent=2) + "\n"})
    return {"ok": True, "note": str(Path(out).resolve() / "note.md"), "source_map": str(Path(out).resolve() / "source-map.json"),
            "paragraphs": len(paragraphs), "source_groups": len(entries), "warnings": warnings, "model_calls": 0}
