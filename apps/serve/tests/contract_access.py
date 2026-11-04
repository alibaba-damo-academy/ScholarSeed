"""Access logging must retain failures and non-polling requests."""

from __future__ import annotations

import logging
import unittest

from service.cli.access import AccessFilter


class AccessContracts(unittest.TestCase):
    def kept(
        self, target: str, *, desktop: bool = True, method: str = "GET", status: int = 200
    ) -> bool:
        record = logging.LogRecord(
            "uvicorn.access",
            logging.INFO,
            __file__,
            1,
            '%s - "%s %s HTTP/%s" %d',
            ("127.0.0.1:12345", method, target, "1.1", status),
            None,
        )
        return AccessFilter(quiet_desktop_polls=desktop).filter(record)

    def test_only_desktop_suppresses_successful_poll_requests(self):
        for target in (
            "/api/serve/attention",
            "/api/serve/sessions?limit=60&scope=all",
            "/api/serve/sessions?scope=all&limit=60",
            "/api/content/projects",
        ):
            with self.subTest(target=target):
                self.assertFalse(self.kept(target))
                self.assertTrue(self.kept(target, desktop=False))
                self.assertTrue(self.kept(target, method="POST"))
                self.assertTrue(self.kept(target, status=401))
                self.assertTrue(self.kept(target, status=503))

    def test_near_matches_and_other_requests_are_kept(self):
        for target in (
            "/api/serve/attention/notification/navigation",
            "/api/serve/sessions",
            "/api/serve/sessions?limit=60&scope=project",
            "/api/serve/sessions?limit=60&scope=all&cursor=",
            "/api/serve/sessions?limit=60&scope=all&limit=60",
            "/api/content/projects?includeArchived=true",
            "/api/content/projects/project/tree",
            "/api/healthz/other",
            "/api/serve/sessions?query=/api/healthz",
        ):
            with self.subTest(target=target):
                self.assertTrue(self.kept(target))

    def test_only_successful_get_to_known_health_paths_is_suppressed(self):
        for target in ("/api/healthz", "/api/healthz/backend"):
            with self.subTest(target=target):
                self.assertFalse(self.kept(target, desktop=False))
                self.assertTrue(self.kept(target, status=503))
                self.assertTrue(self.kept(target, method="HEAD"))

    def test_unknown_record_shape_is_kept(self):
        record = logging.LogRecord(
            "uvicorn.access", logging.INFO, __file__, 1, "unexpected /api/healthz", (), None
        )
        self.assertTrue(AccessFilter(quiet_desktop_polls=True).filter(record))


if __name__ == "__main__":
    unittest.main()
