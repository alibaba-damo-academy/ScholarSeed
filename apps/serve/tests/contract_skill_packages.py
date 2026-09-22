"""Deterministic package/HTTP safety contracts; not real product acceptance."""

from __future__ import annotations

import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from typing import Any
from unittest.mock import patch

import httpx

from service.capabilities.service.package import (
    EXECUTABLE_MODE,
    FILE_MODE,
    PACKAGE_MANIFEST,
    PackageError,
    Payload,
    digest,
    extract_package,
    fingerprint,
    json_bytes,
    normalize_document,
    pack_skill,
    read_package,
    validate_paths,
)
from service.capabilities.service.registry import Registry, RegistryError, secure_origin

CONFIG: dict[str, Any] = {
    "namespace": "fixture",
    "download_hosts": ["cdn.example.test"],
    "network": {
        "timeout_seconds": 1,
        "max_redirects": 2,
        "get_attempts": 1,
        "page_size": 2,
        "max_pages": 3,
        "retry_seconds": 0,
    },
}


def fixture_zip(extra: dict[str, bytes] | None = None, *, directories: bool = False) -> bytes:
    document = b'---\nname: example\ndescription: Package fixture\nversion: "1.0.0"\n---\nBody\n'
    files = {
        "SKILL.md": Payload(document),
        "scripts/run": Payload(b"#!/bin/sh\nexit 0\n", EXECUTABLE_MODE),
    }
    manifest = {
        "schema": 1,
        "name": "example",
        "version": "1.0.0",
        "dependencies": {},
        "files": [item.record(name) for name, item in files.items()],
    }
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        if directories:
            archive.writestr("scripts/", b"")
        for name, item in files.items():
            archive.writestr(name, item.data)
        archive.writestr(PACKAGE_MANIFEST, json_bytes(manifest))
        for name, value in (extra or {}).items():
            archive.writestr(name, value)
    return data.getvalue()


class PackageContracts(unittest.TestCase):
    def test_payload_and_modes_survive_hub_style_zip(self) -> None:
        package = read_package(fixture_zip(directories=True))
        self.assertEqual(package.files["scripts/run"].mode, EXECUTABLE_MODE)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "skill"
            extract_package(package, root)
            self.assertEqual((root / "scripts/run").stat().st_mode & 0o777, EXECUTABLE_MODE)
            self.assertEqual((root / "SKILL.md").stat().st_mode & 0o777, FILE_MODE)
            with self.assertRaises(FileExistsError):
                extract_package(package, root)

    def test_unsafe_paths(self) -> None:
        cases = [
            ["../outside"],
            ["/absolute"],
            ["a\\b"],
            ["a:b"],
            ["a", "a"],
            ["a", "a/b"],
            ["Refs/a", "refs/b"],
            ["caf\u00e9/a", "cafe\u0301/b"],
            ["a."],
        ]
        for paths in cases:
            with self.subTest(paths=paths), self.assertRaises(PackageError):
                validate_paths(paths)

    def test_explicit_directories_are_not_files(self) -> None:
        validate_paths(["scripts/run"], ["scripts"])
        with self.assertRaises(PackageError):
            validate_paths(["scripts"], ["scripts"])

    def test_unlisted_or_missing_files_are_rejected(self) -> None:
        with self.assertRaises(PackageError):
            read_package(fixture_zip({"extra.txt": b"unlisted"}))
        with self.assertRaises(PackageError):
            read_package(b"not zip")

    def test_manifest_is_content_checked(self) -> None:
        source = zipfile.ZipFile(io.BytesIO(fixture_zip()))
        for corruption in ("hash", "mode", "identity", "duplicate"):
            with self.subTest(corruption=corruption):
                manifest = json.loads(source.read(PACKAGE_MANIFEST))
                if corruption == "hash":
                    manifest["files"][0]["sha256"] = "0" * 64
                elif corruption == "mode":
                    manifest["files"][0]["mode"] = 0o4755
                elif corruption == "identity":
                    manifest["version"] = "2.0.0"
                else:
                    manifest["files"].append(manifest["files"][0])
                output = io.BytesIO()
                with zipfile.ZipFile(output, "w") as archive:
                    for name in source.namelist():
                        archive.writestr(
                            name,
                            json_bytes(manifest) if name == PACKAGE_MANIFEST else source.read(name),
                        )
                with self.assertRaises(PackageError):
                    read_package(output.getvalue())

    def test_zip_symlink_is_rejected(self) -> None:
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            link = zipfile.ZipInfo("link")
            link.external_attr = 0o120777 << 16
            archive.writestr(link, b"outside")
        with self.assertRaises(PackageError):
            read_package(output.getvalue())

    def test_instruction_body_and_normalization(self) -> None:
        source = "---\nname: example\ndescription: key: value\n---\n# Body\nDo the work.\n"
        result = normalize_document(source, "1.0.0").decode()
        self.assertTrue(result.endswith("---\n# Body\nDo the work.\n"))
        self.assertIn('description: "key: value"', result)

    def test_pack_identity_and_no_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"
            source.mkdir()
            (source / "SKILL.md").write_text(
                "---\nname: example\ndescription: fixture\n---\nBody\n"
            )
            output = Path(temporary) / "package.zip"
            with self.assertRaises(PackageError):
                pack_skill(source, output, "1.0.0", {}, expected_name="wrong")
            self.assertFalse(output.exists())
            package = pack_skill(source, output, "1.0.0", {}, expected_name="example")
            self.assertEqual(package.name, "example")
            with self.assertRaises(FileExistsError):
                pack_skill(source, output, "1.0.0", {}, expected_name="example")

    def test_fingerprint_uses_java_sort_order(self) -> None:
        files = {"\ue000": Payload(b"one"), "\U00010000": Payload(b"two")}
        canonical = f"\U00010000:{digest(b'two')}\n\ue000:{digest(b'one')}\n"
        self.assertEqual(fingerprint(files), "sha256:" + digest(canonical.encode()))


