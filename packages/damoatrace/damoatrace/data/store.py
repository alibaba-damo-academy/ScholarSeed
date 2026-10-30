"""damoatrace 数据读取层 — trace jsonl + obs (app logs / metrics) 的读取与聚合 (proposal 26 §5.1).

从 damoatrace utils 拆出: TraceStore 负责 TRACE_DIR/*.jsonl 的 (path,size,mtime)
缓存读取, 以及 UI/CLI/bench 同源的聚合 (session 列表 / trace 树 / usage rollup /
logs / metrics / overview)。成败/error_class/channel 口径走 damoatrace.recording.records;
映射/价格表 helpers (_parse_ts/_estimate_cost/...) 留在 damoatrace.utils 共享。
"""

from __future__ import annotations

import json
import threading
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, TypedDict

import damoatrace.recording.records as _rec
from damoatrace.contract.event import EventKind
from damoatrace.data.records import decode_event_record, decode_object_line
from damoatrace.paths import APP_DIRNAME, METRICS_DIRNAME, PATHS, TRACE_FILE_SUFFIX, TracePaths
from damoatrace.recording.content import validate_content_version, visible_content
from damoatrace.utils import (
    _NOISE_KINDS,
    _agent_identity,
    _estimate_cost,
    _parse_ts,
    _percentile,
    _session_role,
    _span_type,
)

CONTEXT_LEDGER_DIRNAME = "context"
CONTEXT_SUBAGENTS_DIRNAME = "_subagents"
CONTEXT_ITEMS_FILENAME = "items.jsonl"
CONTEXT_OPERATIONS_FILENAME = "operations.jsonl"
CONTEXT_SPANS_FILENAME = "spans.jsonl"
CONTEXT_VISIBLE_INDEXES_FILENAME = "visible_indexes.jsonl"
CONTEXT_LEDGER_FILES = (
    CONTEXT_ITEMS_FILENAME,
    CONTEXT_OPERATIONS_FILENAME,
    CONTEXT_SPANS_FILENAME,
    CONTEXT_VISIBLE_INDEXES_FILENAME,
)
CONTEXT_CONTENT_PREVIEW_CHARS = 240
CONTEXT_EVENT_ENTERED = "entered"
CONTEXT_EVENT_VISIBLE = "visible"
CONTEXT_EVENT_NOT_VISIBLE = "not_visible"
CONTEXT_EVENT_REPLACED = "replaced"
CONTEXT_EVENT_ENDED = "ended"
CONTEXT_EVENT_COMPACTED = "compacted"
CONTEXT_EVENT_RETAINED = "retained_after_compaction"
TRACE_CONTEXT_KIND = "context"
TRACE_CONTEXT_COMPACTION_NAME = "context.compaction"
TRACE_COMPACTION_ITEM_TRANSITIONS = "item_transitions"
TRACE_COMPACTION_RETAINED_ITEMS = "retained_items"
TRACE_COMPACTION_ITEM_ID = "item_id"
TRACE_COMPACTION_REMOVED_AT = "removed_at"
TRACE_COMPACTION_CHECKPOINT_ITEM_IDS = "checkpoint_item_ids"
TRACE_COMPACTION_OPERATION_ID = "operation_id"
TRACE_COMPACTION_REMOVAL_CONTEXT_SPAN_ID = "removal_context_span_id"
TRACE_COMPACTION_REMOVAL_TRACE_SPAN_ID = "removal_trace_span_id"
TRACE_COMPACTION_REMOVAL_TRACE_REF = "removal_trace_ref"
TRACE_COMPACTION_REMOVAL_TURN_ID = "removal_turn_id"
TRACE_COMPACTION_RETAINED_TURN_ID = "retained_turn_id"
TRACE_EVENT_TASK_START = EventKind.TASK_START.value
TRACE_EVENT_TURN_START = EventKind.TURN_START.value
TRACE_EVENT_MODEL_CALLS = frozenset((EventKind.LLM_STREAM.value, EventKind.SIDE_QUERY.value))
CONSUMPTION_USAGE_EVENT_KINDS = frozenset((EventKind.LLM_STREAM.value, EventKind.SIDE_QUERY.value))


def is_consumption_usage_event(event: Dict[str, Any]) -> bool:
    """Whether an event is a leaf model-consumption record rather than a roll-up."""
    return bool((event.get("attributes") or {}).get("usage")) and (
        event.get("kind") in CONSUMPTION_USAGE_EVENT_KINDS
    )


CONTEXT_EVENT_BATCH_TIMESTAMP_LENGTH = 19

# ───────────────────────── trace 文件读取 + 缓存 ─────────────────────────


class TimingSummary(TypedDict):
    name: str
    count: int
    p50: float
    p95: float
    max: float
    avg: float


@dataclass
class _FileCacheEntry:
    path: Path
    size: int
    mtime: float
    events: List[Dict[str, Any]] = field(default_factory=list)


