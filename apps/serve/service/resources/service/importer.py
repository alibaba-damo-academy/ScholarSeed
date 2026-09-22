"""本地文件与搜索候选网页进入项目资料库的批量编排。"""

from __future__ import annotations

import hmac
import json
import logging
import re
import time
import uuid
from dataclasses import dataclass
from enum import Enum
from hashlib import sha256
from pathlib import PurePosixPath

from service.content.domain.model import ContentError
from service.platform.content import (
    AssetKind,
    AssetOrigin,
    ContentPort,
    ContentWriteReceipt,
    FileAssetRef,
    ImportCollisionPolicy,
    ImportMode,
    ImportSourcePlan,
    PreparedContent,
    RootKind,
)
from service.platform.resources import (
    VERSION_MAX_BYTES,
    PayloadImportPreview,
    ProductMutationKind,
    VersionOrigin,
)
from service.resources.domain.model import (
    ImportDecisionAction,
    ResourceImportDecision,
    ResourceLocationRef,
)
from service.resources.persistence.catalog import (
    WEB_SOURCE_SCHEMA_VERSION,
    ResourceWebSource,
    ResourceWebSourceCatalog,
)
from service.resources.persistence.imports import (
    ResourceImportCatalog,
)
from service.resources.persistence.imports import (
    ResourceImportConflict as ResourceImportCatalogConflict,
)
from service.resources.service.history import ResourceVersionService
from service.resources.service.observe import ResourceVersionSupervisor
from service.resources.service.writer import ResourceWriter, ResourceWriterError

WEB_SOURCE_FALLBACK_NAME = "网页资料"
WEB_SOURCE_NAME_LIMIT = 120
WEB_SOURCE_INVALID_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
WEB_SOURCE_MARKDOWN_TITLE_PREFIX = "# "
WEB_SOURCE_RESERVED_NAMES = frozenset(
    {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        *(f"COM{index}" for index in range(1, 10)),
        *(f"LPT{index}" for index in range(1, 10)),
    }
)
WEB_IMPORT_FAILED = "web_import_failed"
IMPORT_COMPLETED = "completed"
IMPORT_NEEDS_RESOLUTION = "needs_resolution"
IMPORT_PLAN_STALE = "import_plan_stale"
IMPORT_DECISIONS_INVALID = "import_decisions_invalid"
IMPORT_REPLACE_NOT_SUPPORTED = "replace_not_supported"
IMPORT_BACKGROUND_REQUIRED = "import_background_required"
IMPORT_IDEMPOTENCY_PREFIX = "resource-import"
IMPORT_DIGEST_PREFIX = "sha256:"
PAYLOAD_IMPORT_ID_PREFIX = "resource-payload"

logger = logging.getLogger(__name__)


class ResourceImportStatus(str, Enum):
    """Whether one local import completed or needs an explicit collision decision."""

    COMPLETED = IMPORT_COMPLETED
    NEEDS_RESOLUTION = IMPORT_NEEDS_RESOLUTION


