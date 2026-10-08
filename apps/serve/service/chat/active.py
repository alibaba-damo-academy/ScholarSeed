"""Manifest-selected runtime product metadata.

进程启动时按 ``product.json`` + ``SCHOLARSEED_HARNESS`` 解析出**本进程使用的那一个**
Harness，并把它的 identity / defaults 暴露成产品层常量。这样 chat 域的其余模块
（sessions / trace / models / routes / runtime）消费的是「当前 runtime 的值」，
而不是「Codex 的值」。

为什么在模块级解析：一个 serve 进程只服务一个 Harness（与原先 `resolve_harness`
的进程级语义一致），因此在 import 期定一次即可，避免每个调用点重复判断。切换
Harness 通过改 manifest / 环境变量后重启进程完成，而不是运行期热切。

系统提示词属于产品而非 runtime，因此在这里读取产品自己的 prompt 文件并注入
adapter —— adapter 不反向读产品目录（开源方案 §4 依赖方向硬约束）。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from service.chat.service.adapters import registrations, resolve_runtime_id

# 书深产品的会话指令资产, 由本模块注入当前 runtime。
# baseInstructions.md 维护替换 runtime 内置基础指令的完整基础指令 (base_instructions);
# developerInstructions.md 维护叠加在其上的产品附加开发者指令 (developer_instructions)。
# 两者由算法同学的 config.toml (instructions / developer_instructions) 同步维护:
# baseInstructions.md 对应 instructions, developerInstructions.md 的算法章节
# (Request Type Gate) 对应 developer_instructions, 科研细则由
# academic-research-guidance skill 按需加载, 产品细则由
# scholarseed-product-operations skill 按需加载。
BASE_PROMPT_FILE = Path(__file__).resolve().parent / "prompts" / "baseInstructions.md"
DEVELOPER_PROMPT_FILE = Path(__file__).resolve().parent / "prompts" / "developerInstructions.md"
TEXT_ENCODING = "utf-8"
NETWORK_DOMAINS_KEY = "allowed_network_domains"
NETWORK_DOMAIN_PATTERN = re.compile(
    r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+"
)
OUTPUT_DIRECTORY_INSTRUCTIONS = (
    "\n\nThe session output directory, relative to the working directory, is {path}. "
)


def base_instructions() -> str:
    """读取产品基础指令 (替换 runtime 内置基础指令); 缺失或为空是产品资产缺陷, 显式失败。"""

    prompt = BASE_PROMPT_FILE.read_text(encoding=TEXT_ENCODING)
    if not prompt.strip():
        raise ValueError(f"ScholarSeed base instructions are empty: {BASE_PROMPT_FILE}")
    return prompt


def developer_instructions(*, output_directory: str = "", project_context: str = "") -> str:
    """读取产品开发者附加指令; 缺失或为空是产品资产缺陷, 显式失败。"""

    prompt = DEVELOPER_PROMPT_FILE.read_text(encoding=TEXT_ENCODING)
    if not prompt.strip():
        raise ValueError(f"ScholarSeed developer instructions are empty: {DEVELOPER_PROMPT_FILE}")
    if output_directory:
        prompt += OUTPUT_DIRECTORY_INSTRUCTIONS.format(path=json.dumps(output_directory))
    if project_context:
        prompt += "\n\n" + project_context
    return prompt


# 本进程选定的 Harness 及其产品元数据（进程级单一事实源）。
ACTIVE_RUNTIME_ID = resolve_runtime_id()
_runtime = registrations()[ACTIVE_RUNTIME_ID]
_metadata = _runtime.settings
_permission = dict(_metadata.get("default_permission") or {})


def _required(key: str) -> str:
    value = str(_metadata.get(key) or "").strip()
    if not value:
        raise ValueError(f"runtime {ACTIVE_RUNTIME_ID!r} manifest metadata is missing {key!r}")
    return value


def _required_permission(key: str) -> str:
    value = str(_permission.get(key) or "").strip()
    if not value:
        raise ValueError(f"runtime {ACTIVE_RUNTIME_ID!r} default_permission is missing {key!r}")
    return value


# ── 产品层消费的 runtime 身份（原 CODEX_* 常量的 runtime-neutral 替代）──
RUNTIME_ID = ACTIVE_RUNTIME_ID
RUNTIME_DISPLAY_NAME = _required("display_name")
RUNTIME_CLIENT_NAME = _required("client_name")
RUNTIME_CLIENT_TITLE = _required("client_title")
RUNTIME_SERVICE_NAME = _required("service_name")

# ── 默认执行策略 ──
RUNTIME_DEFAULT_SANDBOX = _required_permission("sandbox")
RUNTIME_DEFAULT_APPROVAL_POLICY = _required_permission("approval_policy")
RUNTIME_FULL_ACCESS_SANDBOX = _required_permission("full_access_sandbox")
RUNTIME_NO_APPROVAL_POLICY = _required_permission("no_approval_policy")


def _allowed_network_domains() -> tuple[str, ...]:
    values = _permission.get(NETWORK_DOMAINS_KEY, [])
    if not isinstance(values, list) or any(
        not isinstance(value, str) or NETWORK_DOMAIN_PATTERN.fullmatch(value) is None
        for value in values
    ):
        raise ValueError(f"runtime {ACTIVE_RUNTIME_ID!r} has invalid {NETWORK_DOMAINS_KEY}")
    return tuple(sorted(set(values)))


RUNTIME_ALLOWED_NETWORK_DOMAINS = _allowed_network_domains()


__all__ = [
    "ACTIVE_RUNTIME_ID",
    "BASE_PROMPT_FILE",
    "DEVELOPER_PROMPT_FILE",
    "base_instructions",
    "developer_instructions",
    "RUNTIME_CLIENT_NAME",
    "RUNTIME_CLIENT_TITLE",
    "RUNTIME_DEFAULT_APPROVAL_POLICY",
    "RUNTIME_DEFAULT_SANDBOX",
    "RUNTIME_DISPLAY_NAME",
    "RUNTIME_FULL_ACCESS_SANDBOX",
    "RUNTIME_ID",
    "RUNTIME_NO_APPROVAL_POLICY",
    "RUNTIME_ALLOWED_NETWORK_DOMAINS",
    "RUNTIME_SERVICE_NAME",
]
