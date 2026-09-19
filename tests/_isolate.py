"""Research-DB 测试隔离 (proposal 14 追加契约: 默认库 = 当前 workspace)。

`default_research_db()` 现解析到 `<cwd>/.scholarseed/research.db` — 测试进程 cwd 通常是 repo 根,
不显式 pin 就会把夹具行写进 repo 的 `.scholarseed/research.db` (用户裁定: 泄漏 = FAIL)。

每个会触研究库的套件必须在**任何 first-party import 之前**调用 `isolate_research_db()`:
它把 `SCHOLARSEED_RESEARCH_DB` pin 到独立临时目录并返回该 db 路径 (子进程经继承的 os.environ
自动跟随 — 与 serve↔CLI 的跨进程契约同一机制)。

注: env 键在此按字面量声明 — 原单一来源 `work.scholar.kernel.paths.RESEARCH_DB_ENV` 已随 legacy
research runtime (bc6992e2) 删除; 隔离本就必须发生在 import 任何 first-party 模块之前, 故字面量
即唯一声明 (# noqa 同类豁免)。产品源码现已无人读该 env, 隔离仅为存留套件的兜底。

`service.brand` 是例外: 它刻意只依赖标准库、不 import damoagent, 就是为了能在最早期被调用。
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from service import brand

RESEARCH_DB_ENV = "SCHOLARSEED_RESEARCH_DB"


def isolate_research_db(prefix: str = "scholarseed-test-db-") -> Path:
    """把研究库 pin 到独立临时文件, 返回该路径 (幂等重设: 每套件一个新库)。"""
    db = Path(tempfile.mkdtemp(prefix=prefix)) / "research.db"
    os.environ[RESEARCH_DB_ENV] = str(db)
    return db


def apply_project_dirname() -> str:
    """让测试进程按产品品牌解析项目态目录名, 返回该目录名。

    不设则回落到 Agent 层默认的 `.damoagent`; 而契约断言的是**产品**行为, 因此必须跟随
    `brand.PROJECT_DIRNAME` 这个单一来源 —— 硬编码品牌字面量是 Veda→书深 更名时这批
    断言集体失效的直接原因。

    `damoagent.core.host.paths.PROJECT_DIRNAME` 是模块级常量 (import 时即求值), 所以本函数
    必须在任何 damoagent import 之前调用 —— 与 `isolate_research_db()` 同一时序要求。
    setdefault 语义: 运维/用户显式指定的值仍优先。
    """
    os.environ.setdefault(brand.PROJECT_DIRNAME_ENV, brand.PROJECT_DIRNAME)
    return brand.PROJECT_DIRNAME


__all__ = ["RESEARCH_DB_ENV", "apply_project_dirname", "isolate_research_db"]
