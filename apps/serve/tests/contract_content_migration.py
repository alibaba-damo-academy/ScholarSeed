"""存量迁移与删除接缝契约 (proposal 47 阶段四)。

迁移是整个提案里唯一动用户真实文件的步骤, 因此这里钉的是**四种情形都有确定
结果**: 正常、目标已存在、逐项暂不迁移、单项失败可回滚。外加两条边界:

- 未全部搬完的项目仍按 LEGACY 解析 —— 否则留在根下的资料会从资料树里消失,
  用户看到一个「半空」的资料库, 而文件其实还在磁盘上;
- 删除令牌只有主进程能兑换。渲染层拿不到绝对路径, 没带密钥的兑换一律 403;
  密钥没配时兑换整条关闭 (fail closed), 而不是「没配就放行」。
"""

from __future__ import annotations

import ctypes
import os
import stat
import subprocess
import sys
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from service.content.api.routes import register_content_routes
from service.content.domain.model import (
    LITERATURE_ROOT_RELATIVE,
    MANAGED_LITERATURE_ROOT_RELATIVE,
    MANAGED_RESOURCES_ROOT_RELATIVE,
)
from service.content.persistence.catalog import AUDIT_MIGRATE, ContentCatalog
from service.content.service.port import ContentService, ProjectRegistry
from service.identity.utils import HOST_PROCESS_HEADER, HOST_PROCESS_KEY_ENV
from service.platform.activity import Activities
from service.platform.content import ProjectLayout, RootKind

PASS = 0
FAIL = 0
HOST_KEY = "contract-host-process-key"


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name} {detail}")


def _legacy_project(root: Path, name: str) -> Path:
    """铺一个存量项目: 资料铺在根下, 文献在 `文献/`。"""

    project = root / name
    (project / LITERATURE_ROOT_RELATIVE).mkdir(parents=True)
    (project / LITERATURE_ROOT_RELATIVE / "论文.pdf").write_bytes(b"%PDF-1.4 fake")
    (project / "笔记").mkdir()
    (project / "笔记" / "想法.md").write_text("旧内容", encoding="utf-8")
    (project / "数据.csv").write_text("a,b\n1,2\n", encoding="utf-8")
    return project


def _acl(path: Path, script: str, original: str = "") -> str:
    return subprocess.run(
        [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference='Stop'; " + script,
        ],
        env={**os.environ, "CONTRACT_DIRECTORY": str(path), "CONTRACT_DIRECTORY_SDDL": original},
        capture_output=True,
        text=True,
        check=True,
        timeout=15,
    ).stdout.strip()


