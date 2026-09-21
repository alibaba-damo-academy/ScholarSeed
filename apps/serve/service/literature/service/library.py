"""Global literature application service."""

from __future__ import annotations

from dataclasses import replace

from service.literature.persistence.store import (
    LIBRARY_RELATIVE_PATH,
    LiteratureRepository,
)
from service.literature.schema import LiteratureCollection, LiteratureItem, LiteratureView
from service.literature.service.catalog import ListQuery, apply_query, to_bibtex


class LiteratureStore:
    def __init__(self, db_path: str | None = None):
        self.repo = LiteratureRepository(db_path) if db_path is not None else LiteratureRepository()

    def load(self) -> LiteratureView:
        return self.repo.view()

    def save(self, view: LiteratureView) -> None:
        self.repo.replace(view)


class LiteratureService:
    def __init__(self, db_path: str | None = None):
        self.repo = LiteratureRepository(db_path) if db_path is not None else LiteratureRepository()

    def load(self) -> LiteratureView:
        return self.repo.view()

    def save(self, view: LiteratureView) -> None:
        self.repo.replace(view)

    def get_item(self, key: str) -> LiteratureItem | None:
        return self.repo.get(key)

    def list_items(self, query: ListQuery) -> tuple[LiteratureItem, ...]:
        return apply_query(self.repo.list(q=query.search), query)

    def get_collections(self, project_id: str = "") -> tuple[LiteratureCollection, ...]:
        return self.repo.view(project_id).collections

    def get_tags(self) -> tuple[tuple[str, int], ...]:
        return tuple((x["name"], x["count"]) for x in self.repo.tags())

    def get_years(self) -> tuple[int, ...]:
        return tuple(sorted({x.year for x in self.repo.list() if x.year}, reverse=True))

    def get_fulltext_counts(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for item in self.repo.list():
            counts[item.fulltext.value] = counts.get(item.fulltext.value, 0) + 1
        return counts

    def add_item(self, item: LiteratureItem) -> None:
        self.repo.save(item)

    def update_item(self, item: LiteratureItem) -> None:
        self.repo.save(item)

    def remove_items(self, ids: tuple[str, ...]) -> int:
        return sum(self.repo.delete(x, True)[0] for x in ids)

    def set_collection(self, ids: tuple[str, ...], collection: str, project_id: str = "") -> None:
        for key in ids:
            item = next((item for item in self.repo.view(project_id).items if item.id == key), None)
            if item:
                self.repo.save(
                    replace(item, collections=(collection,), collection=collection), project_id
                )

    def add_tag(self, ids: tuple[str, ...], tag: str) -> None:
        for key in ids:
            item = self.repo.get(key)
            if item:
                self.repo.save(replace(item, tags=tuple(dict.fromkeys((*item.tags, tag)))))

    def remove_tag(self, ids: tuple[str, ...], tag: str) -> None:
        for key in ids:
            item = self.repo.get(key)
            if item:
                self.repo.save(replace(item, tags=tuple(x for x in item.tags if x != tag)))

    def link_project(
        self,
        ids: tuple[str, ...],
        project_id: str,
        collection_ids: tuple[str, ...] = (),
    ) -> tuple[tuple[str, ...], tuple[str, ...]]:
        return self.repo.link_project(ids, project_id, collection_ids)

    def create_collection(self, name: str, parent: str = "", project_id: str = "") -> None:
        self.repo.create_collection(name, parent or None, project_id)

    def delete_collection(self, name: str, project_id: str = "") -> None:
        match = next(
            (x for x in self.repo.collections(project_id) if x["id"] == name or x["name"] == name),
            None,
        )
        if match:
            self.repo.delete_collection(match["id"], project_id)

    def rename_collection(self, old_name: str, new_name: str, project_id: str = "") -> None:
        self.repo.rename_collection(old_name, new_name, project_id)

    def export_entries(self, ids: tuple[str, ...]) -> tuple[LiteratureItem, ...]:
        """按 id 命中库内条目; 已删除或不存在的 id 直接丢弃。"""

        wanted = set(ids)
        return tuple(x for x in self.repo.list() if x.id in wanted)

    def export_bibtex(self, ids: tuple[str, ...]) -> str:
        return to_bibtex(self.export_entries(ids))

    def export_bibtex_counted(self, ids: tuple[str, ...]) -> tuple[str, int]:
        """导出文本与实际写入的条目数。

        计数会直接变成用户看到的「成功导出 N 条文献」, 所以必须是命中条目数,
        不能拿请求 id 数充数。
        """

        entries = self.export_entries(ids)
        return to_bibtex(entries), len(entries)


__all__ = [
    "LIBRARY_RELATIVE_PATH",
    "LiteratureService",
    "LiteratureStore",
]
