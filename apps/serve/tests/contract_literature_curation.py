"""Bridge curation plane contracts: metadata, admission, replay, gate, confirm."""

from __future__ import annotations

import base64
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

_HOME = tempfile.mkdtemp(prefix="scholarseed-curation-")
os.environ["SCHOLARSEED_HOME"] = _HOME

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from apps.serve.tests import pdf as pdf_fixture  # noqa: E402
from service.chat.constants import PRODUCT_EVENT_PRODUCT_DATA_CHANGED  # noqa: E402
from service.chat.service.artifacts import (  # noqa: E402
    ARTIFACT_REVISION_CONFLICT,
    ArtifactReadError,
)
from service.chat.service.invalidation import SCOPE_LITERATURE  # noqa: E402
from service.literature.api.catalogue import LITERATURE_NOT_FOUND  # noqa: E402
from service.literature.api.curation import (  # noqa: E402
    NEXT_ACTIONS,
    PERMISSION_DENIED,
    register_curation_bridge,
)
from service.literature.persistence.store import LiteratureRepository  # noqa: E402
from service.literature.schema import (  # noqa: E402
    PDF_MEDIA_TYPE,
    AttachmentRole,
    FulltextStatus,
    LiteratureAttachment,
    LiteratureItem,
)
from service.literature.service.attachment import (  # noqa: E402
    ARXIV_ALREADY_ATTACHED,
    ATTACHMENT_TYPE_MISMATCH,
)
from service.platform.activity import Activities, ActivityDomain  # noqa: E402
from service.platform.bridge import (  # noqa: E402
    BRIDGE_REQUESTS,
    LITERATURE_CURATION_DESTRUCTIVE,
    LITERATURE_CURATION_EXTERNAL,
    LITERATURE_CURATION_READS,
    LITERATURE_CURATION_REQUESTS,
    LITERATURE_CURATION_ROUTES,
)
from service.platform.citations import PDF_INDEX_STATE  # noqa: E402
from service.platform.queries import (  # noqa: E402
    DESTRUCTIVE_EFFECT,
    EXTERNAL_EFFECT,
    NO_APPROVAL,
    READ_EFFECT,
    USER_CONFIRM,
    WRITE_EFFECT,
)
from service.platform.vocabulary import (  # noqa: E402 - requires SCHOLARSEED_HOME isolation
    BRIDGE_SESSION_HEADER,
    BRIDGE_TOKEN_HEADER,
)

SESSION_ID = "curation-session"
TOKEN = "curation-token"
TURN_ID = "curation-turn"
SNAPSHOT_ID = "curation-snapshot"
ARTIFACT_ID = "art_curation_pdf"
PDF_NAME = "curation-fulltext.pdf"
#: 1x1 PNG: 合法图片、非法主附件, 用来钉住「主附件只允许 PDF」。
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
#: 托管目录常量是按值 import 进各 owner 模块的, 少指一个就会把副本写进真实 home。
LITERATURE_FILE_OWNERS = (
    "service.literature.persistence.files",
    "service.literature.service.attachment",
)


def pdf_payload(text: str = "Attachable full text") -> bytes:
    return pdf_fixture.build_pdf(
        pdf_fixture.PageFixture(texts=(pdf_fixture.TextFixture(x=40, top=40, text=text),)),
        title=text,
    )


PDF_BYTES = pdf_payload()


def _assistant(
    payload: bytes | None = None, name: str = PDF_NAME, error: str = ""
) -> SimpleNamespace:
    """替身只站在 curation 与 assistant 那一层接缝上。

    artifact 准入 (必须已发布 / 只认会话相对路径 / 拒绝绝对路径与 ``..`` / sha 校验)
    由 ``export_publication_bytes`` 自己那一侧的契约测试持有; 这里只决定「交出的字节
    是什么」或「准入失败时报哪个码」, 好让 curation 侧的挂载语义被独立钉住。
    """

    def export_publication_bytes(
        session_id: str,
        workdir: Path,
        *,
        artifact_id: str | None = None,
        path: str | None = None,
        expected_sha256: str | None = None,
    ) -> tuple[bytes, str]:
        assert session_id == SESSION_ID
        assert workdir == Path(_HOME)
        assert (artifact_id is None) != (path is None)
        if error:
            raise ArtifactReadError(error)
        return PDF_BYTES if payload is None else payload, name

    return SimpleNamespace(export_publication_bytes=export_publication_bytes)


