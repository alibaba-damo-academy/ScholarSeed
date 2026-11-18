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
import planning
import receipts
from task_contract import configure, json_input, preview_request, publication_view
from task_contract import read_request
from strategy import policy, QUICK
from budget import measure, search_finished, timing
from response import import_outline
from platform_io import run_stream
from platform_runtime import runtime_info, utf8_env, discover_python
from citation_styles import style_ids
from usage import accumulate
from lifecycle import STOPPED_STATUSES, OperationBlocked, operation, read_status
from recovery import code_revision, dependency_key, reusable, receipt
from workspace_binding import bind
from tracker import transition, STATES, PROTOCOLS, FLAT
from preflight import CHECK_SCOPES, FULL_SCOPE
from manuscript_publication import publication_source, deliverable_path
from input_contracts import describe_init
from local_papers import import_pdfs, load_local, budget as material_budget, validate_files
from materials import import_materials

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
    module_paths = [str(directory) for component in ('lib', 'scripts')
                    for directory in slr_paths.module_dirs(component, profile)]
    if env.get("PYTHONPATH"):
        module_paths.append(env["PYTHONPATH"])
    env["PYTHONPATH"] = os.pathsep.join(module_paths)
    env["PATH"] = str(Path(sys.executable).parent) + os.pathsep + env.get("PATH", "")
    return env


def run_command(command: list[str], workspace: Path, log_path: Path,
                env: dict, timeout: int, progress=False) -> tuple[int, str]:
    """Run one command, mirroring its output into the log file."""
    return run_stream(command,workspace,log_path,env,timeout,progress)


# ----------------------------------------------------------------- commands --

def cmd_run(args) -> int:
    if args.stage not in ('generation_publish','verify_postcheck','verify_audit'):
        planning.require_plan(_resolve_workspace(args))
    workspace = Path(args.workspace).resolve() if args.workspace else slr_paths.workspace()
    if args.dry_run or not workspace.is_dir():
        return _cmd_run(args)
    # Validate before using a stage name as a status/lock path.
    find_stage(args.profile or slr_paths.resolve_profile(), args.stage)
    try:
        with operation(workspace, args.stage) as attempt:
            return _cmd_run(args, attempt)
    except OperationBlocked as exc:
        emit(exc.value, getattr(args, 'full', False))
        return 1
    except (KeyboardInterrupt, Exception):
        emit(read_status(workspace, args.stage), getattr(args, 'full', False))
        return 1


