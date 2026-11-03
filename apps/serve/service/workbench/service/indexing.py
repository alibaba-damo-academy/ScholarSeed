"""Persistent PDF index jobs executed outside Serve's event loop."""

from __future__ import annotations

import asyncio
import contextvars
import json
import logging
import os
import subprocess
import sys
import threading
import time
import uuid
from collections.abc import Iterator
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError
from contextlib import contextmanager
from dataclasses import asdict
from pathlib import Path
from tempfile import TemporaryFile

from service.chat.persistence.catalog import SESSION_CATALOG_TABLE
from service.paths import PROJECT_DB_RELATIVE, SERVICE_LITERATURE_DATABASE
from service.persistence.project import connect, transaction
from service.platform.activity import Activities, ActivityDomain
from service.platform.citations import (
    LITERATURE_STORAGE,
    MANAGED_STORAGE_SCOPE,
    CitationDocument,
    PdfIndex,
    PdfPageContent,
)
from service.platform.content import ContentPort
from service.platform.pdf import (
    PDF_WORKER_MAXIMUM_ATTEMPTS,
    PdfDocumentError,
    PdfPasswordError,
    pdf_document_info,
    pdf_worker_crashed,
)
from service.workbench.service.extraction import (
    END_PAGE_OPTION,
    MAX_DOCUMENT_PAGES,
    PARSER_ENCODING,
    START_PAGE_OPTION,
    decode_index,
    index_identity,
)

INDEX_TABLE = "workbench_pdf_indexes"
METADATA_TABLE = "workbench_pdf_metadata"
PAGE_TABLE = "workbench_pdf_pages"
#: 字节由 serve 代用户保管在 ``SERVICE_LITERATURE_FILES_DIR`` 的存储范围。它们的索引
#: 必须与字节同级 (用户级文献库), 不能按项目库解析: 会话可能根本没有项目 (文献全览),
#: 项目目录拷到别的机器也不该带走 serve 保管的索引。
USER_LEVEL_INDEX_SCOPES: frozenset[str] = frozenset({LITERATURE_STORAGE, MANAGED_STORAGE_SCOPE})
PARSER_MODULE = "service.workbench.service.parser"
PARSER_TIMEOUT_SECONDS = 180
PAGE_PARSER_TIMEOUT_SECONDS = 25
MAXIMUM_PARSE_OUTPUT_BYTES = 64_000_000
MAXIMUM_PARSER_STDERR_BYTES = 4_096
MAXIMUM_PENDING_BYTES = 200_000_000
PARSER_WORKERS = 3
NAVIGATION_INDEX_WAIT_SECONDS = 30
PARSER_ENV_KEYS = ("PATH", "SYSTEMROOT", "LANG", "LC_ALL", "PYTHONPATH")
PARSER_FAILED = "pdf_parser_failed"
PARSER_INVALID_OUTPUT = "pdf_parser_invalid_output"
READY = "ready"
FAILED = "failed"
QUEUED = "queued"
RUNNING = "running"
LOGGER = logging.getLogger(__name__)


def _decode_page(payload: dict) -> PdfPageContent:
    page_number = int(payload["page"])
    index = decode_index(
        {
            "index_id": "",
            "revision": "",
            "fragments": payload["fragments"],
            "page_count": page_number,
            "unavailable_pages": [page_number] if payload.get("unavailable") else [],
            "omissions": payload.get("omissions", []),
            "regions": payload.get("regions", []),
        }
    )
    return PdfPageContent(
        page_number,
        index.fragments,
        page_number in index.unavailable_pages,
        index.omissions,
        index.regions,
    )


def _page_ranges(pages: tuple[int, ...]) -> tuple[tuple[int, int], ...]:
    ranges: list[tuple[int, int]] = []
    for page in pages:
        if ranges and page == ranges[-1][1] + 1:
            ranges[-1] = (ranges[-1][0], page)
        else:
            ranges.append((page, page))
    return tuple(ranges)