def _live(decision: dict | None = None, mode: str = "ask") -> SimpleNamespace:
    interactions = SimpleNamespace(
        request_product_input=AsyncMock(return_value=decision if decision is not None else {})
    )
    return SimpleNamespace(
        id=SESSION_ID,
        bridge_token=TOKEN,
        turn_activity=None,
        active_assistant_snapshot_id=SNAPSHOT_ID,
        ledger=SimpleNamespace(active_turn_id=TURN_ID),
        applied_permission_mode=mode,
        #: fulltext-attach 解析会话相对路径时的工作区根; 真实实现是 LiveSession 的属性。
        runtime_workdir=Path(_HOME),
        interactions=interactions,
        #: 粗失效广播的落点; 真实实现是 LiveSession.publish (持久化 + SSE 投递)。
        publish=AsyncMock(return_value=SimpleNamespace(product_seq=1)),
    )


def _app(
    live: SimpleNamespace,
    cleanup=None,
    assistant: SimpleNamespace | None = None,
    pdf_indexes: Any = None,
) -> TestClient:
    activities = Activities()
    live.turn_activity = activities.enter(ActivityDomain.TURN)
    if cleanup is not None:
        cleanup(live.turn_activity.close)
    sessions = SimpleNamespace(
        bridge_caller=lambda scope_id: live if scope_id == SESSION_ID else None
    )
    app = FastAPI()
    if pdf_indexes is not None:
        setattr(app.state, PDF_INDEX_STATE, pdf_indexes)
    register_curation_bridge(
        app,
        sessions,
        assistant=_assistant() if assistant is None else assistant,
        activities=activities,
    )
    return TestClient(app)


HEADERS = {BRIDGE_SESSION_HEADER: SESSION_ID, BRIDGE_TOKEN_HEADER: TOKEN}


def _call(client: TestClient, name: str, payload: dict) -> dict:
    """POST one bridge operation; transport must succeed, the envelope may not."""

    response = client.post(LITERATURE_CURATION_ROUTES[name], json=payload, headers=HEADERS)
    assert response.status_code == 200, response.text
    return response.json()


class CurationRegistration(unittest.TestCase):
    def test_every_operation_is_registered_with_explicit_layer_metadata(self) -> None:
        for name, request in LITERATURE_CURATION_REQUESTS.items():
            entry = BRIDGE_REQUESTS[("literature", name)]
            self.assertEqual(entry.route, LITERATURE_CURATION_ROUTES[name])
            self.assertIs(entry.request_type, request)
            self.assertEqual(entry.response_type, None)
            expected_effect = (
                READ_EFFECT
                if name in LITERATURE_CURATION_READS
                else (
                    EXTERNAL_EFFECT
                    if name in LITERATURE_CURATION_EXTERNAL
                    else (
                        DESTRUCTIVE_EFFECT
                        if name in LITERATURE_CURATION_DESTRUCTIVE
                        else WRITE_EFFECT
                    )
                )
            )
            self.assertEqual(entry.effect, expected_effect)
            self.assertEqual(
                entry.approval,
                USER_CONFIRM if name in LITERATURE_CURATION_DESTRUCTIVE else NO_APPROVAL,
            )
            self.assertTrue(request.model_config.get("extra") == "forbid")
            self.assertTrue(request.model_config.get("strict") is True)

    def test_write_requests_require_a_client_op_id(self) -> None:
        for name in ("note-add", "patch", "delete", "fulltext-attach"):
            model = LITERATURE_CURATION_REQUESTS[name]
            self.assertIn("client_op_id", model.model_fields)
        with self.assertRaises(ValidationError):
            LITERATURE_CURATION_REQUESTS["note-add"].model_validate(
                {"literature_id": "x", "text": "t", "client_op_id": "short"}
            )