@contextmanager
def _ordinary_file_privileges() -> Iterator[None]:
    """Temporarily remove backup/restore bypass from this test process only."""
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    security = ctypes.WinDLL("advapi32", use_last_error=True)
    handle = ctypes.c_void_p
    word = ctypes.c_uint32
    kernel.GetCurrentProcess.restype = handle
    kernel.CloseHandle.argtypes = [handle]
    kernel.CloseHandle.restype = ctypes.c_int
    security.OpenProcessToken.argtypes = [handle, word, ctypes.POINTER(handle)]
    security.OpenProcessToken.restype = ctypes.c_int
    security.LookupPrivilegeValueW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_void_p]
    security.LookupPrivilegeValueW.restype = ctypes.c_int
    security.AdjustTokenPrivileges.argtypes = [
        handle,
        ctypes.c_int,
        ctypes.c_void_p,
        word,
        ctypes.c_void_p,
        ctypes.POINTER(word),
    ]
    security.AdjustTokenPrivileges.restype = ctypes.c_int
    token = handle()
    token_query, token_adjust_privileges = 0x0008, 0x0020
    not_all_assigned = 1300
    if not security.OpenProcessToken(
        kernel.GetCurrentProcess(), token_query | token_adjust_privileges, ctypes.byref(token)
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    previous_states = []
    try:
        for name in ("SeBackupPrivilege", "SeRestorePrivilege"):
            # TOKEN_PRIVILEGES with one LUID_AND_ATTRIBUTES: DWORD count,
            # DWORD LUID low/high, DWORD attributes (zero disables, not removes).
            requested = (word * 4)(1, 0, 0, 0)
            previous = (word * 4)()
            length = word()
            if not security.LookupPrivilegeValueW(
                None, name, ctypes.byref(requested, ctypes.sizeof(word))
            ):
                raise ctypes.WinError(ctypes.get_last_error())
            ctypes.set_last_error(0)
            changed = security.AdjustTokenPrivileges(
                token, False, requested, ctypes.sizeof(previous), previous, ctypes.byref(length)
            )
            error = ctypes.get_last_error()
            if not changed or error not in (0, not_all_assigned):
                raise ctypes.WinError(error)
            previous_states.append(previous)
        yield
    finally:
        try:
            for previous in reversed(previous_states):
                ctypes.set_last_error(0)
                restored = security.AdjustTokenPrivileges(token, False, previous, 0, None, None)
                error = ctypes.get_last_error()
                if not restored or error:
                    raise ctypes.WinError(error)
        finally:
            if not kernel.CloseHandle(token):
                raise ctypes.WinError(ctypes.get_last_error())


@contextmanager
def _readonly_directory(path: Path) -> Iterator[None]:
    """Deny child creation on this test-owned directory, then restore its authority."""
    if sys.platform != "win32":
        original_mode = stat.S_IMODE(path.stat().st_mode)
        try:
            path.chmod(0o500)
            yield
        finally:
            path.chmod(original_mode)
        return
    original_acl = _acl(path, "(Get-Acl -LiteralPath $env:CONTRACT_DIRECTORY).Sddl")
    try:
        _acl(
            path,
            """
$acl = Get-Acl -LiteralPath $env:CONTRACT_DIRECTORY
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$rights = [System.Security.AccessControl.FileSystemRights]'CreateFiles,CreateDirectories,DeleteSubdirectoriesAndFiles'
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, [System.Security.AccessControl.AccessControlType]::Deny)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:CONTRACT_DIRECTORY -AclObject $acl
""",
        )
        with _ordinary_file_privileges():
            yield
    finally:
        _acl(
            path,
            """
$acl = Get-Acl -LiteralPath $env:CONTRACT_DIRECTORY
$acl.SetSecurityDescriptorSddlForm($env:CONTRACT_DIRECTORY_SDDL)
Set-Acl -LiteralPath $env:CONTRACT_DIRECTORY -AclObject $acl
""",
            original_acl,
        )


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="content-migration-")).resolve()
    workspace = root / "workspace"
    workspace.mkdir()
    legacy = _legacy_project(root, "老项目")
    partial = _legacy_project(root, "半迁项目")

    catalog = ContentCatalog(root / "content.sqlite3")
    registry = ProjectRegistry(str(workspace), catalog)
    registry.seed_legacy(((legacy, "老项目"), (partial, "半迁项目")))
    registry.seed_workspace()
    content = ContentService(registry, catalog, activities=Activities())
    legacy_ref = next(item for item in content.projects() if item.root == str(legacy))
    partial_ref = next(item for item in content.projects() if item.root == str(partial))

    # ---- dry-run ----
    plan = content.migration_plan(legacy_ref.id)
    sources = {entry.source for entry in plan.entries}
    check("dry-run 列出顶层条目, 不动文件", sources == {"文献", "笔记", "数据.csv"}, str(sources))
    check(
        "dry-run 之后磁盘原样",
        (legacy / "数据.csv").is_file() and not (legacy / MANAGED_RESOURCES_ROOT_RELATIVE).exists(),
    )
    check("dry-run 给出体积量级", plan.total_size > 0, str(plan.total_size))
    check(
        "`文献` 整体成为 `literature`, 其余进 `resources`",
        {entry.source: entry.target for entry in plan.entries}
        == {
            "文献": MANAGED_LITERATURE_ROOT_RELATIVE,
            "笔记": f"{MANAGED_RESOURCES_ROOT_RELATIVE}/笔记",
            "数据.csv": f"{MANAGED_RESOURCES_ROOT_RELATIVE}/数据.csv",
        },
        str({entry.source: entry.target for entry in plan.entries}),
    )

    # ---- 正常迁移 ----
    outcome = content.migrate_project(legacy_ref.id)
    check(
        "迁移逐项成功且无失败项", set(outcome.moved) == sources and not outcome.failed, str(outcome)
    )
    check("迁移后转 MANAGED", outcome.layout is ProjectLayout.MANAGED)
    check(
        "内置双库在磁盘上就位, 资料真的搬过去了",
        (legacy / MANAGED_RESOURCES_ROOT_RELATIVE / "数据.csv").is_file()
        and (legacy / MANAGED_RESOURCES_ROOT_RELATIVE / "笔记" / "想法.md").is_file()
        and (legacy / MANAGED_LITERATURE_ROOT_RELATIVE / "论文.pdf").is_file(),
        str(sorted(item.name for item in legacy.iterdir())),
    )
    check(
        "原位置已清空, 没有留下重复副本",
        not (legacy / "数据.csv").exists() and not (legacy / "笔记").exists(),
    )
    names = {
        node.asset.path for node in content.tree(legacy_ref.id, RootKind.RESOURCES, 2).children
    }
    check(
        "迁移后的资料树按 MANAGED 解析且看得见资料",
        f"{MANAGED_RESOURCES_ROOT_RELATIVE}/数据.csv" in names,
        str(names),
    )
    check(
        "迁移写了审计",
        any(str(row["action"]) == AUDIT_MIGRATE for row in catalog.audit()),
    )
    check(
        "已是 MANAGED 的项目再迁移会被明确拒绝",
        content.migration_plan(legacy_ref.id).blocked == "already_managed",
    )

    # ---- 逐项「暂不迁移」: 仍按 LEGACY ----
    outcome = content.migrate_project(partial_ref.id, skip=("笔记",))
    check(
        "暂不迁移的条目留在原位",
        (partial / "笔记" / "想法.md").is_file(),
        str(sorted(item.name for item in partial.iterdir())),
    )
    check(
        "其余条目已搬到内置库", (partial / MANAGED_RESOURCES_ROOT_RELATIVE / "数据.csv").is_file()
    )
    check(
        "没搬完的项目仍按 LEGACY 解析 (留在根下的资料不能从树里消失)",
        outcome.layout is ProjectLayout.LEGACY
        and content.project(partial_ref.id).layout is ProjectLayout.LEGACY,
        str(outcome.layout),
    )
    legacy_names = {
        node.asset.path for node in content.tree(partial_ref.id, RootKind.RESOURCES, 1).children
    }
    check(
        "LEGACY 树里同时看得见未迁移条目与新建的库目录", "笔记" in legacy_names, str(legacy_names)
    )

    # ---- 目标已存在: 同名不覆盖 ----
    conflicted = _legacy_project(root, "撞名项目")
    (conflicted / MANAGED_RESOURCES_ROOT_RELATIVE).mkdir()
    (conflicted / MANAGED_RESOURCES_ROOT_RELATIVE / "数据.csv").write_text(
        "先来的", encoding="utf-8"
    )
    registry.seed_legacy(((conflicted, "撞名项目"),))
    conflicted_ref = next(item for item in content.projects() if item.root == str(conflicted))
    plan = content.migration_plan(conflicted_ref.id)
    check(
        "dry-run 提前标出目标已存在",
        any(entry.conflict for entry in plan.entries if entry.source == "数据.csv"),
        str([(entry.source, entry.conflict) for entry in plan.entries]),
    )
    content.migrate_project(conflicted_ref.id)
    check(
        "同名不覆盖: 两份资料都在",
        (conflicted / MANAGED_RESOURCES_ROOT_RELATIVE / "数据.csv").read_text(encoding="utf-8")
        == "先来的"
        and (conflicted / MANAGED_RESOURCES_ROOT_RELATIVE / "数据 (2).csv").is_file(),
        str(sorted(item.name for item in (conflicted / MANAGED_RESOURCES_ROOT_RELATIVE).iterdir())),
    )

    # ---- 中途失败: 单项失败只回滚该项, 原文件留在原处 ----
    blocked = _legacy_project(root, "受阻项目")
    # 目标位置被一个**文件**占住: 建目录必然失败, 于是那一项搬不过去。
    (blocked / MANAGED_RESOURCES_ROOT_RELATIVE).write_text("我不是目录", encoding="utf-8")
    registry.seed_legacy(((blocked, "受阻项目"),))
    blocked_ref = next(item for item in content.projects() if item.root == str(blocked))
    outcome = content.migrate_project(blocked_ref.id)
    check(
        "单项失败逐条回报, 不汇总成一句「部分失败」",
        bool(outcome.failed) and all(len(item) == 2 for item in outcome.failed),
        str(outcome.failed),
    )
    check(
        "失败项的原文件仍在原处 (没有被搬走也没有丢)",
        (blocked / "数据.csv").is_file() and (blocked / "笔记" / "想法.md").is_file(),
        str(sorted(item.name for item in blocked.iterdir())),
    )
    check("有失败项时项目不转 MANAGED", outcome.layout is ProjectLayout.LEGACY, str(outcome.layout))
    names = {
        node.asset.path for node in content.tree(blocked_ref.id, RootKind.RESOURCES, 1).children
    }
    check("失败后资料树照旧看得见资料 (仍按 LEGACY 解析)", "数据.csv" in names, str(names))

    # ---- 权限不足: 项目根只读 → 明确失败, 不是静默半迁 ----
    readonly = _legacy_project(root, "只读项目")
    registry.seed_legacy(((readonly, "只读项目"),))
    readonly_ref = next(item for item in content.projects() if item.root == str(readonly))
    with _readonly_directory(readonly):
        probe = readonly / ".write-probe"
        denied = False
        try:
            probe.mkdir()
        except PermissionError:
            denied = True
        else:
            probe.rmdir()
        check("权限夹具确实禁止创建子目录", denied)
        outcome = content.migrate_project(readonly_ref.id)
        check(
            "项目根不可写时逐项失败, 且不转 MANAGED",
            bool(outcome.failed) and outcome.layout is ProjectLayout.LEGACY,
            str(outcome),
        )
        check(
            "权限不足时用户的资料一个都没动",
            (readonly / "数据.csv").is_file() and (readonly / "笔记").is_dir(),
            str(sorted(item.name for item in readonly.iterdir())),
        )
    probe.mkdir()
    probe.rmdir()
    check("权限夹具退出后恢复写入权限", True)

    # ---- 删除令牌: 只有主进程能兑换 ----
    app = FastAPI()
    app.state.content = content
    app.state.workspace = str(workspace)
    register_content_routes(app)
    client = TestClient(app)
    target = legacy / MANAGED_RESOURCES_ROOT_RELATIVE / "数据.csv"
    issued = client.post(
        "/api/content/trash-token",
        json={"project": legacy_ref.id, "path": f"{MANAGED_RESOURCES_ROOT_RELATIVE}/数据.csv"},
    )
    token = str(issued.json().get("token") or "")
    check(
        "签发令牌成功且不含绝对路径",
        issued.status_code == 200 and bool(token) and str(target) not in token,
    )

    os.environ.pop(HOST_PROCESS_KEY_ENV, None)
    closed = client.post("/api/content/trash-token/redeem", json={"token": token})
    check(
        "未配主进程密钥时兑换整条关闭 (fail closed)",
        closed.status_code == 403 and closed.json().get("detail") == "host_process_only",
        closed.text[:120],
    )

    os.environ[HOST_PROCESS_KEY_ENV] = HOST_KEY
    try:
        without = client.post("/api/content/trash-token/redeem", json={"token": token})
        check("没带密钥头的兑换被拒", without.status_code == 403, without.text[:120])
        wrong = client.post(
            "/api/content/trash-token/redeem",
            json={"token": token},
            headers={HOST_PROCESS_HEADER: "wrong-key"},
        )
        check("密钥不对的兑换被拒", wrong.status_code == 403, wrong.text[:120])
        redeemed = client.post(
            "/api/content/trash-token/redeem",
            json={"token": token},
            headers={HOST_PROCESS_HEADER: HOST_KEY},
        )
        check(
            "主进程凭密钥兑换到待删绝对路径",
            redeemed.status_code == 200 and redeemed.json().get("absolute") == str(target),
            redeemed.text[:200],
        )
        again = client.post(
            "/api/content/trash-token/redeem",
            json={"token": token},
            headers={HOST_PROCESS_HEADER: HOST_KEY},
        )
        check("令牌用后即焚", again.status_code == 400, again.text[:120])
        premature = client.post(
            "/api/content/trash-token/complete",
            json={"token": token},
            headers={HOST_PROCESS_HEADER: HOST_KEY},
        )
        check(
            "文件仍在时拒绝删除完成回执且保留重试能力",
            premature.status_code == 400
            and premature.json().get("detail") == "trash_not_completed",
            premature.text[:120],
        )
        target.unlink()
        completed = client.post(
            "/api/content/trash-token/complete",
            json={"token": token},
            headers={HOST_PROCESS_HEADER: HOST_KEY},
        )
        check(
            "系统废纸篓成功后主进程回执逻辑路径",
            completed.status_code == 200
            and completed.json().get("path") == f"{MANAGED_RESOURCES_ROOT_RELATIVE}/数据.csv",
            completed.text[:120],
        )
        completed_again = client.post(
            "/api/content/trash-token/complete",
            json={"token": token},
            headers={HOST_PROCESS_HEADER: HOST_KEY},
        )
        check(
            "删除完成回执可安全重放",
            completed_again.status_code == 200,
            completed_again.text[:120],
        )
    finally:
        os.environ.pop(HOST_PROCESS_KEY_ENV, None)

    print(f"\ncontract_content_migration: PASS {PASS} / FAIL {FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
