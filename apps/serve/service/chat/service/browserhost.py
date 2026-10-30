"""Authenticated local transport to the managed Desktop browser host."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from typing import TypedDict
from urllib.parse import urlsplit

import httpx

from service.platform.bridge import BROWSER_CLOSE_OPERATION, BROWSER_OPEN_OPERATION

AGENT_BROWSER_PORT_ENV = "SCHOLARSEED_AGENT_BROWSER_PORT"
AGENT_BROWSER_KEY_ENV = "SCHOLARSEED_AGENT_BROWSER_KEY"
AGENT_BROWSER_HEADER = "X-ScholarSeed-Agent-Key"
AGENT_BROWSER_ROUTE = "/agent/browser"
AGENT_BROWSER_TIMEOUT_SECONDS = 10.0
AGENT_BROWSER_RESPONSE_GRACE_SECONDS = 1.0
AGENT_BROWSER_SCOPE_END_TIMEOUT_SECONDS = (
    AGENT_BROWSER_TIMEOUT_SECONDS + AGENT_BROWSER_RESPONSE_GRACE_SECONDS
)
AGENT_BROWSER_ACTION_DEADLINE_SECONDS = 29.0
AGENT_BROWSER_ACTION_TIMEOUT_SECONDS = 35.0
AGENT_BROWSER_MAX_RESPONSE_BYTES = 65_536
AGENT_BROWSER_PROOF_LIFETIME_MS = 60_000
AGENT_BROWSER_PROOF_ID_CHARS = 128
AGENT_BROWSER_HISTORY_DIGEST_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
AGENT_BROWSER_MAX_URL_CHARS = 8_192
AGENT_BROWSER_KEY_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
BROWSER_UNAVAILABLE = {"ok": False, "error": "browser_unavailable"}
BROWSER_STALE_SCOPE = "stale_scope"
BROWSER_SCOPE_UNSETTLED = "scope_unsettled"
BROWSER_SCOPE_DRAIN_PHASES = frozenset({"requests", "effects", "leases"})
BROWSER_SCOPE_DRAIN_STATUS = 408
BROWSER_OBSERVATION_READ_REQUIRED = "observation_read_required"
BROWSER_OBSERVATION_REQUIRED_STATUS = 409
logger = logging.getLogger(__name__)


class BrowserScope(TypedDict):
    session_id: str
    instance_id: str
    product_turn_id: str
    turn_id: str
    generation: int
    interrupt_generation: int
    lifecycle_epoch: int


def _web_origin(value: object) -> str | None:
    if not isinstance(value, str) or not value or len(value) > AGENT_BROWSER_MAX_URL_CHARS:
        return None
    if "\\" in value or any(ord(character) <= 32 for character in value):
        return None
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or not value.startswith(f"{parsed.scheme}://")
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
        ):
            return None
        parsed.hostname.encode("ascii")
        port = parsed.port
    except (ValueError, UnicodeError):
        return None
    host = parsed.hostname
    if ":" in host:
        host = f"[{host}]"
    default_port = 443 if parsed.scheme == "https" else 80
    return f"{parsed.scheme}://{host}" + (f":{port}" if port and port != default_port else "")


class BrowserHostClient:
    def __init__(self, port: int | None, key: str | None, *, enabled: bool = True) -> None:
        self.product_enabled = enabled
        self._port = port
        self._key = key
        self._faulted = False

    @classmethod
    def from_environment(cls, *, enabled: bool) -> "BrowserHostClient":
        port_raw = os.environ.pop(AGENT_BROWSER_PORT_ENV, "")
        key = os.environ.pop(AGENT_BROWSER_KEY_ENV, "")
        if not enabled:
            return cls(None, None, enabled=False)
        try:
            port = int(port_raw)
        except ValueError:
            return cls(None, None)
        if not 1 <= port <= 65535 or not AGENT_BROWSER_KEY_PATTERN.fullmatch(key):
            return cls(None, None)
        return cls(port, key)

    @property
    def _transport_available(self) -> bool:
        return self.product_enabled and self._port is not None and self._key is not None

    @property
    def available(self) -> bool:
        return self._transport_available and not self._faulted

    async def search(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        request_id: str,
        query: str,
        engine: str,
        limit: int,
    ) -> dict[str, object]:
        return await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="search",
            request_id=request_id,
            query=query,
            engine=engine,
            limit=limit,
        )

    async def start_scope(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
    ) -> dict[str, object]:
        return await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="scope/start",
        )

    async def end_scope(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
    ) -> dict[str, object]:
        try:
            result = await self._request(
                session_id=session_id,
                instance_id=instance_id,
                product_turn_id=product_turn_id,
                turn_id=turn_id,
                generation=generation,
                interrupt_generation=interrupt_generation,
                lifecycle_epoch=lifecycle_epoch,
                action="scope/end",
            )
        except asyncio.CancelledError:
            self._faulted = True
            logger.warning("browser_host_channel_faulted reason=cancelled")
            raise
        except Exception:
            self._faulted = True
            logger.warning("browser_host_channel_faulted reason=exception")
            return BROWSER_UNAVAILABLE.copy()
        if result.get("ok") is not True and result.get("error") not in (
            BROWSER_STALE_SCOPE,
            BROWSER_SCOPE_UNSETTLED,
        ):
            self._faulted = True
            logger.warning("browser_host_channel_faulted reason=unconfirmed_response")
        return result

    async def prepare_history(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        request_id: str,
        search: str,
        offset: int,
        limit: int,
        intent: str,
    ) -> dict[str, object]:
        result = await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="history/prepare",
            request_id=request_id,
            search=search,
            offset=offset,
            limit=limit,
            intent=intent,
        )
        if result.get("ok") is not True:
            return result
        proof = result.get("proof")
        expected_scope = {
            "sessionId": session_id,
            "instanceId": instance_id,
            "productTurnId": product_turn_id,
            "turnId": turn_id,
            "generation": generation,
            "interruptGeneration": interrupt_generation,
            "lifecycleEpoch": lifecycle_epoch,
        }
        if not isinstance(proof, dict) or set(proof) != {
            "proof_id",
            "request_id",
            "scope",
            "query_digest",
            "history_revision",
            "expires_at",
        }:
            return BROWSER_UNAVAILABLE.copy()
        expires_at = proof["expires_at"]
        if (
            not isinstance(proof["proof_id"], str)
            or not 1 <= len(proof["proof_id"]) <= AGENT_BROWSER_PROOF_ID_CHARS
            or proof["request_id"] != request_id
            or proof["scope"] != expected_scope
            or not isinstance(proof["query_digest"], str)
            or AGENT_BROWSER_HISTORY_DIGEST_PATTERN.fullmatch(proof["query_digest"]) is None
            or not isinstance(proof["history_revision"], int)
            or isinstance(proof["history_revision"], bool)
            or proof["history_revision"] < 0
            or not isinstance(expires_at, int)
            or isinstance(expires_at, bool)
            or not time.time() * 1000
            < expires_at
            <= time.time() * 1000 + AGENT_BROWSER_PROOF_LIFETIME_MS
        ):
            return BROWSER_UNAVAILABLE.copy()
        return result

    async def execute_history(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        request_id: str,
        grant_request_id: str,
        proof_id: str,
    ) -> dict[str, object]:
        return await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="history/execute",
            request_id=request_id,
            grant_request_id=grant_request_id,
            proof_id=proof_id,
        )

    async def cancel_history(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        request_id: str,
        grant_request_id: str,
        proof_id: str | None = None,
    ) -> dict[str, object]:
        return await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="history/cancel",
            request_id=request_id,
            grant_request_id=grant_request_id,
            proof_id=proof_id,
        )

    async def complete_history(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        request_id: str,
        grant_request_id: str,
        proof_id: str,
    ) -> dict[str, object]:
        return await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="history/complete",
            request_id=request_id,
            grant_request_id=grant_request_id,
            proof_id=proof_id,
        )

    async def list_tabs(
        self,
        *,
        session_id: str,
        turn_id: str,
        request_id: str,
        instance_id: str,
        product_turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
    ) -> dict[str, object]:
        return await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="list",
            request_id=request_id,
        )

    async def open_tab(
        self,
        *,
        session_id: str,
        turn_id: str,
        request_id: str,
        instance_id: str,
        product_turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
    ) -> dict[str, object]:
        return await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action=BROWSER_OPEN_OPERATION,
            request_id=request_id,
        )

    async def close_tab(
        self,
        *,
        session_id: str,
        turn_id: str,
        request_id: str,
        instance_id: str,
        product_turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        tab_id: str,
    ) -> dict[str, object]:
        return await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action=BROWSER_CLOSE_OPERATION,
            request_id=request_id,
            tab_id=tab_id,
        )

    async def prepare_read(
        self,
        *,
        session_id: str,
        turn_id: str,
        request_id: str,
        instance_id: str,
        product_turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        tab_id: str,
        intent: str,
    ) -> dict[str, object]:
        result = await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="prepare-read",
            request_id=request_id,
            tab_id=tab_id,
            intent=intent,
        )
        if result.get("ok") is not True:
            return result
        proof = result.get("proof")
        expected_scope = {
            "sessionId": session_id,
            "instanceId": instance_id,
            "productTurnId": product_turn_id,
            "turnId": turn_id,
            "generation": generation,
            "interruptGeneration": interrupt_generation,
            "lifecycleEpoch": lifecycle_epoch,
        }
        if not isinstance(proof, dict) or set(proof) != {
            "proof_id",
            "request_id",
            "scope",
            "tab_id",
            "target_instance_id",
            "target_generation",
            "origin",
            "intent",
            "expires_at",
            "policy_revision",
            "policy_decision",
        }:
            return BROWSER_UNAVAILABLE.copy()
        expires_at = proof["expires_at"]
        if (
            not isinstance(proof["proof_id"], str)
            or not 1 <= len(proof["proof_id"]) <= AGENT_BROWSER_PROOF_ID_CHARS
            or proof["request_id"] != request_id
            or proof["scope"] != expected_scope
            or proof["tab_id"] != tab_id
            or not isinstance(proof["target_instance_id"], str)
            or not proof["target_instance_id"]
            or not isinstance(proof["target_generation"], int)
            or isinstance(proof["target_generation"], bool)
            or proof["target_generation"] < 0
            or not isinstance(proof["origin"], str)
            or not proof["origin"]
            or proof["intent"] != intent
            or not isinstance(expires_at, int)
            or isinstance(expires_at, bool)
            or not time.time() * 1000
            < expires_at
            <= time.time() * 1000 + AGENT_BROWSER_PROOF_LIFETIME_MS
            or not isinstance(proof["policy_revision"], int)
            or isinstance(proof["policy_revision"], bool)
            or proof["policy_revision"] < 0
            or proof["policy_decision"] not in {"ask", "allow"}
        ):
            return BROWSER_UNAVAILABLE.copy()
        return result

    async def prepare_navigate(
        self,
        *,
        session_id: str,
        turn_id: str,
        request_id: str,
        instance_id: str,
        product_turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        tab_id: str,
        url: str,
        intent: str,
    ) -> dict[str, object]:
        result = await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="prepare-navigate",
            request_id=request_id,
            tab_id=tab_id,
            url=url,
            intent=intent,
        )
        if result.get("ok") is not True:
            return result
        proof = result.get("proof")
        expected_scope = {
            "sessionId": session_id,
            "instanceId": instance_id,
            "productTurnId": product_turn_id,
            "turnId": turn_id,
            "generation": generation,
            "interruptGeneration": interrupt_generation,
            "lifecycleEpoch": lifecycle_epoch,
        }
        if not isinstance(proof, dict) or set(proof) != {
            "proof_id",
            "request_id",
            "scope",
            "tab_id",
            "target_instance_id",
            "target_generation",
            "source_origin",
            "destination_url",
            "destination_origin",
            "intent",
            "expires_at",
            "policy_revision",
            "policy_decision",
        }:
            return BROWSER_UNAVAILABLE.copy()
        expires_at = proof["expires_at"]
        source_origin = proof["source_origin"]
        destination_url = proof["destination_url"]
        destination_origin = proof["destination_origin"]
        if (
            not isinstance(proof["proof_id"], str)
            or not 1 <= len(proof["proof_id"]) <= AGENT_BROWSER_PROOF_ID_CHARS
            or proof["request_id"] != request_id
            or proof["scope"] != expected_scope
            or proof["tab_id"] != tab_id
            or not isinstance(proof["target_instance_id"], str)
            or not proof["target_instance_id"]
            or not isinstance(proof["target_generation"], int)
            or isinstance(proof["target_generation"], bool)
            or proof["target_generation"] < 0
            or source_origin is not None
            and _web_origin(source_origin) != source_origin
            or _web_origin(destination_url) != destination_origin
            or not isinstance(destination_origin, str)
            or proof["intent"] != intent
            or not isinstance(expires_at, int)
            or isinstance(expires_at, bool)
            or not time.time() * 1000
            < expires_at
            <= time.time() * 1000 + AGENT_BROWSER_PROOF_LIFETIME_MS
            or not isinstance(proof["policy_revision"], int)
            or isinstance(proof["policy_revision"], bool)
            or proof["policy_revision"] < 0
            or proof["policy_decision"] not in {"ask", "allow"}
        ):
            return BROWSER_UNAVAILABLE.copy()
        return result

    async def execute_navigate(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        request_id: str,
        grant_request_id: str,
        proof_id: str,
        tab_id: str,
    ) -> dict[str, object]:
        if not self.available:
            return BROWSER_UNAVAILABLE.copy()
        result = await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="execute-navigate",
            request_id=request_id,
            grant_request_id=grant_request_id,
            proof_id=proof_id,
            tab_id=tab_id,
        )
        if result.get("ok") is not True and result.get("error") == "browser_unavailable":
            return {"ok": False, "error": "request_unknown"}
        return result

    async def cancel_navigate(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        request_id: str,
        grant_request_id: str,
        tab_id: str,
    ) -> dict[str, object]:
        return await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="cancel-navigate",
            request_id=request_id,
            grant_request_id=grant_request_id,
            tab_id=tab_id,
        )

    async def prepare_action(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        request_id: str,
        tab_id: str,
        snapshot_id: str,
        element_ref: str,
        browser_action: str,
        intent: str,
        value: str | None = None,
        preparation_request_id: str | None = None,
        read_request_id: str | None = None,
        read_proof_id: str | None = None,
    ) -> dict[str, object]:
        observing = any(
            item is not None for item in (preparation_request_id, read_request_id, read_proof_id)
        )
        if observing and (
            not all(
                isinstance(item, str) and item
                for item in (preparation_request_id, read_request_id, read_proof_id)
            )
            or preparation_request_id == request_id
            or read_request_id == request_id
            or preparation_request_id == read_request_id
        ):
            return BROWSER_UNAVAILABLE.copy()
        result = await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="prepare-action",
            request_id=preparation_request_id if observing else request_id,
            action_request_id=request_id if observing else None,
            grant_request_id=read_request_id,
            proof_id=read_proof_id,
            tab_id=tab_id,
            snapshot_id=snapshot_id,
            element_ref=element_ref,
            browser_action=browser_action,
            intent=intent,
            value=value,
        )
        if result.get("ok") is not True:
            return result
        proof = result.get("proof")
        expected_scope = {
            "sessionId": session_id,
            "instanceId": instance_id,
            "productTurnId": product_turn_id,
            "turnId": turn_id,
            "generation": generation,
            "interruptGeneration": interrupt_generation,
            "lifecycleEpoch": lifecycle_epoch,
        }
        if not isinstance(proof, dict) or set(proof) != {
            "prepared_id",
            "proof_id",
            "request_id",
            "scope",
            "tab_id",
            "target_instance_id",
            "target_generation",
            "origin",
            "snapshot_id",
            "element_ref",
            "backend_node_id",
            "grant_id",
            "grant_request_id",
            "grant_revision",
            "revocation_epoch",
            "browser_action",
            "intent",
            "expires_at",
            "element",
        }:
            return BROWSER_UNAVAILABLE.copy()
        expires_at = proof["expires_at"]
        element = proof["element"]
        if (
            any(
                not isinstance(proof[field], str)
                or not 1 <= len(proof[field]) <= AGENT_BROWSER_PROOF_ID_CHARS
                for field in (
                    "prepared_id",
                    "proof_id",
                    "target_instance_id",
                    "grant_id",
                    "grant_request_id",
                )
            )
            or proof["request_id"] != request_id
            or proof["scope"] != expected_scope
            or proof["tab_id"] != tab_id
            or _web_origin(proof["origin"]) != proof["origin"]
            or proof["snapshot_id"] != snapshot_id
            or observing
            and proof["grant_request_id"] != read_request_id
            or proof["element_ref"] != element_ref
            or proof["browser_action"] != browser_action
            or proof["intent"] != intent
            or any(
                isinstance(proof[field], bool)
                or not isinstance(proof[field], int)
                or proof[field] < 0
                for field in (
                    "target_generation",
                    "backend_node_id",
                    "grant_revision",
                    "revocation_epoch",
                )
            )
            or not isinstance(expires_at, int)
            or isinstance(expires_at, bool)
            or not time.time() * 1000
            < expires_at
            <= time.time() * 1000 + AGENT_BROWSER_PROOF_LIFETIME_MS
            or not isinstance(element, dict)
            or set(element) != {"role", "name"}
            or any(not isinstance(item, str) for item in element.values())
        ):
            return BROWSER_UNAVAILABLE.copy()
        return result

    async def execute_action(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        request_id: str,
        grant_request_id: str,
        proof_id: str,
        tab_id: str,
    ) -> dict[str, object]:
        result = await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="execute-action",
            request_id=request_id,
            grant_request_id=grant_request_id,
            proof_id=proof_id,
            tab_id=tab_id,
        )
        if result.get("ok") is not True and result.get("error") == "browser_unavailable":
            return {"ok": False, "error": "request_unknown"}
        return result

    async def cancel_action(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        request_id: str,
        grant_request_id: str,
        tab_id: str,
    ) -> dict[str, object]:
        return await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="cancel-action",
            request_id=request_id,
            grant_request_id=grant_request_id,
            tab_id=tab_id,
        )

    async def snapshot(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        request_id: str,
        grant_request_id: str,
        proof_id: str,
        tab_id: str,
    ) -> dict[str, object]:
        result = await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="snapshot",
            request_id=request_id,
            grant_request_id=grant_request_id,
            proof_id=proof_id,
            tab_id=tab_id,
        )
        if result.get("ok") is not True:
            return result
        snapshot = result.get("snapshot")
        if (
            not isinstance(snapshot, dict)
            or set(snapshot) != {"snapshot_id", "origin", "title", "elements"}
            or not all(
                isinstance(snapshot[field], str) and snapshot[field]
                for field in ("snapshot_id", "origin")
            )
            or not isinstance(snapshot["title"], str)
            or not isinstance(snapshot["elements"], list)
            or any(
                not isinstance(element, dict)
                or set(element) != {"element_ref", "role", "name"}
                or not all(
                    isinstance(element[field], str) for field in ("element_ref", "role", "name")
                )
                for element in snapshot["elements"]
            )
        ):
            return BROWSER_UNAVAILABLE.copy()
        return result

    async def read(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        request_id: str,
        tab_id: str,
        snapshot_id: str,
        element_ref: str,
    ) -> dict[str, object]:
        result = await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="read",
            request_id=request_id,
            tab_id=tab_id,
            snapshot_id=snapshot_id,
            element_ref=element_ref,
        )
        if result.get("ok") is not True:
            return result
        element = result.get("element")
        if (
            not isinstance(element, dict)
            or set(element) != {"element_ref", "role", "name"}
            or any(not isinstance(element[field], str) for field in ("element_ref", "role", "name"))
        ):
            return BROWSER_UNAVAILABLE.copy()
        return result

    async def cancel_read(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        request_id: str,
        grant_request_id: str,
        tab_id: str,
    ) -> dict[str, object]:
        return await self._request(
            session_id=session_id,
            instance_id=instance_id,
            product_turn_id=product_turn_id,
            turn_id=turn_id,
            generation=generation,
            interrupt_generation=interrupt_generation,
            lifecycle_epoch=lifecycle_epoch,
            action="cancel-read",
            request_id=request_id,
            grant_request_id=grant_request_id,
            tab_id=tab_id,
        )

    async def _request(
        self,
        *,
        session_id: str,
        instance_id: str,
        product_turn_id: str,
        turn_id: str,
        generation: int,
        interrupt_generation: int,
        lifecycle_epoch: int,
        action: str,
        request_id: str | None = None,
        action_request_id: str | None = None,
        tab_id: str | None = None,
        url: str | None = None,
        intent: str | None = None,
        grant_request_id: str | None = None,
        proof_id: str | None = None,
        snapshot_id: str | None = None,
        element_ref: str | None = None,
        browser_action: str | None = None,
        value: str | None = None,
        search: str | None = None,
        offset: int | None = None,
        limit: int | None = None,
        query: str | None = None,
        engine: str | None = None,
    ) -> dict[str, object]:
        if not self._transport_available or (self._faulted and action != BROWSER_CLOSE_OPERATION):
            logger.warning(
                "browser_host_unavailable action=%s enabled=%s configured=%s faulted=%s",
                action,
                self.product_enabled,
                self._transport_available,
                self._faulted,
            )
            return BROWSER_UNAVAILABLE.copy()
        action_request = action in {
            BROWSER_OPEN_OPERATION,
            BROWSER_CLOSE_OPERATION,
            "snapshot",
            "read",
            "execute-navigate",
            "execute-action",
            "history/execute",
            "search",
        }
        request_timeout = (
            AGENT_BROWSER_SCOPE_END_TIMEOUT_SECONDS
            if action == "scope/end"
            else (
                AGENT_BROWSER_ACTION_TIMEOUT_SECONDS
                if action_request
                else AGENT_BROWSER_TIMEOUT_SECONDS
            )
        )
        deadline_seconds = (
            AGENT_BROWSER_ACTION_DEADLINE_SECONDS
            if action_request
            else AGENT_BROWSER_TIMEOUT_SECONDS
        )
        deadline = int((time.time() + deadline_seconds) * 1000) - 1
        payload = {
            "session_id": session_id,
            "instance_id": instance_id,
            "product_turn_id": product_turn_id,
            "turn_id": turn_id,
            "generation": generation,
            "interrupt_generation": interrupt_generation,
            "lifecycle_epoch": lifecycle_epoch,
            **({"request_id": request_id} if request_id is not None else {}),
            **({"action_request_id": action_request_id} if action_request_id is not None else {}),
            **(
                {"tab_id": tab_id, "intent": intent}
                if tab_id is not None and intent is not None
                else {}
            ),
            **({"tab_id": tab_id} if tab_id is not None and intent is None else {}),
            **({"grant_request_id": grant_request_id} if grant_request_id is not None else {}),
            **({"proof_id": proof_id} if proof_id is not None else {}),
            **({"url": url} if url is not None else {}),
            **({"snapshot_id": snapshot_id} if snapshot_id is not None else {}),
            **({"element_ref": element_ref} if element_ref is not None else {}),
            **({"browser_action": browser_action} if browser_action is not None else {}),
            **({"value": value} if value is not None else {}),
            **({"search": search} if search is not None else {}),
            **({"offset": offset} if offset is not None else {}),
            **({"limit": limit} if limit is not None else {}),
            **({"query": query} if query is not None else {}),
            **({"engine": engine} if engine is not None else {}),
            "action": action,
            "deadline": deadline,
        }
        try:
            async with asyncio.timeout(request_timeout):
                async with httpx.AsyncClient(trust_env=False, timeout=request_timeout) as client:
                    async with client.stream(
                        "POST",
                        f"http://127.0.0.1:{self._port}{AGENT_BROWSER_ROUTE}",
                        headers={AGENT_BROWSER_HEADER: self._key or ""},
                        json=payload,
                    ) as response:
                        if response.headers.get("content-encoding", "identity") != "identity":
                            return BROWSER_UNAVAILABLE.copy()
                        chunks: list[bytes] = []
                        total = 0
                        async for chunk in response.aiter_raw(chunk_size=8192):
                            total += len(chunk)
                            if total > AGENT_BROWSER_MAX_RESPONSE_BYTES:
                                return BROWSER_UNAVAILABLE.copy()
                            chunks.append(chunk)
            result = json.loads(b"".join(chunks))
            if not isinstance(result, dict) or not isinstance(result.get("ok"), bool):
                return BROWSER_UNAVAILABLE.copy()
            if result.get("error") == BROWSER_STALE_SCOPE and response.status_code != 409:
                return BROWSER_UNAVAILABLE.copy()
            if result.get("error") == BROWSER_OBSERVATION_READ_REQUIRED and (
                action != "prepare-action"
                or result.get("ok") is not False
                or response.status_code != BROWSER_OBSERVATION_REQUIRED_STATUS
            ):
                return BROWSER_UNAVAILABLE.copy()
            if result.get("error") == BROWSER_SCOPE_UNSETTLED and (
                action != "scope/end"
                or response.status_code != BROWSER_SCOPE_DRAIN_STATUS
                or result.get("ok") is not False
                or not isinstance(result.get("phase"), str)
                or result["phase"] not in BROWSER_SCOPE_DRAIN_PHASES
            ):
                return BROWSER_UNAVAILABLE.copy()
            if result.get("ok") is False:
                logger.warning(
                    "browser_host_rejected action=%s status=%d unavailable=%s stale_scope=%s scope_unsettled=%s",
                    action,
                    response.status_code,
                    result.get("error") == BROWSER_UNAVAILABLE["error"],
                    result.get("error") == BROWSER_STALE_SCOPE,
                    result.get("error") == BROWSER_SCOPE_UNSETTLED,
                )
            return result
        except (httpx.HTTPError, ValueError, TimeoutError) as error:
            logger.warning(
                "browser_host_transport_failed action=%s failure_type=%s",
                action,
                type(error).__name__,
            )
            return BROWSER_UNAVAILABLE.copy()
