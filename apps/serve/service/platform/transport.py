"""Serve-owned Windows socket teardown for the reviewed CPython 3.12 runtime.

CPython's Proactor socket transport calls shutdown before close/_detach. A peer
reset can raise there after protocol.connection_lost has already removed the
HTTP connection, stranding the asyncio server's active count. Keep the normal
Proactor IO/subprocess semantics, but guarantee socket release at this boundary.
No interpreter files or process-wide asyncio classes are patched.
"""

from __future__ import annotations

import asyncio
import logging
import socket
import sys
from asyncio.proactor_events import _ProactorSocketTransport

if sys.platform == "win32":
    from asyncio.windows_events import ProactorEventLoop

logger = logging.getLogger(__name__)
LOOP_FACTORY = "service.platform.transport:create_loop"


class SocketTransport(_ProactorSocketTransport):
    def _call_connection_lost(self, exc):
        if self._called_connection_lost:
            return
        try:
            self._protocol.connection_lost(exc)
        finally:
            try:
                if self._sock.fileno() != -1:
                    try:
                        self._sock.shutdown(socket.SHUT_RDWR)
                    except ConnectionResetError:
                        # The peer has already ended this connection. Still
                        # close our socket and release the server attachment.
                        logger.info(
                            "socket peer reset during teardown local=%s peer=%s server=%s",
                            self.get_extra_info("sockname"),
                            self.get_extra_info("peername"),
                            self._server is not None,
                        )
            finally:
                self._sock.close()
                self._sock = None
                if self._server is not None:
                    self._server._detach()
                    self._server = None
                self._called_connection_lost = True


if sys.platform == "win32":

    class ServeEventLoop(ProactorEventLoop):
        def _make_socket_transport(self, sock, protocol, waiter=None, extra=None, server=None):
            return SocketTransport(self, sock, protocol, waiter, extra, server)


def create_loop() -> asyncio.AbstractEventLoop:
    if sys.platform == "win32":
        return ServeEventLoop()
    return asyncio.new_event_loop()
