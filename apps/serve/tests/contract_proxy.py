"""Proxy bypass normalization contracts for the inherited NO_PROXY list."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import httpx

from service import brand
from service.platform import proxy

AMBIENT = "localhost,.localhost,127.0.0.1,127.0.0.0/8,[::1],::1"

SCRIPT = """
import json, os
from service.brand import apply_runtime_defaults
apply_runtime_defaults()
import httpx
httpx.Client().close()
print(json.dumps({name: os.environ.get(name) for name in ("NO_PROXY", "no_proxy")}))
"""


def _client_accepts(value: str) -> None:
    """The normalized list must be parseable by the real HTTP client."""

    environment = {"NO_PROXY": value, "no_proxy": value}
    previous = {name: os.environ.get(name) for name in environment}
    os.environ.update(environment)
    try:
        httpx.Client().close()
    finally:
        for name, value_before in previous.items():
            if value_before is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value_before


def normalization_contract() -> None:
    assert proxy.normalize("[::1]") == ("::1", ())
    assert proxy.normalize(AMBIENT) == (
        "localhost,.localhost,127.0.0.1,127.0.0.0/8,::1,::1",
        (),
    )

    stripped, warnings = proxy.normalize("[::1]:8080")
    assert stripped == "::1", stripped
    assert len(warnings) == 1 and "8080" not in stripped and "::1" in warnings[0], warnings
    assert proxy.normalize("[2001:db8::1]:443")[0] == "2001:db8::1"
    assert len(proxy.normalize("[2001:db8::1]:443")[1]) == 1

    # A CIDR suffix is not a port and stays attached to the address. httpx rejects
    # IPv6 CIDR with or without brackets, which bracket removal does not address.
    assert proxy.normalize("[2001:db8::]/32") == ("2001:db8::/32", ())

    for value in ("localhost", "*.example.com", "127.0.0.0/8", "*", "example.com:8080", ""):
        assert proxy.normalize(value) == (value, ()), value

    # Anything that is not a bracketed IPv6 literal is left alone.
    for value in ("[example.com]", "[::1", "[]"):
        assert proxy.normalize(value) == (value, ()), value

    for value in (AMBIENT, "[::1]:8080", "[2001:db8::1]:443", "localhost,[::1],example.com"):
        normalized, _ = proxy.normalize(value)
        _client_accepts(normalized)
        assert proxy.normalize(normalized) == (normalized, ()), normalized


def environment_contract() -> None:
    names = ("NO_PROXY", "no_proxy")
    previous = {name: os.environ.get(name) for name in names}
    try:
        for name in names:
            os.environ[name] = AMBIENT
        proxy.apply()
        assert all(os.environ[name] == proxy.normalize(AMBIENT)[0] for name in names)
        proxy.apply()
        assert all(os.environ[name] == proxy.normalize(AMBIENT)[0] for name in names)

        for name in names:
            os.environ[name] = "localhost,127.0.0.1"
        proxy.apply()
        assert all(os.environ[name] == "localhost,127.0.0.1" for name in names)

        for name in names:
            os.environ.pop(name, None)
        proxy.apply()
        assert all(name not in os.environ for name in names)
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def composition_root_contract() -> None:
    """Every product entry normalizes before the first client is built."""

    with tempfile.TemporaryDirectory(prefix="proxy-contract-") as temporary:
        home = Path(temporary) / "home"
        environment = dict(os.environ)
        environment[brand.HOME_ENV] = str(home)
        environment["NO_PROXY"] = AMBIENT
        environment["no_proxy"] = AMBIENT
        result = subprocess.run(
            [sys.executable, "-c", SCRIPT],
            cwd=temporary,
            env=environment,
            text=True,
            capture_output=True,
            check=True,
        )
        values = json.loads(result.stdout)
        expected = proxy.normalize(AMBIENT)[0]
        assert values == {"NO_PROXY": expected, "no_proxy": expected}, values
        assert not home.exists(), "normalization must not create product state"


def main() -> int:
    normalization_contract()
    environment_contract()
    composition_root_contract()
    print("proxy bypass: bracketed IPv6 normalized before any HTTP client is built")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
