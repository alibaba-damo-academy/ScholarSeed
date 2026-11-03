"""File-backed taxonomy management and transactional scope contracts."""

from __future__ import annotations

import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from pydantic import ValidationError

from service.literature.domain.model import (
    COLLECTION_CYCLE,
    TAXONOMY_CONFLICT,
    TAXONOMY_ITEM_UNAVAILABLE,
    TAXONOMY_NOT_FOUND,
    TAXONOMY_REVISION_CONFLICT,
    LiteratureError,
)
from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import LiteratureItem
from service.literature.service.taxonomy import LiteratureTaxonomyService
from service.platform.taxonomy import (
    COLLECTION_CREATE,
    COLLECTION_DELETE,
    COLLECTION_LIST,
    COLLECTION_UPDATE,
    ORGANIZE,
    TAG_CREATE,
    TAG_DELETE,
    TAG_LIST,
    TAG_UPDATE,
    TAXONOMY_REQUESTS,
)

PROJECT = "taxonomy-project"
OTHER_PROJECT = "other-project"


class TaxonomyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="taxonomy-")
        self.addCleanup(self.temporary.cleanup)
        self.repository = LiteratureRepository(Path(self.temporary.name) / "literature.sqlite3")
        self.service = LiteratureTaxonomyService(self.repository)
        self.repository.save_all(
            (LiteratureItem(id="paper", title="Research"),), project_id=PROJECT
        )
        self.repository.save_all(
            (LiteratureItem(id="other", title="Elsewhere"),), project_id=OTHER_PROJECT
        )

    def run_operation(self, operation: str, project_id: str = PROJECT, **parameters):
        return self.service.execute(
            project_id, operation, TAXONOMY_REQUESTS[operation].model_validate(parameters)
        )

    def test_create_reuses_sibling_and_global_tag(self) -> None:
        root = self.run_operation(COLLECTION_CREATE, name="Agents").items[0]
        self.assertTrue(self.run_operation(COLLECTION_CREATE, name="agents").reused)
        child = self.run_operation(COLLECTION_CREATE, name="agents", parent_id=root.id).items[0]
        self.assertNotEqual(root.id, child.id)
        self.run_operation(TAG_CREATE, name="Read")
        self.assertTrue(
            self.run_operation(TAG_CREATE, project_id=OTHER_PROJECT, name="read").reused
        )

    def test_lists_are_bounded_and_project_scoped(self) -> None:
        for name in ("First", "Second", "Third"):
            self.run_operation(COLLECTION_CREATE, name=name)
            self.run_operation(TAG_CREATE, name=name)
        self.run_operation(COLLECTION_CREATE, project_id=OTHER_PROJECT, name="Elsewhere")
        page = self.run_operation(COLLECTION_LIST, limit=2)
        self.assertEqual(len(page.items), 2)
        self.assertEqual(page.next_offset, 2)
        self.assertEqual(len(self.run_operation(COLLECTION_LIST, limit=2, offset=2).items), 1)
        self.assertEqual(len(self.run_operation(TAG_LIST, limit=2).items), 2)

    def test_organize_add_remove_preserves_other_memberships(self) -> None:
        first = self.run_operation(COLLECTION_CREATE, name="First").items[0]
        second = self.run_operation(COLLECTION_CREATE, name="Second").items[0]
        tag = self.run_operation(TAG_CREATE, name="Read").items[0]
        self.run_operation(ORGANIZE, literature_ids=["paper"], collection_ids=[first.id])
        added = self.run_operation(
            ORGANIZE, literature_ids=["paper"], collection_ids=[second.id], tag_ids=[tag.id]
        )
        self.assertEqual(added.affected, 2)
        self.assertEqual(
            self.run_operation(
                ORGANIZE, literature_ids=["paper"], collection_ids=[second.id], tag_ids=[tag.id]
            ).affected,
            0,
        )
        self.run_operation(
            ORGANIZE,
            literature_ids=["paper"],
            collection_ids=[second.id],
            tag_ids=[tag.id],
            action="remove",
        )
        self.assertEqual(
            tuple(item["id"] for item in self.repository.project_collections("paper", PROJECT)),
            (first.id,),
        )

    def test_all_items_validate_before_transaction_writes(self) -> None:
        tag = self.run_operation(TAG_CREATE, name="Read").items[0]
        for unavailable in ("other", "missing"):
            with self.assertRaisesRegex(LiteratureError, TAXONOMY_ITEM_UNAVAILABLE):
                self.run_operation(
                    ORGANIZE, literature_ids=["paper", unavailable], tag_ids=[tag.id]
                )
        self.assertEqual(self.run_operation(TAG_LIST).items[0].count, 0)
        self.assertEqual(self.repository.projects("other"), (OTHER_PROJECT,))

    def test_foreign_collections_are_rejected(self) -> None:
        foreign = self.run_operation(
            COLLECTION_CREATE, project_id=OTHER_PROJECT, name="Foreign"
        ).items[0]
        for operation, parameters in (
            (COLLECTION_CREATE, {"name": "Child", "parent_id": foreign.id}),
            (COLLECTION_UPDATE, {"id": foreign.id, "name": "Renamed"}),
            (COLLECTION_DELETE, {"id": foreign.id}),
            (ORGANIZE, {"literature_ids": ["paper"], "collection_ids": [foreign.id]}),
        ):
            with self.assertRaisesRegex(LiteratureError, TAXONOMY_NOT_FOUND):
                self.run_operation(operation, **parameters)

    def test_concurrent_create_reuses_one_definition(self) -> None:
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = tuple(
                executor.map(
                    lambda _: self.run_operation(COLLECTION_CREATE, name="Concurrent"), range(2)
                )
            )
        self.assertEqual(results[0].items[0].id, results[1].items[0].id)
        self.assertEqual(sum(result.affected for result in results), 1)

    def test_missing_relationship_rolls_back_all_additions(self) -> None:
        collection = self.run_operation(COLLECTION_CREATE, name="Valid").items[0]
        with self.assertRaisesRegex(LiteratureError, TAXONOMY_NOT_FOUND):
            self.run_operation(
                ORGANIZE,
                literature_ids=["paper"],
                collection_ids=[collection.id],
                tag_ids=["missing"],
            )
        self.assertEqual(self.repository.project_collections("paper", PROJECT), ())

    def test_update_cycle_collision_and_global_tag_relations(self) -> None:
        root = self.run_operation(COLLECTION_CREATE, name="Root").items[0]
        child = self.run_operation(COLLECTION_CREATE, name="Child", parent_id=root.id).items[0]
        with self.assertRaisesRegex(LiteratureError, COLLECTION_CYCLE):
            self.run_operation(COLLECTION_UPDATE, id=root.id, parent_id=child.id)
        self.run_operation(COLLECTION_UPDATE, id=child.id, parent_id=None, name="Moved")
        tag = self.run_operation(TAG_CREATE, name="Read").items[0]
        self.run_operation(ORGANIZE, literature_ids=["paper"], tag_ids=[tag.id])
        self.run_operation(TAG_UPDATE, project_id=OTHER_PROJECT, id=tag.id, name="Reviewed")
        self.assertEqual(self.run_operation(TAG_LIST).items[0].count, 1)
        self.run_operation(TAG_CREATE, name="Another")
        with self.assertRaisesRegex(LiteratureError, TAXONOMY_CONFLICT):
            self.run_operation(TAG_UPDATE, id=tag.id, name="Another")

    def test_delete_subtree_preview_revision_and_preserve_literature(self) -> None:
        root = self.run_operation(COLLECTION_CREATE, name="Root").items[0]
        child = self.run_operation(COLLECTION_CREATE, name="Child", parent_id=root.id).items[0]
        preview = self.run_operation(COLLECTION_DELETE, id=root.id)
        self.assertTrue(preview.preview)
        self.assertEqual(preview.impact.definitions, 2)
        self.run_operation(ORGANIZE, literature_ids=["paper"], collection_ids=[child.id])
        with self.assertRaisesRegex(LiteratureError, TAXONOMY_REVISION_CONFLICT):
            self.run_operation(COLLECTION_DELETE, id=root.id, expected_revision=preview.revision)
        refreshed = self.run_operation(COLLECTION_DELETE, id=root.id)
        deleted = self.run_operation(
            COLLECTION_DELETE, id=root.id, expected_revision=refreshed.revision
        )
        self.assertEqual(deleted.affected, 2)
        self.assertFalse(deleted.preview)
        self.assertEqual(len(self.repository.list(project_id=PROJECT)), 1)

    def test_global_tag_preview_includes_other_projects(self) -> None:
        tag = self.run_operation(TAG_CREATE, name="Read").items[0]
        self.run_operation(ORGANIZE, literature_ids=["paper"], tag_ids=[tag.id])
        self.run_operation(
            ORGANIZE, project_id=OTHER_PROJECT, literature_ids=["other"], tag_ids=[tag.id]
        )
        preview = self.run_operation(TAG_DELETE, id=tag.id)
        self.assertEqual(preview.impact.projects, 2)
        self.assertEqual(preview.impact.memberships, 2)
        self.run_operation(TAG_DELETE, id=tag.id, expected_revision=preview.revision)
        self.assertEqual(len(self.run_operation(TAG_LIST).items), 0)
        self.assertEqual(len(self.repository.list()), 2)

    def test_definition_change_invalidates_delete_preview(self) -> None:
        tag = self.run_operation(TAG_CREATE, name="Read").items[0]
        preview = self.run_operation(TAG_DELETE, id=tag.id)
        self.run_operation(TAG_UPDATE, id=tag.id, name="Reviewed")
        with self.assertRaisesRegex(LiteratureError, TAXONOMY_REVISION_CONFLICT):
            self.run_operation(TAG_DELETE, id=tag.id, expected_revision=preview.revision)

    def test_request_validation(self) -> None:
        for operation, parameters in (
            (COLLECTION_CREATE, {"name": " "}),
            (COLLECTION_UPDATE, {"id": "id"}),
            (COLLECTION_DELETE, {"id": "id", "expected_revision": "x"}),
            (TAG_LIST, {"limit": "2"}),
            (ORGANIZE, {"literature_ids": ["paper"]}),
        ):
            with self.assertRaises(ValidationError):
                TAXONOMY_REQUESTS[operation].model_validate(parameters)


if __name__ == "__main__":
    unittest.main()
