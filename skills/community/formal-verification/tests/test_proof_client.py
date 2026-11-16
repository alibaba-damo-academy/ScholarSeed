"""Exercise the real HTTP client against an isolated, deterministic service."""

from contextlib import redirect_stderr, redirect_stdout
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
import secrets
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from proof_client import (ClientError, ProofClient, api_base, lean_request,
                          main, prove_problem, run_lean, task_summary,
                          confirm_candidate, submit_selected, client_formalization_prompt,
                          progress_snapshot, ProgressReporter)
from proof_client import context_error, validate_for_submission
from proof_client import compare_target_headers
from proof_batch import BatchProgressReporter, run_batch


_token_environment = None


def setUpModule():
    global _token_environment
    _token_environment = patch.dict(os.environ, {
        "SCHOLARSEED_ACCOUNT_TOKEN": secrets.token_urlsafe(32)})
    _token_environment.start()


def tearDownModule():
    _token_environment.stop()


TASK_ID = "a" * 32
LEAN = "import Mathlib\n\ntheorem odd_square (n : ℤ) (h : Odd n) : Odd (n^2) := by\n  sorry\n"
PROOF = LEAN.replace("  sorry", "  exact h.pow 2").encode()


def accepted_task(outcome="prove", explanation=None):
    pipeline = [{"stage": "prove", "status": "done"},
                {"stage": "verdict", "status": "done"}]
    if explanation:
        pipeline.append({"stage": "informalize", "status": explanation,
                         "detail": "test explanation stage"})
    return {"task_id": TASK_ID, "status": "succeeded", "solve_status": outcome,
            "verdict": outcome, "verdict_trust": 0,
            "verdict_backend": "lake-env-lean-trust-zero", "verdict_axioms": [],
            "server_commit": "b" * 40, "proof_method": "direct", "pipeline": pipeline}


class Service:
    def __init__(self):
        self.requests = []
        self.failures = {}
        self.valid = True
        self.snapshots = [accepted_task()]
        self.index = 0
        self.keys = {}
        self.creates = 0
        self.listing = [{"name": "proof", "filename": "../../outside.lean",
                         "href": "https://untrusted.invalid/proof", "revision": "revision-1"},
                        {"name": "problem", "filename": "problem.lean"}]
        self.artifact_bodies = {"proof": PROOF, "problem": LEAN.encode()}
        self.capabilities = {}
        self.preflight_valid = True

    def handle(self, method, path, headers, data):
        payload = json.loads(data) if data else None
        self.requests.append((method, path, dict(headers), payload))
        path = path.removeprefix("/proof_server/webapi/v1")
        if (method, path) in self.failures:
            return self.failures[(method, path)]
        if path == "/health":
            return 200, {"service": "proofserver", "status": "ok", "commit": "b" * 40}, {}
        if path == "/ui-config":
            return 200, {"proof_methods": [{"id": "direct"}, {"id": "dsp"}],
                         "providers": [{"id": "test", "models": ["model-1"]}],
                         "defaults": {"provider": "test", "model": "model-1"},
                         "capabilities": {"request_llm_api_key": True, **self.capabilities},
                         "limits": {"max_upload_bytes": 262144}}, {}
        if path == "/openapi.json":
            return 200, {"openapi": "3.1.0", "paths": {"/tasks": {}}}, {}
        if path == "/task-validations":
            return 200, {"valid": self.valid, "issues": [] if self.valid else ["bad Lean"],
                         "normalized": {}}, {}
        if path == "/lean-preflights":
            return 200, {"valid": self.preflight_valid, "verified": False,
                         "diagnostics": [] if self.preflight_valid else ["unknown identifier"]}, {}
        if path == "/tasks" and method == "POST":
            key = headers.get("Idempotency-Key")
            if key in self.keys and self.keys[key] != payload:
                return 409, {"error": {"code": "IDEMPOTENCY_CONFLICT", "message": "changed"}}, {}
            if key not in self.keys:
                self.keys[key] = payload
                self.creates += 1
            return 202, {"task_id": TASK_ID, "status": "queued", "pipeline": []}, {}
        if path == "/tasks/" + TASK_ID:
            snapshot = self.snapshots[min(self.index, len(self.snapshots) - 1)]
            self.index += 1
            return 200, snapshot, {}
        if path == "/tasks/" + TASK_ID + "/artifacts":
            return 200, {"items": self.listing}, {}
        if "/artifacts/" in path:
            return 200, self.artifact_bodies.get(path.rsplit("/", 1)[1], PROOF), {
                "Content-Type": "text/plain", "ETag": '"proof-v1"'}
        if path.endswith("/cancellations"):
            return 200, {"task_id": TASK_ID, "status": "cancelled"}, {}
        if path.endswith("/informalizations"):
            return 202, accepted_task(explanation="running"), {}
        if path == "/tasks/" + TASK_ID + "/evidence":
            return 200, self.evidence, {}
        if path == "/lean-verdicts":
            passed = "sorry" not in payload["source"]
            return 200, {"verdict": "pass" if passed else "fail", "ok": passed,
                         "checked": passed, "trust_level": 0 if passed else None,
                         "backend": "lake-env-lean-trust-zero" if passed else "source-policy",
                         "axioms": [], "diagnostics": [] if passed else ["sorry forbidden"]}, {}
        return 404, {"error": {"code": "NOT_FOUND", "message": path}}, {}