def _cmd_run(args, attempt=None) -> int:
    profile = args.profile or slr_paths.resolve_profile()
    workspace = Path(args.workspace).resolve() if args.workspace else slr_paths.workspace()
    stage = find_stage(profile, args.stage)

    if (workspace/'01_input/writing_request.json').exists():
        selected_policy=policy(read_request(workspace))
        if args.stage in selected_policy.get('blocked_stages', ()):
            raise ValueError('Quick does not read or download full text; use processing for abstracts, or recommend Standard.')
        override=selected_policy.get('stage_scripts',{}).get(args.stage)
        if override:
            command=[sys.executable,str(slr_paths.HOME/override[0]),override[1],str(workspace)]
            stage={**stage,'steps':[command], 'status':{'kind':'trailing_json'}}
            stage.pop('progress_file',None)
            outputs=selected_policy.get('stage_outputs',{}).get(args.stage)
            if outputs is not None:
                stage['writes']=list(outputs)

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
    status_path = workspace / '_status' / f'{args.stage}.json'
    previous = attempt.previous if attempt else _read_json_status(status_path)
    if args.stage not in ('generation_publish','verify_postcheck','verify_audit'):
        from task_contract import sync_views
        sync_views(workspace)
    returncode, stdout = 0, ''
    step_results = []
    checkpoints = dict(previous.get('checkpoints', {}))
    policies = stage.get('resume_steps', {})
    revision = code_revision(slr_paths.HOME) if policies else None
    for index, command in enumerate(commands, 1):
        rule = policies.get(str(index))
        key = dependency_key(workspace, rule, command, revision) if rule else None
        payload = reusable(workspace, rule, key, checkpoints.get(rule['id'])) if rule else None
        reused = payload is not None
        if reused:
            returncode, stdout = 0, json.dumps(payload)
        else:
            with measure(workspace):
                returncode, stdout = run_command(command, workspace, log_path, env, timeout)
            payload = extract_trailing_json(stdout) or {}
            if rule and not returncode and payload.get('status') in ('SUCCESS', 'PARTIAL_SUCCESS'):
                if key != dependency_key(workspace, rule, command, revision):
                    returncode = 1
                    payload = {'status': 'FAILED', 'code': 'MATERIAL_INPUTS_CHANGED',
                               'message': 'Inputs changed during this step; completed evidence is preserved.',
                               'next_action': 'Check current inputs before resuming the same stage.'}
                    stdout = json.dumps(payload)
                else:
                    saved = receipt(workspace, rule, key, payload)
                    if saved:
                        checkpoints[rule['id']] = saved
        step_results.append({'step':index,'command':command[1] if len(command)>1 else command[0],
                             'returncode':returncode,'status':payload.get('status','SUCCESS' if returncode==0 else 'FAILED'),
                             'reused': reused, 'detail':payload})
        if attempt:
            attempt.save(steps=step_results, checkpoints=checkpoints)
        if returncode != 0 or payload.get('status') in STOPPED_STATUSES:
            if len(commands) > 1:
                stdout += f"\n[slr] step {index}/{len(commands)} failed"
            break

    status, reason = resolve_status(stage, workspace, stdout, returncode)
    blocking_failure = next((item['detail'] for item in step_results
                             if item['detail'].get('retryable') is False
                             and (item['returncode'] != 0 or item['status'] == 'FAILED')), {})
    readiness_result = {}
    stopped = next((step['status'] for step in step_results if step['status'] in STOPPED_STATUSES), None)
    if stopped:
        status = stopped
    elif returncode != 0 and not (stage.get('optional') and status=='PARTIAL_SUCCESS' and returncode in (2,3)):
        status = 'FAILED'
    elif status not in STOPPED_STATUSES and any(x['status'] not in ('SUCCESS','SKIPPED') for x in step_results):
        status = 'PARTIAL_SUCCESS'
        reason = reason or 'One or more substeps did not complete; inspect steps and downstream readiness.'
    execution_failed = status in STOPPED_STATUSES
    if args.stage == 'processing':
        from paper_materials import readiness
        try:
            readiness_result = readiness(workspace)
        except (ValueError, OSError) as exc:
            if not execution_failed:
                raise
            # A secondary inspection failure must not replace the command's
            # original error. Preserve both diagnoses independently.
            readiness_result = {'status': 'FAILED', 'ready_for_outline': False,
                                'message': str(exc)}
        if not execution_failed and not readiness_result['ready_for_outline'] and not blocking_failure:
            status = readiness_result['status']
            reason = 'Required paper evidence or citation identities are incomplete.'
        if blocking_failure:
            status = 'FAILED'
    writes = stage.get("writes", [])
    spec_path = workspace / "04_outline/output_spec.json"
    if spec_path.exists() and json.loads(spec_path.read_text()).get("format") == "markdown":
        writes = [re.sub(r"full_draft_v([123])\.tex$", r"full_draft_v\1.md", artifact) for artifact in writes]
    if args.stage in ('verify_postcheck','generation_publish'):
        source=publication_source(workspace)
        settings=_read_json_status(source.parent/'publication.json')
        requested=(read_request(workspace).get('publication',{})
                   if (workspace/'01_input/writing_request.json').exists() else {})
        output_format=requested.get('format') or settings.get('format') or ('markdown' if source.suffix=='.md' else 'latex_pdf')
        final=deliverable_path(workspace,source,output_format).relative_to(workspace).as_posix()
        replacements={'06_output/survey.pdf':final,
                      '06_output/survey.md':deliverable_path(workspace,source,'markdown').relative_to(workspace).as_posix()}
        if source.suffix=='.md':
            replacements['06_output/survey.tex']=replacements['06_output/survey.md']
            writes=[artifact for artifact in writes if artifact!='07_verifier/postcheck/pages/']
        writes=list(dict.fromkeys(replacements.get(artifact,artifact) for artifact in writes))
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
        "processing_time": timing(workspace),
    }
    result['steps'] = step_results
    result['checkpoints'] = checkpoints
    for step in step_results:
        if step['detail'].get('task') == 'BIBLIOGRAPHY_PREFLIGHT':
            result['bibliography_preflight'] = step['detail']
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
    if args.stage == 'retrieval_adapt' and status not in STOPPED_STATUSES:
        from workflow import retrieval_summary
        result['retrieval'] = retrieval_summary(workspace)
    readiness_excluded = {'status', 'stage'}
    if execution_failed:
        readiness_excluded.update(('code', 'message', 'status_reason', 'issues', 'next_action'))
    result.update({k:v for k,v in readiness_result.items() if k not in readiness_excluded})
    if readiness_result:
        result['material_readiness'] = readiness_result
    from task_contract import atomic_json
    if compile_result:
        result["compile"] = compile_result
    if status in STOPPED_STATUSES:
        failed_step = next((step for step in step_results
                            if step['returncode'] or step['status'] in STOPPED_STATUSES), {})
        failure = failed_step.get('detail', {})
        result['failed_substep'] = {key: failed_step[key] for key in ('step', 'command', 'returncode') if key in failed_step}
        result.update({key: failure[key] for key in ('code', 'message', 'status_reason', 'issues', 'next_action', 'metadata_repair') if key in failure})
        result.setdefault('code', 'LATEX_COMPILE_ERROR' if reason.startswith('LATEX_COMPILE_ERROR') else 'STAGE_FAILED')
        tail = stdout.splitlines()[-args.tail:] if args.tail else []
        result["log_tail"] = tail
    if args.stage == 'processing' and blocking_failure:
        result.pop('next_action', None)
        for key in ('code', 'message', 'location', 'retryable', 'next_action'):
            if key in blocking_failure:
                result[key] = blocking_failure[key]
    # Retain invocation history in the existing status file across retries.
    if attempt:
        result = attempt.finish(result)
    else:
        result.update(accumulate(previous, result, time.time() - started))
        atomic_json(status_path, result)
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




