#!/usr/bin/env scholarseed-skill-python
"""Generate v7 Figure Cards with the OpenAI Python SDK and a compatible Responses API."""

from __future__ import annotations

import argparse
import base64
import copy
import concurrent.futures
import importlib.util
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
BATCH_RUNNER = SCRIPT_DIR / "batch_runner.py"
DEFAULT_MODEL = "qwen3.8-max"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


BATCH = load_module("cpes_figure_batch", BATCH_RUNNER)


def atomic_json(path: Path, value: Any) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def ledger_count(path: Path) -> int:
    if not path.is_file():
        return 0
    return sum(1 for line in path.read_text(encoding="utf-8").splitlines() if line.strip())


class CallBudget:
    def __init__(self, maximum: int, ledger: Path | None = None):
        if maximum < 0:
            raise ValueError("max_calls must be non-negative")
        self.maximum = maximum
        self.ledger = ledger
        self.used = 0
        if ledger:
            self.used = ledger_count(ledger)
        if self.used > maximum:
            raise ValueError("persisted SDK calls exceed max_calls")
        self._lock = threading.Lock()

    def reserve(self, metadata: dict | None = None) -> int:
        with self._lock:
            if self.used >= self.maximum:
                raise RuntimeError("SDK call cap exhausted")
            self.used += 1
            if self.ledger:
                self.ledger.parent.mkdir(parents=True, exist_ok=True)
                with self.ledger.open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps({"call_number": self.used, "reserved_at_epoch": time.time(), **(metadata or {})}, ensure_ascii=False) + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())
            return self.used


MUTABLE_FIELDS = (
    "overview", "panels", "how_to_read", "author_findings",
    "prerequisites", "scope",
)


def caption_line_numbers(job: dict) -> set[int]:
    if job["card_template"].get("caption", {}).get("number_source") == "pdf-caption":
        return {int(row["line"]) for row in job.get("context", {}).get("figure_source", [])}
    result = set()
    depth = 0
    active = False
    for row in job.get("context", {}).get("figure_source", []):
        value = str(row.get("text", ""))
        if not active and re.search(r"\\caption\s*(?:\[[^\]]*\]\s*)?\{", value):
            active = True
        if active:
            result.add(int(row["line"]))
            depth += len(re.findall(r"(?<!\\)\{", value)) - len(re.findall(r"(?<!\\)\}", value))
            if depth <= 0:
                active = False
                depth = 0
    return result


def evidence_catalog(job: dict) -> dict[str, dict]:
    catalog = {}
    source_file = job["card_template"]["source"]["tex_file"]
    caption_lines = caption_line_numbers(job)
    for row in job.get("context", {}).get("figure_source", []):
        line = int(row["line"])
        catalog[f"figure:L{line}"] = {
            "file": source_file, "line_start": line, "line_end": line,
            "kind": "caption" if line in caption_lines else "other",
            "text": str(row.get("text", "")),
        }
    for mention_index, mention in enumerate(job.get("context", {}).get("numbered_mentions", []), 1):
        filename = mention["file"]
        for row in mention.get("lines", []):
            line = int(row["line"])
            kind = "caption" if filename == source_file and line in caption_lines else ("appendix" if "appendix" in filename.lower() else "body")
            catalog[f"mention-{mention_index}:L{line}"] = {
                "file": filename, "line_start": line, "line_end": line, "kind": kind,
                "text": str(row.get("text", "")),
            }
    return catalog


def model_evidence_catalog(job: dict, *, legacy: bool = False) -> dict[str, dict]:
    """Bind short IDs to unique source locations; legacy IDs support old caches."""
    if job.get('evidence_mode') == 'complete-units-v1':
        if legacy:raise ValueError('Complete units have no legacy line-ID representation')
        context = load_module('cpes_complete_context', SKILL_DIR.parent/'src/cpes/reference_context.py')
        return context.complete_evidence_catalog(job)
    catalog = {}
    locations = {}
    for evidence_id, span in evidence_catalog(job).items():
        location = (span["file"], span["line_start"], span["line_end"])
        if location in locations:
            if catalog[locations[location]]["text"] != span["text"]:
                raise ValueError(f"conflicting evidence at {location}")
            continue
        locations[location] = evidence_id
        catalog[evidence_id] = span
    if legacy:
        return catalog
    files = list(dict.fromkeys(span["file"] for span in catalog.values()))
    prefixes = {name: f"S{index}:" if len(files) > 1 else "" for index, name in enumerate(files, 1)}
    return {f"{prefixes[span['file']]}L{span['line_start']}": span for span in catalog.values()}