class RegistryContracts(unittest.TestCase):
    def test_bearer_api_does_not_reuse_preflight_session_cookie(self) -> None:
        requests: list[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                200, json={"code": 0, "data": {}}, headers={"set-cookie": "SESSION=fixture; Path=/"}
            )

        with Registry(CONFIG, token="fixture", url="https://hub.example.test") as registry:
            registry.client.close()
            registry.client = httpx.Client(
                transport=httpx.MockTransport(handle), headers={"Authorization": "Bearer fixture"}
            )
            registry.request("POST", "/preflight")
            registry.request("POST", "/publish")
        self.assertTrue(all("cookie" not in request.headers for request in requests))
        self.assertTrue(
            all(request.headers["authorization"] == "Bearer fixture" for request in requests)
        )

    def test_public_http_and_userinfo_rejected(self) -> None:
        for url in ("http://public.example", "https://user:pass@example.test", "file:///tmp/a"):
            with self.subTest(url=url), self.assertRaises(RegistryError):
                secure_origin(url, loopback=True)
        self.assertEqual(
            secure_origin("http://127.0.0.1:18780", loopback=True), "http://127.0.0.1:18780"
        )

    def test_session_cannot_download(self) -> None:
        with Registry(CONFIG, url="https://hub.example.test") as registry:
            with self.assertRaises(RegistryError):
                registry.download("/file")

    def test_redirect_never_leaks_bearer_or_cookies(self) -> None:
        calls: list[httpx.Request] = []

        def handle(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            if request.url.host == "hub.example.test":
                return httpx.Response(
                    302,
                    headers={
                        "location": "https://cdn.example.test/file?signature=fixture",
                        "set-cookie": "secret=fixture; Domain=.example.test; Path=/",
                    },
                )
            return httpx.Response(200, content=b"package")

        with Registry(CONFIG, token="fixture", url="https://hub.example.test") as registry:
            transport = httpx.Client(transport=httpx.MockTransport(handle))
            with patch(
                "service.capabilities.service.registry.httpx.Client", return_value=transport
            ):
                self.assertEqual(registry.download("/file"), b"package")
        self.assertEqual(calls[0].headers["authorization"], "Bearer fixture")
        self.assertNotIn("authorization", calls[1].headers)
        self.assertNotIn("cookie", calls[1].headers)

    def test_unapproved_redirect_fails(self) -> None:
        with Registry(CONFIG, token="fixture", url="https://hub.example.test") as registry:
            transport = httpx.Client(
                transport=httpx.MockTransport(
                    lambda request: httpx.Response(
                        302,
                        headers={"location": "https://unapproved.example/file?secret=not-logged"},
                    )
                )
            )
            with patch(
                "service.capabilities.service.registry.httpx.Client", return_value=transport
            ):
                with self.assertRaises(RegistryError) as captured:
                    registry.download("/file")
                self.assertNotIn("not-logged", str(captured.exception))


if __name__ == "__main__":
    unittest.main()
