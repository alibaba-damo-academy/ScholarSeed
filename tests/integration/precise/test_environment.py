import os
import unittest
from unittest import mock

from environment import download_environment


class DownloadEnvironmentTests(unittest.TestCase):
    def test_product_credentials_are_not_forwarded(self):
        supplied = {
            "HOME": "/test/home",
            "PATH": "/test/bin",
            "PAPER_DL_MODE": "interactive",
            "PLAYWRIGHT_NODEJS_PATH": "/product/browser/node",
            "NODE_OPTIONS": "--require=/unrelated/module.js",
            "SCHOLARSEED_PYTHON": "/product/python",
            "SCHOLARSEED_SKILLHUB_TOKEN": "synthetic-hub-secret",
            "OPENAI_API_KEY": "synthetic-model-secret",
            "PAPERHUB_API_KEY": "synthetic-search-secret",
        }
        with mock.patch.dict(os.environ, supplied, clear=True):
            self.assertEqual(
                download_environment(),
                {
                    "HOME": "/test/home",
                    "PATH": "/test/bin",
                    "PAPER_DL_MODE": "interactive",
                    "PLAYWRIGHT_NODEJS_PATH": "/product/browser/node",
                },
            )


if __name__ == "__main__":
    unittest.main()
