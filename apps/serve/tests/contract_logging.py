"""Access logging preserves failures while silencing successful attention polls."""

from __future__ import annotations

import logging
import unittest

from service.cli.access import AccessFilter


class AttentionLoggingContracts(unittest.TestCase):
    def test_only_successful_attention_gets_are_silent(self):
        access_filter = AccessFilter(quiet_desktop_polls=True)
        for method, path, status, expected in (
            ("GET", "/api/serve/attention", 200, False),
            ("GET", "/api/serve/attention?revision=1", 200, True),
            ("GET", "/api/serve/attention", 204, True),
            ("GET", "/api/serve/attention", 299, True),
            ("GET", "/api/serve/attention", 199, True),
            ("GET", "/api/serve/attention", 302, True),
            ("GET", "/api/serve/attention", 401, True),
            ("GET", "/api/serve/attention", 500, True),
            ("POST", "/api/serve/attention", 200, True),
            ("POST", "/api/serve/attention/read", 200, True),
            ("GET", "/api/serve/attention/abc/navigation", 200, True),
            ("GET", "/api/serve/attention-extra", 200, True),
            ("GET", "/api/other?next=/api/serve/attention", 200, True),
        ):
            with self.subTest(method=method, path=path, status=status):
                record = logging.LogRecord(
                    "uvicorn.access",
                    logging.INFO,
                    __file__,
                    0,
                    '%s - "%s %s HTTP/%s" %d',
                    ("127.0.0.1:1234", method, path, "1.1", status),
                    None,
                )
                self.assertEqual(access_filter.filter(record), expected)

    def test_unknown_records_and_warnings_are_preserved(self):
        for arguments, level in (
            ((), logging.INFO),
            (("unexpected",), logging.INFO),
            (("client", "GET", "/api/serve/attention", "1.1", "200"), logging.INFO),
            (("client", "GET", "/api/serve/attention", "1.1", 200), logging.WARNING),
        ):
            with self.subTest(arguments=arguments, level=level):
                record = logging.LogRecord(
                    "uvicorn.access",
                    level,
                    __file__,
                    0,
                    "attention diagnostic",
                    arguments,
                    None,
                )
                self.assertTrue(AccessFilter(quiet_desktop_polls=True).filter(record))


if __name__ == "__main__":
    unittest.main()