def output_schema(job: dict) -> dict:
    string_array = {"type": "array", "items": {"type": "string"}}
    ids = list(model_evidence_catalog(job))
    properties = {
        "overview": {"type": "string"},
        "panels": {
            "type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "required": ["panel_id", "title", "visual_observations"],
                "properties": {"panel_id": {"type": "string"}, "title": {"type": "string"}, "visual_observations": string_array},
            },
        },
        "how_to_read": string_array,
        "author_findings": {
            "type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "required": ["claim", "evidence_ids"],
                "properties": {"claim": {"type": "string"}, "evidence_ids": {"type": "array", "items": {"type": "string", "enum": ids}}},
            },
        },
        "prerequisites": string_array, "scope": string_array,
    }
    return {"type": "object", "additionalProperties": False, "required": list(properties), "properties": properties}


def request_schema(job: dict) -> dict:
    """Keep source-specific enums local; V11 sends a reusable structural schema."""
    schema = copy.deepcopy(output_schema(job))
    mode = reader_config(job).get('request_schema_mode', 'evidence-enum')
    if mode == 'fixed-no-evidence-enum':
        schema['properties']['author_findings']['items']['properties']['evidence_ids']['items'].pop('enum', None)
    elif mode != 'evidence-enum':
        raise ValueError('Unsupported request schema mode')
    return schema