def cmd_compile(args) -> int:
    from workflow import advance
    result=advance(_resolve_workspace(args),'publish')
    emit(result,getattr(args,'full',False))
    return 1 if result['status']=='FAILED' else 0




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


INIT_LANGUAGE_ALIASES = {'en': 'ENGLISH', 'english': 'ENGLISH', 'zh': 'CHINESE', 'zh-cn': 'CHINESE', 'chinese': 'CHINESE'}


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
    runtime = discover_python(slr_paths.HOME, os.environ.get('SCHOLARSEED_PYTHON'),
                              workspace if (workspace/'.slr-binding.json').exists() else None)
    if Path(runtime['python']).absolute() != Path(sys.executable).absolute():
        raise ValueError('Initialize with the bound product Python returned by doctor --scope runtime.')
    supplied = json_input(args.request) if getattr(args, 'request', None) else None
    if supplied is not None and not isinstance(supplied, dict):
        raise ValueError('init request must be a writing request object')
    original = args.intent if args.intent is not None else (supplied or {}).get('intent', '')
    if not isinstance(original, str):
        raise ValueError('init intent must be the original task text')
    intent = original.strip()
    if args.intent is not None and not intent:
        print("init: --intent must contain a non-empty precise sentence", file=sys.stderr)
        return 2
    if getattr(args,'request',None) and not intent:
        raise ValueError('init requires original intent in --intent or the request; for an existing task use its bound launcher with writing configure')
    initial_request = None
    if intent and not workspace.is_relative_to(Path.cwd()):
        raise ValueError('Initialize from the session working directory with a workspace inside it; use the installed launcher by its full locator without changing into the Skill directory.')
    if intent:
        task_path = workspace / '01_input/writing_request.json'
        if task_path.exists():
            raise ValueError(f'task already exists at {workspace}; restore a missing launcher with init --workspace for this exact directory, '
                             'without --intent or --request; then use the bound launcher with writing configure to update the task')
        current_year = date.today().year
        defaults = {'intent':intent, 'language':_intent_language(intent,args.language),
            'execution': {'mode': getattr(args,'mode','standard')},
            'retrieval': {'temporal_policy': {'constraint':'soft',
                'explicit_range_source':'query_text_if_present',
                'default_if_unspecified':{'label':'recent_five_calendar_years',
                    'start_year':current_year-4,'end_year':current_year},
                'allow_earlier_foundational_work':True}}}
        if supplied is not None and supplied.get('intent', intent) != intent:
            raise ValueError('original intent is immutable; the initial request cannot replace --intent')
        initial = {**defaults, **(supplied or {})}
        for key in ('execution', 'retrieval'):
            if key in (supplied or {}):
                if not isinstance(supplied[key], dict):
                    raise ValueError(key + ' must be an object')
                initial[key] = {**defaults[key], **supplied[key]}
        language = initial.get('language')
        if isinstance(language, str):
            initial['language'] = INIT_LANGUAGE_ALIASES.get(language.casefold(), language)
        deliverable = initial.get('deliverable')
        unit = deliverable.get('unit') if isinstance(deliverable, dict) else None
        if unit and 'output_scope' not in initial:
            initial['output_scope'] = 'survey' if unit == 'document' else 'section'
        if initial.get('local_pdfs'):
            local_files = validate_files(initial['local_pdfs'])
            for item in local_files:
                source = Path(item['path']).expanduser()
                source = (Path.cwd() / source).resolve()
                if not source.exists():
                    raise ValueError('local PDF input does not exist relative to the session working directory: ' + str(source))
                item['path'] = str(source)
            initial['local_pdfs'] = local_files
        initial_request = preview_request(None, initial)
        publication_view(initial_request)

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
    if initial_request is not None:
        configure(workspace, initial_request)
        inputs_written = ['01_input/writing_request.json', '01_input/query.json', '04_outline/output_spec.json']
    local_materials = import_pdfs(workspace) if initial_request and initial_request.get('local_pdfs') else None
    entry = bind(workspace, slr_paths.HOME)
    binding=json.loads((workspace/'.slr-binding.json').read_text(encoding='utf-8'))

    # An existing workspace with artefacts in it is the one thing worth
    # stopping for: `01_input/` … `06_output/` are fixed names, so a second
    # survey run here overwrites the first.
    emit({
        "command": "init",
        "status": "SUCCESS",
        "workspace": str(workspace),
        "created": created, "entrypoint": str(entry), "python": sys.executable,
        "runtime": runtime_info(slr_paths.HOME,workspace),
        "activation_request": {'task_type':'literature_review','skill_name':'literature-review',
                               'skill_version':binding['version'],'skill_path':binding['skill'],
                               'workspace':workspace.relative_to(Path.cwd()).as_posix() if workspace.is_relative_to(Path.cwd()) else None},
        "already_present": existing,
        "inputs_written": inputs_written,
        "local_materials": local_materials,
        "non_empty_before_init": occupied_before,
        "note": ("this workspace already holds artefacts from an earlier run; "
                 "do not start a second survey in it" if occupied_before else
                 "complete request bound; activate the task and obtain its execution agreement before execution"),
    }, getattr(args, 'full', False))
    return 0


