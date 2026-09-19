"""Built-in login providers for the Community identity host."""

from __future__ import annotations

from typing import Tuple

from service.identity.providers.local import LocalAuthProvider
from service.identity.providers.protocol import AuthProvider


def auth_providers() -> Tuple[AuthProvider, ...]:
    """Build the login methods owned by this distribution."""
    return (LocalAuthProvider(),)


__all__ = ["auth_providers"]
