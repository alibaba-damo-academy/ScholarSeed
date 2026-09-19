"""
slr_paths — the single path resolver for the systematic-literature-review skill.

Everything in this skill locates itself through this module. Nothing hardcodes
an installation directory, walks a fixed number of parents, or assumes the
process was launched from a particular working directory. The skill therefore
works from `~/.codex/skills/`, a project checkout, or another unpacked path.

Home discovery
--------------
The skill root is the nearest ancestor of this file containing the marker file
`.slr-home`. Marker-based discovery survives being nested at any depth, so
callers never need to know how deep they sit.

Proxy hygiene
-------------
`bootstrap()` also adds every host in `config/endpoints.json` to `NO_PROXY`, so
PaperHub traffic is never handed to an outbound proxy that has no route to it.
See `lib/no_proxy.py` for why that failure is worth pre-empting.

Profile overlay
---------------
The skill ships exactly one pipeline profile, `fast`. The overlay mechanism it
was built around is still load-bearing: code owned by the pipeline lives in a
`_fast/` subdirectory, and code shared with anything outside it (`table_checks`,
the processing steps) lives in the parent directory.
`bootstrap()` puts the profile overlay ahead of that parent on `sys.path`, so a
module such as `_utils` resolves to the pipeline's copy when one exists and to
the shared copy otherwise -- without any caller changing its import statements.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

__all__ = [
    "HOME", "PROFILES", "find_home", "resolve_profile", "bootstrap",
    "lib_dir", "config_path", "schema_path", "asset_path",
    "script_path", "module_dirs", "endpoints", "model_config_path",
    "profile_config", "workspace",
]

MARKER = ".slr-home"
# One profile ships. The tuple stays a tuple -- every caller that iterates it,
# validates against it or renders it in an error message keeps working, and a
# second pipeline would only have to be added here.
PROFILES = ("fast",)
DEFAULT_PROFILE = "fast"


def find_home(start: str | Path | None = None) -> Path:
    """Nearest ancestor directory holding the `.slr-home` marker."""
    here = Path(start or __file__).resolve()
    for candidate in (here, *here.parents):
        if (candidate / MARKER).is_file():
            return candidate
    raise RuntimeError(
        f"systematic-literature-review skill root not found above {here}; "
        f"the {MARKER} marker file is missing -- the skill directory is incomplete."
    )


HOME: Path = find_home()


def resolve_profile(caller_file: str | Path | None = None,
                    explicit: str | None = None) -> str:
    """
    Decide which pipeline profile is active, in priority order:

    1. an explicit argument,
    2. an `_fast` component in the calling file's own path -- a script that
       lives inside a profile overlay always belongs to that profile,
    3. the SLR_PROFILE environment variable,
    4. DEFAULT_PROFILE.

    With a single profile every branch lands on `fast`; what the checks still
    earn is a loud failure rather than a silent one when a caller passes or
    exports a profile name that does not exist.
    """
    if explicit:
        if explicit not in PROFILES:
            raise ValueError(f"unknown profile {explicit!r}; expected one of {PROFILES}")
        return explicit

    if caller_file:
        parts = Path(caller_file).resolve().parts
        for profile in PROFILES:
            if f"_{profile}" in parts:
                return profile

    env = os.environ.get("SLR_PROFILE", "").strip().lower()
    if env in PROFILES:
        return env
    if env:
        raise ValueError(f"SLR_PROFILE={env!r} is not one of {PROFILES}")

    return DEFAULT_PROFILE


def module_dirs(rel: str | Path, profile: str) -> list[Path]:
    """
    Search path for a directory that may carry a profile overlay: the overlay
    first (when it exists), then the directory holding the code shared with
    everything outside the overlay. Missing directories are skipped, so this is
    safe for components that have no overlay at all.
    """
    base = HOME / rel
    found = [d for d in (base / f"_{profile}", base) if d.is_dir()]
    return found


def bootstrap(caller_file: str | Path | None = None,
              profile: str | None = None,
              extra: tuple[str, ...] = ()) -> str:
    """
    Put this skill's importable directories on `sys.path` and return the active
    profile. Idempotent: re-running never duplicates entries.

    Search order (highest priority first):
        <caller's own directory>          sibling modules
        <caller's overlay parent>         shared modules of the same component
        lib/_<profile>, lib               shared runtime, profile overlay first
        scripts/generation/_<profile>, scripts/generation
        <extra>...

    The overlay parent matters: a script in `tables/_fast/` must still be able
    to `import table_checks`, which lives in `tables/` because it is not owned
    by the pipeline overlay. Python only puts the script's own directory on the
    path, so the shared half of a partially-overlaid component would otherwise
    be invisible.
    """
    active = resolve_profile(caller_file, profile)

    ordered: list[Path] = []
    if caller_file:
        own = Path(caller_file).resolve().parent
        ordered.append(own)
        if own.name in {f"_{p}" for p in PROFILES}:
            ordered.append(own.parent)
    ordered += module_dirs("lib", active)
    ordered += module_dirs("scripts/generation", active)
    ordered += [HOME / e for e in extra]

    # insert in reverse so the first element of `ordered` ends up at sys.path[0]
    for directory in reversed(ordered):
        entry = str(directory)
        if directory.is_dir() and entry not in sys.path:
            sys.path.insert(0, entry)

    os.environ.setdefault("SLR_PROFILE", active)

    # Keep this skill's own service traffic off any ambient HTTP proxy. Import
    # is deferred to here because no_proxy imports slr_paths back for
    # endpoints(); at module scope that would be a cycle.
    try:
        import no_proxy
        no_proxy.apply()
    except Exception:
        # Never let proxy hygiene stop a script from starting -- worst case the
        # request goes through the proxy and fails with a clear HTTP error.
        pass

    return active


# ---------------------------------------------------------------- locations --

def workspace() -> Path:
    """
    The user's workspace -- the directory holding `01_input/` … `06_output/`.

    This is deliberately *not* derived from any script's own location. A Codex
    skill is commonly installed outside the survey workspace, so the workspace
    is whatever the caller says it is: `SLR_WORKSPACE` when set, otherwise the
    current directory.
    """
    override = os.environ.get("SLR_WORKSPACE", "").strip()
    return Path(override).resolve() if override else Path.cwd().resolve()


def lib_dir(profile: str | None = None) -> Path:
    return HOME / "lib" / f"_{profile}" if profile else HOME / "lib"


def config_path(name: str) -> Path:
    return HOME / "config" / name


def schema_path(name: str) -> Path:
    return HOME / "schema" / name


def asset_path(name: str) -> Path:
    return HOME / "assets" / name


def model_config_path(profile: str) -> Path:
    return config_path(f"model_config.{profile}.json")


def script_path(rel_dir: str, name: str, profile: str) -> Path:
    """
    Locate an executable script that may be profile-specific: look in the
    overlay first, fall back to the shared directory. Raises rather than
    returning a path that does not exist, so a typo fails loudly at dispatch
    time instead of as a confusing "file not found" from a subprocess.
    """
    for directory in module_dirs(rel_dir, profile):
        candidate = directory / name
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        f"{name} not found for profile {profile!r} under {HOME / rel_dir} "
        f"(looked in _{profile}/ then the shared directory)"
    )


# ------------------------------------------------------------------ configs --

_endpoints_cache: dict | None = None


def endpoints() -> dict:
    """
    Service endpoints, resolved once. `config/endpoints.json` holds the
    defaults; any key may be overridden by an environment variable named in
    that file's `env` mapping, so a deployment can retarget the skill without
    editing files it ships.
    """
    global _endpoints_cache
    if _endpoints_cache is None:
        import json
        path = config_path("endpoints.json")
        data = json.loads(path.read_text()) if path.is_file() else {}
        resolved = {}
        for key, spec in data.get("services", {}).items():
            value = spec.get("default", "")
            env_name = spec.get("env")
            if env_name:
                value = os.environ.get(env_name) or value
            if key == "paper_hub":
                from endpoint_defaults import paperhub_base
                value=paperhub_base(value)
            resolved[key] = value
        _endpoints_cache = resolved
    return _endpoints_cache


def profile_config(profile: str) -> dict:
    """The per-stage pipeline manifest for a profile."""
    import json
    return json.loads(config_path(f"profiles/{profile}.json").read_text())
