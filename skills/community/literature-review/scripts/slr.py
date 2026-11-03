#!/usr/bin/env scholarseed-skill-python
"""slr — current literature-review task and workflow interface.

Bind a workspace with init, configure the task, then use workflow evidence.
Display its outline result and honor the real publication decision. Prepare and
run manuscript generation alongside the figure author, then workflow publish.
Use status for observed progress and --full only for named diagnostics.
Explicit compatibility interfaces remain callable; --legacy-help exposes them.
"""
from __future__ import annotations

# --- slr path bootstrap ---
import sys as _slr_sys, pathlib as _slr_pathlib
for _slr_anc in _slr_pathlib.Path(__file__).resolve().parents:
    if (_slr_anc / ".slr-home").is_file():
        _slr_sys.path.insert(0, str(_slr_anc / "lib"))
        break
else:
    raise RuntimeError("systematic-literature-review skill root not found above " + __file__)
import slr_paths
import run_identity
# --- end slr path bootstrap ---

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import re
from main_view import emit
from datetime import date
from functools import partial
from pathlib import Path
import review_timeout
from task_contract import json_input
from platform_io import run_stream
from platform_runtime import runtime_info, utf8_env
from citation_styles import style_ids

TERMINAL_STATUSES = ("SUCCESS", "PARTIAL_SUCCESS", "FAILED")


# ------------------------------------------------------------------ helpers --

def load_profile(profile: str) -> dict:
    return slr_paths.profile_config(profile)


def find_stage(profile: str, stage_id: str) -> dict:
    for stage in load_profile(profile)["stages"]:
        if stage["id"] == stage_id:
            return stage
    known = ", ".join(s["id"] for s in load_profile(profile)["stages"])
    raise SystemExit(f"unknown stage {stage_id!r} for profile {profile!r}; known: {known}")


def substitute(command: list[str], workspace: Path) -> list[str]:
    mapping = {"${SLR_HOME}": str(slr_paths.HOME), "${WORKSPACE}": str(workspace)}
    out = []
    for token in command:
        for key, value in mapping.items():
            token = token.replace(key, value)
        out.append(token)
    if out and out[0] in ("python", "scholarseed-skill-python"):
        out[0] = sys.executable
    return out


def extract_trailing_json(text: str) -> dict | None:
    """
    Pull the last JSON object carrying a "status" key out of a stage's stdout.

    Stages may print progress objects before the terminal handshake. Scan
    forwards, skipping complete objects, so nested check statuses cannot hide
    their parent. Keep the last status-bearing object and tolerate log noise.
    """
    decoder = json.JSONDecoder()
    index = 0
    latest = None
    while index < len(text):
        index = text.find('{', index)
        if index < 0:
            break
        try:
            parsed, end = decoder.raw_decode(text, index)
        except ValueError:
            index += 1
            continue
        if isinstance(parsed, dict) and "status" in parsed:
            latest = parsed
        # Skip the complete object so a nested SUCCESS cannot hide outer FAILED.
        index = end
    return latest


def resolve_status(stage: dict, workspace: Path, stdout: str, returncode: int) -> tuple[str, str]:
    spec = stage.get("status", {})
    kind = spec.get("kind", "exit_code")

    if kind == "json_file":
        path = workspace / spec["path"]
        if path.is_file():
            try:
                data = json.loads(path.read_text())
                return (str(data.get("status", "UNKNOWN")).upper(),
                        str(data.get("status_reason", "")))
            except (json.JSONDecodeError, OSError) as exc:
                return "FAILED", f"could not read {spec['path']}: {exc}"
        return "FAILED", f"{spec['path']} was never written"

    if kind == "trailing_json":
        payload = extract_trailing_json(stdout)
        if payload:
            return (str(payload.get("status", "UNKNOWN")).upper(),
                    str(payload.get("status_reason", "")))
        if returncode == 0:
            return "PARTIAL_SUCCESS", "stage exited 0 but printed no status object"
        return "FAILED", f"no status object; exit code {returncode}"

    if kind == "artifact":
        target = workspace / spec["path"]
        if target.exists():
            return "SUCCESS", ""
        return "FAILED", f"expected artefact {spec['path']} was not produced"

    return ("SUCCESS", "") if returncode == 0 else ("FAILED", f"exit code {returncode}")


def stage_env(profile: str, workspace: Path) -> dict:
    env = utf8_env()
    env["SLR_HOME"] = str(slr_paths.HOME)
    env["SLR_PROFILE"] = profile
    env["SLR_WORKSPACE"] = str(workspace)
    env["PYTHONUNBUFFERED"] = "1"
    env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", "")
    return env


def run_command(command: list[str], workspace: Path, log_path: Path,
                env: dict, timeout: int, progress=False) -> tuple[int, str]:
    """Run one command, mirroring its output into the log file."""
    return run_stream(command,workspace,log_path,env,timeout,progress)


# ----------------------------------------------------------------- commands --