class CurationRoutes(unittest.TestCase):
    def setUp(self) -> None:
        self.repository = LiteratureRepository()
        saved = self.repository.save_all((LiteratureItem(id="lit-1", title="Alpha"),))
        self.item_id = saved[0].id

    def tearDown(self) -> None:
        self.repository.delete(self.item_id, True)

    def _client(self, decision: dict | None = None, mode: str = "ask") -> TestClient:
        return _app(_live(decision, mode), cleanup=self.addCleanup)

    def _post(self, client: TestClient, name: str, payload: dict) -> dict:
        return _call(client, name, payload)

    def test_reads_return_summaries_without_approval(self) -> None:
        client = self._client()
        counts = self._post(client, "counts", {"project_id": ""})
        self.assertTrue(counts["ok"])
        self.assertGreaterEqual(counts["all"], 1)
        notes = self._post(client, "notes", {"literature_id": self.item_id})
        self.assertEqual(notes["items"], [])

    def test_unknown_field_is_rejected_by_the_strict_contract(self) -> None:
        client = self._client()
        response = client.post(
            LITERATURE_CURATION_ROUTES["counts"],
            json={"project_id": "", "surprise": 1},
            headers=HEADERS,
        )
        self.assertEqual(response.status_code, 400)
        self.assertFalse(response.json()["ok"])

    def test_anonymous_caller_is_denied(self) -> None:
        client = self._client()
        response = client.post(LITERATURE_CURATION_ROUTES["counts"], json={"project_id": ""})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"], "bridge_access_denied")

    def test_write_replays_the_first_result_for_a_reused_client_op_id(self) -> None:
        client = self._client()
        payload = {
            "literature_id": self.item_id,
            "text": "first note",
            "client_op_id": "op-note-0001",
        }
        first = self._post(client, "note-add", payload)
        self.assertTrue(first["ok"])
        second = self._post(client, "note-add", payload)
        self.assertTrue(second["ok"])
        self.assertTrue(second["replayed"])
        notes = self.repository.notes(self.item_id) or ()
        self.assertEqual(len(notes), 1)

    def test_every_write_operation_survives_its_own_request_shape(self) -> None:
        # 回归: _execute 曾有一行无条件取 data["literature_ids"], 把请求体里没有这个
        # 字段的 patch / tag-create / collection-create / tag-delete / collection-delete
        # 全部打成 KeyError → 500。每个操作只许读自己契约里的字段。
        client = self._client(decision={"answers": {"q": "确认执行"}})
        tag = self.repository.create_tag("shape-tag")
        collection = self.repository.create_collection("shape-col", None, "")
        self.addCleanup(self.repository.delete_tag, tag["id"])
        self.addCleanup(self.repository.delete_collection, collection["id"])
        patched = self._post(
            client,
            "patch",
            {"literature_id": self.item_id, "title": "Shaped", "client_op_id": "op-shape-0001"},
        )
        self.assertEqual(patched["item"]["title"], "Shaped")
        created = self._post(
            client, "tag-create", {"name": "shape-tag-2", "client_op_id": "op-shape-0002"}
        )
        self.addCleanup(self.repository.delete_tag, created["tag"]["id"])
        self.assertTrue(created["tag"]["id"])
        made = self._post(
            client, "collection-create", {"name": "shape-col-2", "client_op_id": "op-shape-0003"}
        )
        self.addCleanup(self.repository.delete_collection, made["collection"]["id"])
        self.assertTrue(made["collection"]["id"])
        removed = self._post(
            client, "tag-delete", {"tag_id": tag["id"], "client_op_id": "op-shape-0004"}
        )
        self.assertEqual(removed["deleted"], tag["id"])
        cleared = self._post(
            client,
            "collection-delete",
            {"collection_id": collection["id"], "client_op_id": "op-shape-0005"},
        )
        self.assertEqual(cleared["deleted"], collection["id"])

    def test_bulk_writes_report_only_what_they_actually_changed(self) -> None:
        """批量写的回执只列真正改到的条目。

        AI 拿这份回执决定下一步: 过去不管库里有没有这些 id 都回「全部成功」, 已被删除
        的条目会一直留在它的认知里, 后面的推理全建在假的成功面上。
        """

        client = self._client()
        tagged = self._post(
            client,
            "bulk-tag",
            {
                "literature_ids": [self.item_id, "lit-missing"],
                "action": "add",
                "tags": ["Receipt"],
                "client_op_id": "op-bulktag-01",
            },
        )

        self.assertTrue(tagged["ok"], tagged)
        self.assertEqual(tagged["succeeded"], [self.item_id])
        self.assertEqual(tagged["failed"], [{"id": "lit-missing", "code": LITERATURE_NOT_FOUND}])
        self.assertEqual(self.repository.get(self.item_id).tags, ("Receipt",))
        tag = next(entry for entry in self.repository.tags() if entry["name"] == "Receipt")
        self.addCleanup(self.repository.delete_tag, tag["id"])

        untagged = self._post(
            client,
            "bulk-tag",
            {
                "literature_ids": [self.item_id],
                "action": "remove",
                "tags": ["Receipt"],
                "client_op_id": "op-bulktag-02",
            },
        )
        self.assertEqual(untagged["succeeded"], [self.item_id])
        self.assertEqual(untagged["failed"], [])
        self.assertEqual(self.repository.get(self.item_id).tags, ())

    def test_facets_read_is_a_bounded_aggregate(self) -> None:
        """聚合维度回 {total, entries, truncated}: 截断必须显式, 不能让调用方当成全貌。"""

        facets = self._post(self._client(), "facets", {"project_id": ""})

        self.assertTrue(facets["ok"], facets)
        for dimension in ("years", "item_types", "publications"):
            self.assertEqual(set(facets[dimension]), {"total", "entries", "truncated"}, dimension)
            self.assertEqual(facets[dimension]["total"], len(facets[dimension]["entries"]))
            self.assertFalse(facets[dimension]["truncated"])
        # 分类树与标签喂着界面, 不套有界视图。
        self.assertIsInstance(facets["collections"], list)
        self.assertIsInstance(facets["tags"], list)

    def test_read_only_session_cannot_write(self) -> None:
        client = self._client(mode="read_only")
        response = client.post(
            LITERATURE_CURATION_ROUTES["note-add"],
            json={
                "literature_id": self.item_id,
                "text": "nope",
                "client_op_id": "op-note-0002",
            },
            headers=HEADERS,
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"], "permission_mode_denied")

    def test_destructive_requires_confirmation_and_replays_denials_only_once(self) -> None:
        denied = self._client(decision={"answers": {"q": "取消"}})
        payload = {"literature_ids": [self.item_id], "client_op_id": "op-del-0001"}
        result = self._post(denied, "delete", payload)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "user_denied")
        self.assertIsNotNone(self.repository.get(self.item_id))

        approved = self._client(decision={"answers": {"q": "确认执行"}})
        result = self._post(approved, "delete", payload)
        self.assertTrue(result["ok"])
        self.assertEqual(result["deleted"], [self.item_id])
        self.assertIsNone(self.repository.get(self.item_id))

    def test_confirmation_has_explicit_presentation_and_unchanged_protocol(self) -> None:
        live = _live(decision={"answers": {"q": "取消"}})
        client = _app(live, cleanup=self.addCleanup)
        result = self._post(
            client, "delete", {"literature_ids": [self.item_id], "client_op_id": "op-meta-0001"}
        )
        self.assertFalse(result["ok"])
        call = live.interactions.request_product_input.call_args
        question = call.args[0]
        self.assertTrue(question["id"].startswith("literature-curation-"))
        self.assertEqual(question["header"], "文献库操作确认")
        self.assertEqual([option["label"] for option in question["options"]], ["确认执行", "取消"])
        self.assertEqual(
            question["presentation"],
            {"kind": "literature-curation", "operation": "delete", "count": 1, "titles": ["Alpha"]},
        )
        self.assertEqual(call.kwargs, {"turn_id": TURN_ID, "timeout_seconds": 120.0})
        self.assertIsNotNone(self.repository.get(self.item_id))

    def test_cancel_timeout_and_translated_answers_never_approve(self) -> None:
        decisions = (
            {"cancelled": True, "answers": {"q": "确认执行"}},
            {"timed_out": True, "answers": {"q": "确认执行"}},
            {"answers": {"q": "Confirm execution"}},
            {"answers": {"q": "Cancel"}},
            {},
        )
        for index, decision in enumerate(decisions):
            with self.subTest(decision=decision):
                client = self._client(decision=decision)
                result = self._post(
                    client,
                    "delete",
                    {"literature_ids": [self.item_id], "client_op_id": f"op-cancel-{index:04}"},
                )
                self.assertEqual(result["error"], "user_denied")
                self.assertIsNotNone(self.repository.get(self.item_id))

    def test_read_only_destructive_operation_does_not_request_confirmation(self) -> None:
        live = _live(mode="read_only")
        client = _app(live, cleanup=self.addCleanup)
        response = client.post(
            LITERATURE_CURATION_ROUTES["delete"],
            json={"literature_ids": [self.item_id], "client_op_id": "op-readonly-0001"},
            headers=HEADERS,
        )
        self.assertEqual(response.status_code, 403)
        live.interactions.request_product_input.assert_not_awaited()
        self.assertIsNotNone(self.repository.get(self.item_id))

    def test_bypass_session_skips_the_confirmation_card(self) -> None:
        live = _live(decision={"answers": {"q": "取消"}}, mode="bypassPermissions")
        client = _app(live, cleanup=self.addCleanup)
        result = self._post(
            client, "delete", {"literature_ids": [self.item_id], "client_op_id": "op-del-0002"}
        )
        self.assertTrue(result["ok"])
        live.interactions.request_product_input.assert_not_awaited()


