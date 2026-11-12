"""brand.py — 书深产品身份与运行时根默认值。

产品拥有 SCHOLARSEED_HOME。Trace 与 Codex 各自拥有独立的路径配置入口；本模块仅在
产品启动时填入它们的缺省值，不覆盖用户显式配置，也不把业务路径放入 Runtime 契约包。

路径消费者含 import 时求值的常量，因此产品入口须先调用 apply_runtime_defaults，
再导入 Serve、Trace 与 Adapter。源码包重命名不更改既有 ~/.scholarseed 数据目录。
"""

from __future__ import annotations

import os
from pathlib import Path

from service.platform import proxy

PRODUCT_NAME = "书深"
#: 产品的 ASCII 标识（用于文件名、trace 事件命名空间等不便使用中文的场合）。
PRODUCT_SLUG = "scholarseed"
#: 用户级运行时根目录名（`~/.scholarseed`）。
HOME_DIRNAME = f".{PRODUCT_SLUG}"
#: 每个工作区内的项目态目录名（`<workspace>/.scholarseed`）。
PROJECT_DIRNAME = f".{PRODUCT_SLUG}"

HOME_ENV = "SCHOLARSEED_HOME"
PRODUCT_HOME_ENV = "SCHOLARSEED_HOME"
#: 产品入口使用的项目状态目录名配置。
PROJECT_DIRNAME_ENV = "SCHOLARSEED_PROJECT_DIRNAME"
PRODUCT_PROJECT_DIRNAME_ENV = "SCHOLARSEED_PROJECT_DIRNAME"
TRACE_HOME_ENV = "DAMOATRACE_HOME"
TRACE_LEDGER_ROOT_ENV = "DAMOATRACE_LEDGER_ROOT"
CODEX_HOME_ENV = "SCHOLARSEED_CODEX_HOME"
CODEX_DIRNAME = "codex"
PROJECTS_DIRNAME = "projects"


def default_home() -> Path:
    """书深默认的用户级运行时根。"""

    return Path.home() / HOME_DIRNAME


def apply_runtime_defaults() -> None:
    """把书深的运行时根写入环境变量（不覆盖用户已显式指定的值）。

    必须在导入路径消费者前调用，确保它们首次求值时取得产品默认配置。
    """

    product_home = os.environ.get(PRODUCT_HOME_ENV, "").strip()
    product_project_dirname = os.environ.get(PRODUCT_PROJECT_DIRNAME_ENV, "").strip()
    os.environ.setdefault(HOME_ENV, product_home or str(default_home()))
    os.environ.setdefault(PROJECT_DIRNAME_ENV, product_project_dirname or PROJECT_DIRNAME)
    os.environ.setdefault(TRACE_HOME_ENV, os.environ[HOME_ENV])
    os.environ.setdefault(TRACE_LEDGER_ROOT_ENV, str(Path(os.environ[HOME_ENV]) / PROJECTS_DIRNAME))
    os.environ.setdefault(CODEX_HOME_ENV, str(Path(os.environ[HOME_ENV]) / CODEX_DIRNAME))
    proxy.apply()
