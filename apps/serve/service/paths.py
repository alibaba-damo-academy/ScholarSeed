"""Service-owned persistence and workspace paths.

serve/auth/webui/action-spine 是服务面业务, 路径不进 core;
root 从 substrate 机制路径单一来源 SCHOLARSEED_HOME 派生 (root 可经环境变量整体切换)。
"""

from __future__ import annotations

import os
import re
from hashlib import sha256
from pathlib import Path

from service.brand import HOME_ENV, default_home
from service.content.domain.model import PROJECT_STATE_DIRNAME
from service.platform.storage import account_directory


def global_home() -> Path:
    """Resolve product state independently of runtime selection and workspace."""

    configured = os.environ.get(HOME_ENV, "").strip()
    return Path(configured).expanduser() if configured else default_home()


# Permanent OS-account namespace, never derived from relocatable product data.
COORDINATION_DIRNAME = ".scholarseed-coordination"


def coordination_root() -> Path:
    """Select the shared coordinator without creating it or authorizing IO."""
    return Path(account_directory()) / COORDINATION_DIRNAME


SCHOLARSEED_HOME = global_home()
CONFIG_FILENAME = "config.json"
LOGS_DIRNAME = "logs"
SYSTEM_LOG_FILENAME = "scholarseed.log"
STARTUP_LOG_DIRNAME = "startup"
CONFIG_PATH = SCHOLARSEED_HOME / CONFIG_FILENAME
MCP_CONFIG_FILENAME = "mcp.json"
MCP_CONFIG_LOCK_FILENAME = "mcp.lock"
MCP_CONFIG_PATH = SCHOLARSEED_HOME / MCP_CONFIG_FILENAME
MCP_PLANS_DIRNAME = "mcp-plans"
MCP_PLANS_PATH = SCHOLARSEED_HOME / MCP_PLANS_DIRNAME
CONNECTOR_DIRECTORY = "connectors"
CONNECTOR_STATE_ROOT = SCHOLARSEED_HOME / CONNECTOR_DIRECTORY
LOGS_DIR = SCHOLARSEED_HOME / LOGS_DIRNAME
SYSTEM_LOG = LOGS_DIR / SYSTEM_LOG_FILENAME
STARTUP_LOG_DIR = LOGS_DIR / STARTUP_LOG_DIRNAME

# 本地 research 产品的默认工作区: 用户打开哪个目录, 哪个目录就是 workspace。
# 可通过 SCHOLARSEED_DEFAULT_WORKSPACE 指定启动目录; 未指定时使用当前启动目录, 不再在 SCHOLARSEED_HOME
# 下自动创建隐藏的中间 workspace 目录。
#
# 这里**只**给出环境变量名: 工作区根的取值顺序 (产品设置 > 本环境变量 > 桌面端注入 > cwd)
# 由唯一组合根 service/bootstrap.py 解析。曾经的 DEFAULT_WORKSPACE_DIR 常量是死代码 ——
# 它在 import 时就把 cwd 冻住, 全仓无人使用, 留着只会诱导出第二处工作区解析。
DEFAULT_WORKSPACE_ENV = "SCHOLARSEED_DEFAULT_WORKSPACE"

