"""Static renderer mounting for a composed FastAPI product."""

from __future__ import annotations

from collections.abc import MutableMapping
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

CROSS_ORIGIN_OPENER_POLICY = "same-origin"
CROSS_ORIGIN_EMBEDDER_POLICY = "require-corp"
STATIC_MEDIA_TYPES = {
    ".css": "text/css",
    ".js": "text/javascript",
    ".json": "application/json",
    ".mjs": "text/javascript",
    ".wasm": "application/wasm",
}


class ProductStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: MutableMapping[str, Any]) -> Response:
        response = await super().get_response(path, scope)
        media_type = STATIC_MEDIA_TYPES.get(Path(path).suffix.lower())
        if media_type:
            response.headers["content-type"] = media_type
        return response


def register_cross_origin_isolation(app: FastAPI) -> None:
    """Enable SharedArrayBuffer for the same-origin ZetaOffice worker runtime."""

    @app.middleware("http")
    async def cross_origin_isolation(request: Request, call_next) -> Response:
        response = await call_next(request)
        response.headers["Cross-Origin-Opener-Policy"] = CROSS_ORIGIN_OPENER_POLICY
        response.headers["Cross-Origin-Embedder-Policy"] = CROSS_ORIGIN_EMBEDDER_POLICY
        return response


def mount_renderer(app: FastAPI, renderer_dist: str = "") -> None:
    """Mount renderer assets after every API route, preserving API precedence."""
    dist = Path(renderer_dist) if renderer_dist else None
    if dist is None or not (dist / "index.html").exists():
        return
    assets = dist / "assets"
    if assets.is_dir():
        app.mount("/assets", ProductStaticFiles(directory=str(assets)), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        candidate = dist / full_path
        if full_path and candidate.is_file():
            return FileResponse(str(candidate))
        return FileResponse(str(dist / "index.html"))
