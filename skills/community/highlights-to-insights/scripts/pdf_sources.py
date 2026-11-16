"""Read PDF evidence without assigning meaning to a reader's marks.

Coordinates are unrotated CropBox-relative page points unless a source explicitly says
otherwise. Source wording is kept; normalization is used only for comparison.
"""
from __future__ import annotations

from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import re

import sys
from contextlib import nullcontext

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cpes_machine import PDFDocument, Rect
from cpes_format_converter.pdf import polygon_contains

MARKS = {"Highlight": "highlight", "Underline": "underline", "StrikeOut": "strikethrough", "Squiggly": "squiggly"}
CHANNELS = ("pdf_annotation", "embedded_mark", "embedded_comment", "embedded_note", "external_note", "visual")


def fingerprint(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def warn(warnings, code, message, **context):
    warnings.append({"code": code, "message": message, **context})


def record(identifier, source, kind, *, page=None, label=None, text="", comment="", rects=None, raw=None):
    return {"id": identifier, "source": source, "kind": kind, "page": page,
            "page_label": label, "text": text, "comment": comment, "rects": rects or [],
            "author": None, "color": None, "target_id": None, "confidence": None,
            "anchor": {"status": "explicit" if page else "unanchored", "candidates": []},
            "source_refs": [{"channel": source, "source_id": identifier, "raw": raw or {}}]}


def marked_text(page, vertices):
    """Select characters inside each quad, in its own baseline direction."""
    if not vertices or len(vertices) % 4:
        return "", []
    seen, parts, rectangles = set(), [], []
    for offset in range(0, len(vertices), 4):
        points = vertices[offset:offset+4]
        rectangles.append([min(x for x,y in points), min(y for x,y in points), max(x for x,y in points), max(y for x,y in points)])
        dx,dy=points[1][0]-points[0][0],points[1][1]-points[0][1]
        chosen=[]
        for i,char in enumerate(page.chars):
            box=char['bbox'];center=((box[0]+box[2])/2,(box[1]+box[3])/2)
            if i not in seen and polygon_contains(center,points):
                chosen.append(((center[0]-points[0][0])*dx+(center[1]-points[0][1])*dy,char['c']))
                seen.add(i)
        text=''.join(c for _,c in sorted(chosen,key=lambda pair:pair[0])).strip()
        if text:parts.append(text)
    return "\n".join(parts), rectangles


def near_blocks(rect, blocks):
    box=Rect(rect);x,y=(box.x0+box.x1)/2,(box.y0+box.y1)/2
    def distance(block):
        r=Rect(block['rect'])
        return math.hypot(max(r.x0-x,0,x-r.x1),max(r.y0-y,0,y-r.y1))
    return [{"text":b["text"],"rect":b["rect"],"distance_points":round(distance(b),2)}
            for b in sorted(blocks,key=distance)[:3]]


def read_native(doc, prefix, warnings):
    pages,records,xrefs=[],[],{}
    for page in doc:
        index=page.number
        blocks=[{'rect':b['rect'],'text':b['text']} for b in page.blocks]
        pages.append({'page':index+1,'page_label':page.label,'width':page.native_rect.width,
                      'height':page.native_rect.height,'rotation':page.rotation,'text':page.text,'blocks':blocks})
        if len(page.text.strip())<40:
            warn(warnings,'sparse_page_text','Page has little selectable text; visual follow-up remains optional.',page=index+1)
        for ref in page.raw.get('/Annots',[]):
            annot=ref.get_object();subtype=str(annot.get('/Subtype','')).lstrip('/')
            if subtype in ('Link','Popup'):continue
            xref=getattr(ref,'idnum',None)
            source_id=str(annot.get('/NM','')) or f'xref-{xref}'
            identifier=f'{prefix}:pdf:{index+1}:{source_id}:xref-{xref}'
            kind=MARKS.get(subtype,'comment' if subtype in ('Text','FreeText') else subtype.lower())
            raw_points=list(annot.get('/QuadPoints',[]))
            vertices=[page.raw_point(raw_points[i],raw_points[i+1]) for i in range(0,len(raw_points)-1,2)]
            raw_rect=list(annot.get('/Rect',[0,0,0,0]));rect=list(page.raw_rect(raw_rect))
            text,rects=marked_text(page,vertices) if subtype in MARKS else ('',[rect])
            info={'id':str(annot.get('/NM','')),'content':str(annot.get('/Contents','')),'title':str(annot.get('/T','')),
                  'creationDate':str(annot.get('/CreationDate','')),'modDate':str(annot.get('/M','')),'subject':str(annot.get('/Subj',''))}
            item=record(identifier,'pdf_annotation',kind,page=index+1,label=page.label,text=text,comment=info['content'],rects=rects,
                        raw={'xref':xref,'info':info,'vertices':vertices,'rect':rect,'type':subtype,
                             'raw_rect':raw_rect,'raw_quadpoints':raw_points,'reply_to_xref':getattr(annot.get('/IRT'),'idnum',0)})
            item.update(author=info['title'] or None,color={'stroke':list(annot.get('/C',[])) or None,'fill':list(annot.get('/IC',[])) or None})
            if kind=='comment':item['anchor']={'status':'spatial_candidate','candidates':near_blocks(rect,blocks)}
            if subtype in MARKS and not text:warn(warnings,'empty_mark_text','Mark exists but selected text was not recovered.',record_id=identifier,page=index+1)
            if kind not in (*MARKS.values(),'comment'):warn(warnings,'visual_annotation','Non-text annotation retained by geometry.',record_id=identifier,page=index+1)
            records.append(item);xrefs[xref]=identifier
    for item in records:
        target=xrefs.get(item['source_refs'][0]['raw']['reply_to_xref'])
        if target:item.update(target_id=target,anchor={'status':'explicit','candidates':[]})
    return pages,records


def physical_page(value, total):
    return value if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= total else None


def normalized_rects(quads, page):
    result = []
    if not isinstance(quads, list):
        return result
    for quad in quads:
        if (isinstance(quad, list) and len(quad) == 4 and
                all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and 0 <= v <= 1 for v in quad)
                and quad[0] < quad[2] and quad[1] < quad[3]):
            result.append([quad[0] * page["width"], quad[1] * page["height"],
                           quad[2] * page["width"], quad[3] * page["height"]])
    return result