def cmd_run(args) -> int:
    profile = args.profile or slr_paths.resolve_profile()
    workspace = Path(args.workspace).resolve() if args.workspace else slr_paths.workspace()
    stage = find_stage(profile, args.stage)

    commands = [substitute(c, workspace) for c in (stage.get("steps") or [stage["command"]])]

    if args.dry_run:
        print(json.dumps({"stage": stage["id"], "profile": profile,
                          "workspace": str(workspace),
                          "commands": commands}, indent=2, ensure_ascii=False))
        return 0

    if not workspace.is_dir():
        print(json.dumps({"stage": stage["id"], "status": "FAILED",
                          "status_reason": f"workspace does not exist: {workspace}"},
                         ensure_ascii=False))
        return 1

    logs = workspace / '_logs'
    logs.mkdir(parents=True, exist_ok=True)
    log_path = logs / f"{stage['id']}.log"
    env = stage_env(profile, workspace)
    timeout = stage.get('timeout_sec', 3600)
    started = time.time()
    if args.stage not in ('generation_publish','verify_postcheck','verify_audit'):
        from task_contract import sync_views
        sync_views(workspace)
    returncode, stdout = 0, ''
    step_results = []
    for index, command in enumerate(commands, 1):
        returncode, stdout = run_command(command, workspace, log_path, env, timeout)
        payload = extract_trailing_json(stdout) or {}
        step_results.append({'step':index,'command':command[1] if len(command)>1 else command[0],
                             'returncode':returncode,'status':payload.get('status','SUCCESS' if returncode==0 else 'FAILED'),
                             'detail':payload})
        if returncode != 0:
            if len(commands) > 1:
                stdout += f"\n[slr] step {index}/{len(commands)} failed"
            break

    status, reason = resolve_status(stage, workspace, stdout, returncode)
    readiness_result = {}
    if returncode != 0 and not (stage.get('optional') and status=='PARTIAL_SUCCESS' and returncode in (2,3)):
        status = 'FAILED'
    elif status != 'FAILED' and any(x['status'] not in ('SUCCESS','SKIPPED') for x in step_results):
        status = 'PARTIAL_SUCCESS'
        reason = reason or 'One or more substeps did not complete; inspect steps and downstream readiness.'
    if args.stage == 'processing':
        from paper_materials import readiness
        readiness_result = readiness(workspace)
        if not readiness_result['ready_for_outline']:
            status = readiness_result['status']
            reason = 'Required paper evidence or citation identities are incomplete.'
    writes = stage.get("writes", [])
    spec_path = workspace / "04_outline/output_spec.json"
    if spec_path.exists() and json.loads(spec_path.read_text()).get("format") == "markdown":
        writes = [re.sub(r"full_draft_v([123])\.tex$", r"full_draft_v\1.md", w)
                  .replace("06_output/survey.pdf", "06_output/survey.md") for w in writes]
    if args.stage in ('verify_postcheck','generation_publish'):
        from manuscript_publication import publication_source
        if publication_source(workspace).suffix=='.md':
            writes=[w.replace('06_output/survey.pdf','06_output/survey.md') for w in writes if w!='07_verifier/postcheck/pages/']
    produced = [w for w in writes if (workspace / w).exists()]
    missing = [w for w in writes if not (workspace / w).exists()]
    compile_result = {}
    if args.stage == "generation_publish":
        compile_result = _compile_summary(_read_json_status(workspace / "05_generation/_status/phase07_compile_latex.json"))
        bad_compile = compile_result.get("verdict") not in (None, "clean")
        if status == "SUCCESS" and (missing or bad_compile):
            status = "PARTIAL_SUCCESS"
            reason = "Publication is incomplete; inspect the compile diagnosis and required artifacts."

    result = {
        "stage": stage["id"],
        "profile": profile,
        "status": status,
        "status_reason": reason,
        "elapsed_sec": round(time.time() - started, 1),
        "log": str(log_path),
        "artifacts_written": produced,
        "artifacts_missing": missing,
    }
    result['steps'] = step_results
    if args.stage == 'fulltext' and step_results:
        for key in ('material_counts', 'unresolved_ids', 'resolved', 'total',
                    'coverage_by_relevance_level', 'by_outcome', 'sources_enabled'):
            if key in step_results[-1]['detail']:
                result[key] = step_results[-1]['detail'][key]
    if args.stage in ('verify_postcheck', 'generation_publish') and step_results:
        detail = step_results[-1]['detail']
        for key in ('checks', 'pages_to_read', 'render_error', 'visual_review_required',
                    'visual_review_complete', 'inspection_scope', 'report', 'deliverable'):
            if key in detail:
                result[key] = detail[key]
    if args.stage == 'retrieval_adapt' and status != 'FAILED':
        from workflow import retrieval_summary
        result['retrieval'] = retrieval_summary(workspace)
    result.update({k:v for k,v in readiness_result.items() if k not in ('status','stage')})
    from task_contract import atomic_json
    if compile_result:
        result["compile"] = compile_result
    if status == "FAILED":
        result['code'] = 'LATEX_COMPILE_ERROR' if reason.startswith('LATEX_COMPILE_ERROR') else 'STAGE_FAILED'
        tail = stdout.splitlines()[-args.tail:] if args.tail else []
        result["log_tail"] = tail
    # The same object the agent reads, appended to the audit trail. One line per
    # invocation, so a re-run after a failure is two lines rather than one
    # overwritten one -- the retry is the interesting part.
    atomic_json(workspace/'_status'/f'{args.stage}.json', result)
    emit(result, getattr(args, 'full', False))
    return 0 if status in ("SUCCESS", "PARTIAL_SUCCESS") and readiness_result.get("ready_for_outline",True) else 1


