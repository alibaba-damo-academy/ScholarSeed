"""
配置模块 — 项目路径、Provider 常量、LLM 工厂函数
"""
from __future__ import annotations

# --- slr path bootstrap ---
import sys as _slr_sys, pathlib as _slr_pathlib
for _slr_anc in _slr_pathlib.Path(__file__).resolve().parents:
    if (_slr_anc / ".slr-home").is_file():
        _slr_sys.path.insert(0, str(_slr_anc / "lib"))
        break
else:
    raise RuntimeError("systematic-literature-review skill root not found above " + __file__)
import slr_paths as _slr_paths
_slr_paths.bootstrap(__file__)
# --- end slr path bootstrap ---

import os
import sys
from pathlib import Path
from typing import Optional


# ---- 工作区根：由调用方决定（SLR_WORKSPACE 或当前目录），不再从脚本位置推断 ----
PROJECT_ROOT = _slr_paths.workspace()
_SCRIPT_DIR = str(Path(__file__).resolve().parent)

sys.path.insert(0, _SCRIPT_DIR)
pass

from load_model_config import load_stage_config as _load_stage_config  # noqa: E402


# ---- 单一 provider：qwen 网关（OpenAI 协议）。Token 只来自
# ---- SCHOLARSEED_ACCOUNT_TOKEN；TEXT_BASE_URL 优先于配置中的默认 URL。 ----
_DEFAULT_PROVIDER = "qwen"
_DEFAULT_MODEL = "qwen3.8-max"


def _create_llm(provider: Optional[str] = None, model: Optional[str] = None,
                base_url: Optional[str] = None, thinking: bool = False, workspace=None):
    """Create the processing-stage LLM client.

    Model settings come from the ``processing`` stage. The shared API token
    always comes from ``SCHOLARSEED_ACCOUNT_TOKEN``; ``TEXT_BASE_URL`` overrides
    ``providers.qwen.base_url``. Function arguments only fill gaps when the
    stage itself is missing.
    """
    from llm import _LightLLM  # noqa: E402 — lazy to avoid circular

    scfg = _load_stage_config("processing")
    if scfg:
        final_model = scfg.get("model", _DEFAULT_MODEL)
        final_base_url = scfg.get("base_url", "")
        final_api_key = scfg.get("api_key", "")
        final_thinking = scfg.get("thinking", False)
        final_max_tokens = scfg.get("max_tokens", 16000)
        final_timeout = scfg.get("timeout", 300.0)
    else:
        prov = provider or _DEFAULT_PROVIDER
        if prov != _DEFAULT_PROVIDER:
            raise ValueError(f"Unknown provider: {prov!r}. Only {_DEFAULT_PROVIDER!r} is supported.")
        final_model = model or _DEFAULT_MODEL
        final_base_url = (os.environ.get("TEXT_BASE_URL") or base_url or "").strip()
        final_api_key = os.environ.get("SCHOLARSEED_ACCOUNT_TOKEN", "").strip()
        final_thinking = thinking
        final_max_tokens = 16000
        final_timeout = 300.0

    from runtime_model_client import runtime_text_client
    runtime=runtime_text_client(final_model,workspace=workspace,processing=True,
        thinking=final_thinking,timeout=(scfg or {}).get('request_deadline_sec',final_timeout),
        default_max_tokens=final_max_tokens)
    if runtime is not None:return runtime

    from endpoint_defaults import model_base
    final_base_url=model_base(final_base_url)
    if not final_base_url:
        raise ValueError(
            "No base_url for the 'processing' stage: set TEXT_BASE_URL or "
            "providers.qwen.base_url in config/model_config.<profile>.json."
        )
    if not final_api_key:
        raise ValueError(
            "No API token for the 'processing' stage: set "
            "SCHOLARSEED_ACCOUNT_TOKEN before starting Codex."
        )

    llm = _LightLLM(
        model=final_model,
        base_url=final_base_url,
        api_key=final_api_key,
        thinking=final_thinking,
        timeout=final_timeout,
        default_max_tokens=final_max_tokens,
    )
    llm.timeout = (scfg or {}).get("request_deadline_sec", final_timeout)
    return llm