class ResourceImportError(RuntimeError):
    """Stable local-import policy failure."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class ResourceImportConflict:
    """One top-level name collision projected for Desktop confirmation."""

    source_index: int
    source_name: str
    source_kind: AssetKind
    target_path: str
    target_kind: AssetKind | None
    suggested_name: str
    expected_target_revision: str | None
    can_replace_with_version: bool


@dataclass(frozen=True)
class ResourceImportOutcome:
    """Discriminated result of the single local-import endpoint."""

    status: ResourceImportStatus
    mode: ImportMode
    imported: tuple[FileAssetRef, ...] = ()
    plan_token: str | None = None
    conflicts: tuple[ResourceImportConflict, ...] = ()


@dataclass(frozen=True)
class _ResourceImportPlan:
    entries: tuple[ImportSourcePlan, ...]
    conflicts: tuple[ResourceImportConflict, ...]
    token: str


class ResourceImportService:
    """Plan collision decisions and execute COPY through Content and version owners."""

    def __init__(
        self,
        content: ContentPort,
        versions: ResourceVersionService,
        supervisor: ResourceVersionSupervisor,
    ) -> None:
        self._content = content
        self._versions = versions
        self._supervisor = supervisor
        self._payloads = ResourceImportCatalog(content)

    @staticmethod
    def _canonical(value: object) -> bytes:
        return json.dumps(
            value,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")

    @classmethod
    def _digest(cls, value: object) -> str:
        return f"{IMPORT_DIGEST_PREFIX}{sha256(cls._canonical(value)).hexdigest()}"

    @staticmethod
    def _payload_operation_id(idempotency_key: str) -> str:
        return f"{PAYLOAD_IMPORT_ID_PREFIX}:{sha256(idempotency_key.encode()).hexdigest()}"

    def _payload_receipt(self, project_id: str, asset: FileAssetRef) -> ContentWriteReceipt:
        snapshot = self._content.stable_snapshot(project_id, asset.path, VERSION_MAX_BYTES)
        return ContentWriteReceipt(
            project_id=project_id,
            path=asset.path,
            size=len(snapshot.content),
            revision=snapshot.revision,
        )

    def _prepare_exact_payload(
        self,
        project_id: str,
        parent: str,
        name: str,
        content: bytes,
        expected_path: str,
        reserved_paths: tuple[str, ...],
    ) -> PreparedContent:
        prepared = self._content.prepare_bytes(
            project_id,
            parent,
            name,
            content,
            reserved_paths,
        )
        if prepared.path == expected_path:
            return prepared
        self._content.release_prepared(prepared)
        raise ResourceImportError("name_exists")

    def preview_payload(
        self,
        project_id: str,
        parent: str,
        name: str,
        content: bytes,
        *,
        replace_path: str | None = None,
        context: str = "",
    ) -> PayloadImportPreview:
        """Resolve naming through Content; preflight never writes an attachment."""

        if len(content) > VERSION_MAX_BYTES:
            raise ResourceImportError("file_too_large")
        parent = self._content.within_root(project_id, RootKind.RESOURCES, parent)
        destination = self._content.destination(project_id, parent, name)
        requested = str(PurePosixPath(parent) / name)
        path = self._content.within_root(project_id, RootKind.RESOURCES, replace_path or requested)
        conflict = destination.path != requested if replace_path is None else True
        target_revision = None
        can_replace = False
        if conflict:
            try:
                snapshot = self._content.stable_snapshot(project_id, path, VERSION_MAX_BYTES)
            except ContentError as error:
                if replace_path or error.code not in {"file_not_found", "not_a_file", "not_file"}:
                    raise
            else:
                target_revision = snapshot.revision
                capability = self._supervisor.capability(project_id, path)
                can_replace = capability.can_version and capability.pending is None
        token = self._digest(
            {
                "project": project_id,
                "parent": parent,
                "name": name,
                "source": self._content.revision(content),
                "path": path,
                "replace": replace_path is not None,
                "revision": target_revision,
                "context": context,
                "can_replace": can_replace,
            }
        )
        return PayloadImportPreview(
            path, token, conflict, destination.name, can_replace, target_revision
        )

    def import_payload(
        self,
        project_id: str,
        parent: str,
        name: str,
        content: bytes,
        token: str,
        idempotency_key: str,
        *,
        replace_path: str | None = None,
        context: str = "",
    ) -> ContentWriteReceipt:
        """Freeze one explicit destination and reuse durable create/replace mutations."""

        digest = self._digest(
            {
                "token": token,
                "source": self._content.revision(content),
                "parent": parent,
                "name": name,
                "replace_path": replace_path,
                "context": context,
            }
        )
        with self._versions.writer(project_id):
            replay = self._versions.product_mutation_receipt(project_id, idempotency_key, digest)
            if replay is not None:
                return replay
        operation_id = self._payload_operation_id(idempotency_key)
        try:
            replayed_asset = self._payloads.resume(project_id, operation_id, digest)
        except ResourceImportCatalogConflict as error:
            raise ResourceImportError(str(error)) from error
        if replayed_asset is not None:
            return self._payload_receipt(project_id, replayed_asset)
        with self._versions.writer(project_id):
            preview = self.preview_payload(
                project_id, parent, name, content, replace_path=replace_path, context=context
            )
            if not hmac.compare_digest(token, preview.token):
                raise ResourceImportError(IMPORT_PLAN_STALE)
            if replace_path is not None:
                if not preview.can_replace or preview.target_revision is None:
                    raise ResourceImportError(IMPORT_REPLACE_NOT_SUPPORTED)
                receipt, _version = self._versions.commit_versioned_replace(
                    project_id,
                    preview.path,
                    content,
                    preview.target_revision,
                    idempotency_key,
                    digest,
                )
                return receipt
            if preview.conflict:
                raise ResourceImportError("name_exists")
            if preview.path in self._supervisor.eligible_paths(
                project_id, include_missing=(preview.path,)
            ):
                return self._versions.commit_product(
                    project_id,
                    preview.path,
                    content,
                    ProductMutationKind.CREATE,
                    idempotency_key,
                    request_digest=digest,
                )
        try:
            operation = self._payloads.reserve(
                project_id,
                operation_id,
                digest,
                lambda reserved_paths: self._prepare_exact_payload(
                    project_id,
                    parent,
                    name,
                    content,
                    preview.path,
                    reserved_paths,
                ),
            )
            asset = self._payloads.finish(project_id, operation)
        except ResourceImportCatalogConflict as error:
            raise ResourceImportError(str(error)) from error
        return self._payload_receipt(project_id, asset)

    def finish_payload(self, project_id: str, path: str, revision: str) -> None:
        """Seal the completed file plus its format-owned companion snapshot."""

        if self._supervisor.is_eligible(project_id, path):
            self._versions.seal(project_id, path, VersionOrigin.USER, expected_revision=revision)

    def _plan(
        self,
        project_id: str,
        sources: tuple[str, ...],
        target_dir: str,
    ) -> _ResourceImportPlan:
        entries = self._content.plan_import_sources(project_id, sources, target_dir)
        conflicts: list[ResourceImportConflict] = []
        for entry in entries:
            if not entry.conflict:
                continue
            can_replace = False
            if (
                entry.source_kind is AssetKind.FILE
                and entry.target_kind is AssetKind.FILE
                and entry.source_size <= VERSION_MAX_BYTES
                and entry.target_size is not None
                and entry.target_size <= VERSION_MAX_BYTES
                and entry.target_revision is not None
            ):
                can_replace = self._supervisor.capability(
                    project_id, entry.requested_path
                ).can_version
            conflicts.append(
                ResourceImportConflict(
                    source_index=entry.source_index,
                    source_name=entry.source_name,
                    source_kind=entry.source_kind,
                    target_path=entry.requested_path,
                    target_kind=entry.target_kind,
                    suggested_name=PurePosixPath(entry.target_path).name,
                    expected_target_revision=entry.target_revision,
                    can_replace_with_version=can_replace,
                )
            )
        token = self._digest(
            {
                "project": project_id,
                "sources": list(sources),
                "target_dir": target_dir,
                "items": [
                    {
                        "source_index": entry.source_index,
                        "source_name": entry.source_name,
                        "source_kind": entry.source_kind.value,
                        "source_generation": entry.source_generation,
                        "source_revision": entry.source_revision,
                        "source_size": entry.source_size,
                        "source_mode_bits": entry.source_mode_bits,
                        "requested_path": entry.requested_path,
                        "target_path": entry.target_path,
                        "conflict": entry.conflict,
                        "target_kind": (
                            entry.target_kind.value if entry.target_kind is not None else None
                        ),
                        "target_revision": entry.target_revision,
                        "target_size": entry.target_size,
                    }
                    for entry in entries
                ],
                "replaceable": [item.can_replace_with_version for item in conflicts],
            }
        )
        return _ResourceImportPlan(entries, tuple(conflicts), token)

    @classmethod
    def _item_key(cls, idempotency_key: str, source_index: int) -> str:
        return f"{IMPORT_IDEMPOTENCY_PREFIX}:{sha256(f'{idempotency_key}\0{source_index}'.encode('utf-8')).hexdigest()}"

    @classmethod
    def _item_digest(
        cls,
        plan_token: str,
        source_index: int,
        action: str,
    ) -> str:
        return cls._digest(
            {
                "plan_token": plan_token,
                "source_index": source_index,
                "action": action,
            }
        )

    @staticmethod
    def _decision_map(
        decisions: tuple[ResourceImportDecision, ...],
    ) -> dict[int, ImportDecisionAction]:
        mapped: dict[int, ImportDecisionAction] = {}
        for decision in decisions:
            if decision.source_index in mapped:
                raise ResourceImportError(IMPORT_DECISIONS_INVALID)
            mapped[decision.source_index] = decision.action
        return mapped

    def _replayed(
        self,
        project_id: str,
        source_count: int,
        plan_token: str,
        decisions: dict[int, ImportDecisionAction],
        idempotency_key: str,
    ) -> tuple[FileAssetRef, ...] | None:
        receipts = []
        for source_index in range(source_count):
            action = decisions.get(source_index)
            operation = action.value if action is not None else ProductMutationKind.CREATE.value
            receipt = self._versions.product_mutation_receipt(
                project_id,
                self._item_key(idempotency_key, source_index),
                self._item_digest(plan_token, source_index, operation),
            )
            if receipt is None:
                return None
            receipts.append(receipt)
        return tuple(
            FileAssetRef(
                project_id=receipt.project_id,
                path=receipt.path,
                name=PurePosixPath(receipt.path).name,
                kind=AssetKind.FILE,
                origin=AssetOrigin.LOCAL,
            )
            for receipt in receipts
        )

    def import_sources(
        self,
        project_id: str,
        mode: ImportMode,
        sources: tuple[str, ...],
        target_dir: str,
        *,
        plan_token: str | None = None,
        decisions: tuple[ResourceImportDecision, ...] = (),
        idempotency_key: str | None = None,
    ) -> ResourceImportOutcome:
        if mode is ImportMode.LINK:
            raise ResourceImportError(IMPORT_BACKGROUND_REQUIRED)

        mapped = self._decision_map(decisions)
        if plan_token is not None:
            if not idempotency_key:
                raise ResourceImportError("idempotency_key_required")
            replayed = self._replayed(project_id, len(sources), plan_token, mapped, idempotency_key)
            if replayed is not None:
                return ResourceImportOutcome(ResourceImportStatus.COMPLETED, mode, replayed)

        plan = self._plan(project_id, sources, target_dir)
        if plan_token is None:
            if mapped:
                raise ResourceImportError(IMPORT_DECISIONS_INVALID)
            if plan.conflicts:
                return ResourceImportOutcome(
                    ResourceImportStatus.NEEDS_RESOLUTION,
                    mode,
                    plan_token=plan.token,
                    conflicts=plan.conflicts,
                )
            imported = self._content.import_sources(
                project_id,
                sources,
                target_dir,
                mode,
                target_names=tuple(PurePosixPath(entry.target_path).name for entry in plan.entries),
                collision_policy=ImportCollisionPolicy.EXACT,
            )
            return ResourceImportOutcome(ResourceImportStatus.COMPLETED, mode, imported)

        if not hmac.compare_digest(plan.token, plan_token):
            raise ResourceImportError(IMPORT_PLAN_STALE)
        conflict_by_index = {item.source_index: item for item in plan.conflicts}
        if set(mapped) != set(conflict_by_index):
            raise ResourceImportError(IMPORT_DECISIONS_INVALID)
        for source_index, action in mapped.items():
            if (
                action is ImportDecisionAction.REPLACE
                and not conflict_by_index[source_index].can_replace_with_version
            ):
                raise ResourceImportError(IMPORT_REPLACE_NOT_SUPPORTED)
        return ResourceImportOutcome(
            ResourceImportStatus.COMPLETED,
            mode,
            self._execute(
                project_id,
                sources,
                plan,
                mapped,
                idempotency_key or "",
            ),
        )

    def _execute(
        self,
        project_id: str,
        sources: tuple[str, ...],
        plan: _ResourceImportPlan,
        decisions: dict[int, ImportDecisionAction],
        idempotency_key: str,
    ) -> tuple[FileAssetRef, ...]:
        contents = {}
        for entry in plan.entries:
            if entry.source_kind is not AssetKind.FILE or entry.source_size > VERSION_MAX_BYTES:
                continue
            source = self._content.read_import_source(project_id, sources[entry.source_index])
            if (
                entry.source_revision is None
                or self._content.revision(source.content) != entry.source_revision
            ):
                raise ResourceImportError(IMPORT_PLAN_STALE)
            contents[entry.source_index] = source.content

        imported = []
        for entry in plan.entries:
            decision = decisions.get(entry.source_index)
            if decision is ImportDecisionAction.REPLACE:
                if entry.target_revision is None:
                    raise ResourceImportError(IMPORT_PLAN_STALE)
                operation = ImportDecisionAction.REPLACE.value
                receipt, _version = self._versions.commit_versioned_replace(
                    project_id,
                    entry.requested_path,
                    contents[entry.source_index],
                    entry.target_revision,
                    self._item_key(idempotency_key, entry.source_index),
                    self._item_digest(plan.token, entry.source_index, operation),
                )
                imported.append(
                    FileAssetRef(
                        project_id=receipt.project_id,
                        path=receipt.path,
                        name=PurePosixPath(receipt.path).name,
                        kind=AssetKind.FILE,
                        origin=AssetOrigin.LOCAL,
                    )
                )
                continue

            target_path = entry.target_path if entry.conflict else entry.requested_path
            target_name = PurePosixPath(target_path).name
            if entry.source_index in contents:
                operation = (
                    ImportDecisionAction.RENAME.value
                    if decision is ImportDecisionAction.RENAME
                    else ProductMutationKind.CREATE.value
                )
                create_receipt = self._supervisor.commit_product_bytes(
                    project_id,
                    target_path,
                    contents[entry.source_index],
                    ProductMutationKind.CREATE,
                    self._item_key(idempotency_key, entry.source_index),
                    mode_bits=entry.source_mode_bits,
                    request_digest=self._item_digest(plan.token, entry.source_index, operation),
                )
                if create_receipt is not None:
                    imported.append(
                        FileAssetRef(
                            project_id=create_receipt.project_id,
                            path=create_receipt.path,
                            name=target_name,
                            kind=AssetKind.FILE,
                            origin=AssetOrigin.LOCAL,
                        )
                    )
                    continue
            copied = self._content.import_sources(
                project_id,
                (sources[entry.source_index],),
                (
                    ""
                    if PurePosixPath(target_path).parent == PurePosixPath(".")
                    else PurePosixPath(target_path).parent.as_posix()
                ),
                ImportMode.COPY,
                target_names=(target_name,),
                collision_policy=ImportCollisionPolicy.EXACT,
            )
            imported.extend(copied)
        return tuple(imported)


class WebImportStatus(str, Enum):
    """单个网页的最终入库状态。"""

    SUCCESS = "success"
    FAILED = "failed"


@dataclass(frozen=True)
class WebCandidate:
    """搜索结果页提交给资料库的一条候选。"""

    title: str
    url: str
    snippet: str = ""


@dataclass(frozen=True)
class WebImportItem:
    """单条候选的独立结果；一条失败不回滚其它成功项。"""

    title: str
    url: str
    status: WebImportStatus
    final_url: str | None = None
    node: FileAssetRef | None = None
    error: str | None = None


def _document_title(page_title: str, candidate_title: str) -> str:
    title = " ".join((page_title or candidate_title).split())
    return title or WEB_SOURCE_FALLBACK_NAME


def _file_name(title: str) -> str:
    """生成同时适用于 Windows/macOS/Linux 的 Markdown 文件名。"""

    cleaned = WEB_SOURCE_INVALID_NAME.sub("_", title)
    cleaned = " ".join(cleaned.split()).rstrip(" .")
    cleaned = cleaned[:WEB_SOURCE_NAME_LIMIT].rstrip(" .") or WEB_SOURCE_FALLBACK_NAME
    stem = cleaned.rsplit(".", 1)[0].upper()
    if stem in WEB_SOURCE_RESERVED_NAMES:
        cleaned = f"{cleaned}_"
    return cleaned


def _markdown(
    *,
    title: str,
    body: str,
) -> str:
    normalized = body.strip("\n")
    if normalized.startswith(WEB_SOURCE_MARKDOWN_TITLE_PREFIX):
        return f"{normalized}\n"
    return "\n".join(
        (
            f"# {title}",
            "",
            normalized,
            "",
        )
    )


def _markdown_link(url: str) -> str:
    """把 URL 写成可点击的 Markdown 链接，链接文字仍是 URL 本身。

    目标用尖括号包裹: 维基等真实 URL 常含括号 (`Foo_(bar)`)，裸 `(url)` 会被
    第一个 `)` 截断成坏链接；`[text](<url>)` 是 CommonMark 标准形态, 渲染端
    (Milkdown / remark) 据此生成链接节点, 才能点击跳系统浏览器。
    """

    text = url.replace("[", "\\[").replace("]", "\\]")
    return f"[{text}](<{url}>)"


class WebImporter:
    """逐个候选生成引用资料并通过资料库 Writer 独立落盘。"""

    def __init__(
        self,
        writer: ResourceWriter,
        content: ContentPort,
        sources: ResourceWebSourceCatalog,
    ) -> None:
        self._writer = writer
        self._content = content
        self._sources = sources

    def _discard_import(
        self,
        project_id: str,
        node: FileAssetRef | None,
        revision: str | None,
    ) -> None:
        if node is None or revision is None:
            return
        try:
            self._content.delete_bytes(project_id, node.path, revision)
        except ContentError:
            logger.exception("failed to discard a Web import document")

    def import_candidates(
        self,
        project_id: str,
        query: str,
        parent: str,
        candidates: tuple[WebCandidate, ...],
    ) -> tuple[WebImportItem, ...]:
        # 用户确认的落点必须在任何出站抓取或写盘之前复核。目录失效时整批保留在
        # 结果页等待重选，不能先抓网页再悄悄改存到资料库根目录。
        self._writer.validate_parent(project_id, parent)
        results: list[WebImportItem] = []
        for candidate in candidates:
            try:
                item = self._import_reference(project_id, query, parent, candidate)
            except ResourceWriterError as error:
                results.append(
                    WebImportItem(
                        title=candidate.title,
                        url=candidate.url,
                        status=WebImportStatus.FAILED,
                        error=error.code,
                    )
                )
                continue
            except Exception:  # noqa: BLE001 — 批量导入的业务契约要求逐项隔离
                # 未预期的解析器/网络栈/文件系统异常不能让其它已选网页丢失结果；
                # 原始异常留在服务日志，线上响应只暴露稳定错误码。
                logger.exception("unexpected web import item failure")
                results.append(
                    WebImportItem(
                        title=candidate.title,
                        url=candidate.url,
                        status=WebImportStatus.FAILED,
                        error=WEB_IMPORT_FAILED,
                    )
                )
                continue
            results.append(item)
        return tuple(results)

    def _import_reference(
        self,
        project_id: str,
        query: str,
        parent: str,
        candidate: WebCandidate,
    ) -> WebImportItem:
        """轻路径：不出站抓取，仅以候选标题与原始 URL 落一份引用资料。"""

        title = _document_title("", candidate.title)
        saved_at = time.time()
        document = _markdown(title=title, body=_markdown_link(candidate.url))
        revision = self._content.revision(document.encode("utf-8"))
        node: FileAssetRef | None = None
        try:
            node = self._writer.write_markdown(
                project_id,
                ResourceLocationRef(parent=parent, name=_file_name(title)),
                document,
            )
            self._sources.save(
                project_id,
                ResourceWebSource(
                    web_source_id=str(uuid.uuid4()),
                    resource_path=node.path,
                    resource_revision=revision,
                    source_title=title or None,
                    source_url=candidate.url,
                    final_url=None,
                    search_query=query or None,
                    fetched_at=saved_at,
                    schema_version=WEB_SOURCE_SCHEMA_VERSION,
                    created_at=saved_at,
                    updated_at=saved_at,
                ),
            )
        except Exception:
            self._discard_import(project_id, node, revision)
            raise
        return WebImportItem(
            title=title,
            url=candidate.url,
            status=WebImportStatus.SUCCESS,
            node=node,
        )


__all__ = [
    "WebCandidate",
    "WebImportItem",
    "WebImportStatus",
    "WebImporter",
    "WEB_IMPORT_FAILED",
]
