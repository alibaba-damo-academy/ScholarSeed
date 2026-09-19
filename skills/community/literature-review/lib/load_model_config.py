"""Centralized model configuration loader.

Reads `config/model_config.<profile>.json` and returns merged stage configs.
Each stage config merges provider-level fields with stage-level overrides.
Credentials are never read from the config file: text stages use
``SCHOLARSEED_ACCOUNT_TOKEN``; image stages prefer ``IMAGE_API_KEY`` and fall back
to ``SCHOLARSEED_ACCOUNT_TOKEN`` when the image-specific key is unset or empty.
Gateway URLs can be overridden at process startup:
``TEXT_BASE_URL`` takes precedence over ``providers.qwen.base_url`` and
``IMAGE_BASE_URL`` over ``providers.idealab.base_url``.

The `fast` and `deep` profiles target different models and gateways for the
same stage names, so which file is read depends on the active profile --
resolved by `slr_paths` from `SLR_PROFILE` or the calling script's location.

If the config file is missing or a stage is not defined, returns None so
callers can fall back to their original hardcoded defaults.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

import slr_paths

_cached_config: dict[str, dict | None] = {}

_PROVIDER_URL_ENV = {
    "qwen": "TEXT_BASE_URL",
    "idealab": "IMAGE_BASE_URL",
}


def _find_config_path() -> Path | None:
    """Locate the active profile's model_config.<profile>.json."""
    path = slr_paths.model_config_path(slr_paths.resolve_profile())
    return path if path.is_file() else None


def _load_raw() -> dict | None:
    profile = slr_paths.resolve_profile()
    if profile in _cached_config:
        return _cached_config[profile]
    path = _find_config_path()
    if path is None:
        return None
    try:
        _cached_config[profile] = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    return _cached_config[profile]


def load_stage_config(stage: str) -> Optional[dict]:
    """Return merged config dict for a pipeline stage, or None.

    The returned dict contains at minimum:
        provider, model, base_url, api_key
    plus any extra keys defined in the stage (timeout, max_tokens, etc.).

    ``api_key`` comes from ``SCHOLARSEED_ACCOUNT_TOKEN`` for text stages. Image
    stages prefer ``IMAGE_API_KEY`` and fall back to the text token when it is
    unset or empty.
    Any legacy provider- or stage-level key is discarded. For the built-in
    providers, the matching URL environment variable wins over the provider
    URL in the config. Environment values are resolved on every call so a
    long-lived process never caches credentials or URL overrides.
    """
    raw = _load_raw()
    if raw is None:
        return None
    stages = raw.get("stages", {})
    if stage not in stages:
        return None
    stage_cfg = dict(stages[stage])

    provider_name = stage_cfg.get("provider")
    providers = raw.get("providers", {})
    provider_cfg = providers.get(provider_name, {})

    result = dict(provider_cfg)
    result.update(stage_cfg)

    # Credentials are an environment-only contract. Explicitly discard a
    # legacy config value so an old local file cannot silently take priority.
    result.pop("api_key", None)
    is_image = result.get("backend") == "openai_image" or stage == "figures_image"
    text_token = os.environ.get("SCHOLARSEED_ACCOUNT_TOKEN", "").strip()
    result["api_key"] = (
        os.environ.get("IMAGE_API_KEY", "").strip() or text_token
        if is_image else text_token
    )

    url_env_name = _PROVIDER_URL_ENV.get(provider_name)
    if url_env_name:
        env_url = os.environ.get(url_env_name, "").strip()
        provider_url = str(provider_cfg.get("base_url") or "").strip()
        result["base_url"] = env_url or provider_url

    from endpoint_defaults import model_base
    result["base_url"]=model_base(result.get("base_url"))
    return result
