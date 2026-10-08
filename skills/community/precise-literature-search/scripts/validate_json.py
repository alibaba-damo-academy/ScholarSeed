#!/usr/bin/env scholarseed-skill-python
"""Validate the stable JSON contracts without third-party packages."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Callable


class ContractError(ValueError):
    pass


def _object(data: Any, label: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ContractError(f"{label} must be a JSON object")
    return data


def _required(data: dict[str, Any], fields: list[str], label: str) -> None:
    missing = [field for field in fields if field not in data]
    if missing:
        raise ContractError(f"{label} missing required field(s): {', '.join(missing)}")


def _nonempty_string(value: Any, field: str) -> None:
    if not isinstance(value, str) or not value.strip():
        raise ContractError(f"{field} must be a non-empty string")


def _integer_at_least(value: Any, field: str, minimum: int) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise ContractError(f"{field} must be an integer >= {minimum}")


def _nullable_string(value: Any, field: str) -> None:
    if value is not None and not isinstance(value, str):
        raise ContractError(f"{field} must be a string or null")


def _array_of_strings(value: Any, field: str) -> None:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ContractError(f"{field} must be an array of strings")


def _string_list(value: Any, field: str, minimum: int, maximum: int) -> list[str]:
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ContractError(f"{field} must contain {minimum} to {maximum} items")
    normalized: list[str] = []
    for index, item in enumerate(value):
        _nonempty_string(item, f"{field}[{index}]")
        normalized.append(item.strip())
    if len(set(normalized)) != len(normalized):
        raise ContractError(f"{field} must not contain duplicates")
    return normalized


def validate_intent(data: Any) -> None:
    obj = _object(data, "intent")
    _required(obj, ["schema_version", "original_request", "precise_intent", "research_questions",
                    "include_criteria", "exclude_criteria", "time_range", "paper_types",
                    "language", "max_results", "confirmed"], "intent")
    if not isinstance(obj["schema_version"], str) or obj["schema_version"] != "1.1":
        raise ContractError("intent schema_version must be 1.1")
    if not isinstance(obj["original_request"], str):
        raise ContractError("original_request must be a string")
    _nonempty_string(obj["precise_intent"], "precise_intent")
    for field in ("research_questions", "include_criteria", "exclude_criteria", "paper_types"):
        _array_of_strings(obj[field], field)
    years = _object(obj["time_range"], "time_range")
    _required(years, ["from_year", "to_year"], "time_range")
    for key in ("from_year", "to_year"):
        if years[key] is not None:
            _integer_at_least(years[key], key, 1)
    if years["from_year"] is not None and years["to_year"] is not None and years["from_year"] > years["to_year"]:
        raise ContractError("time_range from_year cannot exceed to_year")
    _nullable_string(obj["language"], "language")
    if obj["max_results"] is not None:
        _integer_at_least(obj["max_results"], "intent max_results", 1)
    if not isinstance(obj["confirmed"], bool):
        raise ContractError("confirmed must be a boolean")
    if "confirmation_source" in obj and (
        not isinstance(obj["confirmation_source"], str)
        or obj["confirmation_source"] not in {"user_explicit", "auto_delegated"}
    ):
        raise ContractError("confirmation_source must be user_explicit or auto_delegated")


def validate_search_request(data: Any) -> None:
    obj = _object(data, "search request")
    _required(
        obj,
        [
            "schema_version", "run_id", "round", "intent", "user_feedback",
            "previous_round", "exclude_previous_ids", "max_results",
        ],
        "search request",
    )
    if not isinstance(obj["schema_version"], str) or obj["schema_version"] != "2.0":
        raise ContractError("unsupported search request; create a new run (schema 2.0)")
    _nonempty_string(obj["run_id"], "search request run_id")
    _integer_at_least(obj["round"], "search request round", 1)
    validate_intent(obj["intent"])
    _nullable_string(obj["user_feedback"], "search request user_feedback")
    feedback_source = obj.get("feedback_source")
    if feedback_source is not None and (
        not isinstance(feedback_source, str)
        or feedback_source not in {"user", "host_agent"}
    ):
        raise ContractError("search request feedback_source must be user, host_agent, or null")
    _nullable_string(obj["previous_round"], "search request previous_round")
    _array_of_strings(obj["exclude_previous_ids"], "search request exclude_previous_ids")
    _integer_at_least(obj["max_results"], "search request max_results", 1)
    _required(obj, ["search_profile"], "search request schema 2.0")
    profile = obj["search_profile"]
    profile_limits = {"fast_mock": 1, "full": None, "balance": 20}
    if profile not in profile_limits:
        raise ContractError("search request search_profile must be fast_mock, full, or balance")
    if profile_limits[profile] is not None and obj["max_results"] > profile_limits[profile]:
        raise ContractError(
            f"search request max_results exceeds {profile} profile budget"
        )
    requested_count = obj["intent"]["max_results"]
    if "time_budget_seconds" in obj:
        _integer_at_least(obj["time_budget_seconds"], "search request time_budget_seconds", 1)
    if requested_count is not None and obj["max_results"] > requested_count:
        raise ContractError("search request max_results cannot exceed the user intent limit")


def validate_related_recommendations(items: Any) -> None:
    if not isinstance(items, list) or len(items) > 3:
        raise ContractError("related_recommendations must contain at most three entries")
    seen = set()
    for item in items:
        item = _object(item, "related recommendation")
        _required(item, ["id", "confirmed_connections", "unmet_criteria", "scope_key", "evidence_key"], "related recommendation")
        if set(item) - {"id", "confirmed_connections", "unmet_criteria", "scope_key", "evidence_key", "paper"}:
            raise ContractError("recommendation accepts structured connections and gaps only")
        for field in ("id", "scope_key", "evidence_key"):
            _nonempty_string(item[field], f"recommendation {field}")
            if len(item[field]) > 2000:
                raise ContractError("recommendation fields must be bounded")
        if item["id"] in seen:
            raise ContractError("duplicate recommendation ID")
        seen.add(item["id"])
        if any(not re.fullmatch(r"[0-9a-f]{64}", item[field]) for field in ("scope_key", "evidence_key")):
            raise ContractError("recommendation bindings must be SHA-256 digests")
        gaps = item["unmet_criteria"]
        if not isinstance(gaps, list) or not 1 <= len(gaps) <= 64:
            raise ContractError("recommendation needs one to 64 unmet or uncertain criteria")
        for gap in gaps:
            gap = _object(gap, "recommendation gap")
            _required(gap, ["criterion_key", "status", "reason"], "recommendation gap")
            if gap["status"] not in ("unmet", "unverified"):
                raise ContractError("recommendation gap status must be unmet or unverified")
            if set(gap) - {"criterion_key", "status", "reason"}:
                raise ContractError("unexpected recommendation gap fields")
            for field in ("criterion_key", "reason"):
                _nonempty_string(gap[field], f"recommendation gap {field}")
                if len(gap[field]) > 2000:
                    raise ContractError("recommendation gap must be bounded")
        connections = item["confirmed_connections"]
        if not isinstance(connections, list) or not 1 <= len(connections) <= 8:
            raise ContractError("recommendation needs one to eight confirmed connections")
        for connection in connections:
            connection = _object(connection, "recommendation connection")
            _required(connection, ["statement", "evidence"], "recommendation connection")
            if set(connection) - {"statement", "evidence"}:
                raise ContractError("unexpected recommendation connection fields")
            _nonempty_string(connection["statement"], "recommendation connection statement")
            if len(connection["statement"]) > 2000:
                raise ContractError("recommendation connection must be bounded")
            quotes = connection["evidence"]
            if not isinstance(quotes, list) or not 1 <= len(quotes) <= 8:
                raise ContractError("recommendation needs one to eight evidence quotes")
            for quote in quotes:
                quote = _object(quote, "recommendation evidence")
                _required(quote, ["field", "quote"], "recommendation evidence")
                if quote["field"] not in ("title", "abstract", "year", "language", "publication_type", "publication_types"):
                    raise ContractError("invalid recommendation evidence field")
                _nonempty_string(quote["quote"], "recommendation quote")
                if len(quote["quote"]) > 2000:
                    raise ContractError("recommendation quote must be bounded")


def validate_metadata(data: Any) -> None:
    obj = _object(data, "metadata")
    _required(
        obj,
        [
            "schema_version", "run_id", "round", "query_summary", "generated_at",
            "status", "is_placeholder", "papers", "warnings",
        ],
        "metadata",
    )
    if obj["schema_version"] != "1.0":
        raise ContractError("metadata schema_version must be 1.0")
    if not isinstance(obj["run_id"], str):
        raise ContractError("metadata run_id must be a string")
    _integer_at_least(obj["round"], "metadata round", 1)
    if not isinstance(obj["query_summary"], str):
        raise ContractError("metadata query_summary must be a string")
    statuses_with_candidates = {"success", "partial"}
    statuses_without_candidates = {
        "no_confident_match", "execution_blocked", "source_failed", "invalid_result",
    }
    if obj["status"] not in statuses_with_candidates | statuses_without_candidates:
        raise ContractError(f"metadata status is invalid: {obj['status']!r}")
    if "result_summary" in obj and not isinstance(obj["result_summary"], str):
        raise ContractError("metadata result_summary must be a string")
    if not isinstance(obj["generated_at"], str):
        raise ContractError("metadata generated_at must be a string")
    if not isinstance(obj["is_placeholder"], bool):
        raise ContractError("metadata is_placeholder must be a boolean")
    if not isinstance(obj["papers"], list):
        raise ContractError("papers must be an array")
    if obj["status"] in statuses_with_candidates and not obj["papers"]:
        raise ContractError(f"metadata status {obj['status']} requires at least one paper")
    if obj["status"] in statuses_without_candidates and obj["papers"]:
        raise ContractError(f"metadata status {obj['status']} requires an empty paper array")
    _array_of_strings(obj["warnings"], "metadata warnings")
    allowed_access = {"yes", "no", "unknown"}
    allowed_document_types = {
        "paper", "blog", "documentation", "dataset", "web_page", "unknown",
    }
    allowed_identity_statuses = {"verified", "probable", "unverified"}
    required = [
        "id", "title", "authors", "year", "abstract", "doi", "venue",
        "open_access", "source", "relevance", "is_placeholder",
    ]
    related = obj.get("related_recommendations", [])
    validate_related_recommendations(related)
    if related and (obj["papers"] or obj["status"] == "execution_blocked" or obj["is_placeholder"]):
        raise ContractError("related recommendations are separate from matches and execution blockers")
    for item in related:
        paper = _object(item.get("paper"), "recommendation paper")
        if (paper.get("id") != item["id"] or paper.get("document_type") != "paper"
                or paper.get("is_placeholder") is not False or "tier" in paper):
            raise ContractError("recommendation must contain its scholarly paper, without a match tier")
    for index, paper in enumerate(obj["papers"] + [item["paper"] for item in related]):
        item = _object(paper, f"papers[{index}]")
        _required(item, required, f"papers[{index}]")
        _nonempty_string(item["id"], f"papers[{index}].id")
        _nonempty_string(item["title"], f"papers[{index}].title")
        _array_of_strings(item["authors"], f"papers[{index}].authors")
        year = item["year"]
        if year is not None and (isinstance(year, bool) or not isinstance(year, int)):
            raise ContractError(f"papers[{index}].year must be an integer or null")
        for field in ("abstract", "doi", "venue"):
            _nullable_string(item[field], f"papers[{index}].{field}")
        if "abstract_summary" in item and not isinstance(item["abstract_summary"], str):
            raise ContractError(f"papers[{index}].abstract_summary must be a string")
        if not isinstance(item["open_access"], str) or item["open_access"] not in allowed_access:
            raise ContractError(
                f"papers[{index}].open_access must be one of: no, unknown, yes"
            )
        _nonempty_string(item["source"], f"papers[{index}].source")
        _object(item["relevance"], f"papers[{index}].relevance")
        if not isinstance(item["is_placeholder"], bool):
            raise ContractError(f"papers[{index}].is_placeholder must be a boolean")
        for field in ("arxiv_id", "url"):
            if field in item:
                _nullable_string(item[field], f"papers[{index}].{field}")
        document_type = item.get("document_type")
        if "document_type" in item and (
            not isinstance(document_type, str) or document_type not in allowed_document_types
        ):
            raise ContractError(f"papers[{index}].document_type is invalid")
        identity_status = item.get("identity_status")
        if "identity_status" in item and (
            not isinstance(identity_status, str)
            or identity_status not in allowed_identity_statuses
        ):
            raise ContractError(f"papers[{index}].identity_status is invalid")


def validate_search_plan(data: Any) -> None:
    obj = _object(data, "search plan")
    _required(
        obj,
        [
            "schema_version", "strategy_version", "run_id", "outer_round", "precise_intent",
            "subtopics", "candidate_angles", "search_angles", "landmark_queries",
            "planned_queries", "max_results", "exclude_ids", "created_at",
        ],
        "search plan",
    )
    schema_version = obj["schema_version"]
    strategy_version = obj["strategy_version"]
    if schema_version != "2.0":
        raise ContractError("search plan schema_version must be 2.0")
    if strategy_version not in {"search-skill-entity-probes-v1", "search-skill-fast-mock-v1", "search-skill-balanced-v1"}:
        raise ContractError("unsupported search strategy")
    _nonempty_string(obj["precise_intent"], "search plan precise_intent")
    if not isinstance(obj["outer_round"], int) or obj["outer_round"] < 1:
        raise ContractError("search plan outer_round must be an integer >= 1")
    if not isinstance(obj["max_results"], int) or obj["max_results"] < 1:
        raise ContractError("search plan max_results must be an integer >= 1")
    fast_mock = strategy_version == "search-skill-fast-mock-v1"
    balance = strategy_version == "search-skill-balanced-v1"
    compact = fast_mock
    _string_list(obj["subtopics"], "search plan subtopics", 1 if compact or balance else 3, 1 if compact else 6)
    candidate_angles = _string_list(
        obj["candidate_angles"], "search plan candidate_angles", 1 if compact or balance else 12, 1 if compact else 15
    )
    search_angles = _string_list(
        obj["search_angles"], "search plan search_angles", 1 if compact or balance else 6, 1 if compact else 8
    )
    if not set(search_angles).issubset(candidate_angles):
        raise ContractError("search plan search_angles must be selected from candidate_angles")
    if not isinstance(obj["exclude_ids"], list):
        raise ContractError("search plan exclude_ids must be an array")

    _required(
        obj,
        ["entity_analysis", "entity_hypotheses", "concept_probes"],
        "search plan schema 1.1",
    )
    _nonempty_string(obj["entity_analysis"], "search plan entity_analysis")

    allowed_entity_types = {
        "disease", "project", "method", "standard", "dataset", "cohort",
        "person", "organization", "venue", "other",
    }
    allowed_confidence = {"high", "medium", "low"}
    entity_hypotheses = obj["entity_hypotheses"]
    entity_maximum = 1 if fast_mock else 12
    if not isinstance(entity_hypotheses, list) or len(entity_hypotheses) > entity_maximum:
        raise ContractError(
            f"search plan entity_hypotheses must contain 0 to {entity_maximum} items"
        )
    entity_names: dict[str, str] = {}
    for index, value in enumerate(entity_hypotheses):
        label = f"search plan entity_hypotheses[{index}]"
        item = _object(value, label)
        _required(item, ["name", "type", "rationale", "confidence"], label)
        _nonempty_string(item["name"], f"{label}.name")
        _nonempty_string(item["rationale"], f"{label}.rationale")
        if item["type"] not in allowed_entity_types:
            raise ContractError(f"{label}.type is invalid")
        if item["confidence"] not in allowed_confidence:
            raise ContractError(f"{label}.confidence is invalid")
        name = item["name"].strip()
        key = name.casefold()
        if key in entity_names:
            raise ContractError("search plan entity_hypotheses has duplicate entity names")
        entity_names[key] = name

    concept_probes = obj["concept_probes"]
    probe_minimum, probe_maximum = 0, 1 if compact else 24
    if not isinstance(concept_probes, list) or not probe_minimum <= len(concept_probes) <= probe_maximum:
        raise ContractError(
            f"search plan concept_probes must contain {probe_minimum} to {probe_maximum} items"
        )
    seen_probes: set[tuple[str, str]] = set()
    referenced_entities: set[str] = set()
    for index, value in enumerate(concept_probes):
        label = f"search plan concept_probes[{index}]"
        item = _object(value, label)
        _required(item, ["concept", "mode", "query", "rationale", "entity"], label)
        for field in ("concept", "query", "rationale"):
            _nonempty_string(item[field], f"{label}.{field}")
        mode = item["mode"]
        if mode not in {"keyword", "title"}:
            raise ContractError(f"{label}.mode is invalid")
        query = item["query"].strip()
        probe_key = (mode, query.casefold())
        if probe_key in seen_probes:
            raise ContractError("search plan concept_probes must not repeat a mode/query pair")
        seen_probes.add(probe_key)
        if mode == "keyword" and len(query.split()) > 8:
            raise ContractError("search plan concept keyword probes must contain at most 8 words")
        entity = item["entity"]
        if entity is not None:
            _nonempty_string(entity, f"{label}.entity")
            entity_key = entity.strip().casefold()
            if entity_key not in entity_names:
                raise ContractError(f"{label}.entity references an unknown entity")
            referenced_entities.add(entity_key)
    uncovered_entities = set(entity_names) - referenced_entities
    if uncovered_entities:
        names = ", ".join(entity_names[key] for key in sorted(uncovered_entities))
        raise ContractError(
            f"search plan entity hypotheses must be referenced by a concept probe: {names}"
        )


    landmark_queries = obj["landmark_queries"]
    if not isinstance(landmark_queries, list):
        raise ContractError("search plan landmark_queries must be an array")
    if compact and len(landmark_queries) > 1:
        raise ContractError("compact search plan must contain at most one landmark query")
    for index, value in enumerate(landmark_queries):
        item = _object(value, f"search plan landmark_queries[{index}]")
        _required(item, ["mode", "query", "rationale"], f"search plan landmark_queries[{index}]")
        if item["mode"] not in {"keyword", "title"}:
            raise ContractError(f"search plan landmark_queries[{index}].mode is invalid")
        _nonempty_string(item["query"], f"search plan landmark_queries[{index}].query")
        _nonempty_string(item["rationale"], f"search plan landmark_queries[{index}].rationale")
    if compact and landmark_queries:
        landmark_key = (
            landmark_queries[0]["mode"], landmark_queries[0]["query"].strip().casefold()
        )
        probe_key = (
            concept_probes[0]["mode"], concept_probes[0]["query"].strip().casefold()
        ) if concept_probes else None
        if landmark_key != probe_key:
            raise ContractError("compact landmark query must reuse its concept probe")

    planned_queries = obj["planned_queries"]
    if not isinstance(planned_queries, list):
        raise ContractError("search plan planned_queries must be an array")
    modes_by_angle: dict[str, set[str]] = {angle: set() for angle in search_angles}
    web_count = 0
    seen_queries: set[tuple[str, str]] = set()
    for index, value in enumerate(planned_queries):
        item = _object(value, f"search plan planned_queries[{index}]")
        _required(
            item, ["angle", "source", "mode", "query", "purpose"],
            f"search plan planned_queries[{index}]",
        )
        for field in ("angle", "query", "purpose"):
            _nonempty_string(item[field], f"search plan planned_queries[{index}].{field}")
        angle = item["angle"].strip()
        source = item["source"]
        mode = item["mode"]
        query = item["query"].strip()
        if angle not in modes_by_angle:
            raise ContractError(f"search plan planned_queries[{index}].angle is not selected")
        if source not in {"paperhub", "web"} or mode not in {"keyword", "web"}:
            raise ContractError(f"search plan planned_queries[{index}] source or mode is invalid")
        if (source == "web") != (mode == "web"):
            raise ContractError(f"search plan planned_queries[{index}] web source/mode must match")
        key = (mode, query.casefold())
        if key in seen_queries:
            raise ContractError("search plan planned_queries must not repeat a mode/query pair")
        seen_queries.add(key)
        modes_by_angle[angle].add(mode)
        if mode == "web":
            web_count += 1
        elif mode == "keyword" and len(query.split()) > 8:
            raise ContractError("search plan PaperHub keyword queries must contain at most 8 words")
    if not any(q["mode"] in {"keyword", "title"}
               for q in [*planned_queries, *concept_probes, *landmark_queries]):
        raise ContractError("search plan must contain at least one keyword or title query")
    for angle, modes in modes_by_angle.items():
        if "keyword" not in modes:
            raise ContractError(f"search angle {angle!r} must have a PaperHub keyword query")
    if fast_mock:
        if len(planned_queries) != 2 or web_count != 1:
            raise ContractError(
                "fast mock search plan must contain exactly one PaperHub keyword and one web query"
            )
        if obj["max_results"] > 1:
            raise ContractError("fast mock search plan max_results must not exceed 1")
    elif balance:
        if obj["max_results"] > 20:
            raise ContractError("balance search plan max_results must not exceed 20")
        # The first PaperHub phase is one de-duplicated union, not three
        # independent budgets for the angle/probe/landmark representations.
        queries = {(q["mode"], q["query"].strip().casefold())
                   for q in [*planned_queries, *concept_probes, *landmark_queries]
                   if q["mode"] in {"keyword", "title"}}
        keyword_count = sum(mode == "keyword" for mode, _ in queries)
        title_count = sum(mode == "title" for mode, _ in queries)
        if len(queries) > 27 or keyword_count > 6 or title_count > 22:
            raise ContractError("balance first search phase exceeds upstream 27/6/22 query limits")
        if web_count > 8:
            raise ContractError("balance permits at most two entity-resolution web batches of four queries")
    elif not 3 <= web_count <= 5:
        raise ContractError("search plan must contain 3 to 5 web queries")


def _validate_mode_plan(data: Any, strategy: str) -> None:
    validate_search_plan(data)
    if data["strategy_version"] != strategy:
        raise ContractError("search plan strategy does not match the selected mode")


def validate_current_search_plan(data: Any) -> None:
    _validate_mode_plan(data, "search-skill-fast-mock-v1")


def validate_current_full_search_plan(data: Any) -> None:
    _validate_mode_plan(data, "search-skill-entity-probes-v1")


def validate_current_balance_search_plan(data: Any) -> None:
    _validate_mode_plan(data, "search-skill-balanced-v1")


def validate_search_state(data: Any) -> None:
    obj = _object(data, "search state")
    _required(
        obj,
        [
            "schema_version", "iteration", "max_iterations", "searched_queries",
            "subtopic_coverage", "dry_iterations", "pool_size", "source_counts",
            "errors", "stop_reason", "updated_at",
        ],
        "search state",
    )
    for field in ("iteration", "max_iterations", "dry_iterations", "pool_size"):
        if not isinstance(obj[field], int) or obj[field] < 0:
            raise ContractError(f"search state {field} must be a non-negative integer")
    if obj["max_iterations"] < 1:
        raise ContractError("search state max_iterations must be at least 1")
    if obj["iteration"] > obj["max_iterations"]:
        raise ContractError("search state iteration cannot exceed max_iterations")
    if not isinstance(obj["searched_queries"], list) or not isinstance(obj["errors"], list):
        raise ContractError("search state searched_queries and errors must be arrays")
    _object(obj["subtopic_coverage"], "search state subtopic_coverage")
    _object(obj["source_counts"], "search state source_counts")
    if "unresolved_errors" in obj:
        _array_of_strings(obj["unresolved_errors"], "search state unresolved_errors")


def validate_search_pool(data: Any) -> None:
    obj = _object(data, "search pool")
    _required(obj, ["schema_version", "papers"], "search pool")
    if not isinstance(obj["papers"], list):
        raise ContractError("search pool papers must be an array")


def validate_search_selection(data: Any) -> None:
    obj = _object(data, "search selection")
    _required(
        obj,
        ["schema_version", "selected", "coverage_assessment", "warnings"],
        "search selection",
    )
    if not isinstance(obj["selected"], list) or not isinstance(obj["warnings"], list):
        raise ContractError("search selection selected and warnings must be arrays")
    validate_related_recommendations(obj.get("related_recommendations", []))
    if obj["selected"] and obj.get("related_recommendations"):
        raise ContractError("related recommendations require an empty strict selection")
    for index, item in enumerate(obj["selected"]):
        paper = _object(item, f"search selection selected[{index}]")
        _required(
            paper,
            ["id", "tier", "relevance_score", "selection_reason", "subtopics_covered"],
            f"search selection selected[{index}]",
        )
        _nonempty_string(paper["id"], f"search selection selected[{index}].id")
        if paper["tier"] not in {1, 2, 3}:
            raise ContractError(f"search selection selected[{index}].tier must be 1, 2, or 3")


def validate_selection(data: Any) -> None:
    obj = _object(data, "selection")
    _required(
        obj,
        [
            "schema_version", "run_id", "metadata_path", "selected_paper_ids",
            "download_open", "download_paid", "read_after_download", "confirmed_by_user",
        ],
        "selection",
    )
    if not isinstance(obj["selected_paper_ids"], list):
        raise ContractError("selected_paper_ids must be an array")
    if obj["confirmed_by_user"] is not True:
        raise ContractError("confirmed_by_user must be true before downloading")
    decision_source = obj.get("decision_source")
    if decision_source is not None and decision_source not in {"user_explicit", "auto_delegated"}:
        raise ContractError("decision_source must be user_explicit or auto_delegated")
    paid_confirmation = obj.get("paid_download_confirmation")
    if paid_confirmation not in {None, "included_in_selection", "separate"}:
        raise ContractError(
            "paid_download_confirmation must be included_in_selection or separate"
        )


def validate_manifest(data: Any) -> None:
    obj = _object(data, "download manifest")
    _required(
        obj,
        ["schema_version", "run_id", "generated_at", "is_placeholder", "papers", "summary", "warnings"],
        "download manifest",
    )
    if not isinstance(obj["papers"], list):
        raise ContractError("download manifest papers must be an array")
    allowed = {"downloaded", "action_required", "failed", "skipped", "not_attempted"}
    for index, paper in enumerate(obj["papers"]):
        item = _object(paper, f"papers[{index}]")
        _required(item, ["paper_id", "title", "access_type", "status", "file_path", "verified_exists", "message"], f"papers[{index}]")
        if not isinstance(item["access_type"], str) or item["access_type"] not in {"open", "paid", "unknown"}:
            raise ContractError(f"papers[{index}].access_type must be open, paid, or unknown")
        if "download_route" in item and (not isinstance(item["download_route"], str) or item["download_route"] not in {"open-download", "paid-download"}):
            raise ContractError(f"papers[{index}].download_route is invalid")
        if item["status"] not in allowed:
            raise ContractError(f"papers[{index}].status is invalid: {item['status']}")
        if item["status"] == "downloaded" and item["verified_exists"] is not True:
            raise ContractError(f"papers[{index}] claims downloaded without verified_exists=true")
        storage = item.get("storage")
        if storage is not None and storage not in {"managed", "run"}:
            raise ContractError(f"papers[{index}].storage must be managed, run, or null")
        if storage == "managed":
            ref = item.get("ref")
            if item["status"] == "downloaded":
                if not isinstance(ref, str) or not ref.startswith("paper:"):
                    raise ContractError(f"papers[{index}] is managed without a paper: ref")
                _nonempty_string(item.get("revision"), f"papers[{index}].revision")
                if item["file_path"] is not None:
                    raise ContractError(
                        f"papers[{index}] is managed and must not keep a run-directory copy"
                    )
            elif ref is not None:
                raise ContractError(f"papers[{index}] keeps a managed ref without a download")
    _object(obj["summary"], "download manifest summary")
    adapter = obj.get("adapter")
    if isinstance(adapter, dict) and adapter.get("mode") == "interactive":
        status = obj.get("status")
        if status == "action_required":
            _required(obj, ["action_type", "action", "resume_token"], "interactive action manifest")
            action = _object(obj["action"], "interactive action")
            if action.get("safe_to_close_cdp_browser") is not False:
                raise ContractError(
                    "interactive action must set safe_to_close_cdp_browser=false"
                )
            if "completion_notice" in obj:
                raise ContractError("action_required manifest cannot contain completion_notice")
        if "completion_notice" in obj:
            notice = _object(obj["completion_notice"], "completion_notice")
            pool_released = notice.get("browser_pool_released") is True
            valid_close = notice.get("safe_to_close_cdp_browser") is (False if pool_released else True)
            if status != "completed" or not valid_close:
                raise ContractError(
                    "completion_notice requires completed status and a close flag consistent with pool release"
                )


def validate_reading_outcome(data: Any) -> None:
    obj = _object(data, "reading outcome")
    _required(obj, ["schema_version", "run_id", "search_round", "manifest_sha256", "papers"], "reading outcome")
    if obj["schema_version"] != "1.0":
        raise ContractError("reading outcome schema_version must be 1.0")
    _nonempty_string(obj["run_id"], "reading outcome run_id")
    if type(obj["search_round"]) is not int or obj["search_round"] < 1:
        raise ContractError("reading outcome search_round must be an integer >= 1")
    if not isinstance(obj["manifest_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", obj["manifest_sha256"]):
        raise ContractError("reading outcome requires manifest SHA-256")
    if not isinstance(obj["papers"], list):
        raise ContractError("reading outcome papers must be an array")
    for paper in obj["papers"]:
        p = _object(paper, "reading outcome paper")
        _required(p, ["paper_id", "file_path", "status", "reason"], "reading outcome paper")
        _nonempty_string(p["paper_id"], "reading outcome paper_id")
        if p["file_path"] is not None:
            _nonempty_string(p["file_path"], "reading outcome file_path")
        if p["status"] not in {"readable", "unreadable"}:
            raise ContractError("reading outcome status must be readable or unreadable")
        if p["status"] == "unreadable":
            _nonempty_string(p["reason"], "unreadable paper reason")
        if p["status"] == "readable" and p["file_path"] is None:
            raise ContractError("readable paper must name the run-contained evidence it used")
        storage = p.get("storage")
        if storage is not None and storage not in {"managed", "run"}:
            raise ContractError("reading outcome storage must be managed, run, or null")


def validate_run_state(data: Any) -> None:
    obj = _object(data, "run state")
    _required(
        obj,
        ["schema_version", "run_id", "status", "created_at", "updated_at", "search_round", "paths", "events", "errors"],
        "run state",
    )
    if obj["schema_version"] != "2.0":
        raise ContractError("unsupported run state; create a new run (schema 2.0)")
    statuses = {
        "INITIALIZED", "INTENT_DRAFTED", "INTENT_CONFIRMED", "SEARCHING",
        "REVIEW_PENDING", "REFINEMENT_REQUESTED", "RESULTS_ACCEPTED",
        "DOWNLOAD_DECISION_PENDING", "DOWNLOADING_OPEN", "PAID_DOWNLOAD_PENDING",
        "PAID_ACTION_REQUIRED", "DOWNLOADING_PAID", "READING",
        "REPORT_REVIEW_PENDING", "FINAL_REPORTING", "COMPLETED", "FAILED",
    }
    if obj["status"] not in statuses:
        raise ContractError(f"unknown run status: {obj['status']}")
    if "completion_outcome" in obj and obj["completion_outcome"] not in {"full_text", "no_readable_fulltext"}:
        raise ContractError("unknown completion outcome")
    if not isinstance(obj["search_round"], int) or obj["search_round"] < 0:
        raise ContractError("search_round must be a non-negative integer")
    paths = _object(obj["paths"], "run state paths")
    _required(
        paths,
        ["request", "intent", "latest_metadata", "selection", "download_manifest", "report"],
        "run state paths",
    )
    if not isinstance(obj["events"], list) or not isinstance(obj["errors"], list):
        raise ContractError("events and errors must be arrays")


def validate_report_review(data: Any) -> None:
    obj = _object(data, "report review")
    _required(
        obj,
        [
            "schema_version", "run_id", "search_round", "decision", "feedback",
            "report_path", "reviewed_at", "archived_artifacts",
        ],
        "report review",
    )
    if not isinstance(obj["search_round"], int) or obj["search_round"] < 1:
        raise ContractError("report review search_round must be an integer >= 1")
    if obj["decision"] not in {"complete", "refine"}:
        raise ContractError("report review decision must be complete or refine")
    feedback = obj["feedback"]
    if feedback is not None and (not isinstance(feedback, str) or not feedback.strip()):
        raise ContractError("report review feedback must be null or a non-empty string")
    if obj["decision"] == "refine" and not feedback:
        raise ContractError("report review refinement requires feedback")
    _nonempty_string(obj["report_path"], "report review report_path")
    _object(obj["archived_artifacts"], "report review archived_artifacts")


def validate_progress(data: Any) -> None:
    obj = _object(data, "progress")
    _required(
        obj,
        [
            "schema_version", "sequence", "stage", "status", "activity",
            "current", "total", "completed", "needs_user_action", "action",
            "started_at", "updated_at", "elapsed_seconds",
        ],
        "progress",
    )
    if obj["schema_version"] != "1.0":
        raise ContractError("progress schema_version must be 1.0")
    _integer_at_least(obj["sequence"], "progress sequence", 1)
    if obj["stage"] not in {"search", "download", "reading", "reporting"}:
        raise ContractError("progress stage is invalid")
    if obj["status"] not in {
        "running", "action_required", "completed", "failed", "cancelled",
    }:
        raise ContractError("progress status is invalid")
    _nonempty_string(obj["activity"], "progress activity")
    for field in ("current", "total", "completed"):
        if obj[field] is not None:
            _integer_at_least(obj[field], f"progress {field}", 0)
    if not isinstance(obj["needs_user_action"], bool):
        raise ContractError("progress needs_user_action must be a boolean")
    _nullable_string(obj["action"], "progress action")
    _nonempty_string(obj["started_at"], "progress started_at")
    _nonempty_string(obj["updated_at"], "progress updated_at")
    _integer_at_least(obj["elapsed_seconds"], "progress elapsed_seconds", 0)
    if obj["status"] == "action_required":
        if not obj["needs_user_action"]:
            raise ContractError("action_required progress must set needs_user_action")
        _nonempty_string(obj["action"], "progress action")


VALIDATORS: dict[str, Callable[[Any], None]] = {
    "intent": validate_intent,
    "search-request": validate_search_request,
    "metadata": validate_metadata,
    "search-plan": validate_search_plan,
    "search-plan-current": validate_current_search_plan,
    "search-plan-current-full": validate_current_full_search_plan,
    "search-plan-current-balance": validate_current_balance_search_plan,
    "search-state": validate_search_state,
    "search-pool": validate_search_pool,
    "search-selection": validate_search_selection,
    "selection": validate_selection,
    "download-manifest": validate_manifest,
    "reading-outcome": validate_reading_outcome,
    "run-state": validate_run_state,
    "report-review": validate_report_review,
    "progress": validate_progress,
}


def validate_data(contract: str, data: Any) -> None:
    try:
        validator = VALIDATORS[contract]
    except KeyError as exc:
        raise ContractError(f"unknown contract: {contract}") from exc
    validator(data)


def validate_file(contract: str, path: Path) -> None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError as exc:
        raise ContractError(f"contract file does not exist: {path}") from exc
    except json.JSONDecodeError as exc:
        raise ContractError(f"invalid JSON in {path}: {exc}") from exc
    validate_data(contract, data)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", required=True, choices=sorted(VALIDATORS))
    parser.add_argument("--input", required=True, type=Path)
    args = parser.parse_args()
    try:
        validate_file(args.contract, args.input)
    except ContractError as exc:
        print(f"contract validation failed for {args.input}: {exc}", file=sys.stderr)
        return 2
    print(f"valid {args.contract}: {args.input}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