class CurationInvalidation(unittest.TestCase):
    """A committed mutation must tell the UI that the literature scope went stale."""

    def setUp(self) -> None:
        self.repository = LiteratureRepository()
        saved = self.repository.save_all((LiteratureItem(id="lit-invalidation", title="Beta"),))
        self.item_id = saved[0].id

    def tearDown(self) -> None:
        self.repository.delete(self.item_id, True)

    def _session(
        self, decision: dict | None = None, mode: str = "ask"
    ) -> tuple[SimpleNamespace, TestClient]:
        live = _live(decision, mode)
        return live, _app(live, cleanup=self.addCleanup)

    def _note(self, client: TestClient, op_id: str, literature_id: str = "") -> dict:
        return _call(
            client,
            "note-add",
            {
                "literature_id": literature_id or self.item_id,
                "text": "invalidation note",
                "client_op_id": op_id,
            },
        )

    def test_a_committed_write_announces_the_literature_scope_once(self) -> None:
        live, client = self._session()
        self.assertTrue(self._note(client, "op-inv-0001")["ok"])
        live.publish.assert_awaited_once()
        kind, data = live.publish.await_args.args
        self.assertEqual(kind, PRODUCT_EVENT_PRODUCT_DATA_CHANGED)
        # 只带数据域, 不带条目身份: 消费方按域整片重取, 这就是粗失效的全部内容。
        self.assertEqual(data, {"scopes": [SCOPE_LITERATURE]})
        self.assertEqual(live.publish.await_args.kwargs["turn_id"], TURN_ID)

    def test_reads_and_failed_writes_announce_nothing(self) -> None:
        live, client = self._session()
        self.assertTrue(_call(client, "counts", {"project_id": ""})["ok"])
        self.assertFalse(self._note(client, "op-inv-0002", "missing-literature")["ok"])
        live.publish.assert_not_awaited()

    def test_a_denied_destructive_operation_announces_nothing(self) -> None:
        live, client = self._session(decision={"answers": {"q": "取消"}})
        denied = _call(
            client, "delete", {"literature_ids": [self.item_id], "client_op_id": "op-inv-0003"}
        )
        self.assertFalse(denied["ok"])
        live.publish.assert_not_awaited()

    def test_an_approved_destructive_operation_announces_the_scope(self) -> None:
        live, client = self._session(decision={"answers": {"q": "确认执行"}})
        approved = _call(
            client, "delete", {"literature_ids": [self.item_id], "client_op_id": "op-inv-0004"}
        )
        self.assertTrue(approved["ok"])
        live.publish.assert_awaited_once()

    def test_a_replayed_write_does_not_announce_a_second_time(self) -> None:
        live, client = self._session()
        self.assertTrue(self._note(client, "op-inv-0005")["ok"])
        self.assertTrue(self._note(client, "op-inv-0005")["replayed"])
        live.publish.assert_awaited_once()

    def test_a_read_only_session_announces_nothing(self) -> None:
        live, client = self._session(mode="read_only")
        response = client.post(
            LITERATURE_CURATION_ROUTES["note-add"],
            json={
                "literature_id": self.item_id,
                "text": "nope",
                "client_op_id": "op-inv-0006",
            },
            headers=HEADERS,
        )
        self.assertEqual(response.status_code, 403)
        live.publish.assert_not_awaited()

    def test_a_failed_broadcast_never_fails_the_committed_mutation(self) -> None:
        live = _live()
        live.publish = AsyncMock(side_effect=RuntimeError("stream closed"))
        client = _app(live, cleanup=self.addCleanup)
        # 变更已经落库; 通知发不出去只能记日志 —— 报成工具失败会让模型重试并二次改库。
        self.assertTrue(self._note(client, "op-inv-0007")["ok"])
        self.assertTrue(self.repository.notes(self.item_id))