class HTTPClientTests(unittest.TestCase):
    def test_old_server_is_rejected_before_task_creation_or_explanation(self):
        self.service.capabilities["request_llm_api_key"] = False
        with self.assertRaises(ClientError) as caught:
            run_lean(LEAN, client=self.client, output_dir=self.root / "unsupported")
        self.assertEqual(caught.exception.result["code"], "UNSUPPORTED_ACCOUNT_TOKEN")
        with self.assertRaises(ClientError):
            self.client.request("POST", "/tasks/" + TASK_ID + "/informalizations", {})
        self.assertEqual(self.service.creates, 0)
        self.assertFalse(any(m == "POST" for m, *_ in self.service.requests))

    def test_missing_token_stops_cli_and_existing_client_before_http(self):
        for value in (None, "", "   "):
            with self.subTest(token_state=value), patch.dict(os.environ, {"LC_ALL": "en_US.UTF-8"}):
                if value is None:
                    os.environ.pop("SCHOLARSEED_ACCOUNT_TOKEN", None)
                else:
                    os.environ["SCHOLARSEED_ACCOUNT_TOKEN"] = value
                output = io.StringIO()
                with redirect_stdout(output):
                    code = main(["--base-url", self.client.base_url, "discover"])
                self.assertEqual(code, 1)
                self.assertEqual(json.loads(output.getvalue())["error"]["code"], "ACCOUNT_TOKEN_REQUIRED")
                message = json.loads(output.getvalue())["error"]["message"]
                self.assertIn("log in to ScholarSeed", message)
                with self.assertRaises(ClientError):
                    self.client.status(TASK_ID)
                with redirect_stdout(io.StringIO()):
                    code = main(["prepare", "--problem-file", "absent.txt",
                                 "--candidates-json", "absent.json", "--output", str(self.root / "blocked")])
                self.assertEqual(code, 1)
                self.assertFalse((self.root / "blocked").exists())
                with self.assertRaises(ClientError):
                    run_batch(self.root / "absent.json", self.root / "blocked-batch", client=self.client)
                self.assertFalse((self.root / "blocked-batch").exists())
        self.assertEqual(self.service.requests, [])

    def test_missing_token_login_notice_follows_locale(self):
        cases = [
            ({"LANG": "zh_CN.UTF-8"}, "请先登录书深", "ScholarSeed"),
            ({"LANG": "zh-TW"}, "请先登录书深", "ScholarSeed"),
            ({"LANG": "en_US.UTF-8"}, "Please log in to ScholarSeed", "书深"),
            ({"LANG": "en_US.UTF-8", "LC_MESSAGES": "zh_CN.UTF-8"},
             "请先登录书深", "ScholarSeed"),
            ({"LANG": "zh_CN.UTF-8", "LC_ALL": "en_US.UTF-8"},
             "Please log in to ScholarSeed", "书深"),
            ({}, "Please log in to ScholarSeed", "书深"),
        ]
        for environment, expected, other_name in cases:
            with self.subTest(locale=environment), patch.dict(os.environ, environment, clear=True):
                output = io.StringIO()
                with redirect_stdout(output):
                    code = main(["--base-url", self.client.base_url, "discover"])
                self.assertEqual(code, 1)
                error = json.loads(output.getvalue())["error"]
                self.assertEqual(error["code"], "ACCOUNT_TOKEN_REQUIRED")
                self.assertIn(expected, error["message"])
                self.assertNotIn(other_name, error["message"])
                with self.assertRaises(ClientError) as caught:
                    self.client.status(TASK_ID)
                self.assertIn(expected, caught.exception.result["message"])
        self.assertEqual(self.service.requests, [])

    def test_account_token_is_sent_only_in_header_and_not_saved_requests(self):
        token = os.environ["SCHOLARSEED_ACCOUNT_TOKEN"]
        directory = self.root / "token-run"
        run_lean(LEAN, client=self.client, output_dir=directory)
        self.assertTrue(self.service.requests)
        for _, path, headers, payload in self.service.requests:
            self.assertEqual(headers.get("X-Llm-Api-Key"), token)
            self.assertNotIn(token, path)
            self.assertNotIn(token, json.dumps(payload))
        for file in directory.rglob("*"):
            if file.is_file():
                self.assertNotIn(token.encode(), file.read_bytes(), str(file))

    def test_credential_echo_is_redacted_or_rejected(self):
        token = os.environ["SCHOLARSEED_ACCOUNT_TOKEN"]
        self.service.failures[("GET", "/health")] = (401, {
            "error": {"code": "AUTH_REQUIRED", "message": "Rejected " + token}}, {})
        with self.assertRaises(ClientError) as caught:
            self.client.discover()
        self.assertNotIn(token, json.dumps(caught.exception.result))
        self.service.failures[("GET", "/health")] = (200, {"echo": token}, {})
        with self.assertRaises(ClientError) as caught:
            self.client.discover()
        self.assertEqual(caught.exception.result["code"], "SENSITIVE_RESPONSE")
        self.assertNotIn(token, json.dumps(caught.exception.result))

    def test_error_request_ids_redact_credentials_before_reporting(self):
        account_token = 'review-"account\\token'
        with patch.dict(os.environ, {"SCHOLARSEED_ACCOUNT_TOKEN": account_token}):
            for status in (401, 404, 429, 503):
                for credential in (account_token, self.client.token):
                    for echoed in (credential, json.dumps(credential)[1:-1]):
                        with self.subTest(status=status, credential_type=(
                                "account" if credential == account_token else "auth"),
                                escaped=echoed != credential):
                            self.service.failures[("GET", "/health")] = (
                                status, {"error": {"code": "HTTP_ERROR", "message": "denied"}},
                                {"X-Request-ID": "request-" + echoed + "-end"})
                            with self.assertRaises(ClientError) as caught:
                                self.client.request("GET", "/health")
                            result = caught.exception.result
                            self.assertEqual(result["request_id"], "request-[REDACTED]-end")
                            self.assertNotIn(json.dumps(credential)[1:-1], json.dumps(result))

    def test_echoed_account_token_is_not_saved_in_watch_errors(self):
        token = "review-watch-account-token"
        self.service.failures[("GET", "/tasks/" + TASK_ID)] = (
            503, {"error": {"code": "HTTP_ERROR", "message": "denied"}},
            {"X-Request-ID": "request-" + token})
        directory = self.root / "redacted-watch"
        output = io.StringIO()
        with patch.dict(os.environ, {"SCHOLARSEED_ACCOUNT_TOKEN": token}), redirect_stdout(output):
            code = main(["--base-url", self.client.base_url, "watch", TASK_ID,
                         "--output", str(directory)])
        self.assertEqual(code, 1)
        self.assertNotIn(token, output.getvalue())
        error = json.loads((directory / "error.json").read_text())
        self.assertEqual(error["request_id"], "request-[REDACTED]")
        for file in directory.rglob("*"):
            if file.is_file():
                self.assertNotIn(token.encode(), file.read_bytes(), str(file))

    def test_retired_saved_execution_overrides_require_migration_before_http(self):
        with self.assertRaises(ClientError) as raised:
            validate_for_submission(self.client, {
                "source": LEAN, "filename": "problem.lean", "input_type": "lean",
                "proof_method": "direct"}, self.root)
        self.assertEqual(raised.exception.result["code"], "RETIRED_REQUEST_OPTIONS")
        self.assertEqual(self.service.requests, [])

    def public_task(self):
        artifacts = {name: {"sha256": hashlib.sha256(body).hexdigest()}
                     for name, body in self.service.artifact_bodies.items()}
        task = {"task_id": TASK_ID, "run_generation": 1,
                "status": "succeeded", "stage": "success", "verified": True,
                "outcome": "proved", "attempts": {"completed": 2},
                "timing": {"elapsed_seconds": 3.2}, **artifacts}
        self.service.snapshots = [task]
        self.service.evidence = {"task_id": TASK_ID, "run_generation": 1,
                                 "verified": True, "outcome": "proved",
                                 "artifacts": [{"name": name, **metadata}
                                               for name, metadata in artifacts.items()]}
        self.service.listing = [{"name": name, **metadata} for name, metadata in artifacts.items()]
        return task

    def test_public_contract_delivers_hashed_proof_without_execution_overrides(self):
        self.public_task()
        result = run_lean(LEAN, client=self.client, output_dir=self.root / "public")
        self.assertTrue(result["accepted"])
        self.assertEqual(Path(result["proof_path"]).read_bytes(), PROOF)
        request = next(r[3] for r in self.service.requests if r[:2] ==
                       ("POST", "/proof_server/webapi/v1/tasks"))
        self.assertTrue(set(request).isdisjoint({"proof_method", "provider", "model"}))
        self.assertEqual(result["snapshot"]["attempts"]["completed"], 2)

    def test_explicit_busy_stops_without_retrying_or_creating_a_task(self):
        self.service.capabilities["lean_preflight"] = True
        self.service.failures[("POST", "/lean-preflights")] = (503, {
            "error": {"code": "BUSY", "message": "The proof service is busy."}}, {})
        with self.assertRaises(ClientError) as caught:
            run_lean(LEAN, client=self.client, output_dir=self.root / "busy")
        self.assertEqual(caught.exception.result["code"], "BUSY")
        self.assertEqual(context_error(caught.exception.result)["code"], "BUSY")
        self.assertIn("busy", context_error(caught.exception.result)["message"])
        self.assertEqual(self.service.creates, 0)
        self.assertEqual(sum(request[:2] == ("POST", "/proof_server/webapi/v1/lean-preflights")
                             for request in self.service.requests), 1)
        self.assertFalse(any(request[:2] == ("POST", "/proof_server/webapi/v1/tasks")
                             for request in self.service.requests))

    def test_rate_limit_at_submission_stops_after_one_request(self):
        self.service.failures[("POST", "/tasks")] = (429, {
            "error": {"code": "TOO_MANY_REQUESTS", "message": "retry later"}}, {})
        with self.assertRaises(ClientError) as caught:
            run_lean(LEAN, client=self.client, output_dir=self.root / "rate-limited")
        self.assertEqual(caught.exception.result["code"], "BUSY")
        self.assertEqual(sum(request[:2] == ("POST", "/proof_server/webapi/v1/tasks")
                             for request in self.service.requests), 1)
        self.assertEqual(self.service.creates, 0)

    def test_html_and_json_404_stop_discovery_without_submission(self):
        for body in (b"<html>Not Found</html>",
                     {"error": {"code": "BUSY", "message": "misleading status"}}):
            with self.subTest(body=body):
                self.service.requests.clear()
                self.service.failures[("GET", "/health")] = (404, body, {})
                output = io.StringIO()
                with redirect_stdout(output):
                    exit_code = main(["--base-url", self.client.base_url, "discover"])
                result = json.loads(output.getvalue())["error"]
                self.assertEqual(exit_code, 1)
                self.assertEqual(result["code"], "NOT_FOUND")
                self.assertEqual(result["http_status"], 404)
                self.assertEqual(len(self.service.requests), 1)
                self.assertEqual(self.service.creates, 0)
                self.assertNotIn("<html>", output.getvalue())

    def test_404_at_submission_stops_after_one_post(self):
        self.service.failures[("POST", "/tasks")] = (404, b"not found", {})
        with self.assertRaises(ClientError) as caught:
            run_lean(LEAN, client=self.client, output_dir=self.root / "not-found")
        self.assertEqual(caught.exception.result["code"], "NOT_FOUND")
        self.assertEqual(sum(request[:2] == ("POST", "/proof_server/webapi/v1/tasks")
                             for request in self.service.requests), 1)
        self.assertEqual(self.service.creates, 0)
        self.assertTrue((self.root / "not-found" / "error.json").is_file())

    def test_404_while_watching_retains_task_id_and_stops_polling(self):
        self.service.failures[("GET", "/tasks/" + TASK_ID)] = (404, b"gone", {})
        directory = self.root / "missing-task"
        output = io.StringIO()
        with redirect_stdout(output):
            exit_code = main(["--base-url", self.client.base_url, "watch", TASK_ID,
                              "--wait-seconds", "1", "--poll-seconds", "0.01",
                              "--output", str(directory)])
        result = json.loads(output.getvalue())["error"]
        self.assertEqual(exit_code, 1)
        self.assertEqual(result["code"], "NOT_FOUND")
        self.assertEqual(result["task_id"], TASK_ID)
        self.assertEqual(len(self.service.requests), 1)
        self.assertEqual(json.loads((directory / "error.json").read_text())["task_id"], TASK_ID)

    def test_batch_404_stops_later_cases_and_resume_does_not_retry(self):
        prepared = self.prepare_candidates()
        manifest = {"delegated_selection_authorization": "User delegated test choices",
                    "options": {"preflight": "auto"},
                    "cases": [{"id": name, "preparation": prepared["preparation_dir"],
                               "candidate": 1, "reason": "Faithful statement"}
                              for name in ("first", "second")]}
        path = self.root / "not-found-batch.json"
        path.write_text(json.dumps(manifest))
        self.service.failures[("POST", "/tasks")] = (404, b"not found", {})
        directory = self.root / "not-found-batch"
        result = run_batch(path, directory, client=self.client,
                           wait_seconds=1, poll_seconds=0.01)
        self.assertTrue(result["not_found"])
        self.assertEqual(result["complete"], 1)
        self.assertEqual(sum(request[:2] == ("POST", "/proof_server/webapi/v1/tasks")
                             for request in self.service.requests), 1)
        request_count = len(self.service.requests)
        resumed = run_batch(path, directory, client=self.client,
                            wait_seconds=1, poll_seconds=0.01, resume=True)
        self.assertTrue(resumed["not_found"])
        self.assertEqual(len(self.service.requests), request_count)

    def test_batch_poll_404_keeps_task_id_and_stops_next_case(self):
        prepared = self.prepare_candidates()
        manifest = {"delegated_selection_authorization": "User delegated test choices",
                    "options": {"preflight": "auto"},
                    "cases": [{"id": name, "preparation": prepared["preparation_dir"],
                               "candidate": 1, "reason": "Faithful statement"}
                              for name in ("first", "second")]}
        path = self.root / "poll-not-found.json"
        path.write_text(json.dumps(manifest))
        directory = self.root / "poll-not-found"
        self.service.snapshots = [{"task_id": TASK_ID, "status": "queued", "pipeline": []}]
        self.service.failures[("GET", "/tasks/" + TASK_ID)] = (404, b"gone", {})
        result = run_batch(path, directory, client=self.client,
                           concurrency=1, wait_seconds=1, poll_seconds=0.01)
        self.assertTrue(result["not_found"])
        state = json.loads((directory / "batch.json").read_text())
        self.assertEqual(state["cases"][0]["task_id"], TASK_ID)
        self.assertEqual(state["cases"][0]["observation_error"]["code"], "NOT_FOUND")
        self.assertEqual(state["cases"][1]["state"], "pending")
        self.assertEqual(sum(request[:2] == ("GET", "/proof_server/webapi/v1/tasks/" + TASK_ID)
                             for request in self.service.requests), 1)

    def test_batch_stops_after_busy_without_submitting_later_cases(self):
        prepared = self.prepare_candidates()
        manifest = {
            "delegated_selection_authorization": "User delegated test choices",
            "options": {"preflight": "auto"},
            "cases": [{"id": name, "preparation": prepared["preparation_dir"],
                       "candidate": 1, "reason": "Faithful statement"}
                      for name in ("first", "second")],
        }
        path = self.root / "busy-batch.json"
        path.write_text(json.dumps(manifest))
        self.service.failures[("POST", "/tasks")] = (429, {
            "error": {"code": "TOO_MANY_REQUESTS", "message": "retry later"}}, {})
        result = run_batch(path, self.root / "busy-batch", client=self.client,
                           wait_seconds=1, poll_seconds=0.01)
        self.assertTrue(result["busy"])
        self.assertEqual(result["complete"], 1)
        self.assertEqual(sum(request[:2] == ("POST", "/proof_server/webapi/v1/tasks")
                             for request in self.service.requests), 1)
        self.assertEqual(self.service.creates, 0)

    def test_delivery_rejects_evidence_from_another_run_or_task(self):
        for index, changes in enumerate(({"run_generation": 2}, {"task_id": "b" * 32},
                                           {"artifacts": []}, {"verified": False})):
            self.public_task()
            self.service.evidence.update(changes)
            with self.subTest(changes=changes), self.assertRaises(ClientError) as raised:
                run_lean(LEAN, client=self.client, output_dir=self.root / f"wrong-evidence-{index}")
            self.assertEqual(raised.exception.result["code"], "EVIDENCE_CHANGED")

    def test_delivery_rejects_rerun_after_evidence_collection(self):
        task = self.public_task()
        self.service.snapshots = [task, {**task, "run_generation": 2}]
        with self.assertRaises(ClientError) as raised:
            run_lean(LEAN, client=self.client, output_dir=self.root / "rerun")
        self.assertEqual(raised.exception.result["code"], "EVIDENCE_CHANGED")

    def test_public_artifact_sha256_is_enforced(self):
        self.public_task()
        self.service.listing[0]["sha256"] = "0" * 64
        with self.assertRaises(ClientError) as raised:
            run_lean(LEAN, client=self.client, output_dir=self.root / "bad-hash")
        self.assertEqual(raised.exception.result["code"], "ARTIFACT_CHANGED")

    def test_cli_discovery_and_progress_do_not_disclose_implementation(self):
        output = io.StringIO()
        with redirect_stdout(output):
            code = main(["--base-url", self.client.base_url, "discover"])
        self.assertEqual(code, 0)
        self.assertNotIn("proof_methods", output.getvalue())
        self.assertNotIn("model", output.getvalue())
        task = accepted_task()
        task.update(provider="PRIVATE_PROVIDER", model="PRIVATE_MODEL",
                    proof_method="PRIVATE_METHOD", future_private="PRIVATE_FUTURE")
        self.service.snapshots = [task]
        output = io.StringIO()
        with redirect_stdout(output):
            code = main(["--base-url", self.client.base_url, "status", TASK_ID])
        self.assertEqual(code, 0)
        self.assertNotIn("PRIVATE_", output.getvalue())
        self.assertNotIn("backend", output.getvalue())

    def test_public_verdict_contract_and_unverified_results(self):
        path = ("POST", "/lean-verdicts")
        for verified, stage, status in ((True, "success", "accepted"),
                                        (False, "failure", "inconclusive")):
            self.service.failures[path] = (200, {
                "verified": verified, "stage": stage, "timing": {"elapsed_seconds": 1.2}}, {})
            self.assertEqual(self.client.verify(PROOF.decode())["verification_status"], status)

    def test_unrecognized_json_is_not_an_inconclusive_verdict(self):
        path = ("POST", "/lean-verdicts")
        for payload in ({}, {"error": {"code": "UNAVAILABLE"}}, {"verdict": "pass"},
                        {"verified": False, "stage": "success", "timing": {}},
                        {"verified": "true", "stage": "success", "timing": {}},
                        {"verified": 1, "stage": "success", "timing": {}}):
            with self.subTest(payload=payload):
                self.service.failures[path] = (200, payload, {})
                with self.assertRaises(ClientError) as caught:
                    self.client.verify(PROOF.decode())
                self.assertEqual(caught.exception.result["code"], "INVALID_RESPONSE")

    def test_verifier_error_envelope_never_emits_a_consent_eligible_status(self):
        proof = self.root / "proof.lean"
        proof.write_bytes(PROOF)
        for verdict in ({"verified": False, "stage": "failure", "timing": {}},
                        {"verdict": "fail", "ok": False},
                        {"verified": True, "stage": "success", "timing": {}}):
            with self.subTest(verdict=verdict):
                self.service.failures[("POST", "/lean-verdicts")] = (
                    200, {**verdict, "error": {"code": "UNAVAILABLE"}}, {})
                output = io.StringIO()
                with redirect_stdout(output):
                    code = main(["--base-url", self.client.base_url, "verify", str(proof)])
                result = json.loads(output.getvalue())
                self.assertNotEqual(code, 0)
                self.assertEqual(result["error"]["code"], "INVALID_RESPONSE")
                self.assertNotIn("verification_status", result)
                self.assertEqual(self.service.creates, 0)

    def test_public_success_without_complete_acceptance_evidence_is_unverified(self):
        task = self.public_task()
        for changes in ({"verified": False}, {"verified": 1}, {"stage": "verdict"},
                        {"status": "running"}, {"run_generation": None},
                        {"outcome": None}, {"attempts": None}):
            with self.subTest(changes=changes):
                self.assertFalse(task_summary({**task, **changes})["accepted"])

    def test_delegated_selection_has_provenance_and_requires_reason(self):
        prepared = self.prepare_candidates()
        with self.assertRaises(ValueError):
            confirm_candidate(prepared["preparation_dir"], 1, selection_actor="llm")
        choice = confirm_candidate(prepared["preparation_dir"], 2, selection_actor="llm",
                                   authorization="User delegated test choices", reason="Faithful native predicate")
        self.assertEqual(choice["status"], "llm_selected")
        self.assertEqual(choice["selection_actor"], "llm")
        result = submit_selected(prepared["preparation_dir"], client=self.client,
                                 output_dir=self.root / "selected")
        self.assertEqual(result["task_id"], TASK_ID)

    def test_preflight_rejects_before_model_task_and_required_is_fail_closed(self):
        with self.assertRaises(ClientError) as raised:
            run_lean(LEAN, client=self.client, output_dir=self.root / "unsupported", preflight="required")
        self.assertEqual(raised.exception.result["code"], "PREFLIGHT_UNAVAILABLE")
        self.service.capabilities["lean_preflight"] = True
        self.service.preflight_valid = False
        with self.assertRaises(ClientError) as raised:
            run_lean(LEAN, client=self.client, output_dir=self.root / "invalid", preflight="required")
        self.assertEqual(raised.exception.result["code"], "PREFLIGHT_FAILED")
        self.assertEqual(self.service.creates, 0)
        self.assertTrue((self.root / "invalid" / "preflight.json").is_file())

    def test_local_text_audit_is_not_a_delivery_gate(self):
        for index, proof in enumerate((PROOF.replace(b"odd_square", b"other"),
                                       LEAN.encode(), b"theorem fake : True := by trivial")):
            self.service.artifact_bodies["proof"] = proof
            result = run_lean(LEAN, client=self.client, output_dir=self.root / f"bad-{index}")
            self.assertTrue(result["server_accepted"])
            self.assertTrue(result["accepted"])
            self.assertEqual(result["delivery_status"], "complete")
            self.assertTrue(Path(result["proof_path"]).is_file())
            self.assertNotIn("audit", result)
            self.assertFalse((self.root / f"bad-{index}" / "audit.json").exists())

    def test_named_proof_and_problem_delivery(self):
        result = run_lean(LEAN, client=self.client, output_dir=self.root / "named")
        self.assertTrue(result["accepted"])
        self.assertEqual(Path(result["proof_path"]).name, "proof.lean")
        self.assertEqual(Path(result["problem_path"]).read_text(), LEAN)
        self.assertEqual(result["delivery_status"], "complete")

    def test_server_success_without_downloadable_proof_is_incomplete(self):
        self.service.listing = [{"name": "problem", "filename": "problem.lean"}]
        result = run_lean(LEAN, client=self.client, output_dir=self.root / "no-proof")
        self.assertTrue(result["server_accepted"])
        self.assertFalse(result["accepted"])
        self.assertEqual(result["delivery_status"], "incomplete")
        self.assertIsNone(result["proof_path"])

    def test_batch_resumes_same_task_and_records_delegated_selection(self):
        preparation = self.prepare_candidates()
        self.service.artifact_bodies["proof"] = PROOF.replace(b"odd_square", b"candidate_1")
        manifest = {"delegated_selection_authorization": "User delegated benchmark choices",
                    "options": {"preflight": "auto"},
                    "cases": [{"id": "odd_square", "preparation": preparation["preparation_dir"],
                               "candidate": 1, "reason": "Direct faithful statement", "tier": "library"}]}
        manifest_path = self.root / "batch-manifest.json"
        manifest_path.write_text(json.dumps(manifest))
        self.service.snapshots = [{"task_id": TASK_ID, "status": "proving", "pipeline": []}]
        first = run_batch(manifest_path, self.root / "batch", client=self.client,
                          concurrency=1, wait_seconds=0.05, poll_seconds=0.01)
        self.assertEqual(first["complete"], 0)
        self.service.snapshots = [accepted_task()]
        final = run_batch(manifest_path, self.root / "batch", client=self.client,
                          concurrency=1, wait_seconds=1, poll_seconds=0.01, resume=True)
        self.assertEqual(final["verified"], 1)
        self.assertEqual(self.service.creates, 1)
        self.assertIn("proof.lean", Path(final["report_path"]).read_text())

    def test_batch_negative_preflight_is_separate_from_verified_proofs(self):
        prepared = self.prepare_candidates()
        self.service.capabilities["lean_preflight"] = True
        self.service.preflight_valid = False
        manifest = {"delegated_selection_authorization": "User delegated test choices",
                    "options": {},
                    "cases": [{"id": "undefined_predicate", "tier": "negative",
                               "preparation": prepared["preparation_dir"], "candidate": 1,
                               "reason": "Check the deliberately invalid statement",
                               "expected": "reject_preflight"}]}
        path = self.root / "negative-batch.json"
        path.write_text(json.dumps(manifest))
        result = run_batch(path, self.root / "negative-run", client=self.client, wait_seconds=1)
        self.assertEqual(result["verified"], 0)
        self.assertEqual(result["expectations_met"], 1)
        self.assertEqual(self.service.creates, 0)
        self.assertEqual(result["per_tier"]["negative"]["expectations_met"], 1)

    def setUp(self):
        self.service = Service()
        service = self.service

        class Handler(BaseHTTPRequestHandler):
            def process(self):
                data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                code, body, headers = service.handle(self.command, self.path, self.headers, data)
                if not isinstance(body, bytes):
                    body = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Length", str(len(body)))
                if not any(key.lower() == "x-request-id" for key in headers):
                    self.send_header("X-Request-ID", "test-request")
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)

            do_GET = process
            do_POST = process

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.01))
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.thread.join)
        self.addCleanup(self.server.shutdown)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.client = ProofClient(f"http://127.0.0.1:{self.server.server_port}/proof_server/",
                                  token="test-secret")

    def test_local_llm_formalizes_then_prove_only_submission_and_download(self):
        seen = []

        def formalizer(problem):
            seen.append(problem)
            return [{"title": f"Option {index}", "explanation": "Preserves the original integer claim.",
                     "source": LEAN if index == 1 else LEAN.replace("odd_square", f"odd_square_{index}")}
                    for index in (1, 2, 3)]

        prepared = prove_problem("the square of an odd integer is odd", formalizer,
                                 output_dir=self.root / "candidates")
        self.assertEqual(prepared["status"], "awaiting_user_selection")
        self.assertEqual(self.service.requests, [])
        confirm_candidate(prepared["preparation_dir"], 1)
        result = submit_selected(prepared["preparation_dir"], client=self.client,
                                 rounds=3, submit_only=False,
                                 output_dir=self.root / "run", poll_seconds=0.01)
        self.assertEqual(seen, ["the square of an odd integer is odd"])
        post = next(r for r in self.service.requests if r[:2] ==
                    ("POST", "/proof_server/webapi/v1/tasks"))
        self.assertEqual(post[3]["input_type"], "lean")
        self.assertEqual(post[3]["source"], LEAN)
        self.assertEqual(post[3]["informal_statement"], seen[0])
        self.assertTrue(result["accepted"])
        self.assertEqual(result["outcome"], "prove")
        artifact = result["artifacts"][0]
        self.assertEqual(Path(artifact["path"]).read_bytes(), PROOF)
        self.assertEqual(artifact["sha256"], hashlib.sha256(PROOF).hexdigest())
        self.assertEqual(artifact["etag"], '"proof-v1"')
        self.assertFalse((self.root / "outside.lean").exists())
        for path in (self.root / "run").glob("*.json"):
            self.assertNotIn("test-secret", path.read_text())
        self.assertTrue(all(r[2]["X-Auth-Token"] == "test-secret" for r in self.service.requests))

    def prepare_candidates(self, directory="prepared"):
        return prove_problem("An integer odd square is odd", lambda problem: [
            {"title": f"Candidate {index}", "explanation": "Same statement, different declaration name.",
             "source": LEAN.replace("odd_square", f"candidate_{index}")}
            for index in (1, 2, 3)], output_dir=self.root / directory)

    def test_unconfirmed_candidates_cannot_submit_and_do_not_contact_server(self):
        prepared = self.prepare_candidates()
        with self.assertRaises(ClientError) as caught:
            submit_selected(prepared["preparation_dir"], client=self.client,
                            output_dir=self.root / "must-not-submit")
        self.assertEqual(caught.exception.result["code"], "CANDIDATE_CONFIRMATION_REQUIRED")
        self.assertEqual(self.service.requests, [])
        self.assertFalse((self.root / "must-not-submit").exists())

    def test_only_the_explicitly_selected_candidate_is_submitted(self):
        prepared = self.prepare_candidates()
        confirm_candidate(prepared["preparation_dir"], 2)
        result = submit_selected(prepared["preparation_dir"], client=self.client,
                                 output_dir=self.root / "selected")
        request = next(r for r in self.service.requests if r[0] == "POST" and r[1].endswith("/tasks"))
        self.assertIn("theorem candidate_2", request[3]["source"])
        self.assertNotIn("theorem candidate_1", request[3]["source"])
        selection = json.loads((Path(result["output_dir"]) / "selection.json").read_text())
        self.assertEqual(selection["candidate_id"], 2)

    def test_edit_after_confirmation_requires_a_new_review(self):
        prepared = self.prepare_candidates()
        directory = Path(prepared["preparation_dir"])
        confirm_candidate(directory, 2)
        (directory / "candidate-2.lean").write_text(LEAN)
        with self.assertRaises(ClientError) as caught:
            submit_selected(directory, client=self.client)
        self.assertEqual(caught.exception.result["code"], "STALE_SELECTION")
        self.assertEqual(self.service.requests, [])

    def test_exactly_three_distinct_open_problems_are_required(self):
        records = [{"title": f"Option {index}", "explanation": "Equivalent form",
                    "source": LEAN.replace("odd_square", f"candidate_{index}")}
                   for index in (1, 2, 3)]
        for invalid in (records[:2], records + records[:1], [records[0]] * 3):
            with self.subTest(count=len(invalid)), self.assertRaises(ValueError):
                prove_problem("odd square", lambda problem: invalid,
                              output_dir=self.root / "invalid-candidates")
        records[2]["source"] = "-- theorem example : True := by sorry\n"
        with self.assertRaises(ValueError):
            prove_problem("odd square", lambda problem: records,
                          output_dir=self.root / "comment-only")
        self.assertEqual(self.service.requests, [])

    def test_select_cli_records_a_choice_without_network_access(self):
        prepared = self.prepare_candidates()
        output = io.StringIO()
        with redirect_stdout(output):
            code = main(["--base-url", self.client.base_url, "select", "--preparation",
                         prepared["preparation_dir"], "--candidate", "3"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["candidate_id"], 3)
        self.assertEqual(self.service.requests, [])

    def test_prompt_reads_local_reference_without_importing_server_code(self):
        reference = self.root / "AutoFormal"
        reference.mkdir()
        source = reference / "prompt_store.py"
        source.write_text('FINE_TUNED_CANDIDATE_SYSTEM = "unique-reference-principle"\n'
                          'raise RuntimeError("Server code must not execute")\n')
        result = client_formalization_prompt("sqrt(2) is irrational", autoformal_root=reference)
        self.assertEqual(result["reference_sources"], [str(source.resolve())])
        self.assertIn("unique-reference-principle", result["prompt"])
        self.assertIn(json.dumps("sqrt(2) is irrational"), result["prompt"])
        self.assertEqual(self.service.requests, [])

    def test_prepare_cli_accepts_prompt_json_without_contacting_server(self):
        original = self.root / "problem.txt"
        original.write_text("An integer odd square is odd")
        response = self.root / "response.json"
        response.write_text(json.dumps({"candidates": [
            {"title": f"Option {index}", "explanation": "Preserves the integer claim",
             "source": LEAN.replace("odd_square", f"candidate_{index}")}
            for index in (1, 2, 3)]}))
        output = io.StringIO()
        with redirect_stdout(output):
            code = main(["--base-url", self.client.base_url, "prepare", "--problem-file",
                         str(original), "--candidates-json", str(response),
                         "--output", str(self.root / "prepared-cli")])
        self.assertEqual(code, 0)
        result = json.loads(output.getvalue())
        self.assertEqual(result["status"], "awaiting_user_selection")
        self.assertEqual(len(result["candidates"]), 3)
        self.assertFalse((self.root / "prepared-cli" / "selection.json").exists())
        self.assertEqual(self.service.requests, [])

    def test_cli_discovery_uses_configured_server(self):
        config = self.root / "configure.json"
        config.write_text(json.dumps({"proof_server_url": self.client.base_url}))
        output = io.StringIO()
        with patch.dict(os.environ, {"PROOFSERVER_BASE_URL": ""}), redirect_stdout(output):
            code = main(["--config", str(config), "discover"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["base_url"], self.client.base_url)
        self.assertEqual([request[1] for request in self.service.requests], [
            "/proof_server/webapi/v1/health", "/proof_server/webapi/v1/ui-config"])
        self.assertEqual(self.service.creates, 0)

    def test_invalid_config_stops_before_http_and_local_selection_still_works(self):
        config = self.root / "configure.json"
        config.write_text('{"proof_server_url": 42}')
        output = io.StringIO()
        with patch.dict(os.environ, {"PROOFSERVER_BASE_URL": ""}), redirect_stdout(output):
            code = main(["--config", str(config), "discover"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(output.getvalue())["error"]["code"], "CLIENT_ERROR")
        self.assertEqual(self.service.requests, [])
        prepared = self.prepare_candidates()
        output = io.StringIO()
        with redirect_stdout(output):
            code = main(["--config", str(config), "select", "--preparation",
                         prepared["preparation_dir"], "--candidate", "1"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["candidate_id"], 1)
        self.assertEqual(self.service.requests, [])

    def test_invalid_validation_never_creates_task(self):
        self.service.valid = False
        with self.assertRaises(ClientError) as caught:
            run_lean(LEAN, client=self.client, output_dir=self.root / "invalid")
        self.assertEqual(caught.exception.result["code"], "INVALID_INPUT")
        self.assertEqual(self.service.creates, 0)
        self.assertTrue((self.root / "invalid" / "error.json").exists())

    def test_unsupported_method_never_submits(self):
        with self.assertRaises(ValueError):
            run_lean(LEAN, client=self.client, proof_method="invented",
                     output_dir=self.root / "unsupported")
        self.assertEqual(self.service.creates, 0)

    def test_timeout_retains_id_snapshot_and_does_not_cancel(self):
        self.service.snapshots = [{"task_id": TASK_ID, "status": "queued", "pipeline": []}]
        with self.assertRaises(ClientError) as caught:
            run_lean(LEAN, client=self.client, output_dir=self.root / "timeout",
                     wait_seconds=0.03, poll_seconds=0.01)
        error = caught.exception.result
        self.assertEqual(error["code"], "WAIT_TIMEOUT")
        self.assertEqual(error["task_id"], TASK_ID)
        self.assertEqual(error["snapshot"]["status"], "queued")
        self.assertTrue((self.root / "timeout" / "task.json").exists())
        self.assertFalse(any(r[1].endswith("/cancellations") for r in self.service.requests))
        history = [json.loads(line) for line in
                   (self.root / "timeout" / "progress.jsonl").read_text().splitlines()]
        self.assertTrue(history)
        self.assertTrue(all(event["task_id"] == TASK_ID for event in history))
        self.assertFalse(any(event["accepted"] for event in history))

    def test_watch_displays_and_preserves_queue_search_and_verdict_evidence(self):
        queued = {"task_id": TASK_ID, "status": "queued", "queue_ahead": 0,
                  "queue_reason": "worker_capacity", "rounds_total": 0,
                  "pipeline": [{"stage": "queue", "status": "running"}]}
        proving = {"task_id": TASK_ID, "status": "proving", "rounds_total": 1,
                   "progress": {"family": "demo", "round": 1, "round_budget": 20},
                   "rounds": [{"round": 1, "ok": False, "error_count": 1,
                               "errors": ["unknown identifier"], "api_attempts": 2,
                               "candidate_proof": "untrusted candidate body"}],
                   "pipeline": [{"stage": "prove", "status": "running"}]}
        verifying = {**proving, "pipeline": [{"stage": "prove", "status": "done"},
                                             {"stage": "verdict", "status": "running"}]}
        self.service.snapshots = [queued, proving, verifying, accepted_task()]
        output, events = io.StringIO(), io.StringIO()
        directory = self.root / "watch"
        with redirect_stdout(output), redirect_stderr(events):
            code = main(["--base-url", self.client.base_url, "watch", TASK_ID,
                         "--poll-seconds", "0.01", "--output", str(directory)])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(output.getvalue())["accepted"])
        history = [json.loads(line) for line in events.getvalue().splitlines()]
        self.assertEqual(len(history), 4)
        self.assertEqual(history[0]["status"], "queued")
        self.assertEqual(history[1]["attempts"]["completed"], 1)
        self.assertEqual(history[2]["stage"], "verdict")
        self.assertNotIn("unknown identifier", events.getvalue())
        self.assertTrue(all(not event["accepted"] for event in history[:3]))
        self.assertTrue(history[3]["accepted"])
        self.assertNotIn("candidate_proof", events.getvalue())
        self.assertEqual(len((directory / "progress.jsonl").read_text().splitlines()), 4)
        self.assertEqual(self.service.creates, 0)

    def test_explanation_waits_after_task_succeeded_and_keeps_proof_on_failure(self):
        self.service.snapshots = [accepted_task(explanation="running"),
                                  accepted_task(explanation="failed")]
        result = run_lean(LEAN, client=self.client, output_dir=self.root / "explain",
                          informalize=True, poll_seconds=0.01)
        self.assertEqual(self.service.index, 2)
        self.assertTrue(result["accepted"])
        self.assertEqual(result["explanation"]["status"], "failed")

    def test_verified_disproof_is_distinct_from_search_failure(self):
        self.service.snapshots = [accepted_task("disprove")]
        source = "theorem demo : False := by sorry\ntheorem demo_disprove : ¬ False := by sorry\n"
        self.service.artifact_bodies["proof"] = "theorem demo_disprove : ¬ False := by simp\n".encode()
        result = run_lean(source, client=self.client, output_dir=self.root / "disproof")
        self.assertEqual(result["outcome"], "disprove")
        self.service.snapshots = [{"task_id": TASK_ID, "status": "failed",
                                   "solve_status": "unknown", "error": "budget exhausted"}]
        result = run_lean(LEAN, client=self.client, output_dir=self.root / "failed")
        self.assertFalse(result["accepted"])
        self.assertEqual(result["outcome"], "unverified")
        self.assertEqual(result["snapshot"]["stage"], "failure")
        self.assertEqual(json.loads((self.root / "failed" / "task.json").read_text())["error"], "budget exhausted")

    def test_replay_is_idempotent_and_conflict_is_preserved(self):
        for index in range(2):
            run_lean(LEAN, client=self.client, output_dir=self.root / str(index),
                     submit_only=True, idempotency_key="same-key")
        self.assertEqual(self.service.creates, 1)
        with self.assertRaises(ClientError) as caught:
            run_lean(LEAN + "\n", client=self.client, output_dir=self.root / "changed",
                     submit_only=True, idempotency_key="same-key")
        self.assertEqual(caught.exception.result["http_status"], 409)
        self.assertEqual(caught.exception.result["code"], "IDEMPOTENCY_CONFLICT")

    def test_uncertain_submission_saves_replay_payload_and_key(self):
        self.service.failures[("POST", "/tasks")] = (504, b"<html>gateway timeout</html>", {})
        with self.assertRaises(ClientError) as caught:
            run_lean(LEAN, client=self.client, output_dir=self.root / "uncertain",
                     idempotency_key="recover-this")
        directory = self.root / "uncertain"
        self.assertEqual(json.loads((directory / "request.json").read_text())["source"], LEAN)
        self.assertEqual(json.loads((directory / "submission.json").read_text())["idempotency_key"],
                         "recover-this")
        error = caught.exception.result
        self.assertEqual(error["http_status"], 504)
        self.assertEqual(error["request_id"], "test-request")
        self.assertIn("gateway timeout", error["body"])
        self.assertEqual(len([r for r in self.service.requests if r[0] == "POST" and
                              r[1].endswith("/tasks")]), 1)

    def test_redirect_is_not_followed(self):
        self.service.failures[("GET", "/health")] = (
            302, b"redirect", {"Location": "https://example.invalid/login"})
        with self.assertRaises(ClientError) as caught:
            self.client.discover()
        self.assertEqual(caught.exception.result["http_status"], 302)
        self.assertEqual(len(self.service.requests), 1)

    def test_non_json_success_is_not_a_lean_verdict(self):
        self.service.failures[("POST", "/lean-verdicts")] = (200, b"<html>login</html>", {})
        with self.assertRaises(ClientError) as caught:
            self.client.verify(PROOF.decode())
        self.assertEqual(caught.exception.result["code"], "INVALID_RESPONSE")

    def test_verify_acceptance_and_policy_rejection(self):
        self.assertTrue(self.client.verify(PROOF.decode())["accepted"])
        result = self.client.verify(LEAN)
        self.assertFalse(result["accepted"])
        self.assertFalse(result["verified"])
        self.assertNotIn("verifier", result)
        self.assertEqual(result["verification_status"], "rejected")
        self.assertEqual(result["diagnostics"], ["sorry forbidden"])
        self.assertEqual(self.service.creates, 0)

    def test_cli_saved_payload_can_be_replayed(self):
        run_lean(LEAN, client=self.client, output_dir=self.root / "original",
                 submit_only=True, idempotency_key="cli-replay")
        output = io.StringIO()
        with redirect_stdout(output):
            code = main(["--base-url", self.client.base_url, "submit", "--request-json",
                         str(self.root / "original" / "request.json"),
                         "--idempotency-key", "cli-replay", "--output", str(self.root / "recovery")])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["task_id"], TASK_ID)
        self.assertEqual(self.service.creates, 1)

    def test_new_run_does_not_overwrite_existing_output(self):
        directory = self.root / "existing"
        directory.mkdir()
        marker = directory / "task.json"
        marker.write_text("keep")
        with self.assertRaises(ValueError):
            run_lean(LEAN, client=self.client, output_dir=directory)
        self.assertEqual(marker.read_text(), "keep")
        self.assertEqual(self.service.requests, [])

    def test_invalid_wait_budget_does_not_create_remote_work(self):
        for budget in (-1, float("inf"), float("nan")):
            with self.subTest(budget=budget), self.assertRaises(ValueError):
                run_lean(LEAN, client=self.client, wait_seconds=budget,
                         output_dir=self.root / "invalid-budget")
        self.assertEqual(self.service.requests, [])

    def test_saved_request_recovery_requires_original_key(self):
        request_file = self.root / "request.json"
        request_file.write_text(json.dumps(lean_request(LEAN)))
        output = io.StringIO()
        with redirect_stdout(output):
            code = main(["--base-url", self.client.base_url, "submit", "--request-json",
                         str(request_file), "--output", str(self.root / "replay")])
        self.assertEqual(code, 1)
        self.assertIn("original --idempotency-key", json.loads(output.getvalue())["error"]["message"])
        self.assertEqual(self.service.requests, [])


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config = self.root / "configure.json"
        default_path = patch("proof_client.DEFAULT_CONFIG_PATH", self.config)
        default_path.start()
        self.addCleanup(default_path.stop)

    def test_default_config_is_loaded_and_reloaded_for_each_client(self):
        self.config.write_text(json.dumps({"proof_server_url": " https://first.example/proof/ "}))
        self.assertEqual(ProofClient().base_url, "https://first.example/proof/webapi/v1")
        self.config.write_text(json.dumps({"proof_server_url": "https://second.example/webapi/v1/"}))
        self.assertEqual(ProofClient().base_url, "https://second.example/webapi/v1")

    def test_custom_config_path_takes_priority_over_bundled_file(self):
        self.config.write_text(json.dumps({"proof_server_url": "https://bundled.example/"}))
        custom = self.root / "custom.json"
        custom.write_text(json.dumps({"proof_server_url": "http://localhost:8080/mount/"}))
        self.assertEqual(ProofClient(config_path=custom).base_url,
                         "http://localhost:8080/mount/webapi/v1")

    def test_explicit_test_override_skips_configuration(self):
        self.config.write_text("invalid JSON")
        self.assertEqual(ProofClient("https://explicit.example/api/").base_url,
                         "https://explicit.example/api/webapi/v1")
        with patch.dict(os.environ, {"PROOFSERVER_BASE_URL": "https://ignored.example/"}):
            with self.assertRaisesRegex(ValueError, "valid JSON"):
                ProofClient()

    def test_missing_configuration_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "configuration file not found"):
            ProofClient()
        with self.assertRaisesRegex(ValueError, "configuration file not found"):
            ProofClient(config_path=self.config)

    def test_remote_http_is_rejected_before_creating_a_network_client(self):
        for url in ("http://example.com/", "http://192.168.1.20:8080/",
                    "http://169.254.169.254/", "http://0.0.0.0/",
                    "http://[::]/", "http://[2001:db8::1]/",
                    "http://localhost.example.com/", "http://127.0.0.1.example.com/"):
            with self.subTest(url=url), patch("proof_client.build_opener") as opener:
                self.config.write_text(json.dumps({"proof_server_url": url}))
                for kwargs in ({}, {"base_url": url}):
                    with self.assertRaisesRegex(ValueError, "HTTPS"):
                        ProofClient(**kwargs)
                opener.assert_not_called()

    def test_invalid_selected_configuration_is_rejected(self):
        values = ["not JSON", "[]", "{}", '{"proof_server_url": null}',
                  '{"proof_server_url": 12}', '{"proof_server_url": " "}',
                  '{"proof_server_url": "ftp://host/"}',
                  '{"proof_server_url": "https://host/?key=secret"}',
                  '{"proof_server_url": "https://user:secret@host/"}']
        for contents in values:
            with self.subTest(contents=contents):
                self.config.write_text(contents)
                with self.assertRaises(ValueError) as caught:
                    ProofClient()
                self.assertIn(str(self.config), str(caught.exception))
                self.assertNotIn("secret", str(caught.exception))


class ResultPolicyTests(unittest.TestCase):
    def test_batch_progress_emits_changes_and_quiet_heartbeats(self):
        stream = io.StringIO()
        reporter = BatchProgressReporter(stream=stream, heartbeat_seconds=30)
        event = {"total": 10, "complete": 2, "verified": 2, "expectations_met": 2,
                 "active": [{"id": "compact_image", "task_id": TASK_ID,
                             "progress": {"status": "proving"}}]}
        with patch("proof_batch.time.monotonic", side_effect=[1, 2, 33, 34]):
            reporter(event)
            reporter(event)
            reporter(event)
            event["active"][0]["progress"]["attempts"] = {"completed": 1}
            reporter(event)
        output = [json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertEqual(len(output), 3)
        self.assertEqual(output[-1]["active"][0]["attempts"]["completed"], 1)

    def test_statement_audit_preserves_string_literals_and_ignores_comments(self):
        original = 'theorem literal : "a  b" = "a  b" := by sorry'
        proof = 'theorem /- heading -/ literal : "a  b" = "a  b" := by rfl'
        self.assertTrue(compare_target_headers(original, proof, "prove")[1])
        changed = 'theorem literal : "a b" = "a b" := by rfl'
        self.assertFalse(compare_target_headers(original, changed, "prove")[1])

    def test_progress_preserves_dsp_and_limits_diagnostics_without_claiming_acceptance(self):
        task = {"task_id": TASK_ID, "status": "proving", "rounds_total": 4,
                "rounds_budget": 20, "elapsed_sec": 65, "deadline_remaining_sec": 300,
                "progress": {"family_index": 2, "families_total": 3, "round": 1,
                             "round_budget": 20, "last_errors": ["x" * 900] * 5},
                "rounds": [{"round": 1, "ok": True, "solve_status": "prove",
                            "input_tokens": 120, "output_tokens": 80}],
                "dsp_events": [{"event_id": "event-3", "dsp_stage": "sketch",
                                "draft_id": 2, "sketch_id": 1}],
                "pipeline": [{"stage": "prove", "status": "running"}]}
        result = progress_snapshot(task)
        self.assertEqual(result["attempts"]["completed"], 4)
        self.assertEqual(result["stage"], "find_proof")
        self.assertEqual(result["timing"]["elapsed_seconds"], 65)
        self.assertEqual(result["timing"]["remaining_seconds"], 300)
        self.assertNotIn("dsp", json.dumps(result))
        self.assertNotIn("tokens", json.dumps(result))
        self.assertFalse(result["accepted"])
        self.assertEqual(result["outcome"], "unverified")
        self.assertNotIn("queue_ahead", result)

    def test_progress_reports_changes_and_quiet_heartbeat_without_poll_spam(self):
        stream = io.StringIO()
        reporter = ProgressReporter(stream, heartbeat_seconds=30)
        task = {"task_id": TASK_ID, "status": "queued", "queue_ahead": 2,
                "elapsed_sec": 1, "pipeline": [{"stage": "queue", "duration_sec": 1}]}
        with patch("proof_client.time.monotonic", side_effect=[0, 3, 30, 31, 32]):
            reporter(task)
            reporter({**task, "elapsed_sec": 4,
                      "pipeline": [{"stage": "queue", "duration_sec": 4}]})
            reporter({**task, "elapsed_sec": 31})
            reporter({**task, "status": "proving", "rounds_total": 1})
            reporter(accepted_task())
        events = [json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertEqual([event["event"] for event in events],
                         ["update", "heartbeat", "update", "update"])
        self.assertEqual(events[1]["unchanged_for_sec"], 30)
        self.assertEqual(events[2]["attempts"]["completed"], 1)
        self.assertTrue(events[3]["accepted"])

    def test_missing_or_untrusted_evidence_is_never_accepted(self):
        modifications = [
            {"verdict_trust": None}, {"verdict_trust": False},
            {"verdict_axioms": None}, {"verdict_axioms": ["sorryAx"]},
            {"verdict_backend": None}, {"pipeline": []},
            {"status": "proving"}, {"solve_status": "unknown"}, {"verdict": "disprove"},
        ]
        for changes in modifications:
            with self.subTest(changes=changes):
                task = {**accepted_task(), **changes}
                self.assertFalse(task_summary(task)["accepted"])

    def test_standard_axioms_are_accepted_and_legacy_fields_are_unverified(self):
        task = accepted_task()
        task["verdict_axioms"] = ["propext", "Classical.choice", "Quot.sound"]
        self.assertTrue(task_summary(task)["accepted"])
        del task["verdict_axioms"]
        self.assertFalse(task_summary(task)["accepted"])

    def test_base_url_retains_mount_and_rejects_credentials(self):
        self.assertEqual(api_base("https://host/proof_server/"),
                         "https://host/proof_server/webapi/v1")
        self.assertEqual(api_base("https://host/proof_server/webapi/v1/"),
                         "https://host/proof_server/webapi/v1")
        with self.assertRaises(ValueError):
            api_base("https://secret:password@host/")

    def test_loopback_http_is_available_for_local_servers(self):
        for host in ("localhost", "LOCALHOST", "127.0.0.1", "127.2.3.4", "[::1]"):
            with self.subTest(host=host):
                url = f"http://{host}:8080/mount/"
                self.assertEqual(api_base(url), url.rstrip("/") + "/webapi/v1")

    def test_malformed_formalization_and_invalid_draft_are_rejected(self):
        for source in ("", "```lean\n" + LEAN + "```", None):
            with self.subTest(source=source), self.assertRaises(ValueError):
                lean_request(source)
        with self.assertRaises(ValueError):
            lean_request(LEAN, rounds=True)
        with self.assertRaises(ValueError):
            lean_request(LEAN, informal_proof="outline")
        with self.assertRaises(ValueError):
            lean_request(LEAN, filename="../problem.lean")


if __name__ == "__main__":
    unittest.main()
