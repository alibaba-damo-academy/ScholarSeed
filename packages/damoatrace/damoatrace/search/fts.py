"""damoatrace 文本检索层 — FTS5 lazy-ingest (proposal 26 §5.3).

从 damoatrace utils 拆出: FtsSearch 把 trace jsonl 按文件 (size,mtime) 水位
增量灌入 core 的 TraceIndex (upsert by event id, 重灌幂等), 供 CLI search/provenance
做关键词检索; 不可用时调用方退回内存扫描。
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from damoatrace.paths import INDEX_FILENAME
from damoatrace.search.index import TraceIndex

# ───────────────────────── FTS5 lazy-ingest 检索 (proposal 26 §5.3) ─────────────────────────


class FtsSearch:
    """TraceIndex 的 lazy-ingest 管理: 首查时按文件 (size,mtime) 水位增量重灌。

    - 索引 upsert by event id → 整文件重灌幂等, 无需行级水位;
    - 水位 sidecar: TRACE_DIR/index_meta.json (索引/水位坏了整删重建);
    - FTS5 不可用或失败 → available()=False, 调用方退回内存扫描。
    """

    def __init__(self, trace_dir: Path, db_path: Optional[Path] = None):
        self.trace_dir = Path(trace_dir)
        self.db_path = Path(db_path) if db_path else self.trace_dir / INDEX_FILENAME
        self.meta_path = self.trace_dir / "index_meta.json"
        self._lock = threading.Lock()
        self._index = None
        self._opened = False

    def _open(self):
        if self._opened:
            return self._index
        self._opened = True
        try:
            self._index = TraceIndex.try_open(self.db_path)
        except Exception:  # noqa: BLE001
            self._index = None
        return self._index

    def available(self) -> bool:
        return self._open() is not None

    def _load_meta(self) -> Dict[str, Any]:
        try:
            return json.loads(self.meta_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def _save_meta(self, meta: Dict[str, Any]) -> None:
        try:
            self.meta_path.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass

    def ensure_indexed(self) -> Dict[str, int]:
        """增量摄入有变化的 jsonl。返回 {"files": 重灌文件数, "events": 摄入条数}。"""
        idx = self._open()
        if idx is None:
            return {"files": 0, "events": 0}
        with self._lock:
            meta = self._load_meta()
            if idx.projection_reset:
                meta = {}
                idx.projection_reset = False
            files = 0
            events = 0
            for p in sorted(self.trace_dir.glob("*.jsonl")):
                try:
                    st = p.stat()
                except FileNotFoundError:
                    continue
                key = p.name
                rec_meta = meta.get(key) or {}
                if rec_meta.get("size") == st.st_size and rec_meta.get("mtime") == st.st_mtime:
                    continue
                try:
                    events += idx.ingest_jsonl(p)
                    files += 1
                    meta[key] = {"size": st.st_size, "mtime": st.st_mtime}
                except Exception:  # noqa: BLE001
                    continue
            if files:
                self._save_meta(meta)
            return {"files": files, "events": events}

    def search(self, query: str, **kwargs: Any) -> Optional[List[Dict[str, Any]]]:
        """FTS 检索 (kwargs 透传 TraceIndex.search)。不可用返 None (上层退内存扫描)。"""
        idx = self._open()
        if idx is None:
            return None
        try:
            self.ensure_indexed()
            return idx.search(query, **kwargs)
        except Exception:  # noqa: BLE001
            return None