def cmd_resume(args) -> int:
    profile = args.profile or slr_paths.resolve_profile()
    stages = [s["id"] for s in load_profile(profile)["stages"]]
    if args.start not in stages:
        raise SystemExit(f"unknown stage {args.start!r}; known: {', '.join(stages)}")
    for stage_id in stages[stages.index(args.start):]:
        args.stage = stage_id
        if cmd_run(args) != 0:
            return 1
    return 0


def _publish_phase(args, script: str, extra: list[str]) -> int:
    """Run one publish-phase script against the workspace, mirroring `run`."""
    profile = args.profile or slr_paths.resolve_profile()
    workspace = Path(args.workspace).resolve() if args.workspace else slr_paths.workspace()
    try:
        path = slr_paths.script_path("scripts/generation/publish", script, profile)
    except FileNotFoundError as exc:
        print(json.dumps({"status": "FAILED", "status_reason": str(exc)}, ensure_ascii=False))
        return 1

    logs = workspace / "_logs"
    logs.mkdir(parents=True, exist_ok=True)
    log_path = logs / "generation.log"
    command = [sys.executable, str(path), *extra]
    returncode, stdout = run_command(command, workspace, log_path,
                                     stage_env(profile, workspace), 3600)

    result: dict = {"phase": script, "profile": profile,
                    "exit_code": returncode, "log": str(log_path)}
    status_file = workspace / "05_generation" / "_status" / f"{Path(script).stem}.json"
    if status_file.is_file():
        try:
            data = json.loads(status_file.read_text())
            result["status"] = data.get("status", "UNKNOWN")
            # the fix loop keys off this verdict
            if "diagnosis" in data:
                result["verdict"] = data["diagnosis"].get("verdict")
                result["diagnosis"] = _compile_summary(data)
            if "engine" in data:
                result["engine"] = data["engine"]
        except (json.JSONDecodeError, OSError) as exc:
            result["status"] = "UNKNOWN"
            result["status_reason"] = f"could not read {status_file.name}: {exc}"
    else:
        payload = extract_trailing_json(stdout)
        result["status"] = (payload or {}).get("status",
                                              "SUCCESS" if returncode == 0 else "FAILED")
        if payload and payload.get("status_reason"):
            result["status_reason"] = payload["status_reason"]
    if result.get("status") == "FAILED" or returncode != 0:
        result["log_tail"] = stdout.splitlines()[-args.tail:] if args.tail else []
    # The fix loop runs these one at a time, so each attempt is its own line.
    # How many attempts a compile took is a fact about the run, and counting the
    # lines is the only way to recover it.

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if returncode == 0 else 1


def cmd_compile(args) -> int:
    from workflow import advance
    result=advance(_resolve_workspace(args),'publish')
    emit(result,getattr(args,'full',False))
    return 1 if result['status']=='FAILED' else 0