def cmd_evidence(args) -> int:
    if not args.view:raise ValueError('evidence build requires --view outline or writing')
    from evidence import build
    result=build(_resolve_workspace(args),args.view,json_input(args.request) if args.request else None)
    emit(result,getattr(args,'full',False))
    return 0


def cmd_outline(args) -> int:
    workspace = _resolve_workspace(args)
    if args.action == 'import':
        emit(import_outline(workspace,json_input(args.request)),getattr(args,'full',False))
        return 0
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


def cmd_progress(args) -> int:
    result=transition(json_input(args.request),args.item_id,args.state,
                      read_request(_resolve_workspace(args)).get('language','CHINESE'),args.complete,
                      protocol=args.protocol,reason=args.reason)
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return 0


def cmd_figures(args) -> int:
    if args.action != 'statistics' and read_request(_resolve_workspace(args)).get('execution',{}).get('mode') == QUICK:
        raise ValueError('Quick does not generate figures; recommend Standard')
    if args.action == 'statistics':
        return _exec_tool([sys.executable,str(slr_paths.HOME/'scripts/generation/figures/_fast/compute_chart_data.py'),'--list','--workspace',str(_resolve_workspace(args))])
    if args.action == 'plan':
        sys.path.insert(0,str(slr_paths.HOME/'scripts'))
        from operator_cli import figure_plan
        if not args.request: raise ValueError('figures plan requires --request FILE or -')
        print(json.dumps(figure_plan(_resolve_workspace(args),json_input(args.request)),ensure_ascii=False))
        return 0
    # Realise the submitted figure plan independently of chapter generation.
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
        value=read_status(ws, args.stage)
        if value.get('status') == 'NOT_STARTED':
            value=readiness(ws)
        else:
            try:
                value['material_readiness']=readiness(ws)
            except (ValueError, OSError) as exc:
                value['material_readiness']={'status':'FAILED','message':str(exc)}
    else:
        path=ws/('_status/workflow.json' if args.stage=='workflow' else '_status/writing.json')
        value=read_status(ws, 'workflow') if args.stage=='workflow' else json.loads(path.read_text()) if path.exists() else {'stage':args.stage,'status':'NOT_STARTED'}
        if args.stage=='writing':
            value['requests']=[json.loads(p.read_text()) for p in (ws/'_status/llm_requests').glob('*.json')]
        value['report'] = str(path)
    emit(value, getattr(args, 'full', False))
    return 0