# proposal 35: service action event spine (产品操作 envelope, 非 trace)
SERVICE_DIR: Path = SCHOLARSEED_HOME / "service"
RESOURCE_SEARCH_PROFILES_DIR: Path = SERVICE_DIR / "resource-search-profiles"
RESOURCE_SEARCH_PROFILE_ENV = "SCHOLARSEED_RESOURCE_SEARCH_PROFILE"
BROWSER_DIRNAME = "browser"
BROWSER_STAGES_DIRNAME = "stages"
BROWSER_RECEIPTS_DIRNAME = "receipts"
BROWSER_LOCK_FILENAME = "store.lock"
BROWSER_VAULT_FILENAME = "vault.bin"
BROWSER_DOWNLOADS_FILENAME = "downloads.json"
BROWSER_DIR: Path = SERVICE_DIR / BROWSER_DIRNAME
BROWSER_STAGES_DIR: Path = BROWSER_DIR / BROWSER_STAGES_DIRNAME
BROWSER_RECEIPTS_DIR: Path = BROWSER_DIR / BROWSER_RECEIPTS_DIRNAME
BROWSER_VAULT_FILE: Path = BROWSER_DIR / BROWSER_VAULT_FILENAME
BROWSER_DOWNLOADS_FILE: Path = BROWSER_DIR / BROWSER_DOWNLOADS_FILENAME
MODEL_CREDENTIALS_DB: Path = SERVICE_DIR / "model_credentials.sqlite3"
MODEL_CREDENTIAL_LOCKS: Path = SERVICE_DIR / "model-credential-locks"
SERVICE_BRIDGE_DIR: Path = SERVICE_DIR / "bridge"
SERVICE_LITERATURE_DIR: Path = SERVICE_DIR / "literature"
SERVICE_LITERATURE_FILES_DIR: Path = SERVICE_LITERATURE_DIR / "files"
SERVICE_LITERATURE_DATABASE: Path = SERVICE_DIR / "literature.sqlite3"
CODEX_RUNTIME_HOME: Path = SCHOLARSEED_HOME / "codex"
SERVICE_ACTIONS_DB: Path = SERVICE_DIR / "actions.sqlite3"
ONE_SHOT_DIR: Path = SERVICE_DIR / "one-shots"
ONE_SHOT_WORKSPACE_DIRNAME = "workspace"
LITERATURE_SEARCH_DIR: Path = SERVICE_DIR / "aisearch"
LITERATURE_SEARCH_TASK_PREFIX = "task-"
LITERATURE_SEARCH_QUERY_FILENAME = "query.txt"
LITERATURE_SEARCH_STATE_FILENAME = "search.json"
# Windows 上任务目录可能因为子进程仍持有 cwd 或杀软句柄而删不掉。删除意图落在这个标记文件里,
# 目录对用户立即消失, 真正的删除由下次启动清扫完成。
LITERATURE_SEARCH_DELETE_FLAG_FILENAME = "deleted.flag"
SESSION_CATALOG_DB: Path = SERVICE_DIR / "sessions.sqlite3"
SESSION_BODY_SUFFIX = ".bodies"
SESSION_BODIES_DIR: Path = SESSION_CATALOG_DB.with_suffix(SESSION_BODY_SUFFIX)
SESSION_BLOCK_SUFFIX = ".blocks"
SESSION_BLOCKS_DIR: Path = SESSION_CATALOG_DB.with_suffix(SESSION_BLOCK_SUFFIX)
# proposal 47: content 域的项目身份、关联授权根、事件游标与审计。
# Project identities have a separate lifecycle from session execution records.
# Both catalogs preserve user rows through additive migrations.
CONTENT_DB: Path = SERVICE_DIR / "content.sqlite3"
RESOURCE_IMPORTS_DB: Path = SERVICE_DIR / "resource-imports.sqlite3"
# proposal 74: 桌面登录交接的本机协调层。独立成库而不并入 sessions.sqlite3 ——
# 交接是 120s/10min 量级的短生命周期高频写, 与会话目录的长期性质不同, 混进去会让
# session catalog 的 additive 迁移约束背上一张性质完全不同的表。
DESKTOP_HANDOFF_DB: Path = SERVICE_DIR / "handoff.sqlite3"
SESSION_RUNTIME_DIR: Path = SERVICE_DIR / "sessions"
SESSION_OUTPUT_DIRNAME = "outputs"
SESSION_ARTIFACT_OBJECTS_RELATIVE = ".artifacts/objects"
SESSION_ATTACHMENT_DIRNAME = "attachments"
# serve 产品级设置（例如新会话的默认权限策略），与模型/provider config 隔离，不能写入
# config.json；后者是运行时连接配置，不是用户产品偏好。
SERVE_SETTINGS_FILE: Path = SERVICE_DIR / "settings.json"
# 简单认证 (serve 多用户基础) / CLI 登录凭据 (scholarseed login)
AUTH_FILE: Path = SCHOLARSEED_HOME / "auth.json"
CREDENTIALS_FILE: Path = SCHOLARSEED_HOME / "credentials.json"
USER_MEMORY_CONFIG_FILE: Path = SCHOLARSEED_HOME / "memory.yaml"
USER_MEMORY_DIR: Path = SCHOLARSEED_HOME / "memory"
SERVICE_SKILLS_DIR: Path = SCHOLARSEED_HOME / "skills"
SERVICE_BUNDLED_SKILLS_DIR: Path = Path(__file__).resolve().parent / "capabilities" / "skills"
SERVICE_BUNDLED_UI: Path = Path(__file__).resolve().parent / "capabilities" / "ui.zip"
SERVICE_SKILL_ROOTS: tuple[Path, ...] = (SERVICE_BUNDLED_SKILLS_DIR, SERVICE_SKILLS_DIR)
TASK_PYTHON_PARTS = (PROJECT_STATE_DIRNAME, "python", "venv")
TASK_PYTHON_COMMAND_PARTS = (*TASK_PYTHON_PARTS[:-1], "commands")
SERVICE_SKILL_STATE_FILE: Path = SERVICE_DIR / "skills.json"
SERVICE_COMPONENTS_DATABASE: Path = SERVICE_DIR / "components.sqlite3"
SERVICE_PROJECTS_FILE: Path = SERVICE_DIR / "projects.json"
SERVICE_CASES_DIR: Path = SCHOLARSEED_HOME / "test_sessions"

