"""service 单一边界门禁 (proposal 57 §0.1 要求 2 · 01 §3.1)。

裁定: `service/**` 不得穿透 `damoagent.core` / `damoagent.work`。原生外部 Runtime 的稳定契约
明确由 `damoagent.proto.surface` 拥有，因此书深 Service 可以直接消费该零逻辑协议，并通过
`damoagent.surface` 打开 Runtime；其他 proto 域仍须经 public facade。

例外 (01 §4.1#3): 机制路径解析 owner = `damoagent/damoagent/core/host/paths.py`, obs/store 同属 core infra
bedrock。service/paths.py 从此 root 派生业务路径 (SCHOLARSEED_HOME 单一来源), 结构化日志同源 ——
`damoagent.host.*` 是被明确认可的 infra bedrock 依赖, 不算穿透 core agent 机制。

豁免 (合理的"知道全层"的装配点):
- composition root: service/cli/scholarseed.py · service/cli/serve.py · service/app.py
- 测试目录 (test 夹具可直连真实来源做断言)。

跑法: .venv/bin/python -m tests.contract_service_sdk_only (确定性, 不烧 token)。
"""

from __future__ import annotations

import ast
import pathlib
import subprocess
import sys

PASS, FAIL = 0, 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


# 豁免文件 (相对 repo 根)。
_EXEMPT = {
    "service/cli/scholarseed.py",
    "service/cli/serve.py",
    "service/app.py",
}
_EXEMPT_DIR_PARTS = ("tests",)
_EXEMPT_PREFIX: tuple[str, ...] = ()
# 01 §3.1: service 禁直接 import damoagent.proto / damoagent.core / damoagent.work (穿透下层协议/机制/agent);
# 下层能力一律经 damoagent (含 sdk.ext facade 端口) 与 damoagent.substrate record 取用。
_FORBIDDEN_ROOTS = ("damoagent.core", "damoagent.work", "damoagent.sdk", "damoagent.bench")
_ALLOWED_PROTO_SURFACE = ("damoagent.proto.surface",)
# 01 §4.1#3: 真实机制路径解析 owner = damoagent/damoagent/core/host/paths.py; obs/store 同属 core **infra**
# bedrock (CLAUDE.md 纯净铁律: infra paths/obs/sqlite_fts 是 core 自身的一部分)。service 业务
# 路径 (service/paths.py) 必须从此 root 派生 SCHOLARSEED_HOME, 结构化日志同源 —— 这是被明确认可的
# infra bedrock 依赖, 非穿透 core agent 机制 (loop/tool/memory 等仍禁)。
_ALLOWED_CORE_INFRA = ("damoagent.host",)


def _is_exempt(rel: str, parts: tuple) -> bool:
    if rel in _EXEMPT:
        return True
    if any(p in parts for p in _EXEMPT_DIR_PARTS):
        return True
    if any(rel.startswith(pre) for pre in _EXEMPT_PREFIX):
        return True
    return False


def _forbidden_mod(mod: str | None) -> bool:
    if not mod:
        return False
    if any(mod == a or mod.startswith(a + ".") for a in _ALLOWED_CORE_INFRA):
        return False  # core infra bedrock (paths/obs/store) — 01 §4.1#3, 允许
    if any(mod == a or mod.startswith(a + ".") for a in _ALLOWED_PROTO_SURFACE):
        return False
    return any(mod == r or mod.startswith(r + ".") for r in _FORBIDDEN_ROOTS)


def _boundary() -> None:
    print("\n── service 单一边界 (service → damoagent.surface / damoagent public facade) ──")
    root = pathlib.Path(__file__).resolve().parents[3]
    svc = root / "apps" / "serve" / "service"
    violations: list[str] = []
    scanned = 0
    for f in sorted(svc.rglob("*.py")):
        rel = str(f.relative_to(root))
        if _is_exempt(rel, f.parts):
            continue
        scanned += 1
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
        for n in ast.walk(tree):
            mods: list[str] = []
            if isinstance(n, ast.ImportFrom) and n.level == 0:
                mods.append(n.module or "")
            elif isinstance(n, ast.Import):
                mods.extend(a.name for a in n.names)
            for m in mods:
                if _forbidden_mod(m) or m == "damoagent.ext" or m.startswith("damoagent.ext."):
                    violations.append(f"{rel}:{getattr(n, 'lineno', '?')} → {m}")
    check(
        f"service 业务面零 damoagent.ext / damoagent.proto / damoagent.work / damoagent.core(除 host infra bedrock) import (扫 {scanned} 文件)",
        not violations,
        str(violations[:8]),
    )


def _harness_removed() -> None:
    """The product consumes only contracts, host infrastructure and external runtime transport."""

    print("\n── 自研 Harness 已从公开运行时边界移除 ──")
    root = pathlib.Path(__file__).resolve().parents[3]
    tracked = subprocess.run(
        ["git", "ls-files", "packages/damoagent/damoagent"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    ).stdout.splitlines()
    residual = [
        path
        for path in tracked
        if any(f"damoagent/{name}/" in path for name in ("core", "work", "sdk", "bench"))
    ]
    check("DamoAgent 已跟踪源码不再包含自研 Harness", not residual, str(residual[:5]))


def main() -> int:
    _boundary()
    _harness_removed()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
