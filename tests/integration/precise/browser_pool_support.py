import os
from pathlib import Path

from browser_pool import BrowserPool

ROOT = Path(__file__).resolve().parents[3]


def pool_environment(root):
    environment = os.environ.copy()
    for key in (
        "PAPER_DL_CDP_ENDPOINT",
        "PAPER_DL_CDP_PROFILE",
        "PAPER_DL_AUTO_LAUNCH_CHROME",
        "PAPER_DL_CONFIG",
        "PAPER_DL_PROFILE_TEMPLATE",
    ):
        environment.pop(key, None)
    environment.update(
        {
            "PAPER_DL_BROWSER_POOL_DIR": str(Path(root) / "pool"),
            "PAPER_DL_CHROME_EXECUTABLE": str(
                ROOT / "tests/integration/precise/fixtures/fake_chrome.py"
            ),
            "PAPER_DL_ZOTERO_MODE": "off",
            "PAPER_DL_CDP_STARTUP_TIMEOUT": "3",
        }
    )
    return environment


def cleanup_pool(root):
    pool = BrowserPool(Path(root) / "pool")
    for state in pool.status():
        if state:
            lease = pool.acquire(Path(state["run_dir"]), existing_only=True, maintenance=True)
            try:
                lease.release()
            finally:
                lease.close()