def cmd_papers(args):
    sys.path.insert(0,str(slr_paths.HOME/'scripts'))
    from operator_cli import papers
    from task_contract import json_input
    workspace = _resolve_workspace(args)
    reference = getattr(args, 'receipt', None)
    if reference and (args.action != 'import-selected' or args.request):
        raise ValueError('--receipt is exclusive with --request and belongs to import-selected')
    value = receipts.read(workspace, reference, receipts.ACTIVATION) if reference else json_input(args.request) if args.request else None
    if args.action == 'import-selected' and isinstance(value, dict) and 'items' in value:
        raise ValueError('legacy per-paper receipt import is retired; preserve existing material snapshots; activate the task and use --receipt for prepared selections')
    print(json.dumps(papers(workspace,args.action,args.ids,value),ensure_ascii=False,indent=2))
    return 0


def cmd_stages(args) -> int:
    profile = args.profile or slr_paths.resolve_profile()
    config = load_profile(profile)
    print(f"profile: {profile} — {config['summary']}\n")
    visible = config['stages']
    for index, stage in enumerate(visible, 1):
        flag = " (optional)" if stage.get("optional") else ""
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
        "stages": [s["id"] for s in load_profile(profile)["stages"]],
    }, indent=2, ensure_ascii=False))
    return 0


def cmd_doctor(args) -> int:
    command = [sys.executable, str(slr_paths.HOME / "scripts" / "preflight.py")]
    command += ['--scope', args.scope]
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
    for name in ("request",):
        value = getattr(args, name, None)
        if value is not None:
            command += ["--" + name, str(value)]
    return _exec_main_tool(args, command, 'manuscript_' + args.action)


def cmd_workflow(args):
    from workflow import advance
    result = advance(_resolve_workspace(args), args.phase, args.start, resume=getattr(args, 'resume', False))
    emit(result, getattr(args, 'full', False))
    return 1 if result['status'] in STOPPED_STATUSES else 0