def read_embedded(doc, pages, prefix, warnings):
    records, inventory = [], []
    for name, attachment_number, content in ((name, i, body) for name, bodies in doc.reader.attachments.items() for i, body in enumerate(bodies)):
        info = {"index": attachment_number, "size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
        entry = {"name": name, "info": info, "status": "unsupported"}
        inventory.append(entry)
        if name != "scholarseed-annotations.json":
            warn(warnings, "unsupported_attachment", "Attachment inventoried; needs format-specific or manual reading.", attachment=name)
            continue
        try:
            payload = json.loads(content)
            entry["payload"] = payload
            if not isinstance(payload, dict) or payload.get("schema_version") != 1:
                warn(warnings, "unsupported_attachment", "Unsupported ScholARSeed schema version; raw payload retained.", attachment=name)
                continue
            for key in ("marks", "comments", "notes"):
                if not isinstance(payload.get(key, []), list) or any(not isinstance(x, dict) for x in payload.get(key, [])):
                    raise ValueError(f"{key} must be an array of objects")
            entry["status"] = "parsed"
        except (ValueError, TypeError, RuntimeError) as exc:
            entry["status"] = "error"
            warn(warnings, "attachment_parse_error", str(exc), attachment=name)
            continue
        targets = {}
        mark_ids = Counter(str(m.get("id", i)) for i, m in enumerate(payload.get("marks", [])))
        for offset, mark in enumerate(payload.get("marks", [])):
            original_id = str(mark.get("id", offset))
            identifier = f"{prefix}:embedded:{name}:mark:{original_id}:{offset}"
            p = physical_page(mark.get("page"), len(pages))
            rects = normalized_rects(mark.get("quads", []), pages[p - 1]) if p else []
            style = str(mark.get("style", "unknown"))
            kind = {"strikeout": "strikethrough"}.get(style, style)
            item = record(identifier, "embedded_mark", kind, page=p, label=pages[p - 1]["page_label"] if p else None,
                          text=str(mark.get("text") or ""), rects=rects, raw=mark)
            item["color"] = mark.get("color")
            item["source_refs"][0]["attachment"] = name
            if not p or not rects or mark.get("anchor_state") == "unanchored":
                item["anchor"]["status"] = "unanchored" if not p else "page_only"
                warn(warnings, "uncertain_embedded_location", "Keep source text; verify page and selected region before citing.", record_id=identifier)
            records.append(item)
            if mark_ids[original_id] == 1:
                targets[original_id] = item
            else:
                warn(warnings, "ambiguous_mark_id", "Duplicate mark IDs retained as separate records; comments cannot be linked uniquely.", source_id=original_id)
        for offset, comment in enumerate(payload.get("comments", [])):
            target = targets.get(str(comment.get("mark_id")))
            item = record(f"{prefix}:embedded:{name}:comment:{comment.get('id', offset)}:{offset}", "embedded_comment", "comment",
                          page=target["page"] if target else None, label=target["page_label"] if target else None,
                          comment=str(comment.get("body") or ""), raw=comment)
            item["source_refs"][0]["attachment"] = name
            item["target_id"] = target["id"] if target else None
            if not target:
                warn(warnings, "orphan_comment", "No matching mark_id; comment retained without invented target.", record_id=item["id"])
            records.append(item)
        for offset, note in enumerate(payload.get("notes", [])):
            p = physical_page(note.get("page"), len(pages))
            body = note.get("body", note.get("text", note.get("content", "")))
            item = record(f"{prefix}:embedded:{name}:note:{note.get('id', offset)}:{offset}", "embedded_note", "note",
                          page=p, label=pages[p - 1]["page_label"] if p else None,
                          text=body if isinstance(body, str) else json.dumps(body, ensure_ascii=False), raw=note)
            item["anchor"]["status"] = "page_only" if p else "document"
            item["source_refs"][0]["attachment"] = name
            if not item["text"]:
                warn(warnings, "unknown_note_body", "Note object retained in raw payload; body format needs manual inspection.", record_id=item["id"])
            records.append(item)
    return records, inventory


def comparable(text):
    text = re.sub(r"(?<=\w)-\s*\n\s*(?=\w)", "", text)
    return re.sub(r"\s+", " ", text).strip()


def overlap(left, right):
    if not left or not right:
        return False
    def matches(a, b):
        a, b = Rect(a), Rect(b)
        area = max(a.get_area(), b.get_area())
        return area > 0 and (a & b).get_area() / area >= 0.75
    return all(any(matches(a, b) for b in right) for a in left) and all(any(matches(a, b) for a in left) for b in right)


def reconcile(records):
    """Merge only spatially supported cross-channel duplicates; keep variants."""
    merged, aliases, conflicts = [], {}, []
    for item in records:
        target = next((old for old in merged if item["source"] != old["source"]
                       and item["kind"] in MARKS.values() and item["kind"] == old["kind"]
                       and item["page"] is not None and item["page"] == old["page"]
                       and comparable(item["text"]) == comparable(old["text"])
                       and overlap(item["rects"], old["rects"])), None)
        if target:
            aliases[item["id"]] = target["id"]
            target["source_refs"].extend(item["source_refs"])
            for field in ("text", "comment", "color"):
                if target[field] and item[field] and target[field] != item[field]:
                    conflicts.append({"record_id": target["id"], "field": field,
                                      "values": [{"source": target["source"], "value": target[field]},
                                                 {"source": item["source"], "value": item[field]}]})
                elif not target[field] and item[field]:
                    target[field] = item[field]
        else:
            merged.append(item)
    for item in merged:
        item["target_id"] = aliases.get(item["target_id"], item["target_id"])
    return merged, conflicts


def read_external(paths, prefix):
    records = []
    for path in dict.fromkeys(Path(p).expanduser().resolve() for p in paths):
        if path.suffix.lower() not in (".md", ".markdown", ".txt"):
            raise ValueError(f"Unsupported external note format: {path.suffix}; export Markdown/TXT or inspect manually.")
        body = path.read_text(encoding="utf-8-sig")
        digest = fingerprint(path)
        item = record(f"{prefix}:note:{hashlib.sha256(str(path).encode()).hexdigest()[:12]}:{digest[:12]}",
                      "external_note", "note", text=body)
        item["anchor"]["status"] = "document"
        item["source_refs"] = [{"channel": "external_note", "path": str(path), "sha256": digest,
                                "line_start": 1, "line_end": len(body.splitlines()),
                                "association": "user_supplied_with_this_paper"}]
        records.append(item)
    return records


def read_visual(path, pages, prefix):
    if not path:
        return [], []
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("schema_version") != 1:
        raise ValueError("Visual observations require schema_version 1.")
    reviewed = data.get("reviewed_pages", [])
    observations = data.get("observations", [])
    if not isinstance(reviewed, list) or any(physical_page(p, len(pages)) is None for p in reviewed):
        raise ValueError("Visual reviewed_pages must contain valid physical 1-based pages.")
    if not isinstance(observations, list) or any(not isinstance(x, dict) for x in observations):
        raise ValueError("Visual observations must be an array of objects.")
    records = []
    for offset, observation in enumerate(observations):
        p = physical_page(observation.get("page"), len(pages))
        if p is None:
            raise ValueError("Visual observation has invalid physical page.")
        item = record(f"{prefix}:visual:{observation.get('id', offset)}", "visual", str(observation.get("kind", "note")),
                      page=p, label=pages[p - 1]["page_label"], text=str(observation.get("text") or ""),
                      comment=str(observation.get("comment") or ""), raw=observation)
        item["rects"] = normalized_rects(observation.get("quads", []), pages[p - 1])
        item["confidence"] = observation.get("confidence", "unspecified")
        item["anchor"]["status"] = "visual_observation"
        item["source_refs"][0]["path"] = str(Path(path).resolve())
        records.append(item)
    return records, sorted(set(reviewed))


def build_bundle(pdf_path, note_paths=(), visual_path=None, *, document=None):
    path = Path(pdf_path).expanduser().resolve()
    digest = fingerprint(path)
    prefix = digest[:12]
    warnings = []
    with (nullcontext(document) if document is not None else PDFDocument(path)) as doc:
        pages, native = read_native(doc, prefix, warnings)
        embedded, attachments = read_embedded(doc, pages, prefix, warnings)
        metadata = doc.metadata
    external = read_external(note_paths, prefix)
    visual, reviewed = read_visual(visual_path, pages, prefix)
    all_records = native + embedded + external + visual
    counts = Counter(x["source"] for x in all_records)
    records, conflicts = reconcile(all_records)
    visual_status = "reviewed" if len(reviewed) == len(pages) and pages else "partial" if reviewed else "pending"
    if visual_status != "reviewed":
        warn(warnings, "visual_review_required", "Structured extraction cannot establish absence of rendered/flattened notes.")
    if not counts["embedded_note"] and not external:
        warn(warnings, "no_independent_notes", "No independent notes supplied or recovered; do not invent them.")
    for item in pages:
        item["annotation_count"] = sum(r["page"] == item["page"] for r in native)
    coverage = {"raw_counts": {c: counts[c] for c in CHANNELS}, "record_count": len(records),
                "kind_counts": dict(Counter(r["kind"] for r in records)),
                "channels": {"pdf_annotations": {"status": "read", "count": len(native)},
                             "embedded": {"status": "incomplete" if any(a["status"] != "parsed" for a in attachments) else "read",
                                          "attachment_count": len(attachments)},
                             "external_notes": {"status": "read" if external else "not_supplied", "count": len(external)},
                             "visual": {"status": visual_status, "reviewed_pages": reviewed,
                                        "review_file": str(Path(visual_path).resolve()) if visual_path else None}},
                "warnings": warnings}
    return {"schema_version": 1,
            "document": {"path": str(path), "sha256": digest, "page_count": len(pages), "metadata": metadata},
            "pages": pages, "records": records, "attachments": attachments, "conflicts": conflicts, "coverage": coverage}
