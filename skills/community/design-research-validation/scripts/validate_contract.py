#!/usr/bin/env scholarseed-skill-python
"""Validate structural traceability of a research-validation contract."""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path
from typing import Any


CLAIM_ID = re.compile(r"C([1-9][0-9]*)$")
AXIS_ID = re.compile(r"C([1-9][0-9]*)\.A([1-9][0-9]*)$")
WORD = re.compile(r"[^\W_]+", re.UNICODE)


def _canonical_words(value: str) -> tuple[str, ...]:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return tuple(WORD.findall(normalized))


def _nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def validate_payload(payload: Any, material: str) -> dict[str, Any]:
    """Return validation errors without making semantic scientific judgments."""
    errors: list[str] = []
    if not isinstance(payload, dict):
        return {"valid": False, "errors": ["payload_not_object"]}

    status = payload.get("status")
    claims = payload.get("claim_map")
    predictions = payload.get("predictions")
    coverage = payload.get("coverage")
    discussion = payload.get("discussion")
    if status not in {"ready", "insufficient_material"}:
        errors.append("invalid_status")
    if not _nonempty_string(discussion):
        errors.append("invalid_discussion")
    if not isinstance(claims, list):
        errors.append("claim_map_not_list")
        claims = []
    if not isinstance(predictions, list):
        errors.append("predictions_not_list")
        predictions = []
    if not isinstance(coverage, list):
        errors.append("coverage_not_list")
        coverage = []

    if status == "insufficient_material":
        if claims or predictions or coverage:
            errors.append("insufficient_material_must_have_empty_arrays")
        return {
            "valid": not errors,
            "errors": errors,
            "status": status,
            "claim_count": len(claims),
            "axis_count": 0,
            "prediction_count": len(predictions),
        }

    if status == "ready" and not claims:
        errors.append("ready_without_claims")
    if status == "ready" and not predictions:
        errors.append("ready_without_predictions")

    material_words = _canonical_words(material)
    material_text = " ".join(material_words)
    claim_ids: set[str] = set()
    axis_ids: set[str] = set()
    validate_axis_ids: set[str] = set()
    central_claims = 0
    for claim_index, claim in enumerate(claims):
        prefix = f"claim_{claim_index}"
        if not isinstance(claim, dict):
            errors.append(f"{prefix}_not_object")
            continue
        claim_id = claim.get("claim_id")
        if not isinstance(claim_id, str) or not CLAIM_ID.fullmatch(claim_id):
            errors.append(f"{prefix}_invalid_id")
            claim_id = ""
        elif claim_id in claim_ids:
            errors.append(f"{prefix}_duplicate_id")
        else:
            claim_ids.add(claim_id)
        if not _nonempty_string(claim.get("statement")):
            errors.append(f"{prefix}_invalid_statement")
        anchor = claim.get("source_anchor")
        if not _nonempty_string(anchor):
            errors.append(f"{prefix}_invalid_source_anchor")
        else:
            anchor_words = _canonical_words(anchor)
            if not anchor_words:
                errors.append(f"{prefix}_invalid_source_anchor")
            elif " ".join(anchor_words) not in material_text:
                errors.append(f"{prefix}_source_anchor_not_found")
        if not isinstance(claim.get("central"), bool):
            errors.append(f"{prefix}_central_not_boolean")
        elif claim["central"]:
            central_claims += 1
        disposition = claim.get("disposition")
        axes = claim.get("axes")
        if disposition not in {"validate", "unresolved"}:
            errors.append(f"{prefix}_invalid_disposition")
        if not isinstance(axes, list):
            errors.append(f"{prefix}_axes_not_list")
            axes = []
        if disposition == "validate" and not axes:
            errors.append(f"{prefix}_validate_without_axes")
        if disposition == "unresolved":
            if axes:
                errors.append(f"{prefix}_unresolved_with_axes")
            if not _nonempty_string(claim.get("unresolved_reason")):
                errors.append(f"{prefix}_missing_unresolved_reason")
        for axis_index, axis in enumerate(axes):
            axis_prefix = f"{prefix}_axis_{axis_index}"
            if not isinstance(axis, dict):
                errors.append(f"{axis_prefix}_not_object")
                continue
            axis_id = axis.get("axis_id")
            match = AXIS_ID.fullmatch(axis_id) if isinstance(axis_id, str) else None
            if match is None or (claim_id and int(match.group(1)) != int(claim_id[1:])):
                errors.append(f"{axis_prefix}_invalid_id")
            elif axis_id in axis_ids:
                errors.append(f"{axis_prefix}_duplicate_id")
            else:
                axis_ids.add(axis_id)
                if disposition == "validate":
                    validate_axis_ids.add(axis_id)
            if not _nonempty_string(axis.get("validation_question")):
                errors.append(f"{axis_prefix}_invalid_question")

    if status == "ready" and central_claims == 0:
        errors.append("ready_without_central_claim")
    if any(
        not (_nonempty_string(item) or (isinstance(item, dict) and bool(item)))
        for item in predictions
    ):
        errors.append("invalid_prediction")
    prediction_keys = [
        " ".join(_canonical_words(item))
        if isinstance(item, str)
        else json.dumps(item, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        for item in predictions
        if isinstance(item, (str, dict))
    ]
    if len(prediction_keys) != len(set(prediction_keys)):
        errors.append("duplicate_prediction")

    seen_indices: set[int] = set()
    covered_axes: set[str] = set()
    for coverage_index, item in enumerate(coverage):
        prefix = f"coverage_{coverage_index}"
        if not isinstance(item, dict):
            errors.append(f"{prefix}_not_object")
            continue
        prediction_index = item.get("prediction_index")
        if (
            isinstance(prediction_index, bool)
            or not isinstance(prediction_index, int)
            or not 0 <= prediction_index < len(predictions)
        ):
            errors.append(f"{prefix}_invalid_prediction_index")
        elif prediction_index in seen_indices:
            errors.append(f"{prefix}_duplicate_prediction_index")
        else:
            seen_indices.add(prediction_index)
        referenced = item.get("axis_ids")
        if not isinstance(referenced, list) or not referenced:
            errors.append(f"{prefix}_axis_ids_not_nonempty_list")
            continue
        if len(referenced) != len(set(referenced)):
            errors.append(f"{prefix}_duplicate_axis_reference")
        for axis_id in referenced:
            if not isinstance(axis_id, str) or axis_id not in axis_ids:
                errors.append(f"{prefix}_unknown_axis_id")
            else:
                covered_axes.add(axis_id)

    if status == "ready" and seen_indices != set(range(len(predictions))):
        errors.append("predictions_not_exactly_covered")
    uncovered = sorted(validate_axis_ids - covered_axes)
    if uncovered:
        errors.append("uncovered_validation_axes")
    return {
        "valid": not errors,
        "errors": errors,
        "status": status,
        "claim_count": len(claim_ids),
        "central_claim_count": central_claims,
        "axis_count": len(axis_ids),
        "prediction_count": len(predictions),
        "uncovered_axis_ids": uncovered,
    }


def validate_claim_map_payload(payload: Any, material: str) -> dict[str, Any]:
    """Validate the frozen-map stage before any plan has been generated."""
    if not isinstance(payload, dict):
        return {"valid": False, "errors": ["payload_not_object"]}
    staged = dict(payload)
    if staged.get("status") == "insufficient_material":
        staged["predictions"] = []
        staged["coverage"] = []
        return validate_payload(staged, material)
    axis_ids = [
        axis.get("axis_id")
        for claim in staged.get("claim_map", [])
        if isinstance(claim, dict)
        for axis in claim.get("axes", [])
        if isinstance(axis, dict) and isinstance(axis.get("axis_id"), str)
    ]
    staged["predictions"] = [f"stage-one axis placeholder {axis_id}" for axis_id in axis_ids]
    staged["coverage"] = [
        {"prediction_index": index, "axis_ids": [axis_id]}
        for index, axis_id in enumerate(axis_ids)
    ]
    return validate_payload(staged, material)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate a research-validation JSON contract")
    parser.add_argument("--material", type=Path, required=True)
    parser.add_argument("--response", type=Path, required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    material = args.material.read_text(encoding="utf-8")
    payload = json.loads(args.response.read_text(encoding="utf-8"))
    report = validate_payload(payload, material)
    print(json.dumps(report, sort_keys=True))
    return 0 if report["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
