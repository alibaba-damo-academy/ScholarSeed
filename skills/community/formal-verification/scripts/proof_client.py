#!/usr/bin/env scholarseed-skill-python
"""Three client-generated Lean candidates -> recorded selection -> remote proof search.

Uses only the Python standard library. Import prove_problem for an LLM callback,
or run --help to submit Lean produced by the LLM executing the skill.
"""

import argparse
import ast
import shutil
from datetime import datetime, timezone
import hashlib
from http.client import HTTPException
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid


DEFAULT_CONFIG_PATH = Path(__file__).resolve().parents[1] / "configure.json"
ALLOWED_AXIOMS = {"propext", "Classical.choice", "Quot.sound"}
TERMINAL = {"succeeded", "failed", "cancelled"}


class ClientError(Exception):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.result = {"code": code, "message": message, **details}


ACCOUNT_TOKEN_ENV = "SCHOLARSEED_ACCOUNT_TOKEN"


def account_token_message():
    language = next((os.environ[name].strip() for name in
                     ("LC_ALL", "LC_MESSAGES", "LANG")
                     if os.environ.get(name, "").strip()), "en")
    if re.split(r"[-_.@]", language.lower())[0] == "zh":
        return "请先登录书深，再重新发起形式化验证。尚未发送证明请求。"
    return ("Please log in to ScholarSeed, then invoke formal verification again. "
            "No proof request was sent.")


def require_account_token():
    token = os.environ.get(ACCOUNT_TOKEN_ENV)
    if not token or not token.strip():
        raise ClientError("ACCOUNT_TOKEN_REQUIRED", account_token_message())
    if (token != token.strip() or len(token) > 8192
            or any(ord(c) < 33 or ord(c) > 126 for c in token)):
        raise ClientError("INVALID_ACCOUNT_TOKEN",
                          "SCHOLARSEED_ACCOUNT_TOKEN must be a nonempty ASCII token without whitespace.")
    return token


