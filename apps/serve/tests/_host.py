"""Controlled shared-host context for deterministic Serve contracts."""

from contextlib import asynccontextmanager
from pathlib import Path

from scholarseed_runtime.contract.command import HostWarmupRequest, RuntimeInventory
from scholarseed_runtime.contract.evidence import NOOP_RUNTIME_TIMING

HOST_ID = "controlled-host"
USER_ID = "fixture-actor"


class HostContextFixture:
    def __init__(self, cwd: Path) -> None:
        self.cwd = cwd.resolve()
        self.identity = HOST_ID
        self.calls = []

    @asynccontextmanager
    async def context(
        self,
        *,
        cwd: Path,
        user_id: str,
        model_id: str = "",
        process_environment=None,
        timing=NOOP_RUNTIME_TIMING,
    ):
        if not user_id.strip():
            raise ValueError("runtime_host_context_required")
        host = HostWarmupRequest(
            request_id="controlled-inspection",
            cwd=cwd.resolve(),
            process_sharing_scope=user_id,
            timing=timing,
        )
        self.calls.append((host, model_id, process_environment))
        yield host, self.identity

    @asynccontextmanager
    async def control(self, *, user_id: str, cwd: Path | None = None, **kwargs):
        async with self.context(cwd=cwd or self.cwd, user_id=user_id, **kwargs) as (
            host,
            _identity,
        ):
            yield host

    def inventory(self, inventory) -> RuntimeInventory:
        return RuntimeInventory(
            inventory.revision,
            {
                "skills": {
                    "revision": inventory.revision,
                    "skills": [
                        {
                            "name": skill.name,
                            "path": str(skill.path),
                            "description": skill.description,
                            "enabled": skill.enabled,
                            "scope": skill.scope,
                            "availability": skill.availability.value,
                        }
                        for skill in inventory.skills
                    ],
                    "errors": [],
                }
            },
            host_identity=self.identity,
        )