class PdfIndexService:
    def __init__(
        self, content: ContentPort, session_database: Path | None = None, *, activities: Activities
    ) -> None:
        self._content = content
        self._activities = activities
        self._session_database = session_database
        self._executor = ThreadPoolExecutor(
            max_workers=PARSER_WORKERS, thread_name_prefix="pdf-index"
        )
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._calls: dict[int, int] = {}
        self._jobs: dict[tuple[str, str], Future[None]] = {}
        self._processes: set[subprocess.Popen] = set()
        self._closed = False
        self._closing: asyncio.Future[None] | None = None
        self._pending_bytes = 0

    @contextmanager
    def _operation(self) -> Iterator[None]:
        thread = threading.get_ident()
        with self._condition:
            depth = self._calls.get(thread, 0)
            if self._closed and not depth:
                raise ValueError("pdf_index_closed")
            activity = self._activities.enter(ActivityDomain.INDEX)
            self._calls[thread] = depth + 1
        try:
            with activity:
                yield
        finally:
            with self._condition:
                remaining = self._calls[thread] - 1
                if remaining:
                    self._calls[thread] = remaining
                else:
                    del self._calls[thread]
                self._condition.notify_all()

    @staticmethod
    def _index_key(document: CitationDocument) -> str:
        identity = index_identity(document.revision)
        return f"{document.session_id}:{identity}" if document.session_id else identity

    @staticmethod
    def _schema(connection, foreign_key: str) -> None:
        connection.execute(
            f"CREATE TABLE IF NOT EXISTS {INDEX_TABLE} (index_id TEXT PRIMARY KEY, revision TEXT NOT NULL, state TEXT NOT NULL, attempt_id TEXT NOT NULL, result TEXT, error TEXT NOT NULL DEFAULT '', updated_at REAL NOT NULL, session_id TEXT{foreign_key})"
        )
        connection.execute(
            f"CREATE TABLE IF NOT EXISTS {METADATA_TABLE} (index_id TEXT PRIMARY KEY, revision TEXT NOT NULL, page_count INTEGER NOT NULL, updated_at REAL NOT NULL, session_id TEXT{foreign_key})"
        )
        connection.execute(
            f"CREATE TABLE IF NOT EXISTS {PAGE_TABLE} (index_id TEXT NOT NULL, page_number INTEGER NOT NULL, revision TEXT NOT NULL, result TEXT NOT NULL, updated_at REAL NOT NULL, session_id TEXT, PRIMARY KEY(index_id,page_number){foreign_key})"
        )

    def _database(self, document: CitationDocument):
        database: Path | str
        if document.storage_scope in USER_LEVEL_INDEX_SCOPES:
            database = SERVICE_LITERATURE_DATABASE
            foreign_key = ""
        elif document.session_id:
            if self._session_database is None:
                raise ValueError("pdf_session_storage_unavailable")
            database = self._session_database
            foreign_key = f", FOREIGN KEY(session_id) REFERENCES {SESSION_CATALOG_TABLE}(session_id) ON DELETE CASCADE"
        else:
            database = self._content.resolve(document.project_id, PROJECT_DB_RELATIVE)
            foreign_key = ""
        with transaction(database) as connection:
            self._schema(connection, foreign_key)
        return database

    def forget_literature(self, revisions: tuple[str, ...]) -> int:
        """Drop literature-scope index rows of content that is gone.

        A literature index is keyed only by content revision and carries no
        session scope, so once the attachment file is unlinked nothing can
        resolve those rows again — the next read of the same item derives a
        different revision. Callers pass only revisions of files this deletion
        actually removed, which is also the guarantee that no surviving
        attachment shares the bytes. Managed full texts share this database and
        the same revision key (identical bytes, identical index), so deleting an
        attachment can drop a managed row too; that is a cache loss the next
        managed read rebuilds, not lost source data. Returns how many distinct
        cached indexes were dropped.
        """
        with self._operation():
            keys = tuple(dict.fromkeys(index_identity(revision) for revision in revisions))
            if not keys:
                return 0
            placeholders = ",".join("?" * len(keys))
            with transaction(SERVICE_LITERATURE_DATABASE) as connection:
                self._schema(connection, "")
                # 三张表各存一半状态: 整篇索引走 INDEX_TABLE, 逐页阅读走 METADATA/PAGE,
                # 只读过页的文献在 INDEX_TABLE 里根本没有行。所以“忘掉了几份索引”要按
                # 三表里出现过的 index_id 去重统计, 不能只数某一张表的 rowcount。
                forgotten = {
                    str(row[0])
                    for table in (INDEX_TABLE, METADATA_TABLE, PAGE_TABLE)
                    for row in connection.execute(
                        f"SELECT DISTINCT index_id FROM {table} "
                        f"WHERE session_id IS NULL AND index_id IN ({placeholders})",
                        keys,
                    )
                }
                for table in (INDEX_TABLE, METADATA_TABLE, PAGE_TABLE):
                    connection.execute(
                        f"DELETE FROM {table} WHERE session_id IS NULL "
                        f"AND index_id IN ({placeholders})",
                        keys,
                    )
            return len(forgotten)

    def status(self, document: CitationDocument) -> dict:
        with self._operation():
            database = self._database(document)
            connection = connect(database)
            try:
                row = connection.execute(
                    f"SELECT state,error,index_id,revision FROM {INDEX_TABLE} WHERE index_id=?",
                    (self._index_key(document),),
                ).fetchone()
                return (
                    dict(row)
                    if row
                    else {
                        "state": "unindexed",
                        "index_id": index_identity(document.revision),
                        "revision": document.revision,
                        "error": "",
                    }
                )
            finally:
                connection.close()

    def index(self, document: CitationDocument, *, wait: bool = False) -> PdfIndex | None:
        with self._operation():
            if wait:
                self.prepare(document)
                key = (document.project_id or document.session_id, self._index_key(document))
                with self._lock:
                    job = self._jobs.get(key)
                if job is not None:
                    try:
                        job.result(timeout=NAVIGATION_INDEX_WAIT_SECONDS)
                    except TimeoutError:
                        LOGGER.info("PDF navigation awaiting index", extra={"index_id": key[1]})
            database = self._database(document)
            connection = connect(database)
            try:
                row = connection.execute(
                    f"SELECT result FROM {INDEX_TABLE} WHERE index_id=? AND state=?",
                    (self._index_key(document), READY),
                ).fetchone()
                return decode_index(json.loads(row["result"])) if row else None
            finally:
                connection.close()

    def page_count(self, document: CitationDocument) -> int:
        with self._operation():
            if not document.payload:
                raise ValueError("pdf_source_unavailable")
            database = self._database(document)
            key = self._index_key(document)
            connection = connect(database)
            try:
                row = connection.execute(
                    f"SELECT page_count FROM {METADATA_TABLE} WHERE index_id=?", (key,)
                ).fetchone()
            finally:
                connection.close()
            if row is not None:
                return int(row["page_count"])
            try:
                page_count = pdf_document_info(document.payload).page_count
            except PdfPasswordError as error:
                raise ValueError("pdf_password_required") from error
            except PdfDocumentError as error:
                raise ValueError("pdf_parse_failed") from error
            if page_count < 1:
                raise ValueError("pdf_no_pages")
            if page_count > MAX_DOCUMENT_PAGES:
                raise ValueError("pdf_too_many_pages")
            with transaction(database) as connection:
                connection.execute(
                    f"INSERT INTO {METADATA_TABLE} (index_id,revision,page_count,updated_at,session_id) VALUES (?,?,?,?,?) ON CONFLICT(index_id) DO UPDATE SET revision=excluded.revision,page_count=excluded.page_count,updated_at=excluded.updated_at,session_id=excluded.session_id",
                    (key, document.revision, page_count, time.time(), document.session_id or None),
                )
            return page_count

    def pages(
        self, document: CitationDocument, start_page: int, end_page: int
    ) -> tuple[PdfPageContent, ...]:
        with self._operation():
            page_count = self.page_count(document)
            if start_page < 1 or end_page < start_page or end_page > page_count:
                raise ValueError("literature_page_range_invalid")
            database = self._database(document)
            key = self._index_key(document)
            requested = tuple(range(start_page, end_page + 1))
            cached = self._cached_pages(database, key, requested)
            if len(cached) != len(requested):
                missing = tuple(page for page in requested if page not in cached)
                with self._lock:
                    if self._closed:
                        raise ValueError("pdf_index_closed")
                    if self._pending_bytes + len(document.payload) > MAXIMUM_PENDING_BYTES:
                        raise ValueError("pdf_index_busy")
                    self._pending_bytes += len(document.payload)
                try:
                    parsed = [
                        (
                            range_start,
                            range_end,
                            self._parse_pages(document, range_start, range_end),
                        )
                        for range_start, range_end in _page_ranges(missing)
                    ]
                    with transaction(database) as connection:
                        for range_start, range_end, index in parsed:
                            for page_number in range(range_start, range_end + 1):
                                page = PdfPageContent(
                                    page_number,
                                    tuple(
                                        fragment
                                        for fragment in index.fragments
                                        if any(
                                            anchor.page == page_number for anchor in fragment.pages
                                        )
                                    ),
                                    page_number in index.unavailable_pages,
                                    tuple(
                                        omission
                                        for omission in index.omissions
                                        if any(
                                            anchor.page == page_number for anchor in omission.pages
                                        )
                                    ),
                                    tuple(
                                        region
                                        for region in index.regions
                                        if region.page == page_number
                                    ),
                                )
                                connection.execute(
                                    f"INSERT INTO {PAGE_TABLE} (index_id,page_number,revision,result,updated_at,session_id) VALUES (?,?,?,?,?,?) ON CONFLICT(index_id,page_number) DO UPDATE SET revision=excluded.revision,result=excluded.result,updated_at=excluded.updated_at,session_id=excluded.session_id",
                                    (
                                        key,
                                        page_number,
                                        document.revision,
                                        json.dumps(asdict(page), ensure_ascii=False),
                                        time.time(),
                                        document.session_id or None,
                                    ),
                                )
                finally:
                    with self._lock:
                        self._pending_bytes -= len(document.payload)
                cached = self._cached_pages(database, key, requested)
            if len(cached) != len(requested):
                raise ValueError("pdf_page_cache_unavailable")
            return tuple(cached[page_number] for page_number in requested)

    @staticmethod
    def _cached_pages(
        database: str | Path, index_id: str, requested: tuple[int, ...]
    ) -> dict[int, PdfPageContent]:
        placeholders = ",".join("?" for _ in requested)
        connection = connect(database)
        try:
            rows = connection.execute(
                f"SELECT page_number,result FROM {PAGE_TABLE} WHERE index_id=? AND page_number IN ({placeholders})",
                (index_id, *requested),
            ).fetchall()
        finally:
            connection.close()
        return {int(row["page_number"]): _decode_page(json.loads(row["result"])) for row in rows}

    def _parse_pages(self, document: CitationDocument, start_page: int, end_page: int) -> PdfIndex:
        returncode, output = self._run_parser(
            document.payload,
            (START_PAGE_OPTION, str(start_page), END_PAGE_OPTION, str(end_page)),
            PAGE_PARSER_TIMEOUT_SECONDS,
        )
        result = self._parser_result(returncode, output)
        index = decode_index(result["index"])
        if index.revision != document.revision or index.index_id != index_identity(
            document.revision
        ):
            raise ValueError("pdf_index_revision_conflict")
        return index

    @staticmethod
    def _parser_result(returncode: int, output: bytes) -> dict:
        if not output:
            raise ValueError(PARSER_FAILED if returncode else PARSER_INVALID_OUTPUT)
        try:
            result = json.loads(output.decode(PARSER_ENCODING))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            code = PARSER_FAILED if returncode else PARSER_INVALID_OUTPUT
            LOGGER.warning(
                "PDF parser output rejected: error=%s returncode=%s output_bytes=%s cause=%s",
                code,
                returncode,
                len(output),
                type(error).__name__,
            )
            raise ValueError(code) from error
        if returncode:
            if isinstance(result, dict) and isinstance(result.get("error"), str):
                LOGGER.warning("PDF parser result failed: error=%s", result["error"])
                raise ValueError(result["error"])
            raise ValueError(PARSER_FAILED)
        if (
            not isinstance(result, dict)
            or result.get("ok") is not True
            or not isinstance(result.get("index"), dict)
        ):
            raise ValueError(PARSER_INVALID_OUTPUT)
        return result

    def _run_parser(
        self, payload: bytes, arguments: tuple[str, ...], timeout: int
    ) -> tuple[int, bytes]:
        for attempt in range(PDF_WORKER_MAXIMUM_ATTEMPTS):
            returncode, output = self._run_parser_once(payload, arguments, timeout)
            if not pdf_worker_crashed(returncode):
                return returncode, output
            LOGGER.warning(
                "PDF index worker crashed: attempt=%s returncode=%s", attempt + 1, returncode
            )
        return returncode, output

    def _run_parser_once(
        self, payload: bytes, arguments: tuple[str, ...], timeout: int
    ) -> tuple[int, bytes]:
        environment = {name: os.environ[name] for name in PARSER_ENV_KEYS if name in os.environ}
        with TemporaryFile() as output_file:
            with self._lock:
                if self._closed:
                    raise ValueError("pdf_index_closed")
                process = subprocess.Popen(
                    [sys.executable, "-B", "-m", PARSER_MODULE, *arguments],
                    stdin=subprocess.PIPE,
                    stdout=output_file,
                    stderr=subprocess.PIPE,
                    env=environment,
                )
                self._processes.add(process)
            try:
                try:
                    _, stderr = process.communicate(payload, timeout=timeout)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.communicate()
                    raise ValueError("pdf_parse_timeout") from None
                output_file.seek(0)
                output = output_file.read(MAXIMUM_PARSE_OUTPUT_BYTES + 1)
            finally:
                # A communicate/read failure is not an exit receipt. Keep the
                # process registered if killing or reaping it is uncertain.
                with process:
                    if process.poll() is None:
                        process.kill()
                # Popen's context closes its pipes and waits for actual exit.
                with self._lock:
                    self._processes.discard(process)
        if process.returncode or not output:
            diagnostic = stderr[-MAXIMUM_PARSER_STDERR_BYTES:].decode("utf-8", errors="replace")
            LOGGER.warning(
                "PDF parser subprocess failed: returncode=%s output_bytes=%s stderr=%s",
                process.returncode,
                len(output),
                diagnostic,
                extra={
                    "parser_returncode": process.returncode,
                    "parser_stderr": diagnostic,
                    "parser_output_bytes": len(output),
                },
            )
        if len(output) > MAXIMUM_PARSE_OUTPUT_BYTES:
            raise ValueError("pdf_index_too_large")
        return process.returncode, output

    def prepare(self, document: CitationDocument, *, retry: bool = False) -> dict:
        with self._operation():
            key = (document.project_id or document.session_id, self._index_key(document))
            with self._lock:
                if self._closed:
                    raise ValueError("pdf_index_closed")
                status = self.status(document)
                if (
                    status["state"] == READY
                    or key in self._jobs
                    or (status["state"] == FAILED and not retry)
                ):
                    return status
                if self._pending_bytes + len(document.payload) > MAXIMUM_PENDING_BYTES:
                    raise ValueError("pdf_index_busy")
                attempt = uuid.uuid4().hex
                database = self._database(document)
                with transaction(database) as connection:
                    connection.execute(
                        f"INSERT INTO {INDEX_TABLE} (index_id,revision,state,attempt_id,updated_at,session_id) VALUES (?,?,?,?,?,?) ON CONFLICT(index_id) DO UPDATE SET state=excluded.state,attempt_id=excluded.attempt_id,error='',updated_at=excluded.updated_at",
                        (
                            key[1],
                            document.revision,
                            QUEUED,
                            attempt,
                            time.time(),
                            document.session_id or None,
                        ),
                    )
                self._pending_bytes += len(document.payload)
                self._jobs[key] = self._activities.submit(
                    self._executor,
                    ActivityDomain.INDEX,
                    self._build,
                    document,
                    database,
                    attempt,
                )
            return self.status(document)

    def _build(self, document: CitationDocument, database: str, attempt: str) -> None:
        key = (document.project_id or document.session_id, self._index_key(document))
        started = time.monotonic()
        try:
            with transaction(database) as connection:
                connection.execute(
                    f"UPDATE {INDEX_TABLE} SET state=? WHERE index_id=? AND attempt_id=?",
                    (RUNNING, key[1], attempt),
                )
            returncode, output = self._run_parser(document.payload, (), PARSER_TIMEOUT_SECONDS)
            result = self._parser_result(returncode, output)
            index = decode_index(result["index"])
            if index.revision != document.revision or index.index_id != index_identity(
                document.revision
            ):
                raise ValueError("pdf_index_revision_conflict")
            if not index.fragments and not index.omissions:
                raise ValueError("pdf_no_text_layer")
            with transaction(database) as connection:
                connection.execute(
                    f"UPDATE {INDEX_TABLE} SET state=?,result=?,updated_at=? WHERE index_id=? AND attempt_id=?",
                    (
                        READY,
                        json.dumps(asdict(index), ensure_ascii=False),
                        time.time(),
                        key[1],
                        attempt,
                    ),
                )
            LOGGER.info(
                "PDF index ready",
                extra={
                    "index_id": key[1],
                    "page_count": index.page_count,
                    "omitted_region_count": len(index.omissions),
                    "duration_seconds": time.monotonic() - started,
                },
            )
        except Exception as error:
            code = (
                str(error)
                if isinstance(error, ValueError)
                else f"pdf_parse_failed:{type(error).__name__}"
            )
            with transaction(database) as connection:
                connection.execute(
                    f"UPDATE {INDEX_TABLE} SET state=?,error=?,updated_at=? WHERE index_id=? AND attempt_id=?",
                    (FAILED, code, time.time(), key[1], attempt),
                )
            LOGGER.warning(
                "PDF index failed: index_id=%s error=%s",
                key[1],
                code,
                extra={"index_id": key[1], "error_code": code},
            )
        finally:
            with self._lock:
                self._jobs.pop(key, None)
                self._pending_bytes -= len(document.payload)

    def close(self) -> None:
        with self._lock:
            if threading.get_ident() in self._calls:
                raise RuntimeError("cannot close PDF indexes from an active operation")
            self._closed = True
            processes = tuple(self._processes)
        for process in processes:
            if process.poll() is None:
                process.terminate()
        self._executor.shutdown(wait=True, cancel_futures=True)
        with self._condition:
            self._condition.wait_for(lambda: not self._calls)
            if self._processes:
                raise RuntimeError("PDF parser exit remains unconfirmed")

    async def aclose(self) -> None:
        """Drain this service before delivering cancellation to the lifespan owner."""
        if self._closing is None:
            # Keep a future for the thread, not a Task which an event-loop-wide
            # task cancellation could finish before the thread actually joins.
            self._closing = asyncio.get_running_loop().run_in_executor(
                None, contextvars.copy_context().run, self.close
            )
        cancelled: asyncio.CancelledError | None = None
        while True:
            try:
                await asyncio.shield(self._closing)
            except asyncio.CancelledError as error:
                if self._closing.cancelled():
                    raise
                cancelled = error
                continue
            except BaseException as error:
                if cancelled is not None:
                    raise BaseExceptionGroup(
                        "PDF index shutdown failed during cancellation", [error, cancelled]
                    ) from None
                raise
            if cancelled is not None:
                raise cancelled
            return
