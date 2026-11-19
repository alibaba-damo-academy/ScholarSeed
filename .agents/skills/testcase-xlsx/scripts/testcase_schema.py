"""Shared testcase schema."""

from __future__ import annotations

from typing import Any

SHEET_NAME = "测试用例"
HEADERS = [
    "编号",
    "用例名称",
    "用例文件夹",
    "作者",
    "优先级",
    "用例类型",
    "前置条件",
    "内容类型",
    "步骤内容",
    "预期结果",
    "标签",
    "描述",
]
KEYS = [
    "id",
    "name",
    "folder",
    "author",
    "priority",
    "case_type",
    "precondition",
    "content_type",
    "steps",
    "expected",
    "tag",
    "description",
]
HEADER_TO_KEY = dict(zip(HEADERS, KEYS))
DEFAULTS = {"case_type": "手工", "content_type": "文本"}
REQUIRED = [
    "id",
    "name",
    "folder",
    "author",
    "priority",
    "precondition",
    "steps",
    "expected",
    "tag",
    "description",
]
VALID_PRIORITIES = {"P0", "P1", "P2", "P3"}


def normalize_multiline(value: Any) -> Any:
    return "\n".join(str(item).rstrip() for item in value) if isinstance(value, list) else value


def validate_cases(cases: list[dict[str, Any]]) -> None:
    seen: set[str] = set()
    for index, case in enumerate(cases, 1):
        missing = [key for key in REQUIRED if not str(case.get(key, "")).strip()]
        if missing:
            raise ValueError(f"Case {case.get('id', index)!r} missing required fields: {missing}")
        case_id = str(case["id"])
        if case_id in seen:
            raise ValueError(f"Duplicate case id: {case_id}")
        seen.add(case_id)
        if str(case["priority"]).strip() not in VALID_PRIORITIES:
            raise ValueError(f"Case {case_id} has invalid priority: {case['priority']!r}")
