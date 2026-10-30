#!/usr/bin/env python3
"""scholarseed 首次配置脚本.

交互式只问模型选择 (model_name / small_model_name), 写入 ~/.scholarseed/config.json.
连接配置 (端点 / 凭据 / 自定义头) 已从 config.json 退役: 内置网关地址由产品常量
提供, 凭据走账号令牌或环境变量; 自己的端点请在产品设置页「模型服务配置」里添加.

跑法:
    python3 scripts/pre/config.py
    python3 scripts/pre/config.py --non-interactive   # 仅生成模板, 不询问
"""

from __future__ import annotations

import argparse
import json
import sys

from service.paths import CONFIG_PATH
from service.settings.config import (
    DEFAULT_CONFIG_PATH,
    load_config_values,
    strip_retired_connection_fields,
)

DEFAULTS = json.loads(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8"))

# 交互只问模型选择字段; 其余键原样保留盘上的值。
PROMPT_FIELDS = ("model_name", "small_model_name")


def _effective_config() -> dict:
    """生效配置 = 产品默认 + 用户文件里的非连接值 + 加载态收敛。

    提问与落盘都以它为基线。空串只是模板回显, 拿它当默认值会让产品默认永远进不来,
    而且空默认值连 ``[...]`` 提示都不显示, 用户看不出产品默认收敛到哪个模型。
    """

    try:
        return load_config_values()
    except (FileNotFoundError, ValueError):
        return dict(DEFAULTS)


def _adopt_product_defaults(cfg: dict) -> dict:
    """未声明的模型选择字段采纳产品默认, 不再把空值固化回文件。"""

    out = dict(cfg)
    effective = _effective_config()
    for key in PROMPT_FIELDS:
        if not str(out.get(key) or "").strip() and str(effective.get(key) or "").strip():
            out[key] = effective[key]
    return out


def _ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    try:
        raw = input(f"{prompt}{suffix}: ").strip()
    except EOFError:
        return default
    return raw or default


def interactive(existing: dict) -> dict:
    print(f"\nWriting config to: {CONFIG_PATH}")
    print("Press Enter to keep current value.\n")
    cfg = _adopt_product_defaults({**DEFAULTS, **existing})

    cfg["model_name"] = _ask("model_name", str(cfg.get("model_name") or ""))
    cfg["small_model_name"] = _ask(
        "small_model_name (used for cheap title/summary calls)",
        str(cfg.get("small_model_name") or ""),
    )
    return cfg


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="ScholarSeed first-time config setup")
    p.add_argument(
        "--non-interactive", action="store_true", help="just write template; don't prompt"
    )
    args = p.parse_args(argv)

    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)

    existing: dict = {}
    if CONFIG_PATH.exists():
        try:
            existing = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception as e:
            print(
                f"warning: existing {CONFIG_PATH} is not valid JSON ({e}); will overwrite",
                file=sys.stderr,
            )

    if args.non_interactive:
        cfg = _adopt_product_defaults({**DEFAULTS, **existing})
    else:
        cfg = interactive(existing)
    # 落盘顺手清掉存量文件里的退役连接字段, 与加载态「一律忽略」保持同一事实。
    cfg = strip_retired_connection_fields(cfg)

    CONFIG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    # 防御性收紧权限: 存量文件里可能还残留凭据字段。
    try:
        CONFIG_PATH.chmod(0o600)
    except OSError:
        pass

    print(f"\nwrote {CONFIG_PATH}")
    print(
        "note: connection settings no longer live in config.json — the built-in gateway\n"
        "      address is a product constant, credentialed by a logged-in desktop session\n"
        "      (or OPENAI_API_KEY for CLI use). To use your own endpoint, add it under\n"
        "      Settings → Model Service in the product."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
