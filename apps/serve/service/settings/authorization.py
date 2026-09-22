"""Short-lived browser authorization transactions and a loopback OAuth callback.

The callback is deliberately separate from the product API listener: it has no
session-management routes, cookies or credentials in its responses or logs.
"""

from __future__ import annotations

import asyncio
import errno
import secrets
import sqlite3
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any
from urllib.parse import parse_qs, urlsplit

from service.settings.credentials import CredentialConflictError, ModelCredentialStore
from service.settings.oauth import PKCE, OAuthFailure, OAuthProtocol, create_pkce

CALLBACK_IPV4_HOST = "127.0.0.1"
# Browsers resolve `localhost` to either loopback family. Holding both denies a
# co-listening wildcard socket (codex CLI, opencode) the ::1 side that would
# otherwise receive this product's callback and reject its state.
CALLBACK_LOOPBACK_HOSTS = (CALLBACK_IPV4_HOST, "::1")
CALLBACK_PORT = 1455
CALLBACK_PATH = "/auth/callback"
CALLBACK_REDIRECT_URI = f"http://localhost:{CALLBACK_PORT}{CALLBACK_PATH}"
AUTHORIZATION_LIFETIME_SECONDS = 300.0
AUTHORIZATION_RESULT_RETENTION_SECONDS = 300.0
CALLBACK_READ_TIMEOUT_SECONDS = 5.0
CALLBACK_REQUEST_LIMIT_BYTES = 8192
AUTHORIZATION_RANDOM_BYTES = 32
HTTP_HEADER_TERMINATOR = b"\r\n\r\n"
CALLBACK_SUCCESS_PAGE = (
    "Authorization complete. You may close this window and return to ScholarSeed."
)
CALLBACK_FAILURE_PAGE = "Authorization could not be completed. Return to ScholarSeed to try again."


class AuthorizationState(str, Enum):
    AUTHORIZING = "authorizing"
    EXCHANGING = "exchanging"
    CONNECTED = "connected"
    CANCELLED = "cancelled"
    EXPIRED = "expired"
    FAILED = "failed"


@dataclass
class Authorization:
    id: str
    owner_id: str
    connection_id: str
    state_token: str = field(repr=False)
    pkce: PKCE = field(repr=False)
    generation: int
    expires_at: float
    #: 凭据行的 owner 戳 = 发起授权时的真实账号; owner_id 只是归属身份(事务键控用)。
    account_id: str = ""
    state: AuthorizationState = AuthorizationState.AUTHORIZING
    error: str = ""
    expiry: asyncio.TimerHandle | None = field(default=None, repr=False)
    task: asyncio.Task | None = field(default=None, repr=False)

    def public(self) -> dict[str, Any]:
        return {
            "transaction_id": self.id,
            "state": self.state.value,
            "expires_at": self.expires_at,
            "error": self.error,
        }