def cmd_finalize(args) -> int:
    """Re-validate the assets, then re-aggregate the report.

    `phase08_finalize` derives `final_status` by aggregating the status files
    every earlier phase left behind. That is the right design and it has one
    trap: a status file is a record of a check, not of the artefact, so a
    problem fixed by hand after the check ran leaves `final_status` FAILED
    against a document that is now fine.

    One run hit exactly that. `validate_tables` failed because a table had
    grown two rows the worklist did not list; the user approved the change, the
    table was correct, and `generation_report.json` said FAILED to the end. The
    orchestrator explained the discrepancy in prose and opened with "the survey
    is complete" — so the human-readable and machine-readable verdicts said
    opposite things, and only one of them is what a downstream consumer reads.

    So finalize re-runs the cheap validators first. They are offline and take
    milliseconds; running them again is far cheaper than shipping a report that
    disagrees with its own document. Their exit codes are deliberately ignored
    here: this command's job is to make the record accurate, not to gate on it.
    """
    workspace = _resolve_workspace(args)
    for script in (
        slr_paths.HOME / "scripts" / "generation" / "tables" / "_fast" / "validate_tables.py",
    ):
        if script.is_file():
            subprocess.call([sys.executable, str(script), str(workspace)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return _publish_phase(args, "phase08_finalize.py", [])


def _resolve_workspace(args) -> Path:
    return Path(args.workspace).resolve() if args.workspace else slr_paths.workspace()


def _exec_tool(command: list[str]) -> int:
    """
    Run one short-lived tool, streaming its output and propagating its exit code.

    Deliberately NOT the stage machinery. A stage is long, so `run` swallows its
    output into a log and hands back one JSON object. These are the commands the
    agent runs *interactively* -- validators and the template query -- whose
    stdout and stderr are the answer, and whose exit code the reference files
    branch on. Wrapping them would hide the very thing the caller needs.

    They live here for one reason: `allowed-tools` grants `Bash(<skill>/scripts/slr:*)`
    and nothing else. Every command the agent could only reach by naming a python
    script directly was a permission prompt per invocation, and prompts the user
    learns to click through are worse than no prompt at all.
    """
    # Our own stdout is block-buffered when piped; the child's stderr is not.
    # Without this the section headers land after the errors they introduce.
    sys.stdout.flush()
    return subprocess.call(command)


def _exec_main_tool(args, command, label):
    """Keep complete subprocess output on disk and emit the main-agent view."""
    ws = _resolve_workspace(args)
    log = ws / '_logs' / (label + '.log')
    log.parent.mkdir(parents=True, exist_ok=True)
    rc, stdout = run_command(command, Path.cwd(), log,
                             stage_env(getattr(args, 'profile', None) or slr_paths.resolve_profile(), ws),
                             14400, progress=True)
    try:
        value = json.loads(stdout)
    except ValueError:
        value = extract_trailing_json(stdout)
    if not isinstance(value, dict):
        value = {'status': 'FAILED', 'code': 'CLI_OUTPUT_INVALID', 'exit_code': rc}
        rc = rc or 1
    if rc and value.get('status') != 'FAILED':
        value.update(status='FAILED', exit_code=rc)
    value['log'] = str(log)
    from task_contract import atomic_json
    path = ws / '_status' / (label + '.json')
    atomic_json(path, value)
    value['cli_report'] = str(path)
    emit(value, getattr(args, 'full', False))
    return rc


# The full artefact tree, in pipeline order. Every stage writes into one of
# these, and each is named by exactly one stage — so there is nothing to
# discover at run time and nothing for a subagent to guess at.
_WORKSPACE_DIRS = (
    "01_input",       # framework-supplied precise intent + defaults
    "02_retrieval",   # search + screening
    "03_process",     # full text, cards, bibliography
    "04_outline",     # outline, rationale, output spec
    "05_generation",  # drafts, tables, figures, merged drafts
    "05_generation/section_drafts",
    "05_generation/tables",
    "05_generation/figures",
    "05_generation/_internal",
    "05_generation/_status",
    "06_output",      # the deliverable
    "07_verifier",    # audit + postcheck
    "_logs",
)


def _intent_language(intent: str, requested: str) -> str:
    if requested != "auto":
        return requested.upper()
    return "CHINESE" if re.search(r"[\u3400-\u9fff]", intent) else "ENGLISH"


def cmd_init(args) -> int:
    """Create the workspace and record the framework-supplied precise intent.

    Directories used to appear as each stage reached them, which left the gaps
    between stages to whoever arrived first. Five separate section-writer
    subagents each opened with the same `mkdir -p .../section_drafts`; four of
    those were no-ops, and every one of them cost a tool call in an agent that
    had a document to write. The scaffold is fixed and known — there is no
    reason for it to be built by whoever happens to need it.
    """
    workspace = _resolve_workspace(args)
    intent = (args.intent or "").strip()
    if args.intent is not None and not intent:
        print("init: --intent must contain a non-empty precise sentence", file=sys.stderr)
        return 2

    occupied_before = sorted(
        rel for rel in ("01_input", "02_retrieval", "03_process", "04_outline",
                        "06_output")
        if (workspace / rel).is_dir() and any((workspace / rel).iterdir())
    )
    created, existing = [], []
    for rel in _WORKSPACE_DIRS:
        path = workspace / rel
        (existing if path.is_dir() else created).append(rel)
        path.mkdir(parents=True, exist_ok=True)

    inputs_written: list[str] = []
    if intent:
        from task_contract import configure
        task_path = workspace / '01_input/writing_request.json'
        if task_path.exists():
            raise ValueError('task already exists; use writing configure to update it')
        current_year = date.today().year
        configure(workspace, {'intent':intent, 'language':_intent_language(intent,args.language),
            'retrieval': {'temporal_policy': {'constraint':'soft',
                'explicit_range_source':'query_text_if_present',
                'default_if_unspecified':{'label':'recent_five_calendar_years',
                    'start_year':current_year-4,'end_year':current_year},
                'allow_earlier_foundational_work':True}}})
        inputs_written = ['01_input/writing_request.json', '01_input/query.json', '04_outline/output_spec.json']
    from workspace_binding import bind
    entry = bind(workspace, slr_paths.HOME)

    # An existing workspace with artefacts in it is the one thing worth
    # stopping for: `01_input/` … `06_output/` are fixed names, so a second
    # survey run here overwrites the first.
    print(json.dumps({
        "command": "init",
        "status": "SUCCESS",
        "workspace": str(workspace),
        "created": created, "entrypoint": str(entry), "python": sys.executable,
        "runtime": runtime_info(slr_paths.HOME,workspace),
        "already_present": existing,
        "inputs_written": inputs_written,
        "non_empty_before_init": occupied_before,
        "note": ("this workspace already holds artefacts from an earlier run; "
                 "do not start a second survey in it" if occupied_before else
                 "scaffold and exact framework intent ready; start retrieval"),
    }, ensure_ascii=False, indent=2))
    return 0


def cmd_evidence(args) -> int:
    if not args.view:raise ValueError('evidence build requires --view outline or writing')
    from evidence import build
    from task_contract import json_input
    result=build(_resolve_workspace(args),args.view,json_input(args.request) if args.request else None)
    emit(result,getattr(args,'full',False))
    return 0


def cmd_outline(args) -> int:
    workspace = _resolve_workspace(args)
    if args.action == 'configure':
        if not args.request:raise ValueError('outline configure requires a complete outline --request FILE or -')
        sys.path.insert(0,str(slr_paths.HOME/'scripts'))
        from operator_cli import configure_outline
        print(json.dumps(configure_outline(workspace,json_input(args.request)),ensure_ascii=False,indent=2))
        return 0
    if args.action == 'review-packet':
        sys.path.insert(0, str(slr_paths.HOME/'scripts'))
        from operator_cli import review_packet
        value = review_packet(workspace)
        value['report'] = str(workspace / '04_outline/review_packet.json')
        emit(value, getattr(args, 'full', False))
        return 0
    if args.action == 'generate':
        command = [sys.executable, str(slr_paths.HOME / 'scripts/scripted_generation.py'),
                   'outline', '--workspace', str(workspace)]
        if args.request: command += ['--request', args.request]
        return _exec_main_tool(args, command, 'outline_generate')
    forwarded: list[str] = []
    for option, attr in (
        ("--min-figures", "min_figures"),
        ("--max-figures", "max_figures"),
        ("--min-tables", "min_tables"),
        ("--max-tables", "max_tables"),
        ("--min-papers-per-subsection", "min_papers_per_subsection"),
        ("--max-papers-per-subsection", "max_papers_per_subsection"),
        ("--min-papers-per-section", "min_papers_per_section"),
    ):
        value = getattr(args, attr, None)
        if value is not None:
            forwarded += [option, str(value)]
    for value in getattr(args, "required_section", None) or []:
        forwarded += ["--required-section", value]
    if getattr(args, "json", False):
        forwarded.append("--json")

    if args.action == "render":
        if forwarded or getattr(args, "requirements", None):
            print("outline validator flags are valid only with `outline check`",
                  file=sys.stderr)
            return 2
        return _exec_tool([sys.executable,
                           str(slr_paths.HOME / "scripts" / "outline" / "render_outline_md.py"),
                           str(workspace)])

    command = [sys.executable, str(slr_paths.HOME/'scripts/validate_outline.py'), str(workspace)]
    return _exec_tool(command + forwarded)


def cmd_templates(args) -> int:
    command = [sys.executable, str(slr_paths.HOME / "scripts" / "templates.py"), args.action]
    if args.name:
        command.append(args.name)
    if args.json:
        command.append("--json")
    return _exec_tool(command)


def cmd_citations(args) -> int:
    if args.action == "examples":
        return _exec_tool([
            sys.executable, str(slr_paths.HOME / "scripts" / "templates.py"), "cite"
        ] + (["--json"] if args.json else []))
    workspace = _resolve_workspace(args)
    command = [
        sys.executable,
        str(slr_paths.HOME / "scripts" / "processing" / "audit_citation_metadata.py"),
        str(workspace),
    ]
    if args.style:
        command += ["--style", args.style]
    if args.json:
        command.append("--json")
    return _exec_tool(command)


def _read_json_status(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _compile_summary(data: dict) -> dict:
    diagnosis = data.get("diagnosis") or {}
    if not diagnosis:
        return {}
    return {"source": data.get("source"), **{key: diagnosis[key] for key in (
        "verdict", "final_pass_rc", "fatal_errors", "error_contexts", "log_path") if key in diagnosis}}


def cmd_figures(args) -> int:
    if args.action == 'context':
        if not args.ids:raise ValueError('figures context requires --ids F1 ...')
        sys.path.insert(0,str(slr_paths.HOME/'scripts'))
        from figure_dependencies import context
        print(json.dumps({'figures':[context(_resolve_workspace(args),fid) for fid in args.ids]},ensure_ascii=False,indent=2))
        return 0
    if args.action == 'statistics':
        return _exec_tool([sys.executable,str(slr_paths.HOME/'scripts/generation/figures/_fast/compute_chart_data.py'),'--list','--workspace',str(_resolve_workspace(args))])
    if args.action == 'plan':
        sys.path.insert(0,str(slr_paths.HOME/'scripts'))
        from operator_cli import figure_plan
        if not args.request: raise ValueError('figures plan requires --request FILE or -')
        print(json.dumps(figure_plan(_resolve_workspace(args),json_input(args.request)),ensure_ascii=False))
        return 0
    # Realise the submitted figure plan. The author binds each figure's actual
    # prerequisite context before submission; unrelated chapters need not finish.
    started = time.time()
    workspace = _resolve_workspace(args)
    status_dir = workspace / "05_generation" / "_status"
    status_dir.mkdir(parents=True, exist_ok=True)
    result_path = status_dir / "figures_plan_generate.json"
    prepared_path = workspace / "05_generation/_internal/manuscript_contract.json"
    expected_preparation = json.loads(prepared_path.read_text()).get("preparation_id") if prepared_path.exists() else None

    result_path.write_text(json.dumps({'status':'RUNNING','stage':'figures_plan_generate'}))
    validate_cmd = [
        sys.executable,
        str(slr_paths.HOME / "scripts" / "validate_figures_meta.py"),
        str(workspace),
    ]
    validate_rc = subprocess.call(validate_cmd, cwd=str(slr_paths.HOME))
    if validate_rc != 0:
        result = {
            "stage": "figures_plan_generate", "status": "FAILED",
            "status_reason": "figure metadata validation failed; fix the named items before generation",
            "validate_rc": validate_rc, "workspace": str(workspace),
            "duration_sec": round(time.time() - started, 2),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                               encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
        return 1

    figure_dir = slr_paths.HOME / "scripts" / "generation" / "figures" / "_fast"
    env = os.environ.copy()
    env["SLR_WORKSPACE"] = str(workspace)
    image_rc = subprocess.call([
        sys.executable, str(figure_dir / "generate_images.py"),
        "--concurrency", str(max(1, args.concurrency)),
    ], cwd=str(workspace), env=env)
    latex_rc = subprocess.call([
        sys.executable, str(figure_dir / "write_latex.py"),
    ], cwd=str(workspace), env=env)

    image_status = _read_json_status(status_dir / "generate_images.json")
    latex_status = _read_json_status(status_dir / "write_latex.json")
    failed = image_status.get("failed") or []
    if image_rc != 0 or latex_rc != 0:
        status = "FAILED"
        reason = f"figure realisation command failed: images_rc={image_rc}, latex_rc={latex_rc}"
    elif failed:
        status = "PARTIAL_SUCCESS"
        reason = f"{len(failed)} figure(s) could not be realised; retry failed figure tasks with figures plan-generate"
    else:
        status = "SUCCESS"
        reason = "figure plan validated and all renderable figures were realised"
    result = {
        "stage": "figures_plan_generate", "status": status,
        "status_reason": reason, "workspace": str(workspace),
        "total": image_status.get("total", 0),
        "rendered": image_status.get("rendered", 0),
        "failed": failed,
        "latex_written": latex_status.get("written", 0),
        "image_generation": image_status.get("image_generation"),
        "validate_rc": validate_rc, "images_rc": image_rc, "latex_rc": latex_rc,
        "visual_review_performed": False, "refinement_performed": False,
        "next_action": "Integrate generated assets directly; no image review or refinement." if status == "SUCCESS" else "Resolve the reported technical failure; do not substitute missing required assets.",
        "duration_sec": round(time.time() - started, 2),
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                           encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 1 if status == "FAILED" else 0


def cmd_status(args):
    ws=_resolve_workspace(args)
    if args.stage=='processing':
        from paper_materials import readiness
        value=readiness(ws)
    else:
        path=ws/('_status/workflow.json' if args.stage=='workflow' else '_status/writing.json')
        value=json.loads(path.read_text()) if path.exists() else {'stage':args.stage,'status':'NOT_STARTED'}
        if args.stage=='writing':
            value['requests']=[json.loads(p.read_text()) for p in (ws/'_status/llm_requests').glob('*.json')]
        value['report'] = str(path)
    emit(value, getattr(args, 'full', False))
    return 0


def cmd_papers(args):
    sys.path.insert(0,str(slr_paths.HOME/'scripts'))
    from operator_cli import papers
    from task_contract import json_input
    print(json.dumps(papers(_resolve_workspace(args),args.action,args.ids,json_input(args.request) if args.request else None),ensure_ascii=False,indent=2))
    return 0


def cmd_stages(args) -> int:
    profile = args.profile or slr_paths.resolve_profile()
    config = load_profile(profile)
    print(f"profile: {profile} — {config['summary']}\n")
    visible = [s for s in config['stages'] if getattr(args, 'include_legacy', False) or not s.get('legacy')]
    for index, stage in enumerate(visible, 1):
        flag = " (optional)" if stage.get("optional") else ""
        if stage.get('legacy'):
            flag += ' (compatibility only)'
        steps = len(stage.get("steps", [])) or 1
        print(f"  {index}. {stage['id']:16s} {stage['title']}{flag}")
        print(f"     {steps} command(s), timeout {stage.get('timeout_sec')}s")
        if stage.get("writes"):
            print(f"     writes: {', '.join(stage['writes'][:3])}"
                  + (" …" if len(stage["writes"]) > 3 else ""))
    return 0


def cmd_info(args) -> int:
    profile = args.profile or slr_paths.resolve_profile()
    print(json.dumps({
        "runtime": "codex",
        "skill_home": str(slr_paths.HOME),
        "profile": profile,
        "workspace": str(slr_paths.workspace()),
        "model_config": str(slr_paths.model_config_path(profile)),
        "endpoints": slr_paths.endpoints(),
        "stages": [s["id"] for s in load_profile(profile)["stages"]
                   if getattr(args, 'include_legacy', False) or not s.get('legacy')],
    }, indent=2, ensure_ascii=False))
    return 0


def cmd_doctor(args) -> int:
    command = [sys.executable, str(slr_paths.HOME / "scripts" / "preflight.py")]
    if args.profile:
        command += ["--profile", args.profile]
    if args.no_network:
        command.append("--no-network")
    if args.json:
        command.append("--json")
    if getattr(args,'workspace',None):
        command += ['--workspace',args.workspace]
    return subprocess.call(command)


def cmd_manuscript(args) -> int:
    if args.action == 'generate':
        command = [sys.executable, str(slr_paths.HOME / 'scripts/scripted_generation.py'),
                   'manuscript', '--workspace', str(_resolve_workspace(args))]
        if args.request: command += ['--request', args.request]
        return _exec_main_tool(args, command, 'manuscript_generate')
    command = [sys.executable, str(slr_paths.HOME / "scripts/manuscript.py"),
               args.action, "--workspace", str(_resolve_workspace(args))]
    for name in ("request", "assets", "part"):
        value = getattr(args, name, None)
        if value is not None:
            command += ["--" + name, str(value)]
    return _exec_main_tool(args, command, 'manuscript_' + args.action)


def cmd_workflow(args):
    from workflow import advance
    result = advance(_resolve_workspace(args), args.phase, args.start)
    emit(result, getattr(args, 'full', False))
    return 1 if result['status'] == 'FAILED' else 0


def cmd_writing(args) -> int:
    if args.action.startswith('review-'):
        value=json_input(args.request) if args.request else {}
        if not isinstance(value,dict):raise ValueError('review input must be an object')
        for field in ('packet_id','wait_seconds'):
            supplied=getattr(args,field,None)
            if supplied is not None:
                if field in value and value[field]!=supplied:raise ValueError('conflicting '+field)
                value[field]=supplied
        result=review_timeout.dispatch(_resolve_workspace(args),args.action,value)
        emit(result,getattr(args,'full',False))
        return 0
    if args.action in ('configure','approve'):
        if not args.request:raise ValueError(args.action+' requires --request FILE or -')
        from task_contract import configure
        from operator_cli import approve
        result=(configure if args.action=='configure' else approve)(_resolve_workspace(args),json_input(args.request))
        emit(result,getattr(args,'full',False))
        return 0
    command = [sys.executable, str(slr_paths.HOME / "scripts/writing.py"),
               args.action, "--workspace", str(_resolve_workspace(args))]
    for name in ("request", "concurrency", "repairs"):
        value = getattr(args, name, None)
        if value is not None:
            command += ["--" + name, str(value)]
    if args.only:
        command += ["--only", *args.only]
    for name in ("overwrite", "dry_run"):
        if getattr(args, name, False):
            command.append("--" + name.replace("_", "-"))
    return _exec_tool(command)


def cmd_import_search(args) -> int:
    return subprocess.call([
        sys.executable,
        str(slr_paths.HOME / "scripts/retrieval/import_search_output.py"),
        "--source", str(Path(args.source).resolve()),
        "--workspace", str(_resolve_workspace(args)),
    ])


# --------------------------------------------------------------------- main --

def main() -> int:
    legacy_help = '--legacy-help' in sys.argv[1:]
    ap = argparse.ArgumentParser(prog="slr", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profile", choices=slr_paths.PROFILES)
    ap.add_argument('--legacy-help', action='store_true', help='show compatibility interfaces and exit')
    output = argparse.ArgumentParser(add_help=False)
    output.add_argument('--json', action='store_true',
                        help='request JSON output (already the default for command reports)')
    output.add_argument('--full', action='store_true',
                        help='return complete diagnostic JSON instead of the main view')
    sub = ap.add_subparsers(dest="command", required=not legacy_help,
                           parser_class=partial(argparse.ArgumentParser, parents=[output]))

    workflow = sub.add_parser('workflow', help='advance existing stages to a main-agent decision boundary')
    workflow.add_argument('phase', choices=['evidence', 'publish'])
    workflow.add_argument('--from', dest='start', choices=['retrieval_adapt', 'fulltext', 'processing', 'outline', 'review-packet'])
    workflow.add_argument('--workspace')
    workflow.set_defaults(func=cmd_workflow)

    doctor = sub.add_parser("doctor", help="check the environment")
    doctor.add_argument("--no-network", action="store_true")
    doctor.add_argument("--workspace", help="inspect an existing workspace runtime binding")
    doctor.set_defaults(func=cmd_doctor)

    info = sub.add_parser("info", help="print resolved paths and configuration")
    info.add_argument('--include-legacy', action='store_true')
    info.set_defaults(func=cmd_info)

    stages = sub.add_parser("stages", help="list the stages of a profile")
    stages.add_argument('--include-legacy', action='store_true')
    stages.set_defaults(func=cmd_stages)

    import_search = sub.add_parser("import-search", help="import a completed independent search run")
    import_search.add_argument("--source", required=True, help="AS result directory")
    import_search.add_argument("--workspace")
    import_search.set_defaults(func=cmd_import_search)

    run = sub.add_parser("run", help="run one stage to completion")
    run.add_argument("stage")
    run.add_argument("--workspace")
    run.add_argument("--tail", type=int, default=40,
                     help="lines of log to include when a stage fails")
    run.add_argument("--dry-run", action="store_true")
    run.set_defaults(func=cmd_run)

    resume = sub.add_parser("resume", help="run every stage from one onward")
    resume.add_argument("--from", dest="start", required=True)
    resume.add_argument("--workspace")
    resume.add_argument("--tail", type=int, default=40)
    resume.add_argument("--dry-run", action="store_true")
    resume.set_defaults(func=cmd_resume)

    compile_cmd = sub.add_parser("compile", help="re-run the LaTeX compile phase")
    compile_cmd.add_argument("--emit-fallback", action="store_true",
                             help="materialise the Markdown fallback when the compile fails")
    compile_cmd.add_argument("--workspace")
    compile_cmd.add_argument("--tail", type=int, default=40)
    compile_cmd.set_defaults(func=cmd_compile)

    init = sub.add_parser("init", help="create the workspace and record a precise framework intent")
    init.add_argument("--workspace")
    init.add_argument("--intent",
                      help="framework-supplied precise one-sentence research intent")
    init.add_argument("--language", choices=("auto", "english", "chinese"), default="auto")
    init.set_defaults(func=cmd_init)

    evidence = sub.add_parser('evidence', help='build deterministic outline or writing evidence')
    evidence.add_argument('action', choices=['build'])
    evidence.add_argument('--view', choices=['outline', 'writing'])
    evidence.add_argument('--workspace')
    evidence.add_argument('--request')
    evidence.set_defaults(func=cmd_evidence)

    outline = sub.add_parser("outline", help="render or check the outline")
    outline.add_argument("action", choices=("generate", "configure", "render", "check", "review-packet"))
    outline.add_argument('--request')
    outline.add_argument("--workspace")
    outline.add_argument("--min-figures", type=int, default=None)
    outline.add_argument("--max-figures", type=int, default=None)
    outline.add_argument("--min-tables", type=int, default=None)
    outline.add_argument("--max-tables", type=int, default=None)
    outline.add_argument("--min-papers-per-subsection", type=int, default=None)
    outline.add_argument("--max-papers-per-subsection", type=int, default=None)
    outline.add_argument("--min-papers-per-section", type=int, default=None)
    outline.add_argument(
        "--required-section",
        action="append",
        default=[],
        metavar='"TITLE[@first|@last|@after:OTHER]"',
    )
    outline.set_defaults(func=cmd_outline)

    templates = sub.add_parser("templates", help="query the installed LaTeX templates")
    templates.add_argument("action", nargs="?", default="list",
                           choices=("list", "cite", "check", "resolve"))
    templates.add_argument("name", nargs="?")
    templates.set_defaults(func=cmd_templates)

    citations = sub.add_parser("citations", help="show examples or audit corpus metadata")
    citations.add_argument("action", choices=("examples", "audit"))
    citations.add_argument("--workspace")
    citations.add_argument("--style", choices=style_ids())
    citations.set_defaults(func=cmd_citations)

    figures = sub.add_parser("figures", help="validate and realise a completed figure plan")
    figures.add_argument("action", choices=("plan", "plan-generate", "statistics", "context"))
    figures.add_argument("--request")
    figures.add_argument("--ids",nargs="+")
    figures.add_argument("--workspace")
    figures.add_argument("--concurrency", type=int, default=4)
    figures.set_defaults(func=cmd_figures)

    manuscript = sub.add_parser("manuscript", help="generate native chapters and refine v1 into editable v2; publish current source")
    manuscript.add_argument("action", choices=("generate", "prepare", "publish"),
                            metavar=None if legacy_help else '{generate,prepare,publish}')
    manuscript.add_argument("--workspace")
    manuscript.add_argument("--request")
    manuscript.add_argument("--assets", help="retired: use outline configure" if legacy_help else argparse.SUPPRESS)
    manuscript.add_argument("--part", type=int, help='legacy card part' if legacy_help else argparse.SUPPRESS)
    manuscript.set_defaults(func=cmd_manuscript)

    writing = sub.add_parser("writing", help="configure the task and record actual publication decisions")
    writing.add_argument("action", choices=("configure", "approve", "review-complete", "review-start","review-status","review-wait","review-response","review-timeout",
                                          "corpus", "context", "draft", "produce", "review", "apply"),
                        metavar=None if legacy_help else '{configure,approve,review-start,review-status,review-wait,review-response,review-timeout}')
    writing.add_argument("--workspace")
    writing.add_argument("--request")
    writing.add_argument("--packet-id",help="current review packet ID for review-* operations")
    writing.add_argument("--wait-seconds",type=int,help="review-wait polling duration, 0..30 seconds")
    compatibility_help = 'compatibility authoring option' if legacy_help else argparse.SUPPRESS
    writing.add_argument("--only", nargs="+", help=compatibility_help)
    writing.add_argument("--concurrency", type=int, default=3, help=compatibility_help)
    writing.add_argument("--repairs", type=int, choices=(0, 1), default=1, help=compatibility_help)
    writing.add_argument("--overwrite", action="store_true", help=compatibility_help)
    writing.add_argument("--dry-run", action="store_true", help=compatibility_help)
    writing.set_defaults(func=cmd_writing)

    finalize = sub.add_parser("finalize", help="re-run the finalize phase")
    finalize.add_argument("--workspace")
    finalize.add_argument("--tail", type=int, default=40)
    finalize.set_defaults(func=cmd_finalize)

    status = sub.add_parser('status',help='show compact computed stage readiness')
    status.add_argument('--workspace')
    status.add_argument('--stage',choices=['processing','writing','workflow'],default='processing')
    status.set_defaults(func=cmd_status)
    papers = sub.add_parser('papers',help='inspect papers, import local PDFs or obtain the search budget')
    papers.add_argument('action',choices=['show','import-local','budget'])
    papers.add_argument('--workspace')
    papers.add_argument('--request',help='import-local JSON containing files')
    papers.add_argument('--ids',nargs='+',help='required for show')
    papers.set_defaults(func=cmd_papers)

    for parser in (writing,outline,evidence,figures,papers):
        parser.add_argument('--describe-input',action='store_true',
                            help='print input fields and valid examples without calling models or changing files')
    if not legacy_help:
        hidden = {'resume', 'compile', 'finalize'}
        # Preserve explicit compatibility calls; argparse has no public method
        # to hide a subcommand from default help while retaining its parser.
        sub._choices_actions = [a for a in sub._choices_actions if a.dest not in hidden]
        sub.metavar = '{' + ','.join(k for k in sub.choices if k not in hidden) + '}'
    args = ap.parse_args()
    if args.legacy_help:
        ap.print_help()
        return 0
    try:
        if getattr(args,'describe_input',False):
            from input_contracts import describe_input
            emit(describe_input(args.command+'.'+args.action,_resolve_workspace(args)),True)
            return 0
        return args.func(args)
    except (ValueError, OSError, KeyError, TypeError) as exc:
        from input_contracts import input_error
        emit(input_error(args.command+'.'+getattr(args,'action',''),exc),True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