def image_data_url(path: str) -> str:
    suffix = Path(path).suffix.lower()
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg"}.get(suffix)
    if not mime:
        raise ValueError(f"unsupported SDK image type: {suffix}")
    encoded = base64.b64encode(Path(path).read_bytes()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def model_packet(job: dict, *, legacy: bool = False) -> dict:
    template = job["card_template"]
    catalog = model_evidence_catalog(job, legacy=legacy)
    if job.get('evidence_mode') == 'complete-units-v1':
        return {'caption':{'number':template['caption']['number']},
            'visual_status':template['visual_status'],
            'evidence_catalog':[{'evidence_id':key,**value} for key,value in catalog.items()],
            **({'visual_input':job['visual_input']} if job.get('visual_input') else {})}
    evidence = [
        {"evidence_id": evidence_id, **span}
        for evidence_id, span in catalog.items()
    ]
    locations = {
        (span["file"], span["line_start"]): evidence_id
        for evidence_id, span in catalog.items()
    }
    caption = {
        key: template["caption"][key]
        for key in ("number", "number_source", "number_uncertain")
        if key in template["caption"]
    }
    caption["evidence_ids"] = [
        evidence_id for evidence_id, span in catalog.items() if span["kind"] == "caption"
    ]
    if not caption["evidence_ids"]:
        # Standalone assets may have a generated caption without numbered source.
        caption["text"] = template["caption"].get("text", "")
    mentions = []
    for mention in job.get("context", {}).get("numbered_mentions", []):
        ids = list(dict.fromkeys(
            locations[(mention["file"], int(row["line"]))] for row in mention.get("lines", [])
        ))
        mentions.append({"reference_line": mention["reference_line"], "evidence_ids": ids})
    return {
        "caption": caption,
        "visual_status": template["visual_status"],
        "mentions": mentions,
        "evidence_catalog": evidence,
        **({'visual_input':job['visual_input']} if job.get('visual_input') else {}),
    }


def native_visual_text(job: dict) -> str:
    rows = job.get('visual_input', {}).get('native_text', [])
    if not rows:
        return ''
    lines = ['Native visual text (auxiliary reading; not author-claim evidence).',
             'Coordinates: displayed PDF points [x0,y0,x1,y1]; image determines layout.']
    region = job.get('visual_input', {}).get('bbox_pdf_points')
    if region:
        lines.append('Figure bounds: ' + json.dumps([round(x,3) for x in region], separators=(',', ':')))
    lines.extend(json.dumps([row['bbox_pdf_points'], row['text']], ensure_ascii=False,
                           separators=(',', ':')) for row in rows)
    return '\n' + '\n'.join(lines)


def model_packet_text(job: dict) -> str:
    """Compact wire format; the full provenance catalog stays local."""
    if job.get('evidence_mode') == 'complete-units-v1':
        context = load_module('cpes_complete_context', SKILL_DIR.parent/'src/cpes/reference_context.py')
        return context.unit_packet_text(job, model_evidence_catalog(job)) + native_visual_text(job)
    packet = model_packet(job)
    caption = packet["caption"]
    lines = [f"Figure: {caption.get('number', '')}"]
    for key, title in (("number_source", "Number source"), ("number_uncertain", "Number uncertain")):
        if key in caption:
            value = caption[key]
            lines.append(f"{title}: {str(value).lower() if isinstance(value, bool) else value}")
    lines.append(f"Visual status: {packet['visual_status']}")
    rows = packet["evidence_catalog"]
    files = list(dict.fromkeys(row["file"] for row in rows))
    for index, filename in enumerate(files, 1):
        lines.append(f"Source{' S' + str(index) if len(files) > 1 else ''}: {filename}")
        source_rows = [row for row in rows if row["file"] == filename]
        for kind in dict.fromkeys(row["kind"] for row in source_rows):
            lines.append(f"{kind}:")
            lines.extend(f"{row['evidence_id']}: {row['text']}" for row in source_rows if row["kind"] == kind)
    if caption["evidence_ids"]:
        lines.append("Caption evidence: " + ", ".join(caption["evidence_ids"]))
    else:
        lines.append("Caption (uncitable): " + caption.get("text", ""))
    for mention in packet["mentions"]:
        ids = mention["evidence_ids"]
        prefix = ids[0].split(":", 1)[0] + ":" if ids and ids[0].startswith("S") else ""
        lines.append(f"Reference {prefix}L{mention['reference_line']}: " + ", ".join(ids))
    return "\n".join(lines) + native_visual_text(job)


def expand_unit_findings(raw: dict, job: dict) -> list[dict]:
    """Strictly resolve complete IDs; never repair an invalid selection."""
    catalog = model_evidence_catalog(job);findings = []
    for index, finding in enumerate(raw['author_findings']):
        ids = finding['evidence_ids'];path = f'author_findings[{index}].evidence_ids'
        if not ids or len(ids) != len(set(ids)) or any(key not in catalog for key in ids):
            raise ValueError(path + ': expected unique complete evidence unit IDs')
        evidence = [];seen = set()
        for key in ids:
            for span in catalog[key]['evidence_spans']:
                identity = (span['file'],span['line_start'],span['line_end'],span['kind'])
                if identity not in seen:
                    seen.add(identity);evidence.append(copy.deepcopy(span))
        findings.append({'claim':finding['claim'],'evidence_unit_ids':list(ids),'evidence':evidence})
    return findings


def reader_config(job: dict) -> dict:
    """Verify the active reader release before dispatch; custom copies are experiments."""
    directory = SKILL_DIR / 'versions'
    registry_path = directory / 'registry.json'
    if not registry_path.exists():
        return {'version': 'unversioned', 'status': 'experimental', 'cpes_prompt_prefix': ''}
    registry = json.loads(registry_path.read_text(encoding='utf-8'))
    version = registry['active']
    entry = registry['versions'][version]
    filename = entry['file']
    if Path(filename).name != filename:
        raise ValueError('Invalid reader archive path')
    data = (directory / filename).read_bytes()
    release_hash = hashlib.sha256(data).hexdigest()
    if release_hash != entry['sha256']:
        raise ValueError('Reader archive hash mismatch')
    config = json.loads(data)
    experimental = registry.get('channel') == 'experimental' and config['status'] == 'experimental'
    if config['version'] != version or (not experimental and (config['status'] != 'stable' or config['validation']['status'] != 'passed')):
        raise ValueError('Active reader must be a validated stable release')
    policy = (SKILL_DIR / 'references/model-instructions.md').read_text(encoding='utf-8')
    if policy != config['policy'] or hashlib.sha256(policy.encode()).hexdigest() != config['policy_sha256']:
        raise ValueError('Active reader policy differs from the frozen release')
    schema = copy.deepcopy(output_schema(job))
    schema['properties']['author_findings']['items']['properties']['evidence_ids']['items'].pop('enum', None)
    if schema != config['schema']:
        raise ValueError('Active reader schema differs from the frozen release')
    if config['packet_format'] != 'compact-lines-v2':
        raise ValueError('Active reader packet format is unsupported by this runtime')
    return {**config, 'release_sha256': release_hash}


def request_input(job: dict) -> list[dict]:
    reader_config(job)
    prompt = (
        (SKILL_DIR / "references" / "model-instructions.md").read_text(encoding="utf-8")
        + "\n\nMODEL PACKET:\n"
        + model_packet_text(job)
    )
    content = [{"type": "input_text", "text": prompt}]
    content.extend({"type": "input_image", "image_url": image_data_url(path)} for path in job["image_files"])
    return [{"role": "user", "content": content}]


def response_dump(response: Any) -> dict:
    if hasattr(response, "model_dump"):
        return response.model_dump(mode="json")
    if isinstance(response, dict):
        return response
    return {"repr": repr(response)}


def usage_dump(response: Any) -> dict | None:
    usage = getattr(response, "usage", None)
    if usage is None:
        return None
    if hasattr(usage, "model_dump"):
        return usage.model_dump(mode="json")
    return usage if isinstance(usage, dict) else {"repr": repr(usage)}


def safe_error(exc: Exception) -> str:
    message = f"{type(exc).__name__}: {exc}"
    secret = os.environ.get("FIGCARD_QWEN_API_KEY")
    if secret:
        message = message.replace(secret, "[REDACTED]")
    return message


def invoke(client: Any, model: str, job: dict) -> tuple[dict | None, dict, dict | None, str | None]:
    response = client.responses.create(
        model=model,
        input=request_input(job),
        text={"format": {"type": "json_schema", "name": "figure_card_content", "strict": True, "schema": request_schema(job)}},
        store=False,
    )
    output_text = getattr(response, "output_text", None)
    response = response_dump(response)
    usage = usage_dump(response) if not isinstance(response, dict) else response.get("usage")
    if not isinstance(output_text, str) or not output_text.strip():
        return None, response, usage, "SDK response has no output_text"
    try:
        raw = json.loads(output_text)
        # The standalone runner also rejects unsupported IDs, rather than
        # silently dropping them during normalization when the wire has no enum.
        catalog = model_evidence_catalog(job)
        findings = raw.get('author_findings') if isinstance(raw, dict) else None
        if not isinstance(findings, list):
            return None, response, usage, 'Invalid author findings'
        for finding in findings:
            if not isinstance(finding, dict) or not isinstance(finding.get('evidence_ids'), list) or not finding['evidence_ids']:
                return None, response, usage, 'Invalid author finding evidence IDs'
            if any(not isinstance(eid, str) or eid not in catalog for eid in finding['evidence_ids']):
                return None, response, usage, 'Unknown evidence ID'
        return raw, response, usage, None
    except json.JSONDecodeError as exc:
        return None, response, usage, f"JSONDecodeError: {exc}"


def unavailable_card(job: dict) -> dict:
    card = dict(job["card_template"])
    card.update({
        "overview": "The referenced Figure could not be inspected because no supported media was available.",
        "panels": [], "how_to_read": [], "author_findings": [], "prerequisites": [],
        "scope": ["No visual interpretation was attempted."],
    })
    return card


def merge_content(raw: dict, job: dict) -> tuple[dict, list[str]]:
    """Merge model-owned content into fixed metadata without inventing claims."""
    template = job["card_template"]
    card = copy.deepcopy(template)
    repairs = []
    raw = dict(raw)
    for alias, canonical in (("findings", "author_findings"),):
        if canonical not in raw and isinstance(raw.get(alias), list):
            raw[canonical] = raw[alias]
            repairs.append(f"top-level.{alias}-to-{canonical}")
    content = {key: raw.get(key) for key in MUTABLE_FIELDS}
    # Reuse narrow provider alias repairs for panels only.
    normalized, alias_repairs = BATCH.normalize_card(
        {
            "panels": content.get("panels") if isinstance(content.get("panels"), list) else [],
            "author_findings": [],
        },
        {"source_tex": template["source"]["tex_file"], "line_start": template["source"]["line_start"], "line_end": template["source"]["line_end"]},
    )
    content["panels"] = normalized["panels"]
    repairs.extend(f"mutable.{value}" for value in alias_repairs)
    panels = []
    for index, panel in enumerate(content["panels"]):
        if not isinstance(panel, dict) or not isinstance(panel.get("panel_id"), str) or not isinstance(panel.get("visual_observations"), list):
            repairs.append(f"panels[{index}].discard-invalid-shape")
            continue
        cleaned = {
            "panel_id": panel["panel_id"],
            "title": panel.get("title") if isinstance(panel.get("title"), str) else "",
            "visual_observations": [value for value in panel["visual_observations"] if isinstance(value, str) and value.strip()],
        }
        if not cleaned["visual_observations"]:
            repairs.append(f"panels[{index}].discard-no-observations")
            continue
        if cleaned != panel:
            repairs.append(f"panels[{index}].canonicalize")
        panels.append(cleaned)
    content["panels"] = panels

    catalog = model_evidence_catalog(job)
    findings = []
    source_findings = content.get("author_findings") if isinstance(content.get("author_findings"), list) else []
    for index, finding in enumerate(source_findings):
        if not isinstance(finding, dict) or not isinstance(finding.get("claim"), str) or not finding["claim"].strip():
            repairs.append(f"author_findings[{index}].discard-invalid-claim")
            continue
        requested = finding.get("evidence_ids") if isinstance(finding.get("evidence_ids"), list) else []
        valid_ids = []
        for value in requested:
            if isinstance(value, str) and value in catalog and value not in valid_ids:
                valid_ids.append(value)
        if not valid_ids:
            repairs.append(f"author_findings[{index}].discard-no-valid-evidence-id")
            continue
        if valid_ids != requested:
            repairs.append(f"author_findings[{index}].filter-evidence-ids")
        findings.append({
            "claim": finding["claim"],
            "evidence": [
                {key: copy.deepcopy(catalog[value][key]) for key in ("file", "line_start", "line_end", "kind")}
                for value in valid_ids
            ],
        })
    content["author_findings"] = findings
    if job.get('evidence_mode') == 'complete-units-v1':
        content['author_findings'] = expand_unit_findings(raw,job)

    for field in MUTABLE_FIELDS:
        value = content.get(field)
        if field == "overview":
            card[field] = value if isinstance(value, str) else ""
        else:
            card[field] = value if isinstance(value, list) else []
    return card, repairs


def validate_normalized(card: dict, job: dict) -> list[str]:
    template = job["card_template"]
    errors = []
    if set(card) != set(template):
        errors.append("top-level keys differ from card_template")
    for field in ("schema_version", "paper_id", "figure_id", "label", "caption", "source", "visual_status"):
        if card.get(field) != template.get(field):
            errors.append(f"fixed field mismatch: {field}")
    if not isinstance(card.get("overview"), str) or not card.get("overview", "").strip():
        errors.append("overview must be a non-empty string")
    list_fields = tuple(field for field in MUTABLE_FIELDS if field != "overview")
    for field in list_fields:
        if not isinstance(card.get(field), list):
            errors.append(f"{field} must be a list")
    if card.get("visual_status") != "unavailable" and not card.get("panels"):
        errors.append("viewable Figure requires panels")
    for index, panel in enumerate(card.get("panels", [])):
        if not isinstance(panel, dict) or not isinstance(panel.get("panel_id"), str) or not isinstance(panel.get("title"), str) or not isinstance(panel.get("visual_observations"), list):
            errors.append(f"invalid panels[{index}]")
    for index, finding in enumerate(card.get("author_findings", [])):
        if not isinstance(finding, dict) or not isinstance(finding.get("claim"), str) or not finding.get("claim", "").strip() or not isinstance(finding.get("evidence"), list) or not finding.get("evidence"):
            errors.append(f"invalid author_findings[{index}]")
            continue
        for span_index, span in enumerate(finding["evidence"]):
            if not isinstance(span, dict) or not all(key in span for key in ("file", "line_start", "line_end", "kind")) or span.get("kind") not in {"caption", "body", "appendix", "other"}:
                errors.append(f"invalid author_findings[{index}].evidence[{span_index}]")
    return errors


def terminal(path: Path) -> bool:
    try:
        return json.loads(path.read_text(encoding="utf-8"))["status"] in {"completed", "quality_failure", "media_unavailable"}
    except Exception:
        return False


class ModelExecutionError(Exception):
    """Carry only bounded provider metadata, never provider messages or responses."""
    def __init__(self, error_type: str, status_code=None, code=None):
        self.error_type = (error_type if isinstance(error_type, str)
                           and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", error_type)
                           else "ModelExecutionError")
        self.status_code = status_code if type(status_code) is int and 100 <= status_code <= 599 else None
        self.code = code if isinstance(code, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code) else None
        super().__init__(self.error_type)


def run_job_memory(client: Any, model: str, job: dict, budget, *, invoke_model=None) -> tuple[dict, dict | None, dict | None]:
    """Run one card request without job/output files; the caller owns the budget."""
    started = time.monotonic()
    raw = None
    card = None
    record = {"status": "execution_error", "model": model, "wall_ms": 0,
              "usage": None, "attempt_count": 0, "error": None}
    try:
        if not job["image_files"]:
            record["status"] = "media_unavailable"
        else:
            budget.reserve({"job": job["card_template"]["figure_id"], "attempt": 1, "model": model})
            record["attempt_count"] = 1
            raw, response, usage, output_error = (invoke_model or invoke)(client, model, job)
            record["usage"] = usage
            if output_error:
                record.update(status="quality_failure", error=output_error)
            else:
                try:
                    normalized, repairs = merge_content(raw, job)
                    errors = validate_normalized(normalized, job)
                    if errors:
                        record.update(status="quality_failure", error="; ".join(errors))
                    else:
                        record["status"] = "completed"
                        card = normalized
                except Exception as exc:
                    record.update(status="quality_failure", error=f"normalization error: {type(exc).__name__}")
    except Exception as exc:
        error = exc.error_type if isinstance(exc, ModelExecutionError) else type(exc).__name__
        if isinstance(exc, ModelExecutionError) and exc.status_code is not None:
            record["http_status"] = exc.status_code
            error += f"; HTTP status {exc.status_code}"
        code = getattr(exc, "code", None)
        if isinstance(code, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code):
            record["error_code"] = code
        record.update(status="execution_error", error=error)
    record["wall_ms"] = round((time.monotonic() - started) * 1000)
    return record, raw, card


def run_job(client: Any, model: str, job_path: Path, output: Path, budget: CallBudget, *, invoke_model=None, max_attempts=2, job_loader=None, debug_artifacts=True) -> dict:
    job = job_loader(job_path) if job_loader else json.loads(job_path.read_text(encoding="utf-8"))
    stem = job_path.name.removesuffix(".job.json")
    evidence = output / "sdk-evidence" / stem
    evidence.mkdir(parents=True, exist_ok=True)
    result_path = evidence / "result.json"
    if terminal(result_path):
        value = json.loads(result_path.read_text(encoding="utf-8"))
        return {"job": stem, "resumed": True, **value}
    started = time.monotonic()
    attempts = []
    raw = None
    status = "execution_error"
    error = None
    usage = None
    if not job["image_files"]:
        raw = unavailable_card(job)
        status = "media_unavailable"
    else:
        for attempt in range(1, max_attempts + 1):
            try:
                call_number = budget.reserve({"job": stem, "attempt": attempt, "model": model})
            except RuntimeError as exc:
                error = str(exc)
                break
            call_started = time.monotonic()
            try:
                raw, response, usage, output_error = (invoke_model or invoke)(client, model, job)
                if debug_artifacts:atomic_json(evidence / "sdk-response.json", response)
                if output_error:
                    attempts.append({"attempt": attempt, "call_number": call_number, "status": "quality_failure", "duration_ms": round((time.monotonic() - call_started) * 1000), "error": output_error})
                    status = "quality_failure"
                    error = output_error
                    break
                attempts.append({"attempt": attempt, "call_number": call_number, "status": "completed", "duration_ms": round((time.monotonic() - call_started) * 1000)})
                status = "completed"
                break
            except Exception as exc:
                error = safe_error(exc)
                attempts.append({"attempt": attempt, "call_number": call_number, "status": "execution_error", "duration_ms": round((time.monotonic() - call_started) * 1000), "error": error})
                if not re.search(r"timeout|connection|429|rate.?limit|5\d\d", error, re.IGNORECASE):
                    break
    repairs = []
    if raw is not None:
        atomic_json(evidence / "raw-model-card.json", raw)
        try:
            normalized, repairs = merge_content(raw, job)
            atomic_json(Path(job["card_json"]), normalized)
            validation_errors = validate_normalized(normalized, job)
            if validation_errors:
                status = "quality_failure"
                error = "; ".join(validation_errors)
        except Exception as exc:
            status = "quality_failure"
            error = f"normalization error: {type(exc).__name__}: {exc}"
    record = {"status": status, "model": model, "job": stem, "wall_ms": round((time.monotonic() - started) * 1000), "usage": usage, "attempts": attempts, "repairs": repairs, "error": error}
    atomic_json(result_path, record)
    return {"job": stem, "resumed": False, **record}


def build_client(api_key: str, base_url: str, timeout: float):
    try:
        from openai import OpenAI
    except ImportError as exc:
        raise SystemExit("OpenAI Python SDK is required; install requirements.txt") from exc
    return OpenAI(api_key=api_key, base_url=base_url.rstrip("/"), timeout=timeout, max_retries=0)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--paper", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--max-calls", type=int, required=True)
    parser.add_argument("--model", default=os.environ.get("FIGCARD_QWEN_PRO_MODEL", DEFAULT_MODEL))
    parser.add_argument("--timeout", type=float, default=420)
    parser.add_argument("--main", action="append", default=[])
    parser.add_argument("--label", action="append", default=[])
    parser.add_argument("--figure-id", action="append", default=[])
    args = parser.parse_args()
    api_key = os.environ.get("FIGCARD_QWEN_API_KEY")
    base_url = os.environ.get("FIGCARD_QWEN_BASE_URL")
    if not api_key or not base_url:
        raise SystemExit("FIGCARD_QWEN_API_KEY and FIGCARD_QWEN_BASE_URL are required")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    manifest_path = output / "manifest.json"
    if not manifest_path.is_file():
        command = [sys.executable, str(BATCH_RUNNER), "prepare", "--paper", str(args.paper.resolve(strict=True)), "--output", str(output)]
        for option, values in (("--main", args.main), ("--label", args.label), ("--figure-id", args.figure_id)):
            for value in values:
                command += [option, value]
        subprocess.run(command, check=True)
    jobs = sorted((output / "jobs").glob("*.job.json"))
    pending_model_calls = sum(1 for path in jobs if json.loads(path.read_text(encoding="utf-8"))["image_files"] and not terminal(output / "sdk-evidence" / path.name.removesuffix(".job.json") / "result.json"))
    call_ledger = output / "sdk-call-ledger.jsonl"
    existing_calls = ledger_count(call_ledger)
    if existing_calls + pending_model_calls > args.max_calls:
        atomic_json(output / "call-cap-blocker.json", {"existing_calls": existing_calls, "pending_jobs": pending_model_calls, "minimum_total_calls": existing_calls + pending_model_calls, "max_calls": args.max_calls, "reason": "minimum one call per pending viewable job exceeds remaining cap"})
        raise SystemExit("pending jobs exceed max_calls")
    atomic_json(output / "sdk-run-plan.json", {"schema_version": 1, "transport": "openai-python-sdk-responses", "model": args.model, "jobs": len(jobs), "existing_calls": existing_calls, "pending_viewable_jobs": pending_model_calls, "minimum_total_calls": existing_calls + pending_model_calls, "concurrency": args.concurrency, "max_calls": args.max_calls, "api_key_env": "FIGCARD_QWEN_API_KEY", "base_url_env": "FIGCARD_QWEN_BASE_URL"})
    client = build_client(api_key, base_url, args.timeout)
    budget = CallBudget(args.max_calls, call_ledger)
    started = time.monotonic()
    results = []
    lock = threading.Lock()
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = [pool.submit(run_job, client, args.model, path, output, budget) for path in jobs]
        for completed, future in enumerate(concurrent.futures.as_completed(futures), 1):
            result = future.result()
            results.append(result)
            with lock:
                with (output / "progress.jsonl").open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps({key: result.get(key) for key in ("job", "status", "wall_ms", "resumed")}, ensure_ascii=False) + "\n")
                atomic_json(output / "progress.json", {"schema_version": 1, "jobs": len(jobs), "completed": completed, "sdk_calls": budget.used, "counts": {status: sum(value["status"] == status for value in results) for status in ("completed", "quality_failure", "media_unavailable", "execution_error")}, "elapsed_seconds": round(time.monotonic() - started, 3), "updated_at_epoch": time.time()})
    finalizable = all(result["status"] in {"completed", "media_unavailable"} for result in results)
    finalize_returncode = None
    if finalizable:
        finalize_returncode = subprocess.run([sys.executable, str(BATCH_RUNNER), "finalize", "--output", str(output)]).returncode
    final = {"schema_version": 1, "jobs": len(jobs), "sdk_calls": budget.used, "counts": {status: sum(value["status"] == status for value in results) for status in ("completed", "quality_failure", "media_unavailable", "execution_error")}, "finalize_returncode": finalize_returncode, "wall_seconds": round(time.monotonic() - started, 3)}
    atomic_json(output / "final-summary.json", final)
    print(json.dumps(final, ensure_ascii=False))
    return 0 if finalizable and finalize_returncode == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