class BrowserAuthorization:
    """One callback listener shared by isolated, owner-bound authorization attempts."""

    def __init__(self, store: ModelCredentialStore, protocol: OAuthProtocol) -> None:
        self._store = store
        self._protocol = protocol
        self._server: asyncio.Server | None = None
        self._start_lock = asyncio.Lock()
        self._transactions: dict[str, Authorization] = {}
        self._states: dict[str, Authorization] = {}
        self._connections: dict[tuple[str, str], str] = {}
        self._callbacks: set[asyncio.Task] = set()
        self._closed = False

    async def start(
        self, owner_id: str, connection_id: str, *, account_id: str = ""
    ) -> dict[str, Any]:
        async with self._start_lock:
            if self._closed:
                raise OAuthFailure("oauth_service_closed")
            scope = (owner_id, connection_id)
            existing_id = self._connections.get(scope)
            if existing_id is not None:
                existing = self._transactions[existing_id]
                if existing.state in (
                    AuthorizationState.AUTHORIZING,
                    AuthorizationState.EXCHANGING,
                ):
                    raise OAuthFailure("oauth_authorization_in_progress")
            record = self._store.read(owner_id, connection_id)
            if self._server is None:
                self._server = await self._bind()
            if self._closed:
                self._server.close()
                await self._server.wait_closed()
                self._server = None
                raise OAuthFailure("oauth_service_closed")
            transaction = Authorization(
                id=secrets.token_urlsafe(AUTHORIZATION_RANDOM_BYTES),
                owner_id=owner_id,
                connection_id=connection_id,
                state_token=secrets.token_urlsafe(AUTHORIZATION_RANDOM_BYTES),
                pkce=create_pkce(),
                generation=record.generation,
                expires_at=time.time() + AUTHORIZATION_LIFETIME_SECONDS,
                account_id=account_id,
            )
            self._transactions[transaction.id] = transaction
            self._states[transaction.state_token] = transaction
            self._connections[scope] = transaction.id
            transaction.expiry = asyncio.get_running_loop().call_later(
                AUTHORIZATION_LIFETIME_SECONDS, self._expire, transaction.id
            )
            return {
                **transaction.public(),
                "authorization_url": self._protocol.provider.authorization_url(
                    CALLBACK_REDIRECT_URI, transaction.pkce.challenge, transaction.state_token
                ),
            }

    async def _bind(self) -> asyncio.Server:
        try:
            return await asyncio.start_server(
                self._callback,
                list(CALLBACK_LOOPBACK_HOSTS),
                CALLBACK_PORT,
                limit=CALLBACK_REQUEST_LIMIT_BYTES,
            )
        except OSError as error:
            # A held loopback side means a foreign listener would win part of the
            # `localhost` callbacks; binding the remainder only would share them.
            if error.errno == errno.EADDRINUSE:
                raise OAuthFailure("oauth_callback_port_unavailable") from None
        try:
            return await asyncio.start_server(
                self._callback,
                CALLBACK_IPV4_HOST,
                CALLBACK_PORT,
                limit=CALLBACK_REQUEST_LIMIT_BYTES,
            )
        except OSError:
            raise OAuthFailure("oauth_callback_port_unavailable") from None

    def status(self, owner_id: str, connection_id: str, transaction_id: str) -> dict[str, Any]:
        return self._owned(owner_id, connection_id, transaction_id).public()

    def cancel(self, owner_id: str, connection_id: str, transaction_id: str) -> None:
        transaction = self._owned(owner_id, connection_id, transaction_id)
        if transaction.state in (AuthorizationState.AUTHORIZING, AuthorizationState.EXCHANGING):
            self._finish(transaction, AuthorizationState.CANCELLED)
            if transaction.task is not None:
                transaction.task.cancel()

    def cancel_connection(self, owner_id: str, connection_id: str) -> None:
        transaction_id = self._connections.get((owner_id, connection_id))
        if transaction_id is not None:
            self.cancel(owner_id, connection_id, transaction_id)

    async def close(self) -> None:
        self._closed = True
        async with self._start_lock:
            server, self._server = self._server, None
            if server is not None:
                server.close()
                await server.wait_closed()
        for transaction in tuple(self._transactions.values()):
            self.cancel(transaction.owner_id, transaction.connection_id, transaction.id)
            if transaction.expiry is not None:
                transaction.expiry.cancel()
        callbacks = tuple(self._callbacks)
        for task in callbacks:
            task.cancel()
        await asyncio.gather(*callbacks, return_exceptions=True)
        self._transactions.clear()
        self._states.clear()
        self._connections.clear()

    def _owned(self, owner_id: str, connection_id: str, transaction_id: str) -> Authorization:
        transaction = self._transactions.get(transaction_id)
        if transaction is None or (transaction.owner_id, transaction.connection_id) != (
            owner_id,
            connection_id,
        ):
            raise OAuthFailure("oauth_transaction_unavailable")
        return transaction

    def _finish(
        self, transaction: Authorization, state: AuthorizationState, error: str = ""
    ) -> None:
        transaction.state = state
        transaction.error = error
        self._states.pop(transaction.state_token, None)
        if transaction.expiry is not None:
            transaction.expiry.cancel()
        transaction.pkce = PKCE("", "")
        transaction.state_token = ""
        transaction.expiry = asyncio.get_running_loop().call_later(
            AUTHORIZATION_RESULT_RETENTION_SECONDS, self._forget, transaction.id
        )
        # A completed attempt need not occupy the registered callback port. Existing
        # accepted callbacks retain their streams; a later login can bind anew.
        if not self._states and self._server is not None:
            self._server.close()
            self._server = None

    def _forget(self, transaction_id: str) -> None:
        transaction = self._transactions.pop(transaction_id, None)
        if transaction is not None:
            scope = (transaction.owner_id, transaction.connection_id)
            if self._connections.get(scope) == transaction_id:
                self._connections.pop(scope, None)

    def _expire(self, transaction_id: str) -> None:
        transaction = self._transactions.get(transaction_id)
        if transaction is None:
            return
        if transaction.state in (AuthorizationState.AUTHORIZING, AuthorizationState.EXCHANGING):
            self._finish(transaction, AuthorizationState.EXPIRED, "oauth_authorization_expired")
            if transaction.task is not None:
                transaction.task.cancel()

    async def _callback(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        if task is not None:
            self._callbacks.add(task)
        successful = False
        try:
            async with asyncio.timeout(CALLBACK_READ_TIMEOUT_SECONDS):
                raw = await reader.readuntil(HTTP_HEADER_TERMINATOR)
            request_line = raw.split(b"\r\n", 1)[0].decode("ascii")
            method, target, version = request_line.split(" ")
            if method != "GET" or version not in ("HTTP/1.0", "HTTP/1.1"):
                raise ValueError("invalid callback method")
            url = urlsplit(target)
            if url.scheme or url.netloc or url.path != CALLBACK_PATH:
                raise ValueError("invalid callback path")
            query = parse_qs(url.query, keep_blank_values=True)
            if any(len(values) != 1 for values in query.values()):
                raise ValueError("duplicate callback parameter")
            state = query.get("state", [""])[0]
            transaction = self._states.get(state)
            if transaction is None or not secrets.compare_digest(transaction.state_token, state):
                raise ValueError("unknown callback state")
            if transaction.state != AuthorizationState.AUTHORIZING:
                raise ValueError("callback already consumed")
            if time.time() >= transaction.expires_at:
                self._expire(transaction.id)
                raise ValueError("expired callback")
            transaction.state = AuthorizationState.EXCHANGING
            transaction.task = task
            code = query.get("code", [""])[0]
            if query.get("error") or not code:
                self._finish(transaction, AuthorizationState.FAILED, "oauth_authorization_denied")
            else:
                try:
                    tokens = await self._protocol.exchange(
                        code, CALLBACK_REDIRECT_URI, transaction.pkce.verifier
                    )
                    if transaction.state != AuthorizationState.EXCHANGING:
                        raise OAuthFailure("oauth_transaction_unavailable")
                    # 新建行按真实账号落 owner 戳; 已有行由 store 沿用原戳(_stored_scope)。
                    self._store.replace(
                        transaction.account_id or transaction.owner_id,
                        transaction.connection_id,
                        tokens,
                        expected_generation=transaction.generation,
                    )
                    self._finish(transaction, AuthorizationState.CONNECTED)
                    successful = True
                except CredentialConflictError:
                    self._finish(transaction, AuthorizationState.FAILED, "oauth_connection_changed")
                except OAuthFailure as error:
                    self._finish(transaction, AuthorizationState.FAILED, error.code)
                except (OSError, sqlite3.Error):
                    self._finish(
                        transaction, AuthorizationState.FAILED, "oauth_storage_unavailable"
                    )
        except (
            ValueError,
            UnicodeError,
            TimeoutError,
            asyncio.IncompleteReadError,
            asyncio.LimitOverrunError,
        ):
            pass
        finally:
            try:
                page = CALLBACK_SUCCESS_PAGE if successful else CALLBACK_FAILURE_PAGE
                body = page.encode("utf-8")
                status = "200 OK" if successful else "400 Bad Request"
                writer.write(
                    f"HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\n"
                    f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\n"
                    "Referrer-Policy: no-referrer\r\nConnection: close\r\n\r\n".encode() + body
                )
                await writer.drain()
            except (ConnectionError, OSError):
                pass
            finally:
                writer.close()
                if task is not None:
                    self._callbacks.discard(task)