#: SQLite 的边车文件名后缀: WAL 里是最新写入, 只 deny 主库等于留一个读口。
SQLITE_SIDE_CAR_SUFFIXES: tuple[str, ...] = ("-wal", "-shm")
SERVICE_DATABASES: tuple[Path, ...] = (
    SERVICE_COMPONENTS_DATABASE,
    MODEL_CREDENTIALS_DB,
    SERVICE_LITERATURE_DATABASE,
    SERVICE_ACTIONS_DB,
    SESSION_CATALOG_DB,
    CONTENT_DB,
    RESOURCE_IMPORTS_DB,
    DESKTOP_HANDOFF_DB,
)


def task_python_root(cwd: Path) -> Path:
    """Resolve a task environment from its execution directory, not project identity."""
    return cwd.expanduser().resolve().joinpath(*TASK_PYTHON_PARTS)


def task_python_commands(cwd: Path) -> Path:
    """Locate per-cwd command aliases without using project registration."""
    return cwd.expanduser().resolve().joinpath(*TASK_PYTHON_COMMAND_PARTS)


def service_deny_read_roots() -> tuple[Path, ...]:
    """serve 自有、Agent 沙箱不得读取的落盘面（proposal 116 P4）。

    逐个文件而不 deny `SERVICE_DIR` 前缀: 该目录下还有 bridge 的 Unix socket 与
    `sessions/` 里的会话工作目录, 前缀式 deny 会一起打死。边车文件不论当前是否存在
    都列出——Codex 的 deny 按路径在访问时判定（0.155.1 darwin 实测: 对启动时不存在的
    路径 deny, 之后创建再读仍 EPERM）, 而 WAL 往往在回合中途才出现。
    """
    databases = set(SERVICE_DATABASES)
    if SERVICE_DIR.is_dir():
        databases.update(SERVICE_DIR.glob("*.sqlite3"))
    roots = [
        CONNECTOR_STATE_ROOT,
        SERVICE_LITERATURE_FILES_DIR,
        BROWSER_DIR,
        RESOURCE_SEARCH_PROFILES_DIR,
        SESSION_BODIES_DIR,
        SESSION_BLOCKS_DIR,
    ]
    for database in sorted(databases):
        roots.append(database)
        roots.extend(
            database.with_name(database.name + suffix) for suffix in SQLITE_SIDE_CAR_SUFFIXES
        )
    return tuple(roots)


