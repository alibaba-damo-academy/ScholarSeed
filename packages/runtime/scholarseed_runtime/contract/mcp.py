"""Runtime-neutral user trust decisions for MCP controls."""

from enum import Enum


class McpTrustDecision(str, Enum):
    ALLOW_SESSION = "allow_session"
    TRUST_WORKSPACE = "trust_workspace"
    DENY = "deny"
