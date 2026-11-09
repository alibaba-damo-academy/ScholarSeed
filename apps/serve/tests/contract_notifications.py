from __future__ import annotations

import asyncio
import sqlite3
import tempfile
import unittest
from pathlib import Path

from service.literature.persistence.store import LiteratureRepository
from service.literature.schema import LiteratureItem
from service.persistence.notifications import NotificationConnection, NotificationRule
from service.platform.notifications import Change, ChangeHub, ChangeTopic


class CommitNotifications(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = sqlite3.connect(":memory:", factory=NotificationConnection)
        self.addCleanup(self.connection.close)
        self.connection.execute("CREATE TABLE document(id TEXT PRIMARY KEY, value TEXT)")
        self.received: list[Change] = []
        self.connection.observe(
            self.received.extend,
            (NotificationRule("document", "INSERT", ChangeTopic.RECORDS, "'owner'", "NEW.id"),),
        )

    def test_commit_is_the_publication_boundary(self) -> None:
        with self.connection:
            self.connection.execute("INSERT INTO document VALUES ('one', 'value')")
            self.assertEqual(self.received, [])
        self.assertEqual(self.received, [Change(ChangeTopic.RECORDS, "owner", "one")])

    def test_rollback_and_savepoint_do_not_publish(self) -> None:
        self.connection.execute("BEGIN")
        self.connection.execute("SAVEPOINT edit")
        self.connection.execute("INSERT INTO document VALUES ('one', 'value')")
        self.connection.execute("ROLLBACK TO edit")
        self.connection.commit()
        self.assertEqual(self.received, [])
        with self.assertRaises(RuntimeError), self.connection:
            self.connection.execute("INSERT INTO document VALUES ('two', 'value')")
            raise RuntimeError("abort")
        self.assertEqual(self.received, [])

    def test_changes_are_coalesced_within_a_transaction(self) -> None:
        with self.connection:
            self.connection.execute("INSERT INTO document VALUES ('one', 'value')")
            self.connection.execute("DELETE FROM document")
            self.connection.execute("INSERT INTO document VALUES ('one', 'new')")
        self.assertEqual(len(self.received), 1)

    def test_noop_updates_do_not_create_notifications(self) -> None:
        connection = sqlite3.connect(":memory:", factory=NotificationConnection)
        self.addCleanup(connection.close)
        connection.execute("CREATE TABLE item(id TEXT PRIMARY KEY, value TEXT)")
        with connection:
            connection.execute("INSERT INTO item VALUES ('one','value')")
        connection.observe(
            self.received.extend, (NotificationRule("item", "UPDATE", ChangeTopic.RECORDS),)
        )
        with connection:
            connection.execute("UPDATE item SET value='value'")
        self.assertEqual(self.received, [])
        with connection:
            connection.execute("UPDATE item SET value='changed'")
        self.assertEqual(len(self.received), 1)


class NotificationSubscriptions(unittest.IsolatedAsyncioTestCase):
    async def test_literature_mutations_reach_shared_stream_after_commit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            hub = ChangeHub("instance")
            repository = LiteratureRepository(Path(directory) / "literature.sqlite3", changes=hub)
            stream = hub.events("owner")
            await anext(stream)
            try:
                repository.save(LiteratureItem(id="paper", title="Paper"))
                self.assertIn('"topic":"literature"', await asyncio.wait_for(anext(stream), 1))
                attachment = repository.add_attachment(
                    "paper", "paper.pdf", "paper.pdf", revision="sha256:test"
                )
                self.assertIn('"topic":"literature"', await asyncio.wait_for(anext(stream), 1))
                note = repository.create_note("paper", "note")
                self.assertIn('"topic":"literature"', await asyncio.wait_for(anext(stream), 1))
                repository.delete_note("paper", note.id)
                self.assertIn('"topic":"literature"', await asyncio.wait_for(anext(stream), 1))
                repository.delete_attachment("paper", attachment["id"])
                self.assertIn('"topic":"literature"', await asyncio.wait_for(anext(stream), 1))
                self.assertEqual(repository.attachments("paper"), [])
            finally:
                await stream.aclose()

    async def test_ready_registration_scope_and_cleanup(self) -> None:
        hub = ChangeHub("instance")
        stream = hub.events("owner")
        self.assertIn("event: ready", await anext(stream))
        hub.publish((Change(ChangeTopic.SESSIONS, "other", "private"),))
        hub.publish((Change(ChangeTopic.RECORDS, "owner", "visible"),))
        frame = await asyncio.wait_for(anext(stream), 1)
        self.assertIn("visible", frame)
        self.assertNotIn("private", frame)
        await stream.aclose()
        self.assertEqual(hub.subscriber_count, 0)


if __name__ == "__main__":
    unittest.main()
