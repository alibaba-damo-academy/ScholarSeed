"""Client-side consumer of hosted connector OAuth; never receives an app secret."""

from __future__ import annotations

import math
import secrets
import time
from typing import Callable
from urllib.parse import urlsplit

import httpx

from service.settings.connectors.catalog import Connector
from service.settings.connectors.oauth import checked_url, pkce, request, tokens

HOSTED_PATH = "/api/connectors"
PROOF_BYTES = 32
OWNER_KEY = "connector_owner"
HOSTED_KEY = "hosted"
LOGIN_REQUIRED = "connector_login_required"
NOT_CONFIGURED = "connector_oauth_registration_required"
ATTEMPT_INVALID = "connector_credentials_invalid"
SERVICE_UNAVAILABLE = "connector_service_unavailable"


class HostedOAuth:
    def __init__(self, base_url: str, credential: Callable[[str], str]) -> None:
        self.base_url = base_url.rstrip("/")
        self.credential = credential

    def _call(self, item: Connector, owner: str, operation: str, payload: dict) -> dict:
        parsed = urlsplit(self.base_url)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError(NOT_CONFIGURED)
        credential = self.credential(owner)
        if not credential:
            raise ValueError(LOGIN_REQUIRED)
        with httpx.Client() as client:
            response = request(
                client,
                "POST",
                self.base_url + HOSTED_PATH + f"/{item.id}/{operation}",
                json=payload,
                headers={"Authorization": "Bearer " + credential},
            )
        if response.status_code in (401, 403):
            raise ValueError(LOGIN_REQUIRED)
        if response.status_code == 409:
            raise ValueError(ATTEMPT_INVALID)
        if not response.is_success:
            raise ValueError(SERVICE_UNAVAILABLE)
        try:
            value = response.json()
        except ValueError:
            raise ValueError("connector_response_invalid") from None
        if not isinstance(value, dict):
            raise ValueError("connector_response_invalid")
        return value

    def begin(self, item: Connector, owner: str, redirect: str) -> dict:
        verifier, challenge = pkce()
        proof = secrets.token_urlsafe(PROOF_BYTES)
        value = self._call(
            item,
            owner,
            "authorizations",
            {
                "client_proof": proof,
                "redirect_uri": redirect,
                "code_challenge": challenge,
            },
        )
        url = checked_url(item, str(value.get("authorization_url", "")))
        for field in ("state", "authorization_id"):
            if not isinstance(value.get(field), str) or not value[field]:
                raise ValueError("connector_response_invalid")
        expiry = value.get("expires_at")
        if (
            isinstance(expiry, bool)
            or not isinstance(expiry, (float, int))
            or not math.isfinite(expiry)
            or expiry <= time.time()
        ):
            raise ValueError("connector_response_invalid")
        return {
            "state": value["state"],
            "verifier": verifier,
            "redirect_uri": redirect,
            "expires_at": expiry,
            "authorization_url": url,
            "metadata": {"issuer": item.issuer},
            "client": {
                HOSTED_KEY: True,
                "owner_id": owner,
                "client_proof": proof,
                "authorization_id": value["authorization_id"],
            },
        }

    def exchange(self, item: Connector, attempt: dict, parameters: dict) -> dict:
        context = attempt["client"]
        payload = {"client_proof": context["client_proof"]}
        refreshing = parameters.get("grant_type") == "refresh_token"
        if refreshing:
            payload.update(
                connection_id=context["connection_id"], refresh_token=parameters["refresh_token"]
            )
        else:
            payload.update(
                authorization_id=context["authorization_id"],
                state=attempt["state"],
                code=parameters["code"],
                code_verifier=parameters["code_verifier"],
            )
        result = tokens(
            self._call(item, context["owner_id"], "refresh" if refreshing else "exchange", payload)
        )
        if not refreshing:
            identifier = result.get("connection_id")
            if not isinstance(identifier, str) or not identifier:
                raise ValueError("connector_response_invalid")
            context["connection_id"] = identifier
        return result

    def disconnect(self, item: Connector, oauth: dict) -> None:
        context = oauth["client"]
        self._call(
            item,
            context["owner_id"],
            "disconnect",
            {
                "client_proof": context["client_proof"],
                "connection_id": context["connection_id"],
            },
        )