# ── 项目级落盘 (相对项目根) ────────────────────────────────────────────
# 上面每一条都是 import 时求值的**绝对**路径, 因为用户级根在 import 时就已知。
# 项目根不是: 它要到运行期才由 content 域按 project_id 解析出来。所以项目级只能给
# **相对项目根**的 posix 路径, 由各域交给 `ContentPort.resolve(project_id, ...)` 换成
# 经越界校验的绝对路径 —— 谁都不要自己拼项目根, 那会让「项目根解析 + 越界校验」
# 在 content 域外多出第二份 (proposal 47 §6.5)。
#
# 目录名与用户级 SERVICE_DIR 同名同义: 都是「serve 业务的落盘根」, 一个在用户家目录下,
# 一个在项目内。`.scholarseed` 不在这里重写字面量, 它的真源是 content 域。
PROJECT_SERVICE_DIRNAME = "service"
PROJECT_DB_FILENAME = "project.sqlite3"
PROJECT_CREATION_RECEIPT_FILENAME = "creation.json"
#: 项目级业务库。单库多表: 各域在同一个文件里建自己的表 (表名带域前缀), 不是每域一个库。
#: 惰性创建 —— 没有域真正写入时, 项目目录下不会凭空出现这个文件。
PROJECT_DB_RELATIVE = f"{PROJECT_STATE_DIRNAME}/{PROJECT_SERVICE_DIRNAME}/{PROJECT_DB_FILENAME}"
LEGACY_DOCUMENTS_BLOBS_RELATIVE = (
    f"{PROJECT_STATE_DIRNAME}/{PROJECT_SERVICE_DIRNAME}/documents/blobs"
)
# proposal 51: resource-version objects travel with the project beside its shared ledger.
PROJECT_RESOURCES_DIRNAME = "resources"
PROJECT_VERSIONS_DIRNAME = "versions"
PROJECT_VERSIONS_RELATIVE = (
    f"{PROJECT_STATE_DIRNAME}/{PROJECT_SERVICE_DIRNAME}/"
    f"{PROJECT_RESOURCES_DIRNAME}/{PROJECT_VERSIONS_DIRNAME}"
)
PROJECT_ARTIFACT_OBJECTS_RELATIVE = (
    f"{PROJECT_STATE_DIRNAME}/{PROJECT_SERVICE_DIRNAME}/artifacts/objects"
)


def storage_instance_id(root: Path = SCHOLARSEED_HOME) -> str:
    """Return a non-reversible identity for one canonical persistence root.

    Product clients use this value to prove that a loopback backend belongs to
    the same local storage profile before attaching.  The path itself is not
    exposed through the health response.
    """

    canonical = str(Path(root).expanduser().resolve())
    return sha256(canonical.encode("utf-8")).hexdigest()


# ── Windows 版本化组件仓库 (proposal 108 §7 / P2a) ─────────────────────────
# Desktop 主进程把 python/texlive 组件 provision 到该根下并发布为不可变目录;
# 本模块是路径契约唯一 owner, Desktop 的 runtime/components.cjs 镜像同一相对形状,
# 两侧契约测试互相钉死 (desktop: runtime/components.test.cjs 读本文件常量比对)。
RUNTIME_DIRNAME = "runtime"
RUNTIME_CACHE_DIRNAME = "cache"
TEXLIVE_CACHE_DIRNAME = "texlive"
RUNTIME_STAGING_DIRNAME = "staging"
RUNTIME_MANIFESTS_DIRNAME = "manifests"
RUNTIME_LOCKS_DIRNAME = "locks"
RUNTIME_COMPONENT_KINDS = ("python", "texlive", "powershell")
RUNTIME_DIR: Path = SCHOLARSEED_HOME / RUNTIME_DIRNAME
TEXLIVE_CACHE_DIR: Path = RUNTIME_DIR / RUNTIME_CACHE_DIRNAME / TEXLIVE_CACHE_DIRNAME
RUNTIME_STAGING_DIR: Path = RUNTIME_DIR / RUNTIME_STAGING_DIRNAME
RUNTIME_MANIFESTS_DIR: Path = RUNTIME_DIR / RUNTIME_MANIFESTS_DIRNAME
RUNTIME_LOCKS_DIR: Path = RUNTIME_DIR / RUNTIME_LOCKS_DIRNAME
_RUNTIME_TARGET_PATTERN = re.compile(r"^[a-z0-9]+-[a-z0-9_]+$")
_RUNTIME_CONTENT_ID_PATTERN = re.compile(r"^[a-f0-9]{64}$")


