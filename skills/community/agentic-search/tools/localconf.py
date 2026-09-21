#!/usr/bin/env scholarseed-skill-python
"""Machine-local self-configuration for the search tools.

Reads an optional, machine-specific config file selected by
AGENTIC_SEARCH_CONFIG, or tools/search_config.json as a compatibility fallback,
and applies it to the process environment at import time, so the tools "just work"
when invoked as `scholarseed-skill-python tools/paperhub.py ...` with no shell setup — no reliance
on the agent remembering to export env vars, and no changes to the global shell
profile.

Config keys (all optional):
    paperhub_url    e.g. "http://HOST:PORT" (sets PAPERHUB_URL)
    paperhub_proxy_mode  auto/inherit/direct (sets PAPERHUB_PROXY_MODE)
    extra_no_proxy  list of hosts to add to no_proxy/NO_PROXY (bypass corp proxy)
    cache_dir       sets SEARCH_CACHE_DIR (enables reproducible caching)
    cache_mode      sets SEARCH_CACHE_MODE (readwrite/readonly/refresh/replay/off)
    cache_replay_timing  sets SEARCH_CACHE_REPLAY_TIMING (instant/account/sleep)

Real environment variables always win over the config file, so a run can override
any setting ad hoc. Config discovery ends at the bundled portable defaults; users
can select a direct endpoint, corporate proxy, or localhost SSH tunnel without
editing the installed skill.

PaperHub authentication is intentionally environment-only: set
SCHOLARSEED_API_KEY before starting Codex. It is never read from this JSON config,
which avoids copying a bearer token into repository-managed templates.
"""

import json
import os
import urllib.parse

_TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
_LOCAL_CFG_PATH = os.path.join(_TOOLS_DIR, "search_config.json")
_BUNDLED_CFG_PATH = os.path.join(_TOOLS_DIR, "search_config.default.json")
_SCHOLARSEED_HOST = "scholarseed.damo.alibaba.com"
_applied = False


def _user_config_path():
    root = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(root, "agentic-search", "search_config.json")


def config_source():
    """Return the highest-priority config path, including bundled defaults."""
    explicit = os.environ.get("AGENTIC_SEARCH_CONFIG")
    if explicit:
        return os.path.abspath(os.path.expanduser(explicit))
    for path in (_user_config_path(), _LOCAL_CFG_PATH, _BUNDLED_CFG_PATH):
        if os.path.isfile(path):
            return os.path.abspath(path)
    return os.path.abspath(_BUNDLED_CFG_PATH)


def config_path():
    """Backward-compatible alias for callers that display the config path."""
    return config_source()


def _ensure_no_proxy(host):
    if not host:
        return
    for key in ("no_proxy", "NO_PROXY"):
        val = os.environ.get(key, "")
        hosts = [h for h in val.split(",") if h]
        if host not in hosts:
            hosts.append(host)
            os.environ[key] = ",".join(hosts)


def _canonical_paperhub_url(value):
    """Force the public ScholarSeed service to HTTPS; preserve custom/tunnel URLs."""
    if not isinstance(value, str):
        return value
    parsed = urllib.parse.urlsplit(value.strip())
    if (
        parsed.scheme.lower() == "http"
        and (parsed.hostname or "").lower() == _SCHOLARSEED_HOST
    ):
        parsed = parsed._replace(scheme="https")
    return urllib.parse.urlunsplit(parsed)


def apply():
    """Idempotently apply machine-local config to os.environ."""
    global _applied
    if _applied:
        return
    _applied = True

    try:
        with open(config_source()) as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}

    env_url = os.environ.get("PAPERHUB_URL")
    url = env_url or cfg.get("paperhub_url")
    url = _canonical_paperhub_url(url)
    if url:
        os.environ["PAPERHUB_URL"] = url

    if not os.environ.get("PAPERHUB_PROXY_MODE") and cfg.get("paperhub_proxy_mode"):
        os.environ["PAPERHUB_PROXY_MODE"] = str(cfg["paperhub_proxy_mode"])

    for host in cfg.get("extra_no_proxy", []):
        _ensure_no_proxy(host)

    if not os.environ.get("SEARCH_CACHE_DIR") and cfg.get("cache_dir"):
        os.environ["SEARCH_CACHE_DIR"] = cfg["cache_dir"]
    if not os.environ.get("SEARCH_CACHE_MODE") and cfg.get("cache_mode"):
        os.environ["SEARCH_CACHE_MODE"] = cfg["cache_mode"]
    if not os.environ.get("SEARCH_CACHE_REPLAY_TIMING") and cfg.get("cache_replay_timing"):
        os.environ["SEARCH_CACHE_REPLAY_TIMING"] = cfg["cache_replay_timing"]


# Apply on import so any tool that imports this is self-configured.
apply()