def _redact_token(text, token):
    for value in {token, json.dumps(token)[1:-1]}:
        text = text.replace(value, "[REDACTED]")
    return text


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def positive_number(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise ValueError("time values must be finite and positive")
    return number


def api_base(url):
    parts = urlsplit(url.rstrip("/"))
    if (parts.scheme not in {"https", "http"} or not parts.netloc
            or parts.username or parts.password or parts.query or parts.fragment):
        raise ValueError("base URL must be an HTTP(S) URL without credentials/query")
    if parts.scheme == "http":
        host = parts.hostname or ""
        try:
            loopback = ipaddress.ip_address(host).is_loopback
        except ValueError:
            loopback = host == "localhost"
        if not loopback:
            raise ValueError("remote servers require HTTPS; HTTP is allowed only for loopback servers")
    path = parts.path.rstrip("/")
    if not path.endswith("/webapi/v1"):
        path += "/webapi/v1"
    return urlunsplit((parts.scheme, parts.netloc, path, "", ""))


def configured_api_base(base_url=None, *, config_path=None):
    """Read the skill configuration; explicit URLs serve tests and recovery."""
    if base_url is not None:
        return api_base(base_url)
    path = Path(config_path).expanduser() if config_path is not None else DEFAULT_CONFIG_PATH
    try:
        contents = path.read_text(encoding="utf-8")
    except FileNotFoundError as error:
        raise ValueError(f"configuration file not found: {path}") from error
    except (OSError, UnicodeError) as error:
        raise ValueError(f"cannot read configuration file: {path}") from error
    try:
        config = json.loads(contents)
    except ValueError as error:
        raise ValueError(f"configuration file must contain valid JSON: {path}") from error
    url = config.get("proof_server_url") if isinstance(config, dict) else None
    if not isinstance(url, str) or not url.strip():
        raise ValueError(f"configuration requires a nonempty proof_server_url string: {path}")
    try:
        return api_base(url.strip())
    except ValueError as error:
        raise ValueError(f"invalid proof_server_url in configuration {path}: {error}") from error


def task_path(task_id):
    if not re.fullmatch(r"[0-9a-f]{32}", task_id):
        raise ValueError("task ID must contain 32 lowercase hexadecimal characters")
    return "/tasks/" + task_id


def write_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n",
                             encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def new_output(path=None):
    directory = Path(path or ("proof-results/" + uuid.uuid4().hex)).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    if any(directory.iterdir()):
        raise ValueError("output directory must be empty; choose a new run directory")
    return directory


def is_public_task(task):
    """Recognize the closed business contract without weakening legacy checks."""
    return ("pipeline" not in task and task.get("stage") in
            {"find_proof", "verdict", "success", "failure"}
            and isinstance(task.get("attempts"), dict)
            and isinstance(task.get("timing"), dict)
            and type(task.get("run_generation")) is int
            and task["run_generation"] >= 1)


def task_summary(task):
    """Check remote attestation; expose business fields only."""
    stages = task.get("pipeline") or []
    if is_public_task(task):
        outcome = {"proved": "prove", "disproved": "disprove"}.get(task.get("outcome"))
        accepted = (task.get("status") == "succeeded" and task.get("stage") == "success"
                    and task.get("verified") is True and outcome is not None)
    else:
        axioms = task.get("verdict_axioms")
        outcome = task.get("solve_status")
        accepted = (
            task.get("status") == "succeeded"
            and outcome in {"prove", "disprove"}
            and task.get("verdict") in {None, outcome}
            and type(task.get("verdict_trust")) is int
            and task.get("verdict_trust") == 0
            and bool(task.get("verdict_backend"))
            and isinstance(axioms, list)
            and all(isinstance(a, str) and a in ALLOWED_AXIOMS for a in axioms)
            and any(s.get("stage") == "verdict" and s.get("status") == "done"
                    for s in stages)
        )
    explanation = next((s for s in stages if s.get("stage") == "informalize"), None)
    return {
        "task_id": task.get("task_id"), "status": task.get("status"),
        "run_generation": task.get("run_generation"), "accepted": accepted,
        "outcome": outcome if accepted else "unverified",
        "explanation": ({"status": explanation.get("status")} if explanation else None),
        "semantic_alignment": "client_review_required",
    }


def progress_snapshot(task):
    """Project either API contract to neutral, measured business progress."""
    def number(value, integer=False):
        if (type(value) not in (int, float) or not math.isfinite(value)
                or value < 0 or (integer and type(value) is not int)):
            return None
        return value

    summary = task_summary(task)
    status = task.get("status")
    if status in {"encoding", "formalizing", "proving"}:
        status = "running"
    stages = {s.get("stage"): s for s in task.get("pipeline") or []}
    if is_public_task(task):
        stage = task["stage"]
        completed = task["attempts"].get("completed")
        raw_timing = task["timing"]
    else:
        stage = ("success" if summary["accepted"] else "failure" if status in TERMINAL
                 else "verdict" if stages.get("verdict", {}).get("status") == "running"
                 else "find_proof")
        completed = task.get("rounds_total")
        raw_timing = {
            "elapsed_seconds": task.get("elapsed_sec"),
            "find_proof_seconds": stages.get("prove", {}).get("duration_sec"),
            "verdict_seconds": task.get("verdict_elapsed_sec"),
            "remaining_seconds": task.get("deadline_remaining_sec"),
        }
    return {
        "task_id": task.get("task_id"), "run_generation": task.get("run_generation"),
        "status": status, "stage": stage,
        "attempts": {"completed": number(completed, integer=True)},
        "timing": {key: number(raw_timing.get(key)) for key in (
            "elapsed_seconds", "find_proof_seconds", "verdict_seconds", "remaining_seconds")},
        "accepted": summary["accepted"], "outcome": summary["outcome"],
        "observed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def save_task_progress(directory, task):
    write_json(directory / "task.json", task)
    with (directory / "progress.jsonl").open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(progress_snapshot(task), ensure_ascii=False) + "\n")


class ProgressReporter:
    """Flush changed evidence immediately, with a heartbeat during quiet waits."""

    def __init__(self, stream=None, heartbeat_seconds=30):
        self.stream = stream if stream is not None else sys.stderr
        self.heartbeat_seconds = positive_number(heartbeat_seconds)
        self.signature = None
        self.last_emitted = None
        self.last_changed = None

    def __call__(self, task):
        snapshot = progress_snapshot(task)
        # Clock changes alone should not print a duplicate update on each poll.
        clock_fields = {"observed_at", "elapsed_seconds", "find_proof_seconds", "verdict_seconds", "remaining_seconds"}

        def without_clocks(value):
            if isinstance(value, dict):
                return {k: without_clocks(v) for k, v in value.items() if k not in clock_fields}
            if isinstance(value, list):
                return [without_clocks(v) for v in value]
            return value

        signature = json.dumps(without_clocks(snapshot), sort_keys=True)
        now = time.monotonic()
        changed = signature != self.signature
        if changed:
            self.last_changed = now
        if changed or self.last_emitted is None or now - self.last_emitted >= self.heartbeat_seconds:
            snapshot["event"] = "update" if changed else "heartbeat"
            snapshot["unchanged_for_sec"] = round(now - self.last_changed, 1)
            print(json.dumps(snapshot, ensure_ascii=False), file=self.stream, flush=True)
            self.last_emitted = now
        self.signature = signature


class ProofClient:
    def __init__(self, base_url=None, token=None, timeout=70, *, config_path=None):
        require_account_token()
        self.base_url = configured_api_base(base_url, config_path=config_path)
        self.token = token if token is not None else os.getenv("PROOFSERVER_AUTH_TOKEN")
        self.timeout = positive_number(timeout)
        self.opener = build_opener(NoRedirect())
        self._credential_supported = False

    def request(self, method, path, payload=None, *, key=None, raw=False,
                timeout=None):
        account_token = require_account_token()
        if method.upper() == "POST" and (path == "/tasks" or
                path.endswith(("/informalizations", "/reruns"))):
            self.ensure_credential_support()
        headers = {"Accept": "application/json", "X-LLM-API-Key": account_token}
        if self.token:
            headers["X-Auth-Token"] = self.token
        data = None
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if key:
            headers["Idempotency-Key"] = key
        started = time.monotonic()
        request = Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=timeout or self.timeout) as response:
                body = response.read()
                response_headers = dict(response.headers)
        except HTTPError as error:
            try:
                body = _redact_token(error.read().decode("utf-8", errors="replace"), account_token)
                request_id = error.headers.get("X-Request-ID")
                if request_id is not None:
                    for credential in (os.getenv("SCHOLARSEED_ACCOUNT_TOKEN"), self.token):
                        if credential:
                            request_id = _redact_token(request_id, credential)
            finally:
                error.close()
            try:
                parsed = json.loads(body)
                detail = parsed.get("error") or {}
                code = detail.get("code", "HTTP_ERROR")
                message = detail.get("message", str(error))
            except (ValueError, AttributeError):
                code, message = "HTTP_ERROR", _redact_token(str(error), account_token)
            if error.code == 404:
                code, message = "NOT_FOUND", "ProofServer returned HTTP 404. Proof search stopped without retrying."
            elif error.code == 429 or code in {"BUSY", "VERIFIER_BUSY", "TOO_MANY_REQUESTS"}:
                code, message = "BUSY", "ProofServer is busy. Proof search stopped without retrying."
            raise ClientError(
                code, message, http_status=error.code,
                request_id=request_id,
                elapsed_seconds=round(time.monotonic() - started, 3),
                body=body[:4000],
            ) from error
        except (URLError, OSError, HTTPException) as error:
            raise ClientError("NETWORK_ERROR", _redact_token(str(error), account_token),
                              elapsed_seconds=round(time.monotonic() - started, 3)) from error
        if any(value.encode("utf-8") in body for value in
               (account_token, json.dumps(account_token)[1:-1])):
            raise ClientError("SENSITIVE_RESPONSE", "Server response echoed a credential; response was not saved.")
        if raw:
            return body, response_headers
        try:
            parsed = json.loads(body)
            if not isinstance(parsed, dict):
                raise ValueError("expected a JSON object")
            return parsed
        except ValueError as error:
            raise ClientError("INVALID_RESPONSE", str(error),
                              body=body[:4000].decode("utf-8", errors="replace")) from error

    def ensure_credential_support(self):
        if not self._credential_supported:
            config = self.request("GET", "/ui-config")
            self._check_credential_support(config)

    def _check_credential_support(self, config):
        if (config.get("capabilities") or {}).get("request_llm_api_key") is not True:
            raise ClientError("UNSUPPORTED_ACCOUNT_TOKEN",
                              "The server does not advertise request API-key support. Deploy the updated server before using this skill; no proof task was submitted.")
        self._credential_supported = True

    def discover(self):
        health = self.request("GET", "/health")
        config = self.request("GET", "/ui-config")
        self._check_credential_support(config)
        caps = config.get("capabilities") or {}
        limits = config.get("limits") or {}
        return {"base_url": self.base_url,
                "health": {"status": health.get("status"), "service": "proofserver"},
                "config": {
                    "rest_api_encapsulation": config.get("rest_api_encapsulation") is True,
                    "capabilities": {key: caps[key] for key in (
                        "request_llm_api_key", "lean_preflight", "lean_verdict", "task_budgets", "evidence_manifest",
                        "verified_proof_download", "task_cancellation") if key in caps},
                    "limits": {key: limits[key] for key in (
                        "max_upload_bytes", "max_runtime_seconds") if key in limits}}}

    def validate(self, payload):
        if payload.get("input_type") != "lean":
            raise ValueError("client formalization must be submitted with input_type=lean")
        return self.request("POST", "/task-validations", payload)

    def status(self, task_id, **kwargs):
        return self.request("GET", task_path(task_id), **kwargs)

    def preflight(self, source, filename="problem.lean"):
        return self.request("POST", "/lean-preflights",
                            {"source": source, "filename": filename})

    def wait(self, task_id, *, wait_seconds=600, poll_seconds=3, on_progress=None):
        deadline = time.monotonic() + positive_number(wait_seconds)
        interval = positive_number(poll_seconds)
        latest = None
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ClientError("WAIT_TIMEOUT", "remote task may still be running",
                                  task_id=task_id, snapshot=latest)
            latest = self.status(task_id, timeout=min(self.timeout, remaining))
            if on_progress:
                on_progress(latest)
            explaining = any(s.get("stage") == "informalize"
                             and s.get("status") in {"pending", "running"}
                             for s in latest.get("pipeline", []))
            if latest.get("status") in TERMINAL and not (
                    latest.get("status") == "succeeded" and explaining):
                return latest
            time.sleep(min(interval, max(0, deadline - time.monotonic())))

    def download(self, task_id, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        listing = self.request("GET", task_path(task_id) + "/artifacts")
        downloaded = []
        for item in listing.get("items", []):
            name = item["name"]
            if name not in {"problem", "proof"}:
                continue
            body, headers = self.request(
                "GET", task_path(task_id) + "/artifacts/" + quote(name, safe=""), raw=True)
            # Ignore server filenames and hrefs. An index prevents name collisions.
            safe_name = re.sub(r"[^A-Za-z0-9_.-]", "_", name)[:80] or "artifact"
            extension = ".lean" if name in {"problem", "proof"} else (
                ".md" if name == "nl_proof" else ".txt")
            path = directory / (str(len(downloaded)) + "_" + safe_name + extension)
            with path.open("xb") as stream:
                stream.write(body)
            downloaded.append({"name": name, "path": str(path.resolve()),
                               "size_bytes": len(body),
                               "sha256": hashlib.sha256(body).hexdigest(),
                               "revision": item.get("revision"),
                               "etag": next((v for k, v in headers.items()
                                             if k.lower() == "etag"), None)})
            expected = item.get("sha256") or item.get("revision")
            if re.fullmatch(r"[0-9a-f]{64}", str(expected)) and \
                    downloaded[-1]["sha256"] != expected:
                raise ClientError("ARTIFACT_CHANGED", "artifact changed during download", name=name)
        return downloaded

    def verify(self, source, filename="proof.lean"):
        result = self.request("POST", "/lean-verdicts",
                              {"source": source, "filename": filename})
        if isinstance(result.get("error"), dict):
            raise ClientError("INVALID_RESPONSE", "Expected a Lean verdict, not an error envelope.")
        axioms = result.get("axioms")
        accepted = (result.get("verdict") == "pass" and result.get("ok") is True
                    and result.get("checked") is True
                    and type(result.get("trust_level")) is int
                    and result.get("trust_level") == 0
                    and bool(result.get("backend"))
                    and isinstance(axioms, list)
                    and all(isinstance(a, str) and a in ALLOWED_AXIOMS for a in axioms))
        rejected = result.get("verdict") == "fail" and result.get("ok") is False
        inconclusive = False
        if "verdict" not in result and isinstance(result.get("timing"), dict):
            accepted = result.get("verified") is True and result.get("stage") == "success"
            inconclusive = result.get("verified") is False and result.get("stage") == "failure"
        if not (accepted or rejected or inconclusive):
            raise ClientError("INVALID_RESPONSE", "Expected a recognized Lean verifier verdict.")
        verification_status = ("accepted" if accepted else
                               "rejected" if rejected else "inconclusive")
        diagnostics = result.get("diagnostics")
        return {"accepted": accepted, "verified": accepted,
                "verification_status": verification_status,
                "diagnostics": [entry for entry in diagnostics if isinstance(entry, str)]
                if isinstance(diagnostics, list) else [],
                "timing": result.get("timing", {"elapsed_seconds": result.get("elapsed_seconds")})}


def lean_request(source, *, statement=None, filename="problem.lean", **options):
    if not isinstance(source, str) or not source.strip() or source.lstrip().startswith("```"):
        raise ValueError("formalizer must return nonempty Lean source without Markdown fences")
    if Path(filename).name != filename or "\\" in filename or not filename.endswith(".lean"):
        raise ValueError("filename must be a .lean basename")
    payload = {"source": source, "filename": filename, "input_type": "lean"}
    allowed = {"rounds", "informalize", "max_runtime_seconds"}
    for key, value in options.items():
        if key not in allowed:
            raise ValueError("unsupported task option; remote configuration controls execution")
        if value is not None:
            payload[key] = value
    if statement:
        payload["informal_statement"] = statement
    if "rounds" in payload and (type(payload["rounds"]) is not int
                               or not 1 <= payload["rounds"] <= 200):
        raise ValueError("rounds must be an integer from 1 to 200")
    for key in ("max_runtime_seconds", "max_output_tokens"):
        if key in payload and (type(payload[key]) is not int or payload[key] <= 0):
            raise ValueError(key + " must be a positive integer")
    return payload


def check_options(payload, config):
    maximum = config.get("limits", {}).get("max_upload_bytes")
    if maximum and len(payload["source"].encode("utf-8")) > maximum:
        raise ValueError("Lean source exceeds deployment upload limit")


def theorem_headers(source):
    """Conservative text audit, not a Lean parser or a semantic certificate."""
    code = _lean_without_comments_and_strings(source)
    literal_code = _lean_without_comments_and_strings(source, keep_strings=True)
    headers = {}
    for match in re.finditer(r"\b(?:theorem|lemma)\s+([^\s(:{\[]+)", code):
        depth = 0
        index = match.end()
        while index < len(code):
            if not depth and code.startswith(":=", index):
                name = match.group(1)
                if name in headers:
                    raise ValueError("duplicate theorem name: " + name)
                header = literal_code[match.start():index]
                header = re.sub(r'"(?:\\.|[^"\\])*"',
                                lambda m: "__literal_" + _digest(m.group().encode()), header)
                headers[name] = " ".join(header.split())
                break
            if code[index] in "({[":
                depth += 1
            elif code[index] in ")}]":
                depth -= 1
            index += 1
    return headers


def compare_target_headers(original, proof, outcome):
    expected, actual = theorem_headers(original), theorem_headers(proof)
    if outcome == "prove":
        expected = {name: head for name, head in expected.items()
                    if not name.endswith("_disprove")}
    elif outcome == "disprove":
        names = list(expected)
        chosen = next((name for name in names if name.endswith("_disprove")
                       and actual.get(name) == expected[name]), None)
        expected = ({name: expected[name] for name in names[:names.index(chosen)]
                     if not name.endswith("_disprove") and name != chosen[:-9]}
                    | {chosen: expected[chosen]}) if chosen else {}
    else:
        expected = {}
    return list(expected), bool(expected) and all(actual.get(name) == head
                                                 for name, head in expected.items())


def audit_delivery(directory, artifacts, outcome):
    """Optional local text diagnostic; remote verification owns proof acceptance."""
    by_role = {item["name"]: item for item in artifacts}
    audit = {"scope": "conservative_statement_text_and_file_integrity",
             "semantic_alignment": "client_review_required", "issues": []}
    request_path = directory / "request.json"
    original = json.loads(request_path.read_text())["source"] if request_path.is_file() else None
    if original is None and "problem" in by_role:
        original = Path(by_role["problem"]["path"]).read_text(encoding="utf-8")
    if original is None:
        audit["issues"].append("original_problem_unavailable")
    elif (directory / "problem.lean").is_file() and \
            (directory / "problem.lean").read_text(encoding="utf-8") != original:
        audit["issues"].append("local_problem_changed")
    else:
        (directory / "problem.lean").write_text(original, encoding="utf-8")
        audit["problem_path"] = str((directory / "problem.lean").resolve())
        audit["problem_sha256"] = _digest(original.encode("utf-8"))
    if "proof" not in by_role:
        audit["issues"].append("proof_artifact_missing")
    else:
        path = Path(by_role["proof"]["path"])
        proof_bytes = path.read_bytes()
        try:
            proof = proof_bytes.decode("utf-8")
        except UnicodeDecodeError:
            proof = ""
            audit["issues"].append("invalid_proof_encoding")
        shutil.copyfile(path, directory / "proof.lean")
        audit["proof_path"] = str((directory / "proof.lean").resolve())
        audit["proof_sha256"] = _digest(proof_bytes)
        if audit["proof_sha256"] != by_role["proof"]["sha256"]:
            audit["issues"].append("downloaded_proof_changed")
        if re.search(r"\b(?:sorry|admit|sorryAx)\b", _lean_without_comments_and_strings(proof)):
            audit["issues"].append("executable_placeholder_in_proof")
        if original:
            try:
                names, matches = compare_target_headers(original, proof, outcome)
            except ValueError as error:
                names, matches = [], False
                audit["diagnostic"] = str(error)
            if not matches:
                audit["issues"].append("target_statement_mismatch_or_unsupported")
            audit["declarations"] = names
    audit["passed"] = not audit["issues"]
    write_json(directory / "audit.json", audit)
    return audit


def collect_result(client, task, directory):
    directory = Path(directory)
    write_json(directory / "task.json", task)
    summary = task_summary(task)
    summary["server_accepted"] = summary["accepted"]
    summary["server_outcome"] = summary["outcome"]
    summary["accepted"] = False
    summary["outcome"] = "unverified"
    summary["delivery_status"] = "pending"
    summary["output_dir"] = str(directory)
    write_json(directory / "result.json", summary)
    summary["artifacts"] = client.download(task["task_id"], directory / "artifacts")
    discovery_file = directory / "discovery.json"
    public = is_public_task(task)
    has_evidence = public or (discovery_file.is_file() and json.loads(
        discovery_file.read_text()).get("config", {}).get("capabilities", {}).get("evidence_manifest"))
    if has_evidence:
        evidence = client.request("GET", task_path(task["task_id"]) + "/evidence")
        write_json(directory / "evidence.json", evidence)
        if (evidence.get("task_id") != task["task_id"]
                or evidence.get("run_generation") != task.get("run_generation")):
            raise ClientError("EVIDENCE_CHANGED", "task run changed during delivery")
        hashes = {item["name"]: item.get("sha256") for item in evidence.get("artifacts", [])}
        delivered = {item["name"]: item["sha256"] for item in summary["artifacts"]}
        required = {"problem", "proof"} if summary["server_accepted"] else set(delivered)
        if (not required.issubset(delivered) or not required.issubset(hashes)
                or any(not re.fullmatch(r"[0-9a-f]{64}", str(hashes.get(name)))
                       or digest != hashes.get(name) for name, digest in delivered.items())):
            raise ClientError("EVIDENCE_CHANGED", "evidence and downloaded artifacts differ")
        if public and summary["server_accepted"]:
            if (evidence.get("verified") is not True or evidence.get("outcome") != task.get("outcome")
                    or any((task.get(name) or {}).get("sha256") != delivered.get(name)
                           for name in ("problem", "proof"))):
                raise ClientError("EVIDENCE_CHANGED", "accepted snapshot differs from delivered evidence")
    if task.get("run_generation") is not None:
        after = client.status(task["task_id"])
        if (after.get("run_generation") != task["run_generation"]
                or (summary["server_accepted"] and not task_summary(after)["accepted"])):
            raise ClientError("EVIDENCE_CHANGED", "task run changed during delivery")
    by_role = {item["name"]: item for item in summary["artifacts"]}
    for role in ("problem", "proof"):
        item = by_role.get(role)
        if item is None:
            summary[role + "_path"] = None
            continue
        content = Path(item["path"]).read_bytes()
        try:
            content.decode("utf-8")
        except UnicodeDecodeError as error:
            raise ClientError("ARTIFACT_INVALID", f"{role} artifact is not UTF-8 Lean text") from error
        path = directory / (role + ".lean")
        path.write_bytes(content)
        summary[role + "_path"] = str(path.resolve())
    delivered = bool(summary["problem_path"] and summary["proof_path"])
    summary["accepted"] = summary["server_accepted"] and delivered
    summary["delivery_status"] = ("complete" if summary["accepted"] else
                                  "incomplete" if summary["server_accepted"] else
                                  "no_verified_proof")
    if summary["accepted"]:
        summary["outcome"] = summary["server_outcome"]
    summary["snapshot"] = progress_snapshot(task)
    write_json(directory / "result.json", summary)
    return summary


def validate_for_submission(client, payload, directory, preflight="auto"):
    """Shared preflight/validation gate for fresh submissions and exact replay."""
    allowed = {"source", "filename", "input_type", "informal_statement",
               "rounds", "informalize", "max_runtime_seconds"}
    if set(payload) - allowed:
        raise ClientError("RETIRED_REQUEST_OPTIONS",
                          "saved request requires explicit migration to a new submission")
    discovery = client.discover()
    write_json(directory / "discovery.json", discovery)
    check_options(payload, discovery["config"])
    capabilities = discovery["config"].get("capabilities", {})
    if any(key in payload for key in ("max_runtime_seconds", "max_output_tokens")) \
            and not capabilities.get("task_budgets"):
        raise ClientError("UNSUPPORTED_BUDGET", "deployment does not advertise task budgets")
    if preflight != "off":
        if capabilities.get("lean_preflight"):
            result = client.preflight(payload["source"], payload["filename"])
            write_json(directory / "preflight.json", result)
            if result.get("infrastructure_error"):
                raise ClientError("LEAN_UNAVAILABLE", "Lean preflight unavailable", preflight=result)
            if result.get("valid") is not True:
                raise ClientError("PREFLIGHT_FAILED", "Lean statement did not elaborate", preflight=result)
        else:
            write_json(directory / "preflight.json", {"status": "unsupported", "verified": False})
            if preflight == "required":
                raise ClientError("PREFLIGHT_UNAVAILABLE", "deployment does not advertise Lean preflight")
    validation = client.validate(payload)
    write_json(directory / "validation.json", validation)
    if validation.get("valid") is not True:
        raise ClientError("INVALID_INPUT", "server rejected the Lean problem", validation=validation)


def run_lean(source, *, client=None, statement=None, output_dir=None, selection_record=None,
             wait_seconds=600, poll_seconds=3, on_progress=None,
             idempotency_key=None, submit_only=False, preflight="auto", **options):
    """Submit client-generated Lean. Saves replay data before any task creation."""
    # Reject invalid local waiting budgets before creating an external task.
    positive_number(wait_seconds)
    positive_number(poll_seconds)
    if preflight not in {"auto", "required", "off"}:
        raise ValueError("preflight must be auto, required, or off")
    client = client or ProofClient()
    payload = lean_request(source, statement=statement, **options)
    directory = new_output(output_dir)
    key = idempotency_key or uuid.uuid4().hex
    write_json(directory / "request.json", payload)
    write_json(directory / "submission.json", {"base_url": client.base_url,
                                               "idempotency_key": key})
    if statement:
        (directory / "problem.txt").write_text(statement, encoding="utf-8")
    (directory / "problem.lean").write_text(source, encoding="utf-8")
    if selection_record is not None:
        write_json(directory / "selection.json", selection_record)
    latest = None

    def progress(task):
        save_task_progress(directory, task)
        if on_progress:
            on_progress(task)

    try:
        validate_for_submission(client, payload, directory, preflight)
        latest = client.request("POST", "/tasks", payload, key=key)
        progress(latest)
        if submit_only:
            return {"task_id": latest["task_id"], "status": latest["status"],
                    "output_dir": str(directory), "snapshot": latest}
        latest = client.wait(latest["task_id"], wait_seconds=wait_seconds,
                             poll_seconds=poll_seconds, on_progress=progress)
        return collect_result(client, latest, directory)
    except ClientError as error:
        error.result["output_dir"] = str(directory)
        error.result["idempotency_key"] = key
        if latest:
            error.result.setdefault("task_id", latest["task_id"])
        write_json(directory / "error.json", error.result)
        raise


def _digest(content):
    return hashlib.sha256(content).hexdigest()


def client_formalization_prompt(problem, *, autoformal_root=None):
    """Render the bundled client prompt, optionally reading local prompt constants.

    This performs no model call and imports/executes no server code.
    """
    require_account_token()
    if not isinstance(problem, str) or not problem.strip():
        raise ValueError("natural-language problem must be nonempty")
    template = Path(__file__).resolve().parents[1] / "references/client_autoformal_prompt.md"
    prompt = template.read_text(encoding="utf-8")
    references = []
    if autoformal_root:
        source = Path(autoformal_root) / "prompt_store.py"
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
        names = {"NL_SYSTEM", "FINE_TUNED_CANDIDATE_SYSTEM", "CANDIDATE_REPAIR_SYSTEM"}
        principles = []
        for node in tree.body:
            if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
                if isinstance(node.value.value, str):
                    for target in node.targets:
                        if isinstance(target, ast.Name) and target.id in names:
                            principles.append(target.id + ":\n" + node.value.value)
        if not principles:
            raise ValueError("no recognized AutoFormal prompt constants found")
        references.append(str(source.resolve()))
        prompt += ("\n\n## Optional source principles\n\n"
                   "Apply the semantic-preservation principles below. The bundled output "
                   "contract above takes precedence: exactly three complete Lean files "
                   "with sorry and the host-managed 20-second review policy in SKILL.md.\n\n" + "\n\n".join(principles))
    prompt += "\n\n## User problem (JSON string)\n\n" + json.dumps(problem, ensure_ascii=False) + "\n"
    return {"prompt": prompt, "reference_sources": references}


def _lean_without_comments_and_strings(source, *, keep_strings=False):
    """Mask comments/strings so a displayed sorry must be in executable code."""
    result = []
    index = 0
    depth = 0
    in_string = False
    while index < len(source):
        start = index
        string_part = in_string or (not depth and source[index] == '"')
        pair = source[index:index + 2]
        char = source[index]
        if depth:
            if pair == "/-":
                depth += 1
                index += 2
            elif pair == "-/":
                depth -= 1
                index += 2
            else:
                index += 1
            result.append(" ")
        elif in_string:
            if char == "\\":
                index += 2
            else:
                in_string = char != '"'
                index += 1
            result.append(" ")
        elif pair == "--":
            newline = source.find("\n", index)
            index = len(source) if newline < 0 else newline
            result.append(" ")
        elif pair == "/-":
            depth = 1
            index += 2
            result.append(" ")
        elif char == '"':
            in_string = True
            index += 1
            result.append(" ")
        else:
            result.append(char)
            index += 1
        # Preserve offsets so declaration spans map back to the original file.
        segment = source[start:index]
        result[-1] = (segment if string_part and keep_strings else
                      "".join("\n" if c == "\n" else " " for c in segment)
                      if result[-1] == " " else segment)
    return "".join(result)


def prepare_problem(problem, formalize, *, output_dir=None):
    """Generate exactly three client-side candidates; never contact the server.

    formalize(problem) returns three {title, explanation, source} records.
    The host must record a user choice or a policy-authorized LLM selection
    before submit_selected can run; the host owns the review timer.
    """
    require_account_token()
    if not isinstance(problem, str) or not problem.strip():
        raise ValueError("natural-language problem must be nonempty")
    candidates = formalize(problem)
    if isinstance(candidates, dict) and set(candidates) == {"candidates"}:
        candidates = candidates["candidates"]
    if not isinstance(candidates, (list, tuple)) or len(candidates) != 3:
        raise ValueError("client formalization must return exactly three candidates")
    records = []
    for index, candidate in enumerate(candidates, 1):
        if not isinstance(candidate, dict):
            raise ValueError("each candidate must have title, explanation, and source")
        title = candidate.get("title")
        explanation = candidate.get("explanation")
        source = candidate.get("source")
        if not isinstance(title, str) or not title.strip():
            raise ValueError("candidate title must be nonempty")
        if not isinstance(explanation, str) or not explanation.strip():
            raise ValueError("candidate explanation must be nonempty")
        lean_request(source)
        code = _lean_without_comments_and_strings(source)
        if not re.search(r"\b(?:theorem|lemma)\s", code) or not re.search(r"\bsorry\b", code):
            raise ValueError("every candidate must contain a named theorem and executable sorry")
        records.append({"id": index, "title": title, "explanation": explanation,
                        "filename": f"candidate-{index}.lean",
                        "source_sha256": _digest(source.encode("utf-8")), "source": source})
    if len({record["source_sha256"] for record in records}) != 3:
        raise ValueError("the three candidate sources must be distinct")
    directory = new_output(output_dir)
    (directory / "problem.txt").write_text(problem, encoding="utf-8")
    manifest = {"version": 1, "status": "awaiting_user_selection",
                "problem_sha256": _digest(problem.encode("utf-8")), "candidates": []}
    for record in records:
        (directory / record["filename"]).write_text(record["source"], encoding="utf-8")
        manifest["candidates"].append({key: value for key, value in record.items() if key != "source"})
    write_json(directory / "candidates.json", manifest)
    return {**manifest, "preparation_dir": str(directory)}


def prove_problem(problem, formalize, *, output_dir=None):
    """Prepare three candidates and pause; this entry point never submits a job."""
    return prepare_problem(problem, formalize, output_dir=output_dir)


def _load_preparation(preparation_dir):
    directory = Path(preparation_dir).resolve()
    manifest_bytes = (directory / "candidates.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    problem = (directory / "problem.txt").read_text(encoding="utf-8")
    if _digest(problem.encode("utf-8")) != manifest.get("problem_sha256"):
        raise ClientError("STALE_SELECTION", "original problem changed; prepare and review again")
    candidates = manifest.get("candidates", [])
    if len(candidates) != 3 or [c.get("id") for c in candidates] != [1, 2, 3]:
        raise ValueError("preparation must contain candidates 1, 2, and 3")
    for candidate in candidates:
        filename = f"candidate-{candidate['id']}.lean"
        if candidate.get("filename") != filename:
            raise ValueError("candidate filename does not match its ID")
        source_bytes = (directory / filename).read_bytes()
        if _digest(source_bytes) != candidate.get("source_sha256"):
            raise ClientError("STALE_SELECTION", "candidate changed; prepare and review again")
    return directory, manifest, problem, _digest(manifest_bytes)


def confirm_candidate(preparation_dir, candidate_id, *, selection_actor="user",
                      authorization=None, reason=None):
    """Record a user choice or an authorized LLM choice with its policy and reason."""
    require_account_token()
    if selection_actor not in {"user", "llm"}:
        raise ValueError("selection_actor must be user or llm")
    if selection_actor == "llm" and not all(isinstance(v, str) and v.strip()
                                            for v in (authorization, reason)):
        raise ValueError("LLM selection requires authorization and a reason")
    if type(candidate_id) is not int or candidate_id not in (1, 2, 3):
        raise ValueError("candidate ID must be 1, 2, or 3")
    directory, manifest, _, manifest_hash = _load_preparation(preparation_dir)
    candidate = manifest["candidates"][candidate_id - 1]
    selection = {"status": selection_actor + "_selected", "candidate_id": candidate_id,
                 "selection_actor": selection_actor, "authorization": authorization,
                 "reason": reason, "selected_at": datetime.now(timezone.utc).isoformat(),
                 "preparation_dir": str(directory), "manifest_sha256": manifest_hash,
                 "source_sha256": candidate["source_sha256"],
                 "problem_sha256": manifest["problem_sha256"]}
    write_json(directory / "selection.json", selection)
    return selection


def submit_selected(preparation_dir, **kwargs):
    """Submit exactly the saved selection, checking for edits first."""
    directory, manifest, problem, manifest_hash = _load_preparation(preparation_dir)
    selection_path = directory / "selection.json"
    if not selection_path.is_file():
        raise ClientError("CANDIDATE_CONFIRMATION_REQUIRED",
                          "present all three candidates and record a selection under SKILL.md's review policy")
    selection = json.loads(selection_path.read_text(encoding="utf-8"))
    candidate_id = selection.get("candidate_id")
    if type(candidate_id) is not int or candidate_id not in (1, 2, 3):
        raise ValueError("saved selection must identify candidate 1, 2, or 3")
    candidate = manifest["candidates"][candidate_id - 1]
    delegated = (selection.get("status") == "llm_selected"
                 and selection.get("selection_actor") == "llm"
                 and isinstance(selection.get("authorization"), str)
                 and bool(selection["authorization"].strip())
                 and isinstance(selection.get("reason"), str)
                 and bool(selection["reason"].strip()))
    if (not (selection.get("status") == "user_selected" or delegated)
            or selection.get("manifest_sha256") != manifest_hash
            or selection.get("source_sha256") != candidate["source_sha256"]
            or selection.get("problem_sha256") != manifest["problem_sha256"]):
        raise ClientError("STALE_SELECTION", "selection no longer matches the reviewed candidates")
    kwargs.setdefault("submit_only", True)
    return run_lean((directory / candidate["filename"]).read_text(encoding="utf-8"),
                    statement=problem, selection_record=selection, **kwargs)


def context_error(error):
    if error.get("code") == "ACCOUNT_TOKEN_REQUIRED":
        return {"code": "ACCOUNT_TOKEN_REQUIRED", "message": account_token_message()}
    if error.get("code") == "UNSUPPORTED_ACCOUNT_TOKEN":
        return {"code": "UNSUPPORTED_ACCOUNT_TOKEN", "message": "Deploy a server that supports request API keys before using this skill. No proof task was submitted."}
    if error.get("code") == "INVALID_ACCOUNT_TOKEN":
        return {"code": "INVALID_ACCOUNT_TOKEN", "message": "Set a valid SCHOLARSEED_ACCOUNT_TOKEN and invoke the proof skill again."}
    if error.get("http_status") == 404 or error.get("code") == "NOT_FOUND":
        return {"code": "NOT_FOUND", "message": "ProofServer returned HTTP 404. Proof search stopped without retrying.",
                **{key: error[key] for key in ("task_id", "output_dir", "http_status", "request_id")
                   if key in error}}
    if error.get("code") == "BUSY":
        return {"code": "BUSY", "message": "ProofServer is busy. Proof search stopped without retrying.",
                **{key: error[key] for key in ("task_id", "output_dir", "http_status", "request_id")
                   if key in error}}
    result = {key: error[key] for key in ("code", "task_id", "output_dir", "http_status", "request_id")
              if key in error}
    result["message"] = "The operation did not complete; local evidence contains the diagnostics."
    if result.get("code") not in {
            "NETWORK_ERROR", "HTTP_ERROR", "INVALID_RESPONSE", "WAIT_TIMEOUT",
            "IDEMPOTENCY_CONFLICT", "IDEMPOTENCY_IN_PROGRESS", "INVALID_INPUT",
            "PREFLIGHT_FAILED", "PREFLIGHT_UNAVAILABLE", "LEAN_UNAVAILABLE",
            "UNSUPPORTED_BUDGET", "RETIRED_REQUEST_OPTIONS", "ARTIFACT_CHANGED",
            "EVIDENCE_CHANGED", "STALE_SELECTION", "AUTH_REQUIRED", "NOT_FOUND", "SENSITIVE_RESPONSE"}:
        result["code"] = "REQUEST_FAILED"
    if isinstance(error.get("snapshot"), dict):
        result["snapshot"] = progress_snapshot(error["snapshot"])
    return result


def context_output(command, result):
    """Only the closed business contract enters host LLM context."""
    if command in {"prompt", "prepare", "select", "discover", "verify"}:
        return result
    if command in {"validate", "preflight"}:
        return {"valid": result.get("valid") is True, "verified": False}
    if command in {"cancel", "explain"}:
        return progress_snapshot(result)
    result = dict(result)
    if isinstance(result.get("snapshot"), dict) and "observed_at" not in result["snapshot"]:
        result["snapshot"] = progress_snapshot(result["snapshot"])
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", help="server root or full /webapi/v1 base")
    parser.add_argument("--config", type=Path,
                        help="configuration JSON (default: configure.json in the skill folder)")
    parser.add_argument("--timeout", type=positive_number, default=70)
    commands = parser.add_subparsers(dest="command", required=True)
    prompt_command = commands.add_parser("prompt", help="render the client LLM prompt locally")
    prompt_command.add_argument("--problem-file", type=Path, required=True)
    prompt_command.add_argument("--autoformal-root", type=Path)
    prepare = commands.add_parser("prepare", help="save three host-LLM candidates without any API call")
    prepare.add_argument("--problem-file", type=Path, required=True)
    prepare.add_argument("--candidates-json", type=Path, required=True)
    prepare.add_argument("--output", type=Path)
    select = commands.add_parser("select", help="record a user choice or an authorized LLM selection")
    select.add_argument("--preparation", type=Path, required=True)
    select.add_argument("--candidate", type=int, choices=(1, 2, 3), required=True)
    select.add_argument("--selection-actor", choices=("user", "llm"), default="user")
    select.add_argument("--authorization", help="the user's delegation or the applicable timed-default skill policy")
    select.add_argument("--reason")
    selected = commands.add_parser("submit-selected", help="submit only a previously selected candidate")
    selected.add_argument("--preparation", type=Path, required=True)
    selected.add_argument("--output", type=Path)
    selected.add_argument("--rounds", type=int)
    selected.add_argument("--explain", action="store_true", default=None)
    selected.add_argument("--max-runtime-seconds", type=int)
    selected.add_argument("--preflight", choices=("auto", "required", "off"), default="auto")
    preflight_cmd = commands.add_parser("preflight", help="elaborate a Lean statement; sorry allowed")
    preflight_cmd.add_argument("lean_file", type=Path)
    commands.add_parser("discover")
    for command in ("run", "submit", "validate"):
        sub = commands.add_parser(command)
        inputs = sub.add_mutually_exclusive_group(required=True)
        inputs.add_argument("--lean-file", type=Path)
        inputs.add_argument("--request-json", type=Path, help="exact saved request for recovery")
        sub.add_argument("--statement-file", type=Path)
        sub.add_argument("--rounds", type=int)
        sub.add_argument("--max-runtime-seconds", type=int)
        sub.add_argument("--preflight", choices=("auto", "required", "off"), default="auto")
        sub.add_argument("--explain", action="store_true", default=None)
        if command != "validate":
            sub.add_argument("--output", type=Path)
            sub.add_argument("--idempotency-key")
        if command == "run":
            sub.add_argument("--wait-seconds", type=positive_number, default=600)
            sub.add_argument("--poll-seconds", type=positive_number, default=3)
    for command in ("status", "watch", "cancel", "explain", "download"):
        sub = commands.add_parser(command)
        sub.add_argument("task_id")
        if command in {"watch", "download"}:
            sub.add_argument("--output", type=Path)
        if command == "watch":
            sub.add_argument("--wait-seconds", type=positive_number, default=600)
            sub.add_argument("--poll-seconds", type=positive_number, default=3)
    verify = commands.add_parser("verify")
    verify.add_argument("lean_file", type=Path)
    args = parser.parse_args(argv)
    # The host turns stderr events into visible commentary; stdout stays JSON.
    progress = ProgressReporter()

    try:
        require_account_token()
        client = None
        if args.command not in {"prompt", "prepare", "select"}:
            client = ProofClient(args.base_url, timeout=args.timeout, config_path=args.config)
        if args.command == "prompt":
            result = client_formalization_prompt(
                args.problem_file.read_text(encoding="utf-8"), autoformal_root=args.autoformal_root)
        elif args.command == "prepare":
            candidates = json.loads(args.candidates_json.read_text(encoding="utf-8"))
            result = prepare_problem(args.problem_file.read_text(encoding="utf-8"),
                                     lambda problem: candidates, output_dir=args.output)
        elif args.command == "select":
            result = confirm_candidate(args.preparation, args.candidate,
                                       selection_actor=args.selection_actor,
                                       authorization=args.authorization, reason=args.reason)
        elif args.command == "submit-selected":
            result = submit_selected(args.preparation, client=client, output_dir=args.output,
                                     rounds=args.rounds,
                                     informalize=args.explain, on_progress=progress,
                                     max_runtime_seconds=args.max_runtime_seconds,
                                     preflight=args.preflight)
        elif args.command == "discover":
            result = client.discover()
        elif args.command in {"run", "submit", "validate"}:
            if args.request_json:
                if args.command != "validate" and not args.idempotency_key:
                    raise ValueError("saved request recovery requires its original --idempotency-key")
                payload = json.loads(args.request_json.read_text(encoding="utf-8"))
                if any(getattr(args, field) is not None for field in
                       ("statement_file", "rounds", "explain", "max_runtime_seconds")):
                    raise ValueError("saved request recovery cannot include payload overrides")
                # Accept only the prove-only fields supported by this client.
                payload = dict(payload)
                if payload.pop("input_type", None) != "lean":
                    raise ValueError("saved request must use input_type=lean")
                source = payload.pop("source")
                statement = payload.pop("informal_statement", None)
            else:
                source = args.lean_file.read_text(encoding="utf-8")
                statement = (args.statement_file.read_text(encoding="utf-8")
                             if args.statement_file else None)
                payload = {"filename": args.lean_file.name, "rounds": args.rounds,
                           "max_runtime_seconds": args.max_runtime_seconds,
                           "informalize": args.explain}
            if args.command == "validate":
                result = client.validate(lean_request(source, statement=statement, **payload))
            else:
                result = run_lean(
                    source, statement=statement, client=client, output_dir=args.output,
                    idempotency_key=args.idempotency_key, submit_only=args.command == "submit",
                    preflight=args.preflight,
                    wait_seconds=getattr(args, "wait_seconds", 600),
                    poll_seconds=getattr(args, "poll_seconds", 3), on_progress=progress, **payload)
        elif args.command == "preflight":
            result = client.preflight(args.lean_file.read_text(encoding="utf-8"), args.lean_file.name)
        elif args.command == "verify":
            result = client.verify(args.lean_file.read_text(encoding="utf-8"), args.lean_file.name)
        elif args.command == "status":
            task = client.status(args.task_id)
            result = {**task_summary(task), "snapshot": progress_snapshot(task)}
        elif args.command in {"cancel", "explain"}:
            suffix = "/cancellations" if args.command == "cancel" else "/informalizations"
            result = client.request("POST", task_path(args.task_id) + suffix, {})
        else:
            directory = new_output(args.output)
            if args.command == "download":
                result = collect_result(client, client.status(args.task_id), directory)
            else:
                def save_progress(task):
                    save_task_progress(directory, task)
                    progress(task)
                try:
                    task = client.wait(args.task_id, wait_seconds=args.wait_seconds,
                                       poll_seconds=args.poll_seconds, on_progress=save_progress)
                    result = collect_result(client, task, directory)
                except ClientError as error:
                    error.result.update(task_id=args.task_id, output_dir=str(directory))
                    write_json(directory / "error.json", error.result)
                    raise
        print(json.dumps(context_output(args.command, result), ensure_ascii=False, indent=2))
        if result.get("valid") is False or result.get("accepted") is False:
            return 2
        return 0
    except ClientError as error:
        if getattr(args, "task_id", None):
            error.result.setdefault("task_id", args.task_id)
        print(json.dumps({"error": context_error(error.result)}, ensure_ascii=False, indent=2))
        return 3 if error.result["code"] == "WAIT_TIMEOUT" else 1
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({"error": {"code": "CLIENT_ERROR", "message": str(error)}}))
        return 1
    except KeyboardInterrupt:
        print(json.dumps({"error": {"code": "INTERRUPTED", "message":
                         "Remote task is not cancelled; recover its ID from task.json."}}))
        return 130


if __name__ == "__main__":
    sys.exit(main())