class TraceStore:
    """从 TRACE_DIR/*.jsonl 读 events. 缓存 by (path, size, mtime).

    线程安全: 用一个 lock 包住 cache dict; 单次 query 几毫秒, contention 可忽略.
    """

    def __init__(
        self,
        trace_dir: Path,
        *,
        paths: TracePaths | None = None,
        trace_file: Path | None = None,
        offline: bool = False,
        include_content: bool = False,
        snapshot_at: float | None = None,
    ):
        self.trace_dir = Path(trace_dir).expanduser().resolve()
        self.offline = offline
        self.include_content = include_content
        self.snapshot_at = snapshot_at
        self.trace_file = Path(trace_file).expanduser().resolve() if trace_file else None
        if self.trace_file and self.trace_file.parent != self.trace_dir:
            raise ValueError("trace file must belong to the supplied directory")
        self.paths = paths or (
            PATHS
            if self.trace_dir == PATHS.trace
            else TracePaths(
                home=self.trace_dir.parent,
                trace=self.trace_dir,
                app=self.trace_dir.parent / APP_DIRNAME,
                metrics=self.trace_dir.parent / METRICS_DIRNAME,
            )
        )
        if self.paths.trace != self.trace_dir:
            raise ValueError("trace directory must match the supplied evidence paths")
        self._cache: Dict[Path, _FileCacheEntry] = {}
        self._read_gaps: dict[Path, int] = {}
        self._lock = threading.Lock()

    def _scan_files(self) -> List[Path]:
        if self.trace_file is not None:
            return [self.trace_file]
        try:
            entries = tuple(self.trace_dir.iterdir())
        except FileNotFoundError:
            return []
        return sorted(
            path
            for path in entries
            if path.match(f"*{TRACE_FILE_SUFFIX}")
            and path.is_file()
            and (not self.offline or path.resolve().parent == self.trace_dir)
        )

    def _load_file(self, path: Path) -> List[Dict[str, Any]]:
        try:
            st = path.stat()
        except FileNotFoundError:
            return []
        size, mtime = st.st_size, st.st_mtime
        with self._lock:
            entry = self._cache.get(path)
            if entry and entry.size == size and entry.mtime == mtime:
                return entry.events
        events: List[Dict[str, Any]] = []
        skipped = 0
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    record = decode_object_line(line)
                    if record is not None:
                        validate_content_version(record)
                    record = decode_event_record(record)
                    if record is None:
                        skipped += 1
                        continue
                    events.append(record)
        except FileNotFoundError:
            return []
        except (OSError, UnicodeError):
            with self._lock:
                self._read_gaps[path] = skipped + 1
            raise
        self._attribute_sessions(events)
        with self._lock:
            self._read_gaps[path] = skipped
            self._cache[path] = _FileCacheEntry(path=path, size=size, mtime=mtime, events=events)
        return events

    def completeness(self, session_id: str | None = None) -> dict[str, Any]:
        """Report known evidence gaps, never infer full execution coverage from valid JSON."""
        events = self.session_events(session_id) if session_id else self.all_events()
        gaps = {"execution_coverage_unverified"}
        for event in events:
            declared = (event.get("attributes") or {}).get("evidence_gaps", [])
            if isinstance(declared, list):
                gaps.update(value for value in declared if isinstance(value, str))
        with self._lock:
            skipped = sum(self._read_gaps.values())
        if skipped:
            gaps.add("unreadable_or_invalid_records")
        if self.offline:
            gaps.add("external_logs_and_context_unavailable")
        return {
            "status": "partial" if events else "unavailable",
            "gaps": sorted(gaps),
            "skipped_records": skipped,
        }

    @staticmethod
    def _attribute_sessions(events: List[Dict[str, Any]]) -> None:
        """给每个 event 盖 `_sid` (所属 session) —— **按文件内归属** (一个 jsonl ≈ 一次 run).

        task_run 有对应 task.start → 用其 session_id; task-less / task.start 之前的事件
        (mode.transition / hook / plugin.apply 等) 归到本文件的 session, 而不是全局 _orphan。
        独立 bootstrap 文件没有 task.start 时，使用事件 attributes.session_id；只有整个
        文件都没有可信 session 指针时才真正 _orphan。
        """
        tr2sid: Dict[str, str] = {}
        sids: List[str] = []
        for e in events:
            event_sid = e.get("session_id") or (e.get("attributes") or {}).get("session_id")
            if event_sid:
                sids.append(event_sid)
            if e.get("kind") == "task.start":
                sid = (e.get("attributes") or {}).get("session_id")
                if sid:
                    tr2sid[e.get("task_run_id", "")] = sid
        file_primary = sids[0] if len(set(sids)) == 1 else (sids[0] if sids else "")
        cur = file_primary
        for e in events:
            event_sid = e.get("session_id") or (e.get("attributes") or {}).get("session_id")
            if event_sid:
                cur = event_sid
            # 优先用 event 自带的 session_id (新版 tracer 发出那刻就盖); 旧 trace 没有则
            # 回退到 attributes.session_id / task_run→task.start 映射 / 文件内归属.
            e["_sid"] = event_sid or tr2sid.get(e.get("task_run_id", "")) or cur or ""

    def all_events(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for p in self._scan_files():
            out.extend(
                visible_content(e, include_content=self.include_content, now=self.snapshot_at)
                for e in self._load_file(p)
            )
        return out

    # ─── session 聚合 ───
    def sessions(self) -> List[Dict[str, Any]]:
        """按 session_id (从 TASK_START attributes 抽) 聚合.

        没 TASK_START 的 task_run 归到 '_orphan' session.
        """
        events = self.all_events()
        # task_run_id → session_id (从 TASK_START 拿)
        tr2sid: Dict[str, str] = {}
        tr2workdir: Dict[str, str] = {}
        for e in events:
            if e.get("kind") == "task.start":
                attrs = e.get("attributes") or {}
                sid = attrs.get("session_id")
                if sid:
                    tr2sid[e["task_run_id"]] = sid
                wd = attrs.get("workdir")
                if wd:
                    tr2workdir[e["task_run_id"]] = wd

        sessions: Dict[str, Dict[str, Any]] = defaultdict(
            lambda: {
                "session_id": "",
                "task_runs": set(),
                "event_count": 0,
                "started_at": None,
                "last_at": None,
                "workdirs": set(),
                "errors": 0,
                "tool_calls": 0,
                "llm_calls": 0,
                "agents": set(),
                "spawn_names": set(),  # 该 session 派生的子 agent 名 (subagent_name)
            }
        )
        spawn_by_name: Dict[str, str] = {}  # subagent_name -> parent session_id
        direct_child: Dict[str, str] = {}  # child_session_id (attr 直带) -> parent session_id

        for e in events:
            trid = e.get("task_run_id", "")
            sid = e.get("_sid") or "_orphan"  # 按文件内归属 (见 _attribute_sessions)
            s = sessions[sid]
            s["session_id"] = sid
            s["task_runs"].add(trid)
            s["event_count"] += 1
            started = e.get("started_at")
            if started:
                if s["started_at"] is None or started < s["started_at"]:
                    s["started_at"] = started
                ended = e.get("ended_at") or started
                if s["last_at"] is None or ended > s["last_at"]:
                    s["last_at"] = ended
            if trid in tr2workdir:
                s["workdirs"].add(tr2workdir[trid])
            # Evidence Contract: run.outcome 失败在 attributes.status (顶层恒 ok)
            if _rec.is_failed(e):
                s["errors"] += 1
            kind = e.get("kind", "")
            comp = e.get("component_id") or ""
            if kind == "task.start" and comp.startswith("agent:"):
                s["agents"].add(_agent_identity(comp)["agent"])
            if kind == "tool.exec":
                s["tool_calls"] += 1
            if kind == "llm.stream":
                s["llm_calls"] += 1
            if kind == "subagent.start":
                a = e.get("attributes") or {}
                if a.get("subagent_name"):
                    s["spawn_names"].add(a["subagent_name"])
                    spawn_by_name[a["subagent_name"]] = sid
                    if a.get("child_session_id"):
                        direct_child[a["child_session_id"]] = sid

        all_sids = set(sessions.keys())
        name_to_direct: dict[str, str] = {}  # subagent_name -> direct child sid
        for csid, par in direct_child.items():
            for nm in spawn_by_name:
                if spawn_by_name[nm] == par:
                    name_to_direct.setdefault(nm, csid)

        def _resolve_child(nm: str) -> Optional[str]:
            d = name_to_direct.get(nm)
            if d and d in all_sids:
                return d
            pref = "sub_" + nm
            return next((x for x in all_sids if x == pref or x.startswith(pref)), None)

        def _parent_of(child_sid: str) -> Optional[str]:
            if child_sid in direct_child:
                return direct_child[child_sid]
            if not child_sid.startswith("sub_"):
                return None
            for nm, par in spawn_by_name.items():
                if child_sid == "sub_" + nm or child_sid.startswith("sub_" + nm):
                    return par
            return None

        out = []
        for sid, s in sessions.items():
            spawns = sorted({c for c in (_resolve_child(nm) for nm in s["spawn_names"]) if c})
            out.append(
                {
                    "session_id": s["session_id"],
                    "task_runs": sorted(s["task_runs"]),
                    "task_run_count": len(s["task_runs"]),
                    "event_count": s["event_count"],
                    "started_at": s["started_at"],
                    "last_at": s["last_at"],
                    "workdirs": sorted(s["workdirs"]),
                    "errors": s["errors"],
                    "tool_calls": s["tool_calls"],
                    "llm_calls": s["llm_calls"],
                    "agents": sorted(a for a in s["agents"] if a),
                    "spawns": spawns,
                    "parent_session": _parent_of(s["session_id"]),
                    "role": _session_role(s["session_id"]),
                }
            )
        # 真实 session 在前 (按最近活跃), _orphan 兜底沉底
        out.sort(key=lambda x: (x["session_id"] != "_orphan", x["last_at"] or ""), reverse=True)
        return out

    def _known_session_ids(self) -> set:
        return {(e.get("_sid") or "") for e in self.all_events()}

    @staticmethod
    def _match_child(name: str, sids) -> Optional[str]:
        """子 agent 真实 session id 是 sub_<name>_<suffix>, 按前缀匹配真实存在的那个。"""
        if not name:
            return None
        pref = "sub_" + name
        return next((x for x in sids if x == pref or x.startswith(pref)), None)

    def session_events(self, session_id: str) -> List[Dict[str, Any]]:
        out = [e for e in self.all_events() if (e.get("_sid") or "_orphan") == session_id]
        out.sort(key=lambda e: e.get("started_at") or "")
        return out

    def session_tree(self, session_id: str) -> List[Dict[str, Any]]:
        """返回 root spans (parent_span_id is None within this session) + 嵌套 children."""
        events = self.session_events(session_id)
        by_id: Dict[str, Dict[str, Any]] = {}
        for e in events:
            node = dict(e)
            node["children"] = []
            by_id[e["span_id"]] = node
        roots: List[Dict[str, Any]] = []
        for e in events:
            parent = e.get("parent_span_id")
            if parent and parent in by_id:
                by_id[parent]["children"].append(by_id[e["span_id"]])
            else:
                roots.append(by_id[e["span_id"]])
        return roots

    def session_usage(self, session_id: str) -> Dict[str, Any]:
        events = self.session_events(session_id)
        agg: dict[str, dict[str, int]] = defaultdict(
            lambda: {
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_tokens": 0,
                "cache_creation_tokens": 0,
                "calls": 0,
            }
        )
        for e in events:
            if not is_consumption_usage_event(e):
                continue
            usage = (e.get("attributes") or {}).get("usage") or {}
            model = (e.get("attributes") or {}).get("model") or "_unknown"
            g = agg[model]
            g["input_tokens"] += int(usage.get("input_tokens") or 0)
            g["output_tokens"] += int(usage.get("output_tokens") or 0)
            g["cache_read_tokens"] += int(usage.get("cache_read_tokens") or 0)
            g["cache_creation_tokens"] += int(usage.get("cache_creation_tokens") or 0)
            g["calls"] += 1
        return dict(agg)

    def session_visible_index(
        self, session_id: str, visible_index_id: str
    ) -> Optional[Dict[str, Any]]:
        """Resolve one persisted model-visible index with its context-item content.

        The trace event intentionally carries only the immutable visible-index
        pointer. The session context ledger owns the item text and is read here
        only when the UI explicitly expands that pointer.
        """
        ledger_dir = self._context_ledger_dir(session_id)
        if ledger_dir is None:
            return None
        matching_indexes = [
            row
            for row in self._jsonl_records(ledger_dir / CONTEXT_VISIBLE_INDEXES_FILENAME)
            if row.get("visible_index_id") == visible_index_id
        ]
        # A provider-final budget projection appends a richer version under the
        # same immutable pointer. Resolve the latest append, not the pre-prepare
        # skeleton emitted by compose.
        index = matching_indexes[-1] if matching_indexes else None
        if index is None:
            return None

        item_rows = self._jsonl_records(ledger_dir / CONTEXT_ITEMS_FILENAME)
        entries = []
        for entry in index.get("entries") or []:
            item = self._context_item_at(
                item_rows,
                str(entry.get("item_id") or ""),
                index.get("created_at"),
            )
            entries.append(
                {
                    "ordinal": entry.get("ordinal"),
                    "provider_slot": entry.get("provider_slot"),
                    "channel_id": entry.get("channel_id"),
                    "item_id": entry.get("item_id"),
                    "channel_seq": entry.get("channel_seq"),
                    "projection_index": entry.get("projection_index"),
                    "operation_id": entry.get("operation_id"),
                    "context_span_id": entry.get("context_span_id"),
                    "rendered_hash": entry.get("rendered_hash"),
                    "byte_range": entry.get("byte_range"),
                    "token_estimate": entry.get("token_estimate"),
                    "reason": entry.get("reason"),
                    "item": (
                        {
                            "channel": item.get("channel"),
                            "channel_seq": item.get("channel_seq"),
                            "status": item.get("status"),
                            "item_kind": self._context_item_kind(item),
                            "content": item.get("content"),
                            "content_hash": item.get("content_hash"),
                            "context_span_id": item.get("context_span_id"),
                        }
                        if item is not None
                        else None
                    ),
                }
            )
        return {
            "visible_index_id": index.get("visible_index_id"),
            "session_id": index.get("session_id"),
            "turn_id": index.get("turn_id"),
            "snapshot_id": index.get("snapshot_id"),
            "model_call_id": index.get("model_call_id"),
            "trace_span_id": index.get("trace_span_id"),
            "trace_ref": index.get("trace_ref"),
            "created_at": index.get("created_at"),
            "cache_epoch_id": index.get("cache_epoch_id"),
            "final_wire_hash": index.get("final_wire_hash"),
            "token_estimate": index.get("token_estimate"),
            "token_upper_bound": index.get("token_upper_bound"),
            "serialized_bytes": index.get("serialized_bytes"),
            "budget_measurement_ref": index.get("budget_measurement_ref"),
            "budget_count_source": index.get("budget_count_source"),
            "budget_estimator_version": index.get("budget_estimator_version"),
            "budget_confidence": index.get("budget_confidence"),
            "budget_counts": index.get("budget_counts") or [],
            "input_watermark": index.get("input_watermark"),
            "media_occurrences": index.get("media_occurrences") or [],
            "entries": entries,
        }

    def session_context_item(self, session_id: str, item_id: str) -> Optional[Dict[str, Any]]:
        """Resolve one item's content evolution through persisted context spans.

        Context items are append-only version records. A later replacement may
        use a new item id and point to the prior id through ``supersedes``;
        this reader follows that lineage in both directions so the UI can show
        the before/after content alongside the spans that changed or composed
        it for a model request.
        """
        ledger_dir = self._context_ledger_dir(session_id)
        if ledger_dir is None or not item_id:
            return None

        item_rows = self._jsonl_records(ledger_dir / CONTEXT_ITEMS_FILENAME)
        if not any(row.get("item_id") == item_id for row in item_rows):
            return None

        lineage_ids = self._context_lineage_ids(item_rows, item_id)
        related_rows = [row for row in item_rows if row.get("item_id") in lineage_ids]
        related_rows.sort(key=self._context_item_sort_key)
        latest_items = self._latest_context_items(related_rows)
        operations = self._related_context_operations(
            self._jsonl_records(ledger_dir / CONTEXT_OPERATIONS_FILENAME), lineage_ids
        )
        spans = self._related_context_spans(
            self._jsonl_records(ledger_dir / CONTEXT_SPANS_FILENAME),
            lineage_ids,
            item_rows,
        )
        indexes = self._jsonl_records(ledger_dir / CONTEXT_VISIBLE_INDEXES_FILENAME)
        compactions = self._context_compaction_events(session_id)
        lifecycle = self._link_context_lifecycle_turns(
            self._context_item_lifecycle(
                lineage_ids=lineage_ids,
                item_rows=item_rows,
                operations=operations,
                spans=spans,
                indexes=indexes,
                compactions=compactions,
            ),
            self._session_turns(session_id),
        )

        return {
            "item_id": item_id,
            "lineage_item_ids": sorted(lineage_ids),
            "versions": [self._context_item_view(row) for row in related_rows],
            "content_versions": self._content_versions(related_rows),
            "lifecycle": lifecycle,
            "compactions": [
                compaction
                for compaction in compactions
                if self._item_in_compaction(compaction, lineage_ids)
            ],
            "current_items": {
                current_id: self._context_item_view(row) for current_id, row in latest_items.items()
            },
        }

    def session_context_items(self, session_id: str) -> Dict[str, Any]:
        """Return one lifecycle summary per replacement family in a session."""
        ledger_dir = self._context_ledger_dir(session_id)
        if ledger_dir is None:
            return {"items": [], "totals": {"items": 0, "open": 0, "closed": 0}}

        item_rows = self._jsonl_records(ledger_dir / CONTEXT_ITEMS_FILENAME)
        operation_rows = self._jsonl_records(ledger_dir / CONTEXT_OPERATIONS_FILENAME)
        span_rows = self._jsonl_records(ledger_dir / CONTEXT_SPANS_FILENAME)
        indexes = self._jsonl_records(ledger_dir / CONTEXT_VISIBLE_INDEXES_FILENAME)
        compactions = self._context_compaction_events(session_id)
        turns = self._session_turns(session_id)
        latest_items = self._latest_context_items(item_rows)
        seen: set[str] = set()
        items = []
        for item_id, latest in sorted(
            latest_items.items(), key=lambda pair: self._context_item_sort_key(pair[1])
        ):
            if item_id in seen:
                continue
            lineage_ids = self._context_lineage_ids(item_rows, item_id)
            seen.update(lineage_ids)
            related_rows = [row for row in item_rows if row.get("item_id") in lineage_ids]
            related_rows.sort(key=self._context_item_sort_key)
            operations = self._related_context_operations(operation_rows, lineage_ids)
            spans = self._related_context_spans(span_rows, lineage_ids, item_rows)
            lifecycle = self._link_context_lifecycle_turns(
                self._context_item_lifecycle(
                    lineage_ids=lineage_ids,
                    item_rows=item_rows,
                    operations=operations,
                    spans=spans,
                    indexes=indexes,
                    compactions=compactions,
                ),
                turns,
            )
            current = self._latest_context_items(related_rows)
            final_rows = list(current.values())
            is_open = any(not row.get("lifecycle_ended_at") for row in final_rows)
            first = related_rows[0] if related_rows else latest
            terminal = next(
                (
                    event
                    for event in reversed(lifecycle)
                    if event.get("kind")
                    in (CONTEXT_EVENT_REPLACED, CONTEXT_EVENT_ENDED, CONTEXT_EVENT_COMPACTED)
                ),
                None,
            )
            if is_open:
                terminal = None
            visible_events = [
                event for event in lifecycle if event.get("kind") == CONTEXT_EVENT_VISIBLE
            ]
            items.append(
                {
                    "item_id": first.get("item_id"),
                    "lineage_item_ids": sorted(lineage_ids),
                    "channel": first.get("channel"),
                    "item_kind": self._context_item_kind(first),
                    "status": "open" if is_open else "closed",
                    "content_preview": self._context_content_preview(first.get("content")),
                    "lifecycle_started_at": first.get("lifecycle_started_at"),
                    "entered_turn_id": lifecycle[0].get("turn_id") if lifecycle else None,
                    "entered_turn_span_id": (
                        lifecycle[0].get("turn_span_id") if lifecycle else None
                    ),
                    "lifecycle_ended_at": terminal.get("at") if terminal else None,
                    "ended_turn_id": terminal.get("turn_id") if terminal else None,
                    "ended_turn_span_id": terminal.get("turn_span_id") if terminal else None,
                    "visible_count": len(visible_events),
                    "last_visible_at": visible_events[-1].get("at") if visible_events else None,
                    "terminal_kind": terminal.get("kind") if terminal else None,
                    "compaction_run_id": terminal.get("compaction_run_id") if terminal else None,
                }
            )
        items.sort(key=lambda row: str(row.get("lifecycle_started_at") or ""), reverse=True)
        open_count = sum(1 for item in items if item.get("status") == "open")
        return {
            "items": items,
            "totals": {"items": len(items), "open": open_count, "closed": len(items) - open_count},
        }

    def session_context_channels(self, session_id: str) -> Dict[str, Any]:
        """Return model-visible composition changes grouped by context channel."""
        ledger_dir = self._context_ledger_dir(session_id)
        if ledger_dir is None:
            return {"channels": []}

        item_rows = self._jsonl_records(ledger_dir / CONTEXT_ITEMS_FILENAME)
        indexes = self._jsonl_records(ledger_dir / CONTEXT_VISIBLE_INDEXES_FILENAME)
        latest_items = self._latest_context_items(item_rows)
        rows_by_channel: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        for row in latest_items.values():
            channel = str(row.get("channel") or "unknown")
            rows_by_channel[channel].append(row)

        channels = []
        for channel, rows in sorted(rows_by_channel.items()):
            events = self._context_channel_events(channel, rows, item_rows, indexes)
            channels.append(
                {
                    "channel": channel,
                    "item_count": len(rows),
                    "open_item_count": sum(1 for row in rows if not row.get("lifecycle_ended_at")),
                    "visible_calls": sum(
                        1 for event in events if event.get("kind") == CONTEXT_EVENT_VISIBLE
                    ),
                    "events": events,
                }
            )
        return {"channels": channels}

    @staticmethod
    def _context_lineage_ids(item_rows: List[Dict[str, Any]], item_id: str) -> set[str]:
        """Return a replacement family by traversing ``supersedes`` links."""
        lineage_ids = {item_id}
        changed = True
        while changed:
            changed = False
            for row in item_rows:
                row_id = str(row.get("item_id") or "")
                supersedes = {
                    str(ref) for ref in (row.get("supersedes") or []) if isinstance(ref, str)
                }
                if row_id in lineage_ids:
                    additions = supersedes - lineage_ids
                elif supersedes & lineage_ids:
                    additions = {row_id} - lineage_ids
                else:
                    additions = set()
                if additions:
                    lineage_ids.update(additions)
                    changed = True
        return lineage_ids

    @staticmethod
    def _context_item_sort_key(row: Dict[str, Any]) -> tuple[str, str, int]:
        version = row.get("version")
        return (
            str(row.get("lifecycle_started_at") or ""),
            str(row.get("item_id") or ""),
            int(version) if isinstance(version, int) else 0,
        )

    @staticmethod
    def _latest_context_items(item_rows: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
        latest: Dict[str, Dict[str, Any]] = {}
        for row in item_rows:
            row_id = str(row.get("item_id") or "")
            if row_id:
                latest[row_id] = row
        return latest

    @classmethod
    def _context_item_at(
        cls, item_rows: List[Dict[str, Any]], item_id: str, at: Any
    ) -> Optional[Dict[str, Any]]:
        versions = [row for row in item_rows if row.get("item_id") == item_id]
        versions.sort(key=cls._context_item_sort_key)
        if not versions:
            return None
        if not at:
            return versions[-1]
        historical = [
            row for row in versions if str(row.get("lifecycle_started_at") or "") <= str(at)
        ]
        if not historical:
            return versions[0]
        transitions = [
            row
            for row in historical
            if row.get("lifecycle_ended_at") and str(row.get("lifecycle_ended_at")) <= str(at)
        ]
        if transitions:
            return max(
                transitions,
                key=lambda row: (
                    str(row.get("lifecycle_ended_at") or ""),
                    cls._context_item_sort_key(row),
                ),
            )
        open_versions = [row for row in historical if not row.get("lifecycle_ended_at")]
        return open_versions[-1] if open_versions else historical[-1]

    @staticmethod
    def _context_item_view(row: Dict[str, Any]) -> Dict[str, Any]:
        fields = (
            "item_id",
            "channel",
            "channel_seq",
            "version",
            "status",
            "item_kind",
            "content",
            "content_hash",
            "source",
            "actor",
            "created_by_operation",
            "last_operation",
            "lifecycle_started_at",
            "lifecycle_ended_at",
            "ended_by_operation",
            "supersedes",
            "derived_from",
            "context_span_id",
            "trace_span_id",
            "operation_refs",
            "visible_index_refs",
        )
        view = {field: row.get(field) for field in fields}
        view["item_kind"] = TraceStore._context_item_kind(row)
        return view

    @staticmethod
    def _context_item_kind(row: Dict[str, Any]) -> str:
        metadata = row.get("metadata")
        metadata_kind = metadata.get("item_kind") if isinstance(metadata, dict) else None
        return str(row.get("item_kind") or metadata_kind or "context")

    @staticmethod
    def _context_content_preview(content: Any) -> str:
        if content is None:
            return ""
        text = " ".join(str(content).split())
        if len(text) <= CONTEXT_CONTENT_PREVIEW_CHARS:
            return text
        return text[:CONTEXT_CONTENT_PREVIEW_CHARS].rstrip() + "..."

    @classmethod
    def _context_item_lifecycle(
        cls,
        *,
        lineage_ids: set[str],
        item_rows: List[Dict[str, Any]],
        operations: List[Dict[str, Any]],
        spans: List[Dict[str, Any]],
        indexes: List[Dict[str, Any]],
        compactions: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """Project ledger evidence into user-facing item state changes.

        Ledger operations remain the durable audit record. This projection is
        deliberately state-oriented: item entry, per model-call visibility,
        and replacement/end transitions.
        """
        related_rows = [row for row in item_rows if row.get("item_id") in lineage_ids]
        related_rows.sort(key=cls._context_item_sort_key)
        first_by_item: Dict[str, Dict[str, Any]] = {}
        for row in related_rows:
            first_by_item.setdefault(str(row.get("item_id") or ""), row)
        latest_by_item = cls._latest_context_items(related_rows)
        spans_by_id = {
            str(span.get("context_span_id") or ""): span
            for span in spans
            if span.get("context_span_id")
        }
        operations_by_id = {
            str(operation.get("operation_id") or ""): operation
            for operation in operations
            if operation.get("operation_id")
        }
        successors: Dict[str, Dict[str, Any]] = {}
        for row in related_rows:
            for predecessor in row.get("supersedes") or []:
                if predecessor in lineage_ids:
                    successors[str(predecessor)] = row
        compaction_by_item: Dict[str, Dict[str, Any]] = {}
        retained_by_item: List[Dict[str, Any]] = []
        for compaction in compactions:
            for transition in compaction.get(TRACE_COMPACTION_ITEM_TRANSITIONS, []):
                item_id = str(transition.get(TRACE_COMPACTION_ITEM_ID) or "")
                if item_id in lineage_ids:
                    compaction_by_item[item_id] = {
                        **transition,
                        "compaction_run_id": compaction.get("run_id"),
                        "compaction_at": compaction.get("at"),
                        "compaction_turn_id": compaction.get("turn_id"),
                    }
            if any(
                str(item.get(TRACE_COMPACTION_ITEM_ID) or "") in lineage_ids
                for item in compaction.get(TRACE_COMPACTION_RETAINED_ITEMS, [])
            ):
                retained_by_item.append(compaction)

        events: List[Dict[str, Any]] = []
        for current_id, row in first_by_item.items():
            span = cls._context_item_origin_span(row, spans_by_id, current_id)
            events.append(
                cls._context_lifecycle_event(
                    kind=CONTEXT_EVENT_ENTERED,
                    at=row.get("lifecycle_started_at") or (span or {}).get("created_at"),
                    item=row,
                    span=span,
                )
            )

        family_start = min(
            (str(row.get("lifecycle_started_at") or "") for row in first_by_item.values()),
            default="",
        )
        family_end = ""
        if latest_by_item and all(row.get("lifecycle_ended_at") for row in latest_by_item.values()):
            family_end = max(
                str(row.get("lifecycle_ended_at") or "") for row in latest_by_item.values()
            )
        for index in sorted(indexes, key=lambda row: str(row.get("created_at") or "")):
            created_at = str(index.get("created_at") or "")
            if (
                not created_at
                or created_at < family_start
                or (family_end and created_at > family_end)
            ):
                continue
            active_ids = [
                current_id
                for current_id, row in latest_by_item.items()
                if cls._context_item_active_at(row, created_at)
            ]
            if not active_ids:
                continue
            entries = [
                entry for entry in index.get("entries") or [] if entry.get("item_id") in lineage_ids
            ]
            if entries:
                entry = entries[0]
                item = cls._context_item_at(item_rows, str(entry.get("item_id") or ""), created_at)
                events.append(
                    cls._context_lifecycle_event(
                        kind=CONTEXT_EVENT_VISIBLE,
                        at=created_at,
                        item=item or first_by_item.get(str(entry.get("item_id") or "")),
                        span={
                            "context_span_id": entry.get("context_span_id"),
                            "turn_id": index.get("turn_id"),
                            "trace_span_id": index.get("trace_span_id"),
                        },
                        visible_index_id=index.get("visible_index_id"),
                        provider_slot=entry.get("provider_slot"),
                        reason=entry.get("reason"),
                    )
                )
            else:
                events.append(
                    {
                        "kind": CONTEXT_EVENT_NOT_VISIBLE,
                        "at": created_at,
                        "turn_id": index.get("turn_id"),
                        "trace_span_id": index.get("trace_span_id"),
                    }
                )

        for compaction in retained_by_item:
            retained_item: dict[str, Any] = next(
                (
                    item
                    for item in compaction.get(TRACE_COMPACTION_RETAINED_ITEMS, [])
                    if str(item.get(TRACE_COMPACTION_ITEM_ID) or "") in lineage_ids
                ),
                {},
            )
            events.append(
                {
                    "kind": CONTEXT_EVENT_RETAINED,
                    "at": compaction.get("at"),
                    "turn_id": retained_item.get(TRACE_COMPACTION_RETAINED_TURN_ID)
                    or compaction.get("turn_id"),
                    "compaction_run_id": compaction.get("run_id"),
                    "trace_span_id": compaction.get("trace_span_id"),
                    "context_span_id": compaction.get("context_span_id"),
                    "trace_ref": compaction.get("trace_ref"),
                }
            )

        for current_id, row in latest_by_item.items():
            ended_at = row.get("lifecycle_ended_at")
            if not ended_at:
                continue
            operation = operations_by_id.get(str(row.get("ended_by_operation") or ""))
            span = spans_by_id.get(str((operation or {}).get("context_span_id") or ""))
            successor = successors.get(current_id)
            item_compaction = compaction_by_item.get(current_id)
            if item_compaction is not None:
                span = {
                    "context_span_id": item_compaction.get(
                        TRACE_COMPACTION_REMOVAL_CONTEXT_SPAN_ID
                    ),
                    "trace_span_id": item_compaction.get(TRACE_COMPACTION_REMOVAL_TRACE_SPAN_ID),
                    "trace_ref": item_compaction.get(TRACE_COMPACTION_REMOVAL_TRACE_REF),
                    "turn_id": (
                        item_compaction.get(TRACE_COMPACTION_REMOVAL_TURN_ID)
                        or item_compaction.get("compaction_turn_id")
                        or (operation or {}).get("turn_id")
                    ),
                }
            events.append(
                cls._context_lifecycle_event(
                    kind=(
                        CONTEXT_EVENT_COMPACTED
                        if item_compaction is not None
                        else (CONTEXT_EVENT_REPLACED if successor else CONTEXT_EVENT_ENDED)
                    ),
                    at=(item_compaction or {}).get(TRACE_COMPACTION_REMOVED_AT) or ended_at,
                    item=row,
                    span=span,
                    successor_item_id=successor.get("item_id") if successor else None,
                    compaction_run_id=(item_compaction or {}).get("compaction_run_id"),
                    checkpoint_item_ids=(item_compaction or {}).get(
                        TRACE_COMPACTION_CHECKPOINT_ITEM_IDS
                    ),
                    operation_id=(item_compaction or {}).get(TRACE_COMPACTION_OPERATION_ID),
                )
            )
        priority = {
            CONTEXT_EVENT_ENTERED: 0,
            CONTEXT_EVENT_VISIBLE: 1,
            CONTEXT_EVENT_NOT_VISIBLE: 2,
            CONTEXT_EVENT_RETAINED: 3,
            CONTEXT_EVENT_REPLACED: 4,
            CONTEXT_EVENT_COMPACTED: 5,
            CONTEXT_EVENT_ENDED: 6,
        }
        events.sort(key=lambda event: (str(event.get("at") or ""), priority.get(event["kind"], 9)))
        return events

    def _session_turns(self, session_id: str) -> List[Dict[str, Any]]:
        """Index real turn spans and model calls for context-lifecycle navigation.

        A runtime can emit multiple ``turn.start`` spans inside one task run.
        Older traces do not, so their task root is the only truthful turn
        boundary.  Keeping that fallback here makes context evidence linkable
        across both trace generations without inventing a turn span.
        """
        by_run: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        for event in self.session_events(session_id):
            run_id = str(event.get("task_run_id") or "")
            if run_id:
                by_run[run_id].append(event)

        turns: List[Dict[str, Any]] = []
        for run_id, events in by_run.items():
            events.sort(key=lambda event: str(event.get("started_at") or ""))
            root = next(
                (
                    event
                    for event in events
                    if event.get("kind") == TRACE_EVENT_TASK_START
                    and not event.get("parent_span_id")
                ),
                next(
                    (event for event in events if event.get("kind") == TRACE_EVENT_TASK_START), None
                ),
            )
            if root is None or not root.get("span_id"):
                continue
            root_started_at = str(root.get("started_at") or "")
            root_ended_at = str(root.get("ended_at") or "")
            explicit_turns = [
                event
                for event in events
                if event.get("kind") == TRACE_EVENT_TURN_START and event.get("span_id")
            ]
            turn_events = explicit_turns or [root]
            for index, turn_event in enumerate(turn_events):
                started_at = str(turn_event.get("started_at") or root_started_at)
                next_started_at = (
                    str(turn_events[index + 1].get("started_at") or "")
                    if index + 1 < len(turn_events)
                    else ""
                )
                ended_at = str(turn_event.get("ended_at") or "")
                boundaries = [
                    boundary for boundary in (ended_at, next_started_at, root_ended_at) if boundary
                ]
                effective_end = min(boundaries) if boundaries else ""
                calls = [
                    str(event.get("span_id"))
                    for event in events
                    if event.get("kind") in TRACE_EVENT_MODEL_CALLS
                    and event.get("span_id")
                    and str(event.get("started_at") or "") >= started_at
                    and (not effective_end or str(event.get("started_at") or "") <= effective_end)
                ]
                turns.append(
                    {
                        "turn_id": run_id,
                        "turn_span_id": str(turn_event.get("span_id")),
                        "root_span_id": str(root.get("span_id")),
                        "started_at": started_at,
                        "ended_at": effective_end,
                        "call_span_ids": calls,
                    }
                )

        turns.sort(key=lambda turn: str(turn.get("started_at") or ""))
        for index, turn in enumerate(turns):
            turn["turn_index"] = index + 1
            turn["previous_turn_span_id"] = turns[index - 1].get("turn_span_id") if index else None
            turn["next_turn_span_id"] = (
                turns[index + 1].get("turn_span_id") if index + 1 < len(turns) else None
            )
        return turns

    @staticmethod
    def _turn_for_context_event(
        turns: List[Dict[str, Any]], event: Dict[str, Any]
    ) -> Optional[Dict[str, Any]]:
        turn_id = str(event.get("turn_id") or "")
        at = str(event.get("at") or "")
        candidates = [turn for turn in turns if turn.get("turn_id") == turn_id] if turn_id else []
        if not candidates and at:
            candidates = [
                turn
                for turn in turns
                if str(turn.get("started_at") or "") <= at
                and (not turn.get("ended_at") or at <= str(turn.get("ended_at") or ""))
            ]
        if not candidates:
            return None
        if at:
            covered = [
                turn
                for turn in candidates
                if str(turn.get("started_at") or "") <= at
                and (not turn.get("ended_at") or at <= str(turn.get("ended_at") or ""))
            ]
            if covered:
                return covered[-1]
        return candidates[-1]

    def _link_context_lifecycle_turns(
        self, lifecycle: List[Dict[str, Any]], turns: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """Attach the concrete TraceKit turn span and neighboring query links."""
        for event in lifecycle:
            turn = self._turn_for_context_event(turns, event)
            if turn is None:
                continue
            event.update(
                {
                    "turn_id": event.get("turn_id") or turn.get("turn_id"),
                    "turn_span_id": turn.get("turn_span_id"),
                    "turn_root_span_id": turn.get("root_span_id"),
                    "turn_index": turn.get("turn_index"),
                    "previous_turn_span_id": turn.get("previous_turn_span_id"),
                    "next_turn_span_id": turn.get("next_turn_span_id"),
                    "call_span_ids": list(turn.get("call_span_ids") or []),
                }
            )
        return lifecycle

    @staticmethod
    def _context_item_active_at(row: Dict[str, Any], at: str) -> bool:
        started_at = str(row.get("lifecycle_started_at") or "")
        ended_at = str(row.get("lifecycle_ended_at") or "")
        return bool(started_at and started_at <= at and (not ended_at or ended_at >= at))

    @staticmethod
    def _context_item_origin_span(
        item: Dict[str, Any], spans_by_id: Dict[str, Dict[str, Any]], item_id: str
    ) -> Optional[Dict[str, Any]]:
        context_span_id = str(item.get("context_span_id") or "")
        if context_span_id in spans_by_id:
            return spans_by_id[context_span_id]
        for span in spans_by_id.values():
            if any(row.get("item_id") == item_id for row in span.get("output_items") or []):
                return span
        return None

    @classmethod
    def _context_lifecycle_event(
        cls,
        *,
        kind: str,
        at: Any,
        item: Optional[Dict[str, Any]],
        span: Optional[Dict[str, Any]],
        visible_index_id: Any = None,
        provider_slot: Any = None,
        reason: Any = None,
        successor_item_id: Any = None,
        compaction_run_id: Any = None,
        checkpoint_item_ids: Any = None,
        operation_id: Any = None,
    ) -> Dict[str, Any]:
        event = {
            "kind": kind,
            "at": at,
            "turn_id": (span or {}).get("turn_id"),
            "trace_span_id": (span or {}).get("trace_span_id"),
            "context_span_id": (span or {}).get("context_span_id"),
            "visible_index_id": visible_index_id,
            "provider_slot": provider_slot,
            "reason": reason,
            "successor_item_id": successor_item_id,
            "compaction_run_id": compaction_run_id,
            "checkpoint_item_ids": list(checkpoint_item_ids or []),
            "operation_id": operation_id,
        }
        if item is not None:
            event.update(
                {
                    "item_id": item.get("item_id"),
                    "channel": item.get("channel"),
                    "item_kind": cls._context_item_kind(item),
                    "content": item.get("content"),
                    "content_preview": cls._context_content_preview(item.get("content")),
                }
            )
        return event

    @staticmethod
    def _item_in_compaction(compaction: Dict[str, Any], lineage_ids: set[str]) -> bool:
        transitions = compaction.get(TRACE_COMPACTION_ITEM_TRANSITIONS, [])
        retained = compaction.get(TRACE_COMPACTION_RETAINED_ITEMS, [])
        return any(
            str(item.get(TRACE_COMPACTION_ITEM_ID) or "") in lineage_ids
            for item in [*transitions, *retained]
            if isinstance(item, dict)
        )

    def _context_compaction_events(self, session_id: str) -> List[Dict[str, Any]]:
        """Read item-level compaction links from durable ``context.compaction`` events.

        The context ledger remains the source for content, but the trace event
        is the cross-surface lifecycle link: it identifies exactly which item
        was removed, the removal span, and the checkpoint item(s) that replaced
        its model-visible projection.
        """
        return self.project_compaction_events(self.session_events(session_id))

    @staticmethod
    def project_compaction_events(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Project caller-owned events using the normal context query decoder."""
        compactions = []
        for event in events:
            if (
                event.get("kind") != TRACE_CONTEXT_KIND
                or event.get("name") != TRACE_CONTEXT_COMPACTION_NAME
            ):
                continue
            attrs = event.get("attributes") or {}
            transitions = attrs.get(TRACE_COMPACTION_ITEM_TRANSITIONS)
            if not isinstance(transitions, list):
                continue
            compactions.append(
                {
                    "run_id": attrs.get("run_id"),
                    "at": event.get("started_at"),
                    "turn_id": event.get("task_run_id"),
                    "span_id": event.get("span_id"),
                    "context_span_id": attrs.get("context_span_id"),
                    "trace_span_id": attrs.get("trace_span_id"),
                    "trace_ref": attrs.get("trace_ref"),
                    TRACE_COMPACTION_ITEM_TRANSITIONS: [
                        transition for transition in transitions if isinstance(transition, dict)
                    ],
                    TRACE_COMPACTION_RETAINED_ITEMS: [
                        item
                        for item in attrs.get(TRACE_COMPACTION_RETAINED_ITEMS, [])
                        if isinstance(item, dict)
                    ],
                }
            )
        compactions.sort(key=lambda row: str(row.get("at") or ""))
        return compactions

    def _context_channel_events(
        self,
        channel: str,
        latest_rows: List[Dict[str, Any]],
        item_rows: List[Dict[str, Any]],
        indexes: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        first_by_item: Dict[str, Dict[str, Any]] = {}
        for row in sorted(item_rows, key=self._context_item_sort_key):
            if row.get("channel") == channel:
                first_by_item.setdefault(str(row.get("item_id") or ""), row)
        channel_latest_rows = self._latest_context_items(
            [row for row in item_rows if row.get("channel") == channel]
        )
        events = self._context_channel_item_events(
            CONTEXT_EVENT_ENTERED,
            (
                (row.get("lifecycle_started_at"), item_id, row)
                for item_id, row in first_by_item.items()
            ),
        )
        events.extend(
            self._context_channel_item_events(
                CONTEXT_EVENT_ENDED,
                (
                    (row.get("lifecycle_ended_at"), str(row.get("item_id") or ""), row)
                    for row in latest_rows
                    if row.get("lifecycle_ended_at")
                ),
            )
        )

        last_signature: Optional[tuple[str, ...]] = None
        for index in sorted(indexes, key=lambda row: str(row.get("created_at") or "")):
            at = str(index.get("created_at") or "")
            active_ids = sorted(
                item_id
                for item_id, row in channel_latest_rows.items()
                if self._context_item_active_at(row, at)
            )
            if not active_ids:
                continue
            visible_entries = [
                entry for entry in index.get("entries") or [] if entry.get("channel_id") == channel
            ]
            visible_ids = tuple(
                sorted(str(entry.get("item_id") or "") for entry in visible_entries)
            )
            if visible_ids == last_signature:
                continue
            last_signature = visible_ids
            item_kinds = set()
            for item_id in visible_ids:
                item = self._context_item_at(item_rows, item_id, at)
                if item is not None:
                    item_kinds.add(self._context_item_kind(item))
            events.append(
                {
                    "kind": CONTEXT_EVENT_VISIBLE if visible_ids else CONTEXT_EVENT_NOT_VISIBLE,
                    "at": at,
                    "turn_id": index.get("turn_id"),
                    "visible_index_id": index.get("visible_index_id"),
                    "item_ids": list(visible_ids),
                    "item_count": len(visible_ids),
                    "item_kinds": sorted(item_kinds),
                    "provider_slots": sorted(
                        {str(entry.get("provider_slot") or "") for entry in visible_entries}
                    ),
                }
            )
        events.sort(key=lambda event: str(event.get("at") or ""))
        return events

    def _context_channel_item_events(
        self,
        kind: str,
        rows: Iterable[tuple[Any, str, Dict[str, Any]]],
    ) -> List[Dict[str, Any]]:
        """Group simultaneous item changes into one channel state transition."""
        groups: Dict[str, List[tuple[str, Dict[str, Any]]]] = defaultdict(list)
        for at, item_id, row in rows:
            if at:
                groups[self._context_event_batch_key(str(at))].append((str(item_id), row))
        events = []
        for at, group in groups.items():
            item_ids = [item_id for item_id, _row in group]
            item_kinds = sorted({self._context_item_kind(row) for _item_id, row in group})
            event: Dict[str, Any] = {
                "kind": kind,
                "at": at,
                "item_ids": item_ids,
                "item_count": len(item_ids),
                "item_kinds": item_kinds,
            }
            if len(group) == 1:
                event["content_preview"] = self._context_content_preview(group[0][1].get("content"))
            events.append(event)
        return events

    @staticmethod
    def _context_event_batch_key(at: str) -> str:
        """Collapse a write burst into the state transition users experience."""
        return at[:CONTEXT_EVENT_BATCH_TIMESTAMP_LENGTH]

    @classmethod
    def _content_versions(cls, item_rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Keep one record for each actual content value, not status-only transitions."""
        changes = []
        seen = set()
        for row in item_rows:
            content_key = row.get("content_hash") or row.get("content")
            if content_key in seen:
                continue
            seen.add(content_key)
            changes.append(cls._context_item_view(row))
        return changes

    @classmethod
    def _related_context_operations(
        cls, operations: List[Dict[str, Any]], lineage_ids: set[str]
    ) -> List[Dict[str, Any]]:
        related = []
        for operation in operations:
            refs = cls._context_refs(operation, "input_item_refs", "output_item_refs")
            if not refs & lineage_ids:
                continue
            fields = (
                "operation_id",
                "kind",
                "channel",
                "actor",
                "source",
                "input_item_refs",
                "output_item_refs",
                "reason",
                "context_span_id",
                "source_context_span_id",
                "target_context_span_id",
                "trace_span_id",
                "before_status",
                "after_status",
                "before_version",
                "after_version",
                "created_at",
                "applied_at",
            )
            related.append({field: operation.get(field) for field in fields})
        related.sort(key=lambda row: str(row.get("created_at") or ""))
        return related

    @classmethod
    def _related_context_spans(
        cls,
        spans: List[Dict[str, Any]],
        lineage_ids: set[str],
        item_rows: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        related = []
        for span in spans:
            input_refs = cls._context_refs(span, "input_item_refs")
            output_refs = cls._context_refs(span, "output_item_refs")
            used_refs = cls._context_refs(span, "used_item_refs")
            excluded_refs = cls._context_refs(span, "excluded_item_refs")
            if not (input_refs | output_refs | used_refs | excluded_refs) & lineage_ids:
                continue
            related.append(
                {
                    "context_span_id": span.get("context_span_id"),
                    "kind": span.get("kind"),
                    "owner": span.get("owner"),
                    "operation": span.get("operation"),
                    "created_at": span.get("created_at"),
                    "turn_id": span.get("turn_id"),
                    "trace_span_id": span.get("trace_span_id"),
                    "parent_context_span_id": span.get("parent_context_span_id"),
                    "input_items": cls._span_item_views(
                        input_refs & lineage_ids, item_rows, span.get("created_at"), "input"
                    ),
                    "output_items": cls._span_item_views(
                        output_refs & lineage_ids, item_rows, span.get("created_at"), "output"
                    ),
                    "used_items": cls._span_item_views(
                        used_refs & lineage_ids, item_rows, span.get("created_at"), "used"
                    ),
                    "excluded_items": cls._span_item_views(
                        excluded_refs & lineage_ids, item_rows, span.get("created_at"), "excluded"
                    ),
                }
            )
        related.sort(key=lambda row: str(row.get("created_at") or ""))
        return related

    @staticmethod
    def _context_refs(row: Dict[str, Any], *keys: str) -> set[str]:
        return {
            str(ref) for key in keys for ref in (row.get(key) or []) if isinstance(ref, str) and ref
        }

    @classmethod
    def _span_item_views(
        cls, item_ids: set[str], item_rows: List[Dict[str, Any]], at: Any, role: str
    ) -> List[Dict[str, Any]]:
        views = []
        for current_id in sorted(item_ids):
            chosen = cls._context_item_at(item_rows, current_id, at)
            if chosen is not None:
                views.append({"role": role, **cls._context_item_view(chosen)})
            else:
                views.append({"role": role, "item_id": current_id, "content": None})
        return views

    @staticmethod
    def _context_item_appearances(
        indexes: List[Dict[str, Any]], lineage_ids: set[str]
    ) -> List[Dict[str, Any]]:
        appearances = []
        for index in indexes:
            for entry in index.get("entries") or []:
                if entry.get("item_id") not in lineage_ids:
                    continue
                appearances.append(
                    {
                        "visible_index_id": index.get("visible_index_id"),
                        "created_at": index.get("created_at"),
                        "trace_span_id": index.get("trace_span_id"),
                        "item_id": entry.get("item_id"),
                        "ordinal": entry.get("ordinal"),
                        "channel_id": entry.get("channel_id"),
                        "context_span_id": entry.get("context_span_id"),
                    }
                )
        appearances.sort(key=lambda row: str(row.get("created_at") or ""))
        return appearances

    @classmethod
    def inspect_context_records(
        cls,
        records: dict[str, List[Dict[str, Any]]],
        *,
        compactions: List[Dict[str, Any]] | None = None,
    ) -> None:
        """Run actual ledger projections on caller-owned rows without filesystem IO.

        Compactions, when supplied, come from project_compaction_events under
        the caller's same stable snapshot. Provider write formats remain separate.
        """
        if set(records) != set(CONTEXT_LEDGER_FILES):
            raise ValueError("context inspection requires all ledger file kinds")
        items = records[CONTEXT_ITEMS_FILENAME]
        operations = records[CONTEXT_OPERATIONS_FILENAME]
        spans = records[CONTEXT_SPANS_FILENAME]
        indexes = records[CONTEXT_VISIBLE_INDEXES_FILENAME]
        for rows in records.values():
            if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                raise ValueError("invalid context ledger records")
        for item in items:
            cls._context_item_sort_key(item)
            cls._context_item_view(item)
        lineage = set(cls._latest_context_items(items))
        cls._content_versions(items)
        cls._related_context_operations(operations, lineage)
        cls._related_context_spans(spans, lineage, items)
        cls._context_item_appearances(indexes, lineage)
        cls._context_item_lifecycle(
            lineage_ids=lineage,
            item_rows=items,
            operations=operations,
            spans=spans,
            indexes=indexes,
            compactions=compactions or [],
        )

    @staticmethod
    def _jsonl_records(path: Path) -> List[Dict[str, Any]]:
        try:
            with path.open("r", encoding="utf-8") as handle:
                rows = []
                for line in handle:
                    row = decode_object_line(line)
                    if row is not None:
                        validate_content_version(row)
                        rows.append(row)
                return rows
        except FileNotFoundError:
            return []

    def _context_ledger_dir(self, session_id: str) -> Optional[Path]:
        """Find a session's read-only context ledger without creating paths."""
        if not session_id or Path(session_id).name != session_id:
            return None
        if self.offline or self.paths.ledger_root is None:
            return None
        try:
            projects = sorted(path for path in self.paths.ledger_root.iterdir() if path.is_dir())
        except FileNotFoundError:
            return None
        for project in projects:
            for parent in (project, project / CONTEXT_SUBAGENTS_DIRNAME):
                ledger_dir = parent / session_id / CONTEXT_LEDGER_DIRNAME
                if ledger_dir.is_dir():
                    return ledger_dir
        return None

    # ─── trace / span 模型 (给 TraceSystem UI 用) ───
    def session_traces(
        self, session_id: str, *, include_children: bool = True, _visited: Optional[set] = None
    ) -> List[Dict[str, Any]]:
        """把一个 session 的 events 按 task_run_id 分组成 "trace"，
        每个 trace 含转换后的 span 列表 (相对 start / dur / type / status / tokens / cost)。

        - 一个 task_run = 一次完整调用 (设计里的 "trace")。
        - root = task.start (parent_span_id is None)；没有 task.start 时合成一个虚拟 root。
        - running 判定: 有 task.start 但没有 run.outcome (jsonl 还在写)。
        - include_children: 父子关系并入顶层视图 —— 把子 agent session (sub_*) 的 spans
          按真实时间对齐后嫁接到父 trace 的 subagent.start 节点下 (递归, _visited 防环)。
          peer/team 模式 (无从属) 不受影响, 各 session 仍是独立页面。
        """
        events = self.session_events(session_id)
        by_run: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        no_run: List[Dict[str, Any]] = []
        for e in events:
            trid = e.get("task_run_id")
            if trid:
                by_run[trid].append(e)
            else:
                no_run.append(e)
        # task_run-less 事件 (后台 memory / bootstrap 等) 没有天然边界, 按 30s 时间间隔切成
        # 多个伪 trace, 否则会被聚成一条横跨数天的假 trace。
        if no_run:
            no_run.sort(key=lambda e: _parse_ts(e.get("started_at")) or 0)
            chunk: List[Dict[str, Any]] = []
            prev: Optional[float] = None
            idx = 0
            for e in no_run:
                ts = _parse_ts(e.get("started_at")) or 0
                if prev is not None and ts - prev > 30:
                    by_run[f"_bg{idx}"] = chunk
                    idx += 1
                    chunk = []
                chunk.append(e)
                prev = ts
            if chunk:
                by_run[f"_bg{idx}"] = chunk

        # 关联日志: 一次性加载本 session 的 app 日志，按时间窗落到各 span。
        sess_logs = [
            l
            for l in self.app_logs()
            if l.get("session_id") == session_id or l.get("_sid") == session_id
        ]
        known_sids = self._known_session_ids()

        traces: List[Dict[str, Any]] = []
        for run_id, evs in by_run.items():
            starts = [t for t in (_parse_ts(e.get("started_at")) for e in evs) if t is not None]
            if not starts:
                continue
            t0 = min(starts)
            # trace 终点 = max(ended_at or started_at)
            t_end = t0
            for e in evs:
                en = _parse_ts(e.get("ended_at")) or _parse_ts(e.get("started_at"))
                if en and en > t_end:
                    t_end = en
            root_ev = next((e for e in evs if e.get("kind") == "task.start"), None)
            has_outcome = any(e.get("kind") == "run.outcome" for e in evs)
            total_dur = int((t_end - t0) * 1000)
            if root_ev and root_ev.get("duration_ms"):
                total_dur = max(total_dur, int(root_ev["duration_ms"]))

            spans: List[Dict[str, Any]] = []
            tok_in = tok_out = 0
            cost_sum = 0.0
            had_error = False
            for e in evs:
                st = _parse_ts(e.get("started_at"))
                if st is None:
                    continue
                attrs = e.get("attributes") or {}
                usage = attrs.get("usage") or attrs.get("total_usage")
                model = attrs.get("model")
                cost = _estimate_cost(model, usage)
                kind = e.get("kind") or ""
                status = e.get("status") or "ok"
                if status not in ("ok", None):
                    had_error = True
                if usage and kind in ("llm.stream", "agent.response", "side.query"):
                    tok_in += int(usage.get("input_tokens") or 0)
                    tok_out += int(usage.get("output_tokens") or 0)
                    if cost:
                        cost_sum += cost
                dur = e.get("duration_ms")
                if dur is None:
                    en = _parse_ts(e.get("ended_at"))
                    dur = int((en - st) * 1000) if en else 0
                span_start = e.get("started_at")
                span_end = _parse_ts(e.get("ended_at")) or (st + (dur or 0) / 1000.0)
                # 关联日志: ts 落在 [start, end] 且同 task_run (或同 session) 的 app 日志。
                ev_logs = []
                for lg in sess_logs:
                    lts = _parse_ts(lg.get("ts"))
                    if lts is None or lts < st - 0.05 or lts > span_end + 0.05:
                        continue
                    if (
                        lg.get("task_run_id")
                        and run_id != "_no_run"
                        and lg.get("task_run_id") != run_id
                    ):
                        continue
                    ev_logs.append(
                        {
                            "t": int((lts - t0) * 1000),
                            "level": lg.get("level") or "info",
                            "msg": f"[{lg.get('logger','')}] {lg.get('event','')}",
                        }
                    )
                    if len(ev_logs) >= 50:
                        break
                err = e.get("error")
                if err:
                    en = _parse_ts(e.get("ended_at")) or st
                    ev_logs.append(
                        {
                            "t": int((en - t0) * 1000),
                            "level": "error",
                            "msg": f"{(err.get('error_class') or 'error')}: {err.get('message') or err.get('code') or ''}",
                        }
                    )
                # subagent.start: 关联到子 agent 的独立 session，让 UI 能一键跳过去。
                # 优先 attrs.child_session_id (resident memory worker 直接带);
                # 否则按 sub_<name> 前缀匹配 (fan-out subagent 的子 session 带 suffix)。
                sub_name = attrs.get("subagent_name") if kind.startswith("subagent") else None
                child_sid = None
                if sub_name:
                    direct = attrs.get("child_session_id")
                    child_sid = (
                        direct
                        if direct and direct in known_sids
                        else self._match_child(sub_name, known_sids)
                    )
                spans.append(
                    {
                        "id": e.get("span_id"),
                        "parentId": e.get("parent_span_id"),
                        "type": _span_type(kind),
                        "kind": kind,
                        "name": e.get("name") or kind,
                        "start": max(0, int((st - t0) * 1000)),
                        "dur": int(dur or 0),
                        "status": status,
                        "model": model,
                        "component": e.get("component_id"),
                        "tokensIn": (usage or {}).get("input_tokens") if usage else None,
                        "tokensOut": (usage or {}).get("output_tokens") if usage else None,
                        "cost": cost,
                        "startedAt": span_start,
                        "endedAt": e.get("ended_at"),
                        "eventId": e.get("id"),
                        "taskRunId": e.get("task_run_id"),
                        "sessionId": e.get("session_id"),
                        "artifactPaths": e.get("artifact_paths") or [],
                        "policyDecisionId": e.get("policy_decision_id"),
                        "hilSessionId": e.get("hil_session_id"),
                        "subagentName": sub_name,
                        "subagentType": (
                            attrs.get("subagent_type") if kind.startswith("subagent") else None
                        ),
                        "childSessionId": child_sid,
                        "input": e.get("inputs"),
                        "output": e.get("outputs"),
                        "attrs": attrs,
                        "error": err,
                        "noise": kind in _NOISE_KINDS,
                        "events": sorted(ev_logs, key=lambda x: x["t"]),
                    }
                )
            spans.sort(key=lambda s: (s["start"], s["id"] or ""))

            # ── Turn 分组: turn.start 是一级分组节点 (root → Turn k → llm/dispatch/…)。
            # tracer 把 llm.stream 挂在 turn 下, 但 tool.dispatch/hil 挂在 root 上,
            # 这里按时间窗把 root 级 (或父链悬空的) span 收编进所属 turn, 消除平铺。
            turn_spans = [s for s in spans if s["kind"] == "turn.start"]
            if turn_spans:
                turn_spans.sort(key=lambda s: s["start"])
                root_id = root_ev.get("span_id") if root_ev else None
                sid_set = {s["id"] for s in spans}
                bookend = {
                    "task.start",
                    "turn.start",
                    "user.message",
                    "agent.response",
                    "run.outcome",
                }
                for i, tsp in enumerate(turn_spans):
                    tsp["name"] = f"Turn {i + 1}"
                    tsp["turnIndex"] = i + 1
                first_turn_start = turn_spans[0]["start"]
                for s in spans:
                    # kind=memory 的后台事件不收编进 turn —— 主线整形阶段统一折叠成
                    # 一个 "memory · 后台" 组节点 (避免每个 turn 里散一堆 memory event)。
                    if (
                        s["kind"] in bookend
                        or s["kind"] == "memory"
                        or s["start"] < first_turn_start
                    ):
                        continue
                    pid = s.get("parentId")
                    root_level = (not pid) or pid == root_id or pid not in sid_set
                    if not root_level:
                        continue
                    tgt = None
                    for tsp in turn_spans:
                        if tsp["start"] <= s["start"]:
                            tgt = tsp
                        else:
                            break
                    if tgt is not None and tgt["id"] != s["id"]:
                        s["parentId"] = tgt["id"]
                # turn 时长扩展到覆盖收编进来的 children (dispatch 在 llm 之后)
                for tsp in turn_spans:
                    kid_end = [
                        k["start"] + (k["dur"] or 0)
                        for k in spans
                        if k.get("parentId") == tsp["id"]
                    ]
                    if kid_end:
                        tsp["dur"] = max(tsp["dur"] or 0, max(kid_end) - tsp["start"])

            # tokens / cost: 优先 root 的 total_usage
            if root_ev:
                tu = (root_ev.get("attributes") or {}).get("total_usage")
                if tu:
                    tok_in = int(tu.get("input_tokens") or tok_in)
                    tok_out = int(tu.get("output_tokens") or tok_out)
                    rc = _estimate_cost(next((s["model"] for s in spans if s["model"]), None), tu)
                    if rc:
                        cost_sum = rc
            status = (
                "error" if had_error else ("running" if (root_ev and not has_outcome) else "ok")
            )
            # agent 身份: 取 root (task.start) 的 component_id; 缺则用首个带 component 的 span
            ident_comp = (root_ev or {}).get("component_id") or next(
                (
                    s["component"]
                    for s in spans
                    if s.get("component") and s["component"].startswith("agent:")
                ),
                None,
            )
            ident = _agent_identity(ident_comp)
            # 这条 trace 派生出的子 agent (subagent.start span) → 直接挂在 trace 上, 卡片可一眼看到 + 跳转
            children = [
                {
                    "name": s["subagentName"],
                    "type": s["subagentType"],
                    "session": s["childSessionId"],
                }
                for s in spans
                if s.get("subagentName")
            ]
            traces.append(
                {
                    "id": "trc_" + (run_id if run_id.startswith("_bg") else run_id[:8]),
                    "runId": run_id,
                    "sessionId": session_id,
                    "t0": t0,
                    "name": (root_ev or {}).get("name") or (spans[0]["name"] if spans else "trace"),
                    "status": status,
                    "agent": ident["agent"],
                    "agentId": ident["agentId"],
                    "agentRole": ident["role"],
                    "children": children,
                    "startedAt": (root_ev or {}).get("started_at")
                    or (spans[0]["startedAt"] if spans else None),
                    "duration": max(total_dur, 1),
                    "tokensIn": tok_in,
                    "tokensOut": tok_out,
                    "cost": round(cost_sum, 6) if cost_sum else None,
                    "spanCount": len(spans),
                    "spans": spans,
                }
            )

        # ── 主线整形: 一个 session 读成一条从头到尾的主线 ──
        # 1) _bg 碎片 (assemble / memory 后台等 task_run-less 事件) 并入时间上所属的真实 trace;
        # 2) bootstrap → "assemble · startup" (dur 取 attrs.total_ms, steps 在详情);
        # 3) root 级 memory 后台事件折叠成一个 "memory · N 条后台事件" 组节点 (默认收起);
        # 4) trace 标题改用用户输入预览 ("❯ ..."), 比 agent.run 可读。
        real_traces = [t for t in traces if not t["runId"].startswith("_bg")]
        bg_traces = [t for t in traces if t["runId"].startswith("_bg")]
        if real_traces:
            real_traces.sort(key=lambda t: t["t0"])
            for bg in bg_traces:
                tgt = None
                for rt_ in real_traces:
                    if rt_["t0"] <= bg["t0"]:
                        tgt = rt_
                    else:
                        break
                tgt = tgt or real_traces[0]
                delta = int((bg["t0"] - tgt["t0"]) * 1000)
                rid = next((s["id"] for s in tgt["spans"] if s["type"] == "root"), None)
                for s in bg["spans"]:
                    s2 = dict(s)
                    s2["start"] = max(0, s["start"] + delta)
                    s2["parentId"] = rid
                    tgt["spans"].append(s2)
                end = max(
                    (s["start"] + (s["dur"] or 0) for s in tgt["spans"]), default=tgt["duration"]
                )
                tgt["duration"] = max(tgt["duration"], end, 1)
            traces = real_traces
            for t in traces:
                rid = next((s["id"] for s in t["spans"] if s["type"] == "root"), None)
                idset = {s["id"] for s in t["spans"]}
                for s in t["spans"]:
                    if s["kind"] == "bootstrap":
                        total = (s.get("attrs") or {}).get("total_ms")
                        s["name"] = "assemble · startup"
                        if total:
                            s["dur"] = int(total)
                        s["noise"] = False
                # root 级 (或父链悬空) 的 memory 后台事件 → 一个折叠组
                mem = [
                    s
                    for s in t["spans"]
                    if s["kind"] == "memory"
                    and (s.get("parentId") == rid or s.get("parentId") not in idset)
                ]
                if len(mem) >= 2:
                    m0 = min(s["start"] for s in mem)
                    m1 = max(s["start"] + (s["dur"] or 0) for s in mem)
                    gid = t["id"] + "_membg"
                    t["spans"].append(
                        {
                            "id": gid,
                            "parentId": rid,
                            "type": "retrieval",
                            "kind": "memory.group",
                            "name": f"memory · {len(mem)} 条后台事件",
                            "start": m0,
                            "dur": max(m1 - m0, 1),
                            "status": "ok",
                            "noise": False,
                            "memGroup": True,
                            "model": None,
                            "tokensIn": None,
                            "tokensOut": None,
                            "cost": None,
                            "startedAt": None,
                            "attrs": {"count": len(mem)},
                            "input": None,
                            "output": None,
                            "error": None,
                            "events": [],
                        }
                    )
                    for s in mem:
                        s["parentId"] = gid
                # 标题: 用户输入预览
                um = next((s for s in t["spans"] if s["kind"] == "user.message"), None)
                if um:
                    inp = um.get("input") or {}
                    att = um.get("attrs") or {}
                    txt = (
                        inp.get("content")
                        or inp.get("text")
                        or inp.get("user_input")
                        or att.get("text")
                        or att.get("content")
                        or ""
                    )
                    if isinstance(txt, str) and txt.strip():
                        preview = " ".join(txt.split())
                        t["name"] = "❯ " + (preview[:60] + ("…" if len(preview) > 60 else ""))
                t["spans"].sort(key=lambda s: (s["start"], s["id"] or ""))
                t["spanCount"] = len(t["spans"])

        # ── 父子并入: 把子 agent session 的 trace spans 嫁接到 subagent.start 节点下 ──
        if include_children:
            visited = _visited if _visited is not None else set()
            visited.add(session_id)
            for t in traces:
                anchors = [
                    s
                    for s in t["spans"]
                    if s.get("kind") == "subagent.start" and s.get("childSessionId")
                ]
                for anchor in anchors:
                    child_sid = anchor["childSessionId"]
                    if child_sid in visited:
                        continue
                    visited.add(child_sid)
                    child_traces = self.session_traces(child_sid, _visited=visited)
                    pt0 = t["t0"]
                    parent_ids = {s["id"] for s in t["spans"]}
                    for ct in child_traces:
                        ct0 = ct.get("t0")
                        if ct0 is None:
                            continue
                        delta_ms = int((ct0 - pt0) * 1000)
                        # 同一 task_run 的事件会被拆进父/子两个 session (各一半);
                        # parentId 先在 子集∪父集 找真父, 都没有 (中间 span 未落盘) 才挂 subagent.start。
                        id_set = {s["id"] for s in ct["spans"]} | parent_ids
                        for s in ct["spans"]:
                            s2 = dict(s)
                            s2["start"] = max(0, s["start"] + delta_ms)
                            if not s2.get("parentId") or s2["parentId"] not in id_set:
                                s2["parentId"] = anchor["id"]
                            s2["grafted"] = True
                            s2["agent"] = ct.get("agent")
                            s2["agentRole"] = ct.get("agentRole")
                            t["spans"].append(s2)
                    if child_traces:
                        end = max(
                            (s["start"] + (s["dur"] or 0) for s in t["spans"]),
                            default=t["duration"],
                        )
                        t["duration"] = max(t["duration"], end, 1)
                        t["spans"].sort(key=lambda s: (s["start"], s["id"] or ""))
                        t["spanCount"] = len(t["spans"])

        # ── 包含性收敛: 父 span 的条必须覆盖其子树的总时间窗 ──
        # turn 扩展 / _bg 合并 / 子 session 嫁接都会把孩子加长 (后台 worker 甚至在
        # agent.run 返回后还在跑), 这里自底向上把父链 dur 扩到 max(child end);
        # 被扩的 span 把真实自身时长留在 attrs.self_duration_ms (详情不丢真值)。
        for t in traces:
            by_id = {s["id"]: s for s in t["spans"] if s.get("id")}
            changed = True
            guard = 0
            while changed and guard < 32:  # 收敛轮数 ≤ 树深
                changed = False
                guard += 1
                for s in t["spans"]:
                    pid = s.get("parentId")
                    par = by_id.get(pid) if pid else None
                    if par is None:
                        continue
                    child_end = s["start"] + (s["dur"] or 0)
                    par_end = par["start"] + (par["dur"] or 0)
                    if child_end > par_end:
                        if "self_duration_ms" not in (par.get("attrs") or {}):
                            par.setdefault("attrs", {})["self_duration_ms"] = par["dur"]
                        par["dur"] = child_end - par["start"]
                        changed = True
            end = max((s["start"] + (s["dur"] or 0) for s in t["spans"]), default=t["duration"])
            t["duration"] = max(t["duration"], end, 1)

        # 主线: 按时间正序 (从头到尾读一个 session)
        traces.sort(key=lambda t: t.get("startedAt") or "")
        return traces

    # ─── app 日志 / metrics 读取 (统一进 trace UI) ───
    def _load_plain(self, path: Path) -> List[Dict[str, Any]]:
        try:
            st = path.stat()
        except FileNotFoundError:
            return []
        size, mtime = st.st_size, st.st_mtime
        with self._lock:
            entry = self._cache.get(path)
            if entry and entry.size == size and entry.mtime == mtime:
                return entry.events
        recs: List[Dict[str, Any]] = []
        try:
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        recs.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        except OSError:
            return []
        with self._lock:
            self._cache[path] = _FileCacheEntry(path=path, size=size, mtime=mtime, events=recs)
        return recs

    def app_logs(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        if not self.offline and self.paths.app.exists():
            for p in sorted(self.paths.app.glob("*.jsonl")):
                out.extend(self._load_plain(p))
        return out

    def metric_events(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        if not self.offline and self.paths.metrics.exists():
            for p in sorted(self.paths.metrics.glob("*.jsonl")):
                out.extend(self._load_plain(p))
        return out

    def logs(
        self,
        *,
        q: str = "",
        level: str = "",
        session: str = "",
        since: Optional[float] = None,
        limit: int = 500,
    ) -> Dict[str, Any]:
        ql = q.lower().strip()
        rows = self.app_logs()
        by_level: Dict[str, int] = defaultdict(int)
        by_logger: Dict[str, int] = defaultdict(int)
        matched: List[Dict[str, Any]] = []
        for r in rows:
            if level and (r.get("level") or "") != level:
                continue
            if session and (r.get("session_id") or "") != session:
                continue
            if since is not None:
                ts = _parse_ts(r.get("ts"))
                if ts is not None and ts < since:
                    continue
            if ql:
                blob = json.dumps(r, ensure_ascii=False, default=str).lower()
                if ql not in blob:
                    continue
            by_level[r.get("level") or "info"] += 1
            by_logger[r.get("logger") or "?"] += 1
            matched.append(r)
        matched.sort(key=lambda r: r.get("ts") or "", reverse=True)
        top_loggers = sorted(by_logger.items(), key=lambda kv: kv[1], reverse=True)[:12]
        return {
            "total": len(matched),
            "by_level": dict(by_level),
            "top_loggers": [{"logger": k, "count": v} for k, v in top_loggers],
            "rows": matched[:limit],
        }

    def metrics(self, *, session: str = "") -> Dict[str, Any]:
        rows = self.metric_events()
        timings: Dict[str, List[float]] = defaultdict(list)
        counters: Dict[str, float] = defaultdict(float)
        counter_calls: Dict[str, int] = defaultdict(int)
        for r in rows:
            if session and (r.get("session_id") or "") != session:
                continue
            name = r.get("name") or "?"
            try:
                val = float(r.get("value") or 0)
            except (TypeError, ValueError):
                continue
            if r.get("metric") == "timing":
                timings[name].append(val)
            else:
                counters[name] += val
                counter_calls[name] += 1
        timing_out: list[TimingSummary] = []
        for name, vals in timings.items():
            timing_out.append(
                {
                    "name": name,
                    "count": len(vals),
                    "p50": round(_percentile(vals, 0.5), 1),
                    "p95": round(_percentile(vals, 0.95), 1),
                    "max": round(max(vals), 1),
                    "avg": round(sum(vals) / len(vals), 1),
                }
            )
        # 慢的排前面 (长等待排查)
        timing_out.sort(key=lambda d: d["p95"], reverse=True)
        counter_out = [
            {"name": key, "sum": value, "calls": counter_calls[key]}
            for key, value in sorted(counters.items(), key=lambda item: item[1], reverse=True)
        ]
        return {"timings": timing_out, "counters": counter_out}

    def overview(self) -> Dict[str, Any]:
        """顶部统计条: tokens / 延迟 p50 / 成本 / 错误率 + sparkline。基于全部 trace events。"""
        events = self.all_events()
        BUCKETS = 16
        ts_list = [t for t in (_parse_ts(e.get("started_at")) for e in events) if t is not None]
        t_min = min(ts_list) if ts_list else 0.0
        t_max = max(ts_list) if ts_list else 1.0
        span_t = max(t_max - t_min, 1e-6)

        def bucket(ts: Optional[float]) -> int:
            if ts is None:
                return 0
            return min(BUCKETS - 1, int((ts - t_min) / span_t * BUCKETS))

        tok_buckets = [0.0] * BUCKETS
        cost_buckets = [0.0] * BUCKETS
        lat_buckets: List[List[float]] = [[] for _ in range(BUCKETS)]
        err_buckets = [0.0] * BUCKETS
        run_buckets = [0.0] * BUCKETS
        total_tokens = 0
        total_cost = 0.0
        latencies: List[float] = []
        n_runs = 0
        n_err_runs = 0
        for e in events:
            kind = e.get("kind") or ""
            ts = _parse_ts(e.get("started_at"))
            b = bucket(ts)
            attrs = e.get("attributes") or {}
            usage = attrs.get("usage")
            if kind == "llm.stream":
                if usage:
                    t = int(usage.get("input_tokens") or 0) + int(usage.get("output_tokens") or 0)
                    total_tokens += t
                    tok_buckets[b] += t
                    c = _estimate_cost(attrs.get("model"), usage)
                    if c:
                        total_cost += c
                        cost_buckets[b] += c
                if e.get("duration_ms"):
                    latencies.append(float(e["duration_ms"]))
                    lat_buckets[b].append(float(e["duration_ms"]))
            if kind == "run.outcome":
                n_runs += 1
                run_buckets[b] += 1
                # Evidence Contract: 真实成败在 attributes.status, 顶层 status 恒 ok 会低估错误率
                if _rec.is_failed(e):
                    n_err_runs += 1
                    err_buckets[b] += 1

        lat_spark = [round(_percentile(v, 0.5) / 1000.0, 2) if v else 0.0 for v in lat_buckets]
        err_spark = [
            round(err_buckets[i] / run_buckets[i] * 100, 1) if run_buckets[i] else 0.0
            for i in range(BUCKETS)
        ]

        def delta(arr: List[float]) -> Optional[int]:
            half = len(arr) // 2
            first = sum(arr[:half]) or 0.0
            last = sum(arr[half:]) or 0.0
            if first <= 0:
                return None
            return int(round((last - first) / first * 100))

        return {
            "tokens": {"total": total_tokens, "spark": tok_buckets, "delta": delta(tok_buckets)},
            "latency": {
                "p50_ms": round(_percentile(latencies, 0.5), 0) if latencies else 0,
                "spark": lat_spark,
                "delta": delta([x for x in lat_spark if x]),
            },
            "cost": {
                "total": round(total_cost, 4),
                "spark": cost_buckets,
                "delta": delta(cost_buckets),
            },
            "errors": {
                "rate": round(n_err_runs / n_runs * 100, 1) if n_runs else 0.0,
                "spark": err_spark,
                "delta": delta(err_spark),
            },
            "ingest_ok": True,
        }