def runtime_component_dir(kind: str, target: str, content_id: str) -> Path:
    """已发布组件目录 <runtime>/<kind>/<target>-<contentId>。

    三个入参都过形状闸再参与拼接 —— 组件目录名是路径的最后两段, 这是防穿越的唯一防线,
    与 Desktop 侧 componentDirectoryName 同判据。
    """

    if kind not in RUNTIME_COMPONENT_KINDS:
        raise ValueError(f"unknown runtime component kind: {kind}")
    if not _RUNTIME_TARGET_PATTERN.fullmatch(target):
        raise ValueError(f"invalid runtime component target: {target}")
    if not _RUNTIME_CONTENT_ID_PATTERN.fullmatch(content_id):
        raise ValueError(f"invalid runtime component content id: {content_id}")
    return RUNTIME_DIR / kind / f"{target}-{content_id}"


__all__ = [
    "SCHOLARSEED_HOME",
    "RUNTIME_DIRNAME",
    "RUNTIME_CACHE_DIRNAME",
    "TEXLIVE_CACHE_DIRNAME",
    "TEXLIVE_CACHE_DIR",
    "RUNTIME_STAGING_DIRNAME",
    "RUNTIME_MANIFESTS_DIRNAME",
    "RUNTIME_LOCKS_DIRNAME",
    "RUNTIME_COMPONENT_KINDS",
    "RUNTIME_DIR",
    "RUNTIME_STAGING_DIR",
    "RUNTIME_MANIFESTS_DIR",
    "RUNTIME_LOCKS_DIR",
    "runtime_component_dir",
    "DEFAULT_WORKSPACE_ENV",
    "SERVICE_DIR",
    "SERVICE_BRIDGE_DIR",
    "SERVICE_LITERATURE_DIR",
    "SERVICE_LITERATURE_FILES_DIR",
    "SERVICE_LITERATURE_DATABASE",
    "CODEX_RUNTIME_HOME",
    "SERVICE_ACTIONS_DB",
    "ONE_SHOT_DIR",
    "ONE_SHOT_WORKSPACE_DIRNAME",
    "LITERATURE_SEARCH_DIR",
    "LITERATURE_SEARCH_TASK_PREFIX",
    "LITERATURE_SEARCH_QUERY_FILENAME",
    "LITERATURE_SEARCH_STATE_FILENAME",
    "LITERATURE_SEARCH_DELETE_FLAG_FILENAME",
    "SESSION_CATALOG_DB",
    "SESSION_BODIES_DIR",
    "SESSION_BLOCKS_DIR",
    "CONTENT_DB",
    "RESOURCE_IMPORTS_DB",
    "DESKTOP_HANDOFF_DB",
    "SESSION_RUNTIME_DIR",
    "SESSION_OUTPUT_DIRNAME",
    "SESSION_ATTACHMENT_DIRNAME",
    "SERVE_SETTINGS_FILE",
    "AUTH_FILE",
    "CREDENTIALS_FILE",
    "USER_MEMORY_CONFIG_FILE",
    "USER_MEMORY_DIR",
    "SERVICE_SKILLS_DIR",
    "SERVICE_BUNDLED_SKILLS_DIR",
    "SERVICE_BUNDLED_UI",
    "SERVICE_SKILL_ROOTS",
    "SERVICE_SKILL_STATE_FILE",
    "SERVICE_COMPONENTS_DATABASE",
    "SERVICE_PROJECTS_FILE",
    "SERVICE_CASES_DIR",
    "PROJECT_SERVICE_DIRNAME",
    "PROJECT_DB_FILENAME",
    "PROJECT_DB_RELATIVE",
    "LEGACY_DOCUMENTS_BLOBS_RELATIVE",
    "PROJECT_RESOURCES_DIRNAME",
    "PROJECT_VERSIONS_DIRNAME",
    "PROJECT_VERSIONS_RELATIVE",
    "PROJECT_ARTIFACT_OBJECTS_RELATIVE",
    "storage_instance_id",
]
