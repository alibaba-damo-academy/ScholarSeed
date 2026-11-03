import importlib.util
import ssl
import sys
import unittest
from io import BytesIO, StringIO
from pathlib import Path
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError, URLError
from urllib.request import Request

SCRIPTS = Path(__file__).resolve().parents[1] / ".agents/skills/mastergo/scripts"


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class MastergoContract(unittest.TestCase):
    def test_docs_cli_failure_exit_preserves_partial_results(self):
        docs = load_module("mastergo_fetch_docs")
        for outcomes in (
            [ValueError("TLS verification failed"), ValueError("TLS verification failed")],
            ["retained documentation", ValueError("TLS verification failed")],
        ):
            with self.subTest(outcomes=outcomes):
                output = StringIO()
                with (
                    patch.object(docs, "fetch_url", side_effect=outcomes),
                    patch.object(
                        sys,
                        "argv",
                        [
                            "fetch_docs",
                            "https://design.example/a",
                            "https://design.example/b",
                            "--json",
                        ],
                    ),
                    patch.object(sys, "stdout", output),
                    patch.object(sys, "stderr", StringIO()),
                ):
                    with self.assertRaises(SystemExit) as raised:
                        docs.main()
                self.assertEqual(raised.exception.code, 1)
                self.assertIn("TLS verification failed", output.getvalue())
                if isinstance(outcomes[0], str):
                    self.assertIn("retained documentation", output.getvalue())

    def test_zero_port_is_not_default_https(self):
        network = load_module("utils")
        with self.assertRaisesRegex(ValueError, "port"):
            network.origin("https://design.example:0/file")
        self.assertEqual(network.origin("https://design.example/file"), ("design.example", 443))

    def setUp(self):
        self.network_guard = patch(
            "socket.create_connection",
            side_effect=AssertionError("Network is forbidden in this suite"),
        )
        self.network_guard.start()
        self.addCleanup(self.network_guard.stop)

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(SCRIPTS))
        cls.dsl = load_module("mastergo_get_dsl")

    @classmethod
    def tearDownClass(cls):
        sys.path.remove(str(SCRIPTS))

    def test_http_endpoint_refused_before_network(self):
        with patch.object(self.dsl, "open_https") as network:
            with self.assertRaises(ValueError):
                self.dsl.get_dsl(
                    "123", "1:2", token="test-secret", endpoint="http://design.example"
                )
            network.assert_not_called()

    def test_design_origin_must_match_endpoint(self):
        with patch.object(self.dsl, "get_dsl") as fetch:
            with self.assertRaises(ValueError):
                self.dsl.get_dsl_from_url(
                    "https://other.example/file/123?layer_id=1:2",
                    token="test-secret",
                    endpoint="https://design.example",
                )
            fetch.assert_not_called()

    def test_verified_tls_and_redirect_policy(self):
        network = load_module("utils")
        with patch.object(network, "build_opener") as build:
            response = MagicMock()
            response.__enter__.return_value = response
            build.return_value.open.return_value = response
            network.open_https(Request("https://design.example/file"))
            handlers = build.call_args.args
            tls = next(handler for handler in handlers if hasattr(handler, "_context"))
            self.assertEqual(tls._context.verify_mode, ssl.CERT_REQUIRED)
            self.assertTrue(tls._context.check_hostname)
            redirect = next(handler for handler in handlers if hasattr(handler, "redirect_request"))
            for destination in ("http://design.example/file", "https://other.example/file"):
                with self.subTest(destination=destination), self.assertRaises(ValueError):
                    redirect.redirect_request(
                        Request("https://design.example/file"), None, 302, "", {}, destination
                    )

    def test_authenticated_redirect_preserves_only_same_origin(self):
        network = load_module("utils")
        request = Request(
            "https://design.example/file", headers={"X-MG-UserAccessToken": "test-secret"}
        )
        redirect = network.SameOriginRedirect()
        redirected = redirect.redirect_request(
            request, None, 302, "", {}, "https://design.example:443/target"
        )
        self.assertEqual(redirected.get_header("X-mg-useraccesstoken"), "test-secret")
        with self.assertRaises(ValueError):
            redirect.redirect_request(
                request, None, 302, "", {}, "https://design.example:444/target"
            )

    def test_tls_failure_has_no_fallback(self):
        with patch.object(
            self.dsl,
            "open_https",
            side_effect=URLError(ssl.SSLCertVerificationError("untrusted certificate")),
        ) as network:
            with self.assertRaisesRegex(ValueError, "Network error"):
                self.dsl.get_dsl(
                    "123", "1:2", token="test-secret", endpoint="https://design.example"
                )
            self.assertEqual(network.call_count, 1)

    def test_error_response_cannot_echo_secret(self):
        failure = HTTPError("https://design.example", 403, "Forbidden", {}, BytesIO(b"test-secret"))
        self.addCleanup(failure.close)
        with patch.object(self.dsl, "open_https", side_effect=failure):
            with self.assertRaisesRegex(ValueError, "HTTP 403") as raised:
                self.dsl.get_dsl(
                    "123", "1:2", token="test-secret", endpoint="https://design.example"
                )
            self.assertNotIn("test-secret", str(raised.exception))

    def test_success_uses_encoded_parameters(self):
        with patch.object(self.dsl, "open_https") as network:
            network.return_value.__enter__.return_value.read.return_value = b'{"nodes": []}'
            self.dsl.get_dsl(
                "123", "1:2&fileId=other", token="test-secret", endpoint="https://design.example"
            )
            request = network.call_args.args[0]
            self.assertIn("layerId=1%3A2%26fileId%3Dother", request.full_url)
            self.assertEqual(request.get_header("X-mg-useraccesstoken"), "test-secret")

    def test_short_link_and_docs_share_verified_transport(self):
        docs = load_module("mastergo_fetch_docs")
        with patch.object(self.dsl, "open_https") as network:
            network.return_value.__enter__.return_value.url = (
                "https://design.example/file/123?layer_id=1:2"
            )
            self.dsl.resolve_short_link("https://design.example/goto/123")
            self.assertIsNone(network.call_args.args[0].get_header("X-mg-useraccesstoken"))
        with patch.object(docs, "open_https") as network:
            network.return_value.__enter__.return_value.read.return_value = b"documentation"
            self.assertEqual(docs.fetch_url("https://design.example/doc"), "documentation")
            self.assertIsNone(network.call_args.args[0].get_header("X-mg-useraccesstoken"))

    def test_invalid_endpoint_does_not_fallback(self):
        with patch.dict("os.environ", {"MASTERGO_ENDPOINT": "not-a-url"}):
            with self.assertRaises(ValueError):
                self.dsl.get_endpoint()

    def test_env_endpoint_path_not_silently_ignored(self):
        with patch.dict(
            "os.environ", {"MASTERGO_ENDPOINT": "https://design.example/not-an-origin"}
        ):
            with self.assertRaises(ValueError):
                self.dsl.get_endpoint()


if __name__ == "__main__":
    unittest.main()
