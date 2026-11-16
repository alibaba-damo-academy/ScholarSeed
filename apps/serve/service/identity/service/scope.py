"""In-memory execution scopes for authenticated request generations."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from uuid import uuid4


class ExecutionIdentity:
    """Project login changes without changing account or product data ownership."""

    def __init__(self) -> None:
        self._revision = 0
        self._scopes: dict[str, tuple[int, str]] = {}
        self._request: ContextVar[tuple[str, str | None] | None] = ContextVar(
            "execution_identity", default=None
        )

    @property
    def revision(self) -> int:
        return self._revision

    def scope(self, owner: str) -> str | None:
        request = self._request.get()
        if request is not None and request[1] != self._scopes.get(request[0], (0, request[0]))[1]:
            return None
        return self._scopes.get(owner, (0, owner))[1]

    @contextmanager
    def project(
        self,
        owner: str,
        *,
        revoked: bool,
        observed_revision: int,
    ) -> Iterator[None]:
        revision, scope = self._scopes.get(owner, (0, owner))
        stale = revoked or revision > observed_revision
        token = self._request.set((owner, None if stale else scope))
        try:
            yield
        finally:
            self._request.reset(token)

    def retire(self, owner: str) -> str | None:
        scope = self.scope(owner)
        if scope is None:
            return None
        self._revision += 1
        self._scopes[owner] = (self._revision, f"{owner}:{uuid4().hex}")
        return scope