def cmd_writing(args) -> int:
    reference = getattr(args, 'receipt', None)
    response = None
    if reference:
        operations = {'plan-packet': receipts.ACTIVATION, 'plan-resolve': receipts.PLAN,
                      'review-complete': receipts.OUTLINE, 'approve': receipts.OUTLINE}
        if args.action not in operations or (args.request and args.action != 'approve'):
            raise ValueError('--receipt belongs to plan-packet, plan-resolve, review-complete or approve; only approve accepts publication amendments in --request')
        response = receipts.read(_resolve_workspace(args), reference, operations[args.action])
    if args.action != 'plan-resolve' and (args.plan_action is not None or args.patch is not None):
        raise ValueError('--action and --patch belong to writing plan-resolve')
    if args.action == 'plan-resolve':
        result = planning.resolve(_resolve_workspace(args), response if reference else json_input(args.request), args.plan_action,
                                  json_input(args.patch) if args.patch is not None else None,
                                  source_reference=reference)
        emit(result, getattr(args, 'full', False))
        return 0
    if args.action == 'plan-packet':
        workspace = _resolve_workspace(args)
        preparation = None
        if args.request or reference:
            activation = response if reference else json_input(args.request)
            if not isinstance(activation, dict) or activation.get('ok') is not True:
                raise ValueError('plan-packet requires the unchanged successful task activation response')
            if 'selected_sources' in activation:
                preparation = import_materials(workspace, activation)
            elif read_request(workspace).get('sources', {}).get('refs'):
                raise ValueError('selected-source preparation missing from activation; activate the current task again')
        if (preparation and preparation.get('status') == 'WAITING_MATERIALS'
                and read_request(workspace).get('sources', {}).get('policy') == 'provided_only'
                and not load_local(workspace)):
            emit(preparation, getattr(args, 'full', False))
            return 0
        result = planning.packet(workspace, source_summary=material_budget(workspace))
        if preparation is not None:
            result['materials'] = preparation
        emit(result, getattr(args, 'full', False))
        return 0
    if args.action.startswith('review-'):
        value=response['confirmation'] if reference else json_input(args.request) if args.request else {}
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
        if not args.request and not reference:raise ValueError(args.action+' requires --request FILE or --receipt REF')
        from task_contract import configure
        from operator_cli import approve
        value = receipts.approval(response, json_input(args.request) if args.request else None) if reference else json_input(args.request)
        result=(configure if args.action=='configure' else approve)(_resolve_workspace(args),value)
        emit(result,getattr(args,'full',False))
        return 0
    raise ValueError('Unsupported writing management action: '+args.action)


def cmd_import_search(args) -> int:
    planning.require_plan(_resolve_workspace(args))
    search_finished(_resolve_workspace(args))
    return subprocess.call([
        sys.executable,
        str(slr_paths.HOME / "scripts/retrieval/import_search_output.py"),
        "--source", str(Path(args.source).resolve()),
        "--workspace", str(_resolve_workspace(args)),
    ])


# --------------------------------------------------------------------- main --

