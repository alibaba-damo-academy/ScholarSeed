"""Signed OAuth fixtures for protocol contracts, never product acceptance."""

from __future__ import annotations

import json
import time

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

CLIENT = "oaiapp_contract"
SUBJECT = "account-contract"
NONCE = "contract-nonce"
ISSUER = "https://auth.openai.com"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
JWK = {
    **json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(KEY.public_key())),
    "kid": "contract",
    "use": "sig",
    "alg": "RS256",
}


def identity(*, nonce: str = NONCE, subject: str = SUBJECT, audience: str = CLIENT) -> str:
    return jwt.encode(
        {
            "sub": subject,
            "iss": ISSUER,
            "aud": audience,
            "iat": int(time.time()),
            "exp": int(time.time()) + 3600,
            "nonce": nonce,
            "email": "contract@example.test",
        },
        KEY,
        algorithm="RS256",
        headers={"kid": "contract"},
    )
