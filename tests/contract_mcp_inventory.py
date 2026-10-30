"""MCP application inventory evidence, not product acceptance."""

import asyncio
import unittest
from unittest.mock import AsyncMock, Mock

from scholarseed_codex.mcp import (
    MCP_AUTH_REQUIRED,
    MCP_INVENTORY_INVALID,
    MCP_INVENTORY_MISMATCH,
    MCP_INVENTORY_PENDING,
    MCP_STARTUP_ERROR,
    MCP_STARTUP_UPDATED_NOTIFICATION,
    CodexMcpControl,
    verify_mcp_inventory,
)
from scholarseed_codex.protocol.mcp import McpReloadRequest, McpStartupState
from scholarseed_runtime.contract.mcp import McpConfigurationReceipt, McpServerState


def inventory_row(name="server", **values):
    return {
        "name": name,
        "runtimeStatus": "connected",
        "serverInfo": {"name": name},
        "tools": {},
        "toolsError": None,
        "authStatus": "unsupported",
        **values,
    }


class InventoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_declared_disabled_empty_records_are_allowed_but_never_ready(self):
        request = AsyncMock(
            return_value={
                "data": [
                    inventory_row("healthy"),
                    inventory_row("disabled", runtimeStatus=None, serverInfo=None),
                ]
            }
        )
        result = await verify_mcp_inventory(
            request, (), frozenset({"healthy"}), frozenset({"disabled"})
        )
        self.assertTrue(result.revision)
        self.assertEqual(result.safe_error, "")
        self.assertEqual([item.server_id for item in result.servers], ["healthy"])

    async def test_disabled_live_tools_or_unknown_records_remain_rejected(self):
        for values in (
            {"tools": {"probe": {}}},
            {"runtimeStatus": "connected"},
            {"serverInfo": {"name": "unexpected"}},
        ):
            request = AsyncMock(
                return_value={
                    "data": [
                        inventory_row("healthy"),
                        inventory_row(
                            "disabled", **{"runtimeStatus": None, "serverInfo": None, **values}
                        ),
                    ]
                }
            )
            result = await verify_mcp_inventory(
                request, (), frozenset({"healthy"}), frozenset({"disabled"})
            )
            self.assertEqual(result.safe_error, MCP_INVENTORY_MISMATCH)
            self.assertFalse(result.revision)
        request = AsyncMock(
            return_value={"data": [inventory_row("unknown", runtimeStatus=None, serverInfo=None)]}
        )
        result = await verify_mcp_inventory(request, (), frozenset(), frozenset({"disabled"}))
        self.assertEqual(result.safe_error, MCP_INVENTORY_MISMATCH)

    async def test_failed_server_does_not_erase_healthy_server_observation(self):
        request = AsyncMock(
            return_value={
                "data": [
                    inventory_row("healthy", tools={"probe": {}}),
                    inventory_row("broken", toolsError="sensitive transport details"),
                ],
                "nextCursor": None,
            }
        )
        result = await verify_mcp_inventory(request, ("thread",), frozenset({"healthy", "broken"}))
        observed = {server.server_id: server for server in result.servers}
        self.assertEqual(result.safe_error, MCP_STARTUP_ERROR)
        self.assertFalse(result.revision)
        self.assertTrue(result.can_admit)
        self.assertEqual(observed["healthy"].state, McpServerState.READY)
        self.assertEqual(observed["healthy"].tool_count, 1)
        self.assertEqual(observed["broken"].state, McpServerState.FAILED)
        self.assertEqual(observed["broken"].safe_error, MCP_STARTUP_ERROR)
        self.assertNotIn("sensitive", repr(result.servers))

    async def test_failed_or_unauthorized_servers_require_empty_terminal_inventory(self):
        for error in ({"toolsError": "private"}, {"authStatus": "notLoggedIn"}):
            for values, admitted in (
                ({}, True),
                ({"tools": {"stale": {}}}, False),
                ({"tools": None}, False),
                ({"runtimeStatus": "starting"}, False),
            ):
                with self.subTest(error=error, values=values):
                    result = await verify_mcp_inventory(
                        AsyncMock(return_value={"data": [inventory_row(**error, **values)]}),
                        ("thread",),
                        frozenset({"server"}),
                    )
                    self.assertEqual(result.can_admit, admitted)
                    self.assertFalse(result.revision)

    async def test_partial_failure_never_admits_unknown_or_pending_inventory(self):
        for additional in (
            inventory_row("unknown"),
            inventory_row("healthy", runtimeStatus="starting"),
        ):
            result = await verify_mcp_inventory(
                AsyncMock(
                    return_value={
                        "data": [inventory_row("broken", toolsError="failed"), additional]
                    }
                ),
                ("thread",),
                frozenset({"broken", "healthy"}),
            )
            self.assertFalse(result.can_admit)

    async def test_server_observation_requires_all_thread_connections(self):
        request = AsyncMock(
            side_effect=[
                {"data": [inventory_row()], "nextCursor": None},
                {"data": [inventory_row(tools={"one": {}, "two": {}})], "nextCursor": None},
                {"data": [inventory_row(runtimeStatus="starting")], "nextCursor": None},
            ]
        )
        result = await verify_mcp_inventory(request, ("first", "second"), frozenset({"server"}))
        self.assertEqual(result.servers[0].state, McpServerState.CONNECTING)
        self.assertIsNone(result.servers[0].tool_count)
        self.assertFalse(result.revision)

    async def test_reload_submits_configuration_without_raw_rpc_or_waiting(self):
        request = AsyncMock()
        receipt = McpConfigurationReceipt(3)
        reload_configuration = Mock(return_value=receipt)
        control = CodexMcpControl(
            request=request,
            session_id=lambda: "thread",
            reload_configuration=reload_configuration,
        )
        async with control._admission.enter():
            result = await control.reload(McpReloadRequest())
        self.assertIs(result, receipt)
        reload_configuration.assert_called_once_with()
        request.assert_not_called()
        self.assertTrue(control.capabilities.reload)

    async def test_reload_without_configuration_owner_is_unavailable(self):
        request = AsyncMock()
        control = CodexMcpControl(request=request, session_id=lambda: "thread")
        self.assertFalse(control.capabilities.reload)
        with self.assertRaises(RuntimeError):
            await control.reload(McpReloadRequest())
        request.assert_not_called()

    async def test_snapshot_does_not_default_unknown_or_starting_to_ready(self):
        for status, expected in (
            (None, McpStartupState.UNKNOWN),
            ("unexpected", McpStartupState.UNKNOWN),
            ("starting", McpStartupState.STARTING),
            ("connected", McpStartupState.READY),
        ):
            with self.subTest(status=status):
                control = CodexMcpControl(
                    request=AsyncMock(return_value={"data": [inventory_row(runtimeStatus=status)]}),
                    session_id=lambda: "thread",
                )
                snapshot = await control.snapshot()
                self.assertEqual(snapshot.servers[0].startup_state, expected)

    async def test_paged_refresh_cannot_overwrite_failure_notification(self):
        entered = asyncio.Event()
        released = asyncio.Event()
        calls = 0

        async def request(method, params):
            nonlocal calls
            calls += 1
            if calls == 1:
                return {"data": [inventory_row(runtimeStatus=None)], "nextCursor": "second"}
            if calls == 2:
                entered.set()
                await released.wait()
                return {"data": [], "nextCursor": None}
            return {"data": [inventory_row(runtimeStatus=None)]}

        control = CodexMcpControl(request=request, session_id=lambda: "thread")
        reading = asyncio.create_task(control.snapshot())
        await entered.wait()
        await control.handle_notification(
            MCP_STARTUP_UPDATED_NOTIFICATION,
            {"name": "server", "status": "failed", "error": "private"},
        )
        released.set()
        snapshot = await reading
        self.assertEqual(snapshot.servers[0].startup_state, McpStartupState.FAILED)
        self.assertEqual(snapshot.servers[0].safe_error, MCP_STARTUP_ERROR)
        self.assertEqual(calls, 3)

    async def test_all_attached_threads_are_verified(self):
        request = AsyncMock(return_value={"data": [inventory_row()], "nextCursor": None})
        result = await verify_mcp_inventory(request, ("first", "second"), frozenset({"server"}))
        self.assertTrue(result.revision)
        self.assertFalse(result.safe_error)
        self.assertEqual(
            [call.args[1]["threadId"] for call in request.call_args_list], [None, "first", "second"]
        )

    async def test_missing_extra_and_duplicate_servers_are_not_ready(self):
        for rows, expected in (
            ([], MCP_INVENTORY_MISMATCH),
            ([inventory_row("extra")], MCP_INVENTORY_MISMATCH),
            ([inventory_row(), inventory_row()], MCP_INVENTORY_INVALID),
        ):
            with self.subTest(rows=rows):
                result = await verify_mcp_inventory(
                    AsyncMock(return_value={"data": rows}), ("thread",), frozenset({"server"})
                )
                self.assertFalse(result.revision)
                self.assertEqual(result.safe_error, expected)

    async def test_starting_auth_required_and_tool_errors_are_not_ready(self):
        for values, expected in (
            ({"runtimeStatus": "starting"}, MCP_INVENTORY_PENDING),
            ({"runtimeStatus": None}, MCP_INVENTORY_PENDING),
            ({"serverInfo": None}, MCP_INVENTORY_PENDING),
            ({"authStatus": "notLoggedIn"}, MCP_AUTH_REQUIRED),
            ({"toolsError": "private error"}, MCP_STARTUP_ERROR),
            ({"tools": None}, MCP_INVENTORY_INVALID),
        ):
            with self.subTest(values=values):
                result = await verify_mcp_inventory(
                    AsyncMock(return_value={"data": [inventory_row(**values)]}),
                    ("thread",),
                    frozenset({"server"}),
                )
                self.assertFalse(result.revision)
                self.assertEqual(result.safe_error, expected)

    async def test_process_inventory_has_no_thread_runtime_status(self):
        request = AsyncMock(return_value={"data": [inventory_row(runtimeStatus=None)]})
        result = await verify_mcp_inventory(request, (), frozenset({"server"}))
        self.assertTrue(result.revision)
        self.assertIsNone(request.call_args.args[1]["threadId"])

    async def test_repeated_cursor_is_rejected(self):
        request = AsyncMock(return_value={"data": [], "nextCursor": "same"})
        result = await verify_mcp_inventory(request, ("thread",), frozenset())
        self.assertEqual(result.safe_error, MCP_INVENTORY_INVALID)
        self.assertEqual(request.await_count, 2)

    async def test_invalidation_discards_inflight_old_inventory(self):
        entered = asyncio.Event()
        released = asyncio.Event()
        calls = 0

        async def request(method, params):
            nonlocal calls
            calls += 1
            if calls == 1:
                entered.set()
                await released.wait()
                return {"data": [inventory_row("old")]}
            return {"data": [inventory_row("new")]}

        control = CodexMcpControl(request=request, session_id=lambda: "thread")
        reading = asyncio.create_task(control.snapshot())
        await entered.wait()
        control.invalidate()
        released.set()
        snapshot = await reading
        self.assertEqual([server.name for server in snapshot.servers], ["new"])
        self.assertEqual(calls, 2)


if __name__ == "__main__":
    unittest.main()
