"""资料写入能力 (resources 域, 开发 2 拥有)。

架构文档 §3.2 要求资料库对外提供 `ResourceWriter`, 供「回答保存到资料库」使用;
§4.1 固定了链路: Assistant 编排(开发 6) → ResourceWriter(开发 2) →
ContentPort 原子写文件(开发 1)。

本文件是那条链路的中间一环。它决定**放在哪、叫什么、重名怎么办**,
但**不碰文件系统** —— 落盘全部委托 `ContentPort`。这样资料库不会出现
第二套路径拼接逻辑, 越界校验也仍然只有 content 域一处。
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from pathlib import PurePath, PurePosixPath

from service.content.domain.model import ContentError
from service.platform.content import (
    AssetKind,
    ContentPort,
    FileAssetRef,
    ImportMode,
    RootKind,
)
from service.resources.domain.model import (
    MARKDOWN_SUFFIX,
    ResourceImportPlan,
    ResourceLocationRef,
    agent_output_location,
)
from service.resources.persistence.imports import ResourceImportCatalog, ResourceImportConflict

INVALID_RESOURCE_PARENT = "invalid_resource_parent"
RESOURCE_PARENT_NOT_FOUND = "parent_not_found"
RESOURCE_IMPORT_FAILED = "resource_import_failed"
RESOURCE_NOT_MARKDOWN = "not_text_file"


class ResourceWriterError(RuntimeError):
    """资料写入失败；`code` 可稳定映射到 HTTP 错误。"""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class ResourceWriter:
    """把内容写入资料库的唯一入口 (开发 2 实现, 开发 6 调用)。"""

    def __init__(self, content: ContentPort) -> None:
        self._content = content
        self._imports = ResourceImportCatalog(content)

    def plan_import(
        self,
        operation_id: str | None,
        source_key: str,
        name: str,
        content: bytes,
        location: ResourceLocationRef | None = None,
    ) -> ResourceImportPlan:
        """Describe the exact request without reserving or creating a target."""
        target = location or agent_output_location(name)
        suffix = PurePath(name).suffix
        target_name = target.name.strip()
        if suffix and not PurePath(target_name).suffix:
            target_name = f"{target_name}{suffix}"
        parent = "/".join(part.strip() for part in self._parts(target.parent))
        fingerprint = hashlib.sha256(
            json.dumps(
                [source_key, parent, target_name, hashlib.sha256(content).hexdigest()],
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        operation_id = fingerprint if operation_id is None else operation_id
        return ResourceImportPlan(
            operation_id, fingerprint, ResourceLocationRef(parent, target_name)
        )

    def import_once(
        self,
        project_id: str,
        operation_id: str | None,
        source_key: str,
        name: str,
        content: bytes,
        location: ResourceLocationRef | None = None,
    ) -> FileAssetRef:
        """Replay one import from its durable reservation, never create a second copy."""
        plan = self.plan_import(operation_id, source_key, name, content, location)
        try:
            existing = self._imports.resume(project_id, plan.operation_id, plan.fingerprint)
            if existing is not None:
                return existing
            # Directory ownership emits resource-version notifications against the
            # shared project database, so resolve it before reserve takes its write lock.
            parent = self._ensure_parent(project_id, plan.location.parent)
            operation = self._imports.reserve(
                project_id,
                plan.operation_id,
                plan.fingerprint,
                lambda reserved: self._content.prepare_bytes(
                    project_id,
                    parent,
                    plan.location.name,
                    content,
                    reserved,
                ),
            )
            return self._imports.finish(project_id, operation)
        except (ContentError, ResourceImportConflict) as error:
            raise ResourceWriterError(str(error)) from error

    def resume_import(
        self, project_id: str, operation_id: str, fingerprint: str
    ) -> FileAssetRef | None:
        """Resolve a durable import intent; never prepare a second target on recovery."""
        try:
            return self._imports.resume(project_id, operation_id, fingerprint)
        except (ContentError, ResourceImportConflict) as error:
            raise ResourceWriterError(str(error)) from error

    def write_markdown(
        self,
        project_id: str,
        location: ResourceLocationRef,
        body: str,
    ) -> FileAssetRef:
        """在指定位置落一份 Markdown, 返回它的稳定引用。

        重名不覆盖: `ContentPort.create_text` 在同一次调用中完成命名避让与
        初始内容写入，不会先留下一个可能写入失败的空文件。
        """

        name = location.name
        if not name.endswith(MARKDOWN_SUFFIX):
            name = f"{name}{MARKDOWN_SUFFIX}"

        return self._create_at(
            project_id,
            ResourceLocationRef(parent=location.parent, name=name),
            lambda parent, target_name: self._content.create_text(
                project_id,
                parent,
                target_name,
                body,
            ),
        )

    def write_agent_output(
        self,
        project_id: str,
        name: str,
        body: str,
    ) -> FileAssetRef:
        """把 AI 回答落到标准产物目录 (PRD「基于 AI 回答新建文档」)。"""

        return self.write_markdown(project_id, agent_output_location(name), body)

    def validate_parent(self, project_id: str, parent: str) -> None:
        """确认一个用户选择的资料目录仍然有效，不创建或改选其它目录。"""

        try:
            root = self._content.root(project_id, RootKind.RESOURCES)
            target = root.path
            for part in self._parts(parent):
                target = f"{target}/{part}" if target else part
            if not self._content.is_directory(project_id, target):
                raise ResourceWriterError(RESOURCE_PARENT_NOT_FOUND)
        except ContentError as error:
            raise ResourceWriterError(error.code) from error

    def import_file(
        self,
        project_id: str,
        source_path: str,
        location: ResourceLocationRef,
    ) -> FileAssetRef:
        """把本地文件复制到资料库中的明确位置，保留原始字节。"""

        name = location.name
        source_suffix = PurePath(source_path).suffix
        if source_suffix and not PurePosixPath(name).suffix:
            name = f"{name}{source_suffix}"

        def copy(parent: str, name: str) -> FileAssetRef:
            imported = self._content.import_sources(
                project_id,
                (source_path,),
                parent,
                ImportMode.COPY,
                target_names=(name,),
            )
            if not imported:
                raise ResourceWriterError(RESOURCE_IMPORT_FAILED)
            return imported[0]

        return self._create_at(
            project_id,
            ResourceLocationRef(parent=location.parent, name=name),
            copy,
        )

    def import_bytes(
        self,
        project_id: str,
        name: str,
        content: bytes,
        location: ResourceLocationRef | None = None,
    ) -> FileAssetRef:
        target = location or agent_output_location(name)
        suffix = PurePath(name).suffix
        target_name = target.name
        if suffix and not PurePath(target_name).suffix:
            target_name = f"{target_name}{suffix}"
        return self._create_at(
            project_id,
            ResourceLocationRef(parent=target.parent, name=target_name),
            lambda parent, filename: self._content.create_bytes(
                project_id, parent, filename, content
            ),
        )

    def import_text(
        self,
        project_id: str,
        source_path: str,
        location: ResourceLocationRef,
        body: str,
    ) -> FileAssetRef:
        """Import transformed text while preserving the source filename suffix."""

        name = location.name
        source_suffix = PurePath(source_path).suffix
        if source_suffix and not PurePosixPath(name).suffix:
            name = f"{name}{source_suffix}"
        return self._create_at(
            project_id,
            ResourceLocationRef(parent=location.parent, name=name),
            lambda parent, target_name: self._content.create_bytes(
                project_id,
                parent,
                target_name,
                body.encode("utf-8"),
            ),
        )

    def import_agent_output(self, project_id: str, source_path: str) -> FileAssetRef:
        """把已校验的会话产物文件复制到标准 AI 产物目录。"""

        return self.import_file(
            project_id,
            source_path,
            agent_output_location(PurePath(source_path).name),
        )

    def replace_markdown(
        self,
        project_id: str,
        path: str,
        body: str,
        expected_revision: str,
    ) -> FileAssetRef:
        """CAS-replace an existing Markdown resource without losing user edits."""

        if not path.lower().endswith(MARKDOWN_SUFFIX):
            raise ResourceWriterError(RESOURCE_NOT_MARKDOWN)
        try:
            receipt = self._content.commit_bytes(
                project_id,
                path,
                body.encode("utf-8"),
                expected_revision,
            )
        except ContentError as error:
            raise ResourceWriterError(error.code) from error
        return FileAssetRef(
            project_id=receipt.project_id,
            path=receipt.path,
            name=PurePosixPath(receipt.path).name,
            kind=AssetKind.FILE,
        )

    @staticmethod
    def _parts(parent: str) -> tuple[str, ...]:
        """校验资料库内逻辑目录；绝不允许 `..` 逃出资料库根。"""

        raw = str(parent or "")
        candidate = PurePosixPath(raw)
        if (
            candidate.is_absolute()
            or "\\" in raw
            or any(part in {".", ".."} for part in candidate.parts)
        ):
            raise ResourceWriterError(INVALID_RESOURCE_PARENT)
        return tuple(part for part in candidate.parts if part)

    def _ensure_parent(self, project_id: str, parent: str) -> str:
        """在资料库根下补齐产物目录并返回项目相对路径。

        `ResourceLocationRef.parent` 相对的是资料库根，不是项目根。MANAGED
        项目的真实落点因此是 `resources/<parent>`，LEGACY 项目仍是 `<parent>`。
        逐层由 Content 独占创建或验证真实目录, 不使用存在性预检或同名避让。
        """

        root = self._content.root(project_id, RootKind.RESOURCES)
        current = root.path
        for part in self._parts(parent):
            current = self._content.ensure_directory(project_id, current, part).path
        return current

    def _create_at(
        self,
        project_id: str,
        location: ResourceLocationRef,
        create: Callable[[str, str], FileAssetRef],
    ) -> FileAssetRef:
        """统一解释资料库相对位置，再委托 ContentPort 的安全写原语。"""

        try:
            parent = self._ensure_parent(project_id, location.parent)
            return create(parent, location.name)
        except ContentError as error:
            raise ResourceWriterError(error.code) from error


__all__ = ["ResourceWriter", "ResourceWriterError"]