class CurationFulltextAttach(unittest.TestCase):
    """literature/fulltext-attach: 挂主附件, 且任何入口都不许替换已有全文。"""

    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="curation-attach-")
        self.addCleanup(temporary.cleanup)
        self.files = Path(temporary.name).resolve() / "literature-files"
        for owner in LITERATURE_FILE_OWNERS:
            owner_patch = patch(f"{owner}.SERVICE_LITERATURE_FILES_DIR", self.files)
            owner_patch.start()
            self.addCleanup(owner_patch.stop)
        self.repository = LiteratureRepository()
        saved = self.repository.save_all((LiteratureItem(id="lit-attach", title="Gamma"),))
        self.item_id = saved[0].id
        self.addCleanup(self.repository.delete, self.item_id, True)
        self.forgotten: list[str] = []

    def _client(
        self,
        assistant: SimpleNamespace | None = None,
        mode: str = "ask",
        with_indexes: bool = False,
    ) -> TestClient:
        indexes = None
        if with_indexes:
            indexes = SimpleNamespace(
                forget_literature=lambda revisions: self.forgotten.extend(revisions) or 0
            )
        return _app(
            _live(mode=mode), cleanup=self.addCleanup, assistant=assistant, pdf_indexes=indexes
        )

    def _attach(self, client: TestClient, op_id: str, **overrides: Any) -> dict:
        payload: dict[str, Any] = {
            "literature_id": self.item_id,
            "artifact_id": ARTIFACT_ID,
            "client_op_id": op_id,
        }
        payload.update(overrides)
        return _call(client, "fulltext-attach", payload)

    def _rows(self) -> list[dict]:
        return self.repository.attachments(self.item_id)

    def _primary(self) -> LiteratureAttachment:
        primary = self.repository.primary_attachment(self.item_id)
        self.assertIsNotNone(primary)
        assert primary is not None
        return primary

    def _managed_names(self) -> list[str]:
        return sorted(entry.name for entry in self.files.glob("*")) if self.files.is_dir() else []

    def test_a_session_pdf_becomes_the_primary_fulltext(self) -> None:
        client = self._client()
        result = self._attach(client, "op-attach-0001")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["item"]["id"], self.item_id)
        self.assertTrue(result["item"]["has_fulltext"])
        primary = self._primary()
        self.assertEqual(primary.role, AttachmentRole.PRIMARY)
        self.assertEqual(primary.media_type, PDF_MEDIA_TYPE)
        self.assertEqual(Path(primary.path).read_bytes(), PDF_BYTES)
        # 全文是派生状态: 工具不写 fulltext 列, 是 add_attachment 在同一事务里置的 READY。
        self.assertEqual(self.repository.get(self.item_id).fulltext, FulltextStatus.READY)
        self.assertEqual(len(self._managed_names()), 1)

    def test_a_usable_primary_attachment_is_never_replaced(self) -> None:
        self.assertTrue(self._attach(self._client(), "op-attach-0002")["ok"])
        before = self._primary()
        # 另一份字节、另一个 op: 换的意图很明确, 但不变式不给任何调用方留门。
        replaced = pdf_payload("Replacement")
        replacement = self._client(_assistant(replaced, "replacement.pdf"))
        result = self._attach(replacement, "op-attach-0003")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], ARXIV_ALREADY_ATTACHED)
        self.assertEqual(result["next_action"], NEXT_ACTIONS[ARXIV_ALREADY_ATTACHED])
        after = self._primary()
        self.assertEqual(after.id, before.id)
        self.assertEqual(after.role, AttachmentRole.PRIMARY)
        self.assertEqual(Path(after.path).read_bytes(), PDF_BYTES)
        self.assertNotEqual(Path(after.path).read_bytes(), replaced)
        # 既没有新增行, 也没有把旧主附件降级成补充材料。
        self.assertEqual([row["id"] for row in self._rows()], [before.id])
        self.assertEqual(len(self._managed_names()), 1)

    def test_a_lost_primary_attachment_is_replaced_and_purged(self) -> None:
        self.assertTrue(self._attach(self._client(), "op-attach-0004")["ok"])
        lost = self._primary()
        Path(lost.path).unlink()
        recovered_bytes = pdf_payload("Recovered")
        recovered = self._client(_assistant(recovered_bytes, "recovered.pdf"), with_indexes=True)
        result = self._attach(recovered, "op-attach-0005")
        self.assertTrue(result["ok"], result)
        # 行在而字节丢是「需要补救」而不是「需要拒绝」; 补挂后旧的丢失行被删掉而不是
        # 降级成一条永远 missing 的补充材料, 且它派生的全文索引一并忘掉。
        rows = [row["id"] for row in self._rows()]
        self.assertEqual(rows, [self._primary().id])
        self.assertNotIn(lost.id, rows)
        self.assertEqual(self.forgotten, [lost.revision])
        self.assertEqual(len(self._managed_names()), 1)
        self.assertEqual(Path(self._primary().path).read_bytes(), recovered_bytes)

    def test_a_non_pdf_payload_leaves_no_attachment_row(self) -> None:
        client = self._client(_assistant(PNG, "figure.png"))
        result = self._attach(client, "op-attach-0006")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], ATTACHMENT_TYPE_MISMATCH)
        self.assertIsNone(self.repository.primary_attachment(self.item_id))
        self.assertEqual(self._rows(), [])
        self.assertEqual(self._managed_names(), [])
        self.assertEqual(self.repository.get(self.item_id).fulltext, FulltextStatus.NONE)

    def test_a_replayed_client_op_id_adds_no_second_attachment(self) -> None:
        client = self._client()
        payload = {
            "literature_id": self.item_id,
            "artifact_id": ARTIFACT_ID,
            "client_op_id": "op-attach-0007",
        }
        self.assertTrue(_call(client, "fulltext-attach", payload)["ok"])
        replayed = _call(client, "fulltext-attach", payload)
        self.assertTrue(replayed["ok"])
        self.assertTrue(replayed["replayed"])
        self.assertEqual(len(self._rows()), 1)
        self.assertEqual(len(self._managed_names()), 1)

    def test_a_read_only_session_cannot_attach(self) -> None:
        client = self._client(mode="read_only")
        response = client.post(
            LITERATURE_CURATION_ROUTES["fulltext-attach"],
            json={
                "literature_id": self.item_id,
                "artifact_id": ARTIFACT_ID,
                "client_op_id": "op-attach-0008",
            },
            headers=HEADERS,
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"], PERMISSION_DENIED)
        self.assertEqual(self._rows(), [])

    def test_a_successful_attach_announces_the_literature_scope_once(self) -> None:
        live = _live()
        client = _app(live, cleanup=self.addCleanup, assistant=_assistant())
        self.assertTrue(self._attach(client, "op-attach-0009")["ok"])
        live.publish.assert_awaited_once()
        kind, data = live.publish.await_args.args
        self.assertEqual(kind, PRODUCT_EVENT_PRODUCT_DATA_CHANGED)
        self.assertEqual(data, {"scopes": [SCOPE_LITERATURE]})

    def test_an_artifact_hash_mismatch_leaves_no_residue(self) -> None:
        client = self._client(_assistant(error=ARTIFACT_REVISION_CONFLICT))
        result = self._attach(client, "op-attach-0010", expected_sha256="0" * 64)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], ARTIFACT_REVISION_CONFLICT)
        self.assertEqual(self._rows(), [])
        self.assertEqual(self._managed_names(), [])

    def test_an_unknown_literature_id_reports_not_found(self) -> None:
        client = self._client()
        result = self._attach(client, "op-attach-0011", literature_id="lit-missing")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], LITERATURE_NOT_FOUND)
        self.assertEqual(self._managed_names(), [])

    def test_the_pointer_contract_requires_exactly_one_artifact_source(self) -> None:
        for payload in (
            {"literature_id": "x", "client_op_id": "op-attach-0012"},
            {
                "literature_id": "x",
                "artifact_id": ARTIFACT_ID,
                "path": "paper.pdf",
                "client_op_id": "op-attach-0013",
            },
        ):
            with self.assertRaises(ValidationError):
                LITERATURE_CURATION_REQUESTS["fulltext-attach"].model_validate(payload)


if __name__ == "__main__":
    unittest.main()
