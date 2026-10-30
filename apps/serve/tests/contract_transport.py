"""Transport cleanup fault contracts and native loopback lifecycle checks."""

from __future__ import annotations

import asyncio
import socket
import struct
import sys
import unittest
from unittest.mock import Mock

import uvicorn
from fastapi import FastAPI

from service.platform.activity import Activities
from service.platform.server import ProductServer
from service.platform.transport import LOOP_FACTORY, SocketTransport, create_loop


class TransportContracts(unittest.TestCase):
    def transport(self, shutdown_error=None, protocol_error=None):
        transport = SocketTransport.__new__(SocketTransport)
        self.addCleanup(setattr, transport, "_sock", None)
        transport._extra = {}
        transport._called_connection_lost = False
        transport._sock = Mock()
        transport._sock.fileno.return_value = 10
        transport._sock.shutdown.side_effect = shutdown_error
        transport._protocol = Mock()
        transport._protocol.connection_lost.side_effect = protocol_error
        transport._server = Mock()
        return transport

    def test_peer_reset_closes_socket_and_detaches_exactly_once(self):
        transport = self.transport(ConnectionResetError(10054, "peer reset"))
        sock, server = transport._sock, transport._server
        transport._call_connection_lost(None)
        transport._call_connection_lost(None)
        sock.close.assert_called_once()
        server._detach.assert_called_once()
        transport._protocol.connection_lost.assert_called_once_with(None)
        self.assertIsNone(transport._sock)
        self.assertIsNone(transport._server)

    def test_unknown_shutdown_error_is_visible_after_release(self):
        error = OSError(123, "unexpected socket failure")
        transport = self.transport(error)
        sock, server = transport._sock, transport._server
        with self.assertRaises(OSError) as raised:
            transport._call_connection_lost(None)
        self.assertIs(raised.exception, error)
        sock.close.assert_called_once()
        server._detach.assert_called_once()

    def test_protocol_failure_still_releases_socket(self):
        transport = self.transport(protocol_error=RuntimeError("protocol failed"))
        sock, server = transport._sock, transport._server
        with self.assertRaisesRegex(RuntimeError, "protocol failed"):
            transport._call_connection_lost(None)
        sock.close.assert_called_once()
        server._detach.assert_called_once()

    def test_close_failure_does_not_certify_server_release(self):
        transport = self.transport()
        transport._sock.close.side_effect = OSError("close failed")
        server = transport._server
        with self.assertRaisesRegex(OSError, "close failed"):
            transport._call_connection_lost(None)
        server._detach.assert_not_called()
        self.assertFalse(transport._called_connection_lost)
        transport._sock = None  # test mock owns no OS socket

    def test_native_tcp_peer_disconnects_release_listener(self):
        async def check():
            loop = asyncio.get_running_loop()
            errors = []
            loop.set_exception_handler(lambda _loop, context: errors.append(context))
            for reset in (False, True):
                connected = asyncio.Event()
                lost = asyncio.Event()
                transports = []

                class Protocol(asyncio.Protocol):
                    def connection_made(self, transport):
                        transports.append(transport)
                        connected.set()

                    def connection_lost(self, exc):
                        lost.set()

                server = await loop.create_server(Protocol, "127.0.0.1", 0)
                client = socket.socket()
                try:
                    client.connect(server.sockets[0].getsockname())
                    await asyncio.wait_for(connected.wait(), 2)
                    if sys.platform == "win32":
                        self.assertIsInstance(transports[0], SocketTransport)
                    if reset:
                        layout = "HH" if sys.platform == "win32" else "ii"
                        client.setsockopt(
                            socket.SOL_SOCKET, socket.SO_LINGER, struct.pack(layout, 1, 0)
                        )
                    client.close()
                    await asyncio.wait_for(lost.wait(), 2)
                finally:
                    client.close()
                    for transport in transports:
                        transport.close()
                    server.close()
                await asyncio.wait_for(server.wait_closed(), 2)
            self.assertEqual(errors, [])

        with asyncio.Runner(loop_factory=create_loop) as runner:
            runner.run(check())

    def test_product_server_selects_owned_loop_only_on_windows(self):
        config = uvicorn.Config(FastAPI(), log_config=None)
        ProductServer(config, Activities(), domains=Mock())
        if sys.platform == "win32":
            self.assertEqual(config.loop, LOOP_FACTORY)
            self.assertIs(config.get_loop_factory(), create_loop)
        else:
            self.assertEqual(config.loop, "auto")

    def test_native_subprocess_still_drains_pipes(self):
        async def check():
            proc = await asyncio.create_subprocess_exec(
                sys.executable, "-c", "print('transport-ok')", stdout=asyncio.subprocess.PIPE
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), 5)
            self.assertEqual(proc.returncode, 0)
            self.assertEqual(stdout.strip(), b"transport-ok")

        with asyncio.Runner(loop_factory=create_loop) as runner:
            runner.run(check())


if __name__ == "__main__":
    unittest.main()