def main() -> int:
    ap = argparse.ArgumentParser(prog="slr", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--profile", choices=slr_paths.PROFILES)
    output = argparse.ArgumentParser(add_help=False)
    output.add_argument('--json', action='store_true',
                        help='request JSON output (already the default for command reports)')
    output.add_argument('--full', action='store_true',
                        help='return complete diagnostic JSON instead of the main view')
    sub = ap.add_subparsers(dest="command", required=True,
                           parser_class=partial(argparse.ArgumentParser, parents=[output]))

    workflow = sub.add_parser('workflow', help='advance existing stages to a main-agent decision boundary')
    workflow.add_argument('phase', choices=['evidence', 'publish'])
    workflow_entry = workflow.add_mutually_exclusive_group()
    workflow_entry.add_argument('--from', dest='start', choices=['retrieval_adapt', 'fulltext', 'processing', 'outline', 'review-packet'])
    workflow_entry.add_argument('--resume', action='store_true', help='resume the recorded evidence boundary under the existing execution lock')
    workflow.add_argument('--workspace')
    workflow.set_defaults(func=cmd_workflow)

    doctor = sub.add_parser("doctor", help="check the environment")
    doctor.add_argument("--no-network", action="store_true")
    doctor.add_argument("--workspace", help="inspect an existing workspace runtime binding")
    doctor.add_argument('--scope', choices=CHECK_SCOPES, default=FULL_SCOPE,
                        help='runtime launch identity before agreement; full execution checks after approval')
    doctor.set_defaults(func=cmd_doctor)

    info = sub.add_parser("info", help="print resolved paths and configuration")
    info.set_defaults(func=cmd_info)

    stages = sub.add_parser("stages", help="list the stages of a profile")
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
    init.add_argument('--mode',choices=('quick','standard'),default='standard')
    init.add_argument('--request',help='complete initial writing request JSON, including original intent unless --intent supplies it')
    init.add_argument('--field',help='exact input field path for --describe-input, e.g. constraints.values.required_section')
    init.set_defaults(func=cmd_init,input_operation='init')

    evidence = sub.add_parser('evidence', help='build deterministic outline or writing evidence')
    evidence.add_argument('action', choices=['build'])
    evidence.add_argument('--view', choices=['outline', 'writing'])
    evidence.add_argument('--workspace')
    evidence.add_argument('--request')
    evidence.set_defaults(func=cmd_evidence)

    outline = sub.add_parser("outline", help="render or check the outline")
    outline.add_argument("action", choices=("generate", "configure", "import", "render", "check", "review-packet"))
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
    figures.add_argument("action", choices=("plan", "plan-generate", "statistics"))
    figures.add_argument("--request")
    figures.add_argument("--workspace")
    figures.add_argument("--concurrency", type=int, default=4)
    figures.set_defaults(func=cmd_figures)

    manuscript = sub.add_parser("manuscript", help="generate native chapters and refine v1 into editable v2; publish current source")
    manuscript.add_argument("action", choices=("generate", "prepare", "publish"))
    manuscript.add_argument("--workspace")
    manuscript.add_argument("--request")
    manuscript.set_defaults(func=cmd_manuscript)

    writing = sub.add_parser("writing", help="configure the task and record actual publication decisions")
    writing.add_argument("action", choices=("configure", "approve", "plan-packet", "plan-resolve", "review-complete", "review-start","review-status","review-wait","review-response","review-timeout"))
    writing.add_argument("--workspace")
    writing.add_argument("--request")
    writing.add_argument('--receipt', help='product receipt_ref; read the original response without copying JSON')
    writing.add_argument('--action', dest='plan_action', choices=tuple(planning.DECISIONS),
                         help='plan-resolve interpretation of an actual reply; omit for product timeout/cancellation')
    writing.add_argument('--patch', help='plan-resolve requested amendments JSON; preserve actual user follow-up history')
    writing.add_argument("--packet-id",help="current review packet ID for review-* operations")
    writing.add_argument("--wait-seconds",type=int,help="review-wait polling duration, 0..30 seconds")
    writing.set_defaults(func=cmd_writing)

    status = sub.add_parser('status',help='show compact computed stage readiness')
    status.add_argument('--workspace')
    status.add_argument('--stage',choices=['processing','writing','workflow'],default='processing')
    status.set_defaults(func=cmd_status)
    papers = sub.add_parser('papers',help='inspect papers, import local PDFs or obtain the search budget')
    papers.add_argument('action',choices=['show','import-local','import-selected','budget','retry-extraction'])
    papers.add_argument('--workspace')
    papers.add_argument('--request',help='import-local JSON containing files')
    papers.add_argument('--receipt',help='import-selected product activation receipt_ref')
    papers.add_argument('--ids',nargs='+',help='required for show and retry-extraction')
    papers.set_defaults(func=cmd_papers)

    progress = sub.add_parser('progress',help='build one host plan mutation from the unchanged current plan/get response')
    progress.add_argument('--workspace')
    progress.add_argument('--request')
    progress.add_argument('--item-id')
    progress.add_argument('--state',choices=STATES)
    progress.add_argument('--protocol',choices=PROTOCOLS,default=FLAT,help='match the actually declared tool schema')
    progress.add_argument('--reason',help='observed reason for a pause, block, failure or partial result')
    progress.add_argument('--complete',help='flat: finish this leaf only, then read get and start the next; legacy: combine boundary')
    progress.set_defaults(func=cmd_progress,input_operation='progress')

    for parser in (init,writing,outline,evidence,figures,papers,progress):
        parser.add_argument('--describe-input',action='store_true',
                            help='print input fields and valid examples without calling models or changing files')
    hidden = {'resume', 'compile', 'progress'}
    sub._choices_actions = [action for action in sub._choices_actions if action.dest not in hidden]
    sub.metavar = '{' + ','.join(key for key in sub.choices if key not in hidden) + '}'
    args = ap.parse_args()
    try:
        if getattr(args,'describe_input',False):
            if args.command == 'init':
                emit(describe_init(args.mode, args.field), True)
                return 0
            from input_contracts import describe_input
            operation=getattr(args,'input_operation',args.command+'.'+getattr(args,'action',''))
            emit(describe_input(operation,_resolve_workspace(args)),True)
            return 0
        if args.command == 'init' and args.field:
            raise ValueError('--field is a read-only selector; use it with --describe-input')
        return args.func(args)
    except OperationBlocked as exc:
        emit(exc.value, True)
        return 1
    except (ValueError, OSError, KeyError, TypeError) as exc:
        from input_contracts import input_error
        emit(input_error(args.command+'.'+getattr(args,'action',''),exc),True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
