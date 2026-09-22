#!/usr/bin/env scholarseed-skill-python
"""
preflight.py — check the environment before a run, and say precisely what is missing.

A survey run costs a lot of wall-clock time and API budget, and its stages fail
far from their cause: an unset API key surfaces as a drafting timeout forty
minutes in, and an unreachable PaperHub surfaces as an empty result set. This
check front-loads every such failure into one readable report.

Checks are grouped by what they block, so a partial environment still yields
useful guidance: a missing LaTeX toolchain only costs you the PDF, while an
unconfigured model gateway blocks everything.

    scholarseed-skill-python scripts/preflight.py [--profile fast] [--json] [--no-network]

Exit status is 0 when nothing REQUIRED is missing; warnings alone do not fail.
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
import slr_paths as _slr_paths
import run_identity
import no_proxy as _no_proxy
# Same bypass the pipeline scripts get from slr_paths.bootstrap(). preflight
# does not call bootstrap(), so it has to opt in explicitly -- otherwise doctor
# would probe under different network rules than the run it is vouching for.
_no_proxy.apply()
# --- end slr path bootstrap ---

import argparse
import importlib.util
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
from urllib.parse import urlparse
from platform_runtime import runtime_info, command_spec, discover_python

MIN_PYTHON = (3, 12)
RECOMMENDED_PYTHON = (3, 12)

# (import name, pip name, required?, what breaks without it)
#
# `requests` and `tqdm` used to be here and are gone: they belonged to the
# boolean-search retrieval stack, which was deleted. Nothing in the tree imports
# either any more, and a required check for an unused dependency teaches an
# operator to install things the run does not need.
PACKAGES = [
    ("openai", "openai", True, "every LLM stage; the gateway speaks the OpenAI protocol"),
    ("httpx", "httpx", True, "HTTP transport for the SDK"),
    ("pypdfium2", "pypdfium2", False,
     "PDF full-text extraction and page rendering. Without it PDF sources degrade "
     "to abstract-only and publication page verification remains incomplete"),
    ("pdfplumber", "pdfplumber", False,
     "layout-aware PDF parsing, including columns, tables and figure exclusion"),
    ("pypdf", "pypdf", False,
     "PDF metadata, encryption and embedded-file handling"),
    ("matplotlib", "matplotlib", False,
     "data_chart rendering requires this package; a missing required chart is a "
     "technical failure, never silently dropped"),
    ("PIL", "Pillow", True,
     "required deterministic vertical cropping and bottom-right watermarking before generated images can be published"),
    ("pysbd", "pysbd", True, "sentence segmentation in the current full-text parser"),
    ("filelock", "filelock", True, "cross-platform workspace operation locks"),
]

# (binary, required?, what breaks without it)
LATEX_BINARIES = [
    ("xelatex", False, "Chinese-language PDF typesetting (the ctexart/xeCJK path)"),
    ("pdflatex", False, "English-language PDF typesetting"),
    ("bibtex", False, "bibliography compilation; without it every citation is [?]"),
    ("kpsewhich", False,
     "scripts/templates.py probes .bst availability with it; without it every "
     "citation style reports as unavailable whether or not it is"),
]


# Not a check, a statement. `pandoc` is deliberately absent from the lists
# above: the Markdown output format is rendered natively by
# scripts/generation/latex_to_markdown.py, so nothing in this pipeline shells
# out to a converter. Its absence is never a degradation.
PANDOC_NOTE = ("pandoc is NOT required — the markdown format is rendered "
               "natively, nothing shells out to a converter")


class Report:
    def __init__(self) -> None:
        self.items: list[dict] = []

    def add(self, group: str, name: str, ok: bool, required: bool,
            detail: str = "", hint: str = "") -> None:
        self.items.append({"group": group, "name": name, "ok": ok,
                           "required": required, "detail": detail, "hint": hint})

    @property
    def blocking(self) -> list[dict]:
        return [i for i in self.items if i["required"] and not i["ok"]]

    @property
    def warnings(self) -> list[dict]:
        return [i for i in self.items if not i["required"] and not i["ok"]]


def check_python(rep: Report, workspace_python=None) -> None:
    v = sys.version_info
    expected = _slr_paths.HOME / '.venv'
    explicit=workspace_python or os.environ.get('SCHOLARSEED_PYTHON')
    bound=(explicit is None or
           bool(explicit and pathlib.Path(explicit).absolute()==pathlib.Path(sys.executable).absolute()))
    rep.add('runtime', 'bound Python 3.12.x', v[:2]==(3,12) and bound, True,
            detail=f'{sys.executable}: {v.major}.{v.minor}.{v.micro}',
            hint='launch from ScholarSeed Desktop or Serve with its product Python')


def check_packages(rep: Report) -> None:
    for module, pip_name, required, why in PACKAGES:
        run = subprocess.run([sys.executable,'-c',f'import {module}'],capture_output=True,text=True,timeout=30)
        rep.add('packages',pip_name,run.returncode==0,required,
                detail='' if run.returncode==0 else run.stderr[-500:], hint=f'install {pip_name} in the bound environment')
    code = "import sys; sys.path[:0] = " + repr([str(_slr_paths.HOME/'lib'),str(_slr_paths.HOME/'scripts'),str(_slr_paths.HOME/'scripts/generation')]) + "; import slr_paths; slr_paths.bootstrap(str(" + repr(str(_slr_paths.HOME/'scripts/slr.py')) + ")); import manuscript, scripted_generation, manuscript_publication, workflow"
    run = subprocess.run([sys.executable,'-c',code],capture_output=True,text=True,timeout=30)
    rep.add('runtime','required pipeline imports',run.returncode==0,True,detail=run.stderr[-800:])


def check_binaries(rep: Report) -> None:
    for binary, required, why in LATEX_BINARIES:
        found = shutil.which(binary) is not None
        rep.add("latex", binary, found, required,
                detail="" if found else why,
                hint="install a TeX distribution (TeX Live / MiKTeX on Windows, MacTeX on macOS); on Debian "
                     "the survey path also needs texlive-lang-chinese and "
                     "texlive-pictures")
    if not any(shutil.which(b) for b in ("xelatex", "pdflatex")):
        rep.add("latex", "any LaTeX engine", False, False,
                detail="no engine found. `output_spec.format: latex_pdf` cannot "
                       "compile here at all — offer the user the markdown format "
                       "at the outline review instead of discovering this at the "
                       "end of generation")

    rep.add("pdf tools", "pandoc", True, False, detail=PANDOC_NOTE)
    resources=['ctexart.cls','xeCJK.sty','fontspec.sty','tabularx.sty','booktabs.sty',
               'forest.sty','natbib.sty','caption.sty','longtable.sty']
    if os.name=='nt':
        resources += ['FandolSong-Regular.otf','FandolHei-Regular.otf',
                      'FandolKai-Regular.otf','FandolFang-Regular.otf']
    for resource in resources:
        found=False
        if shutil.which('kpsewhich'):
            try:
                result=subprocess.run(['kpsewhich',resource],capture_output=True,encoding='utf-8',errors='replace',timeout=10)
                found=result.returncode==0 and bool(result.stdout.strip())
            except (OSError,subprocess.SubprocessError):
                pass
        rep.add('latex resources',resource,found,False,hint='install the missing package in the active TeX distribution')


# Values that are obviously templates rather than real settings. A run that
# starts with one of these fails on the first LLM call, so treat them as
# missing rather than present.
PLACEHOLDER_VALUES = ("", "REPLACE_ME_BASE_URL", "REPLACE_ME", "...", "TODO")


def _is_configured(value: str) -> bool:
    """A field counts as set only once every {placeholder} is substituted."""
    value = value.strip()
    if value in PLACEHOLDER_VALUES:
        return False
    return "{" not in value and "}" not in value


def check_providers(rep: Report, profile: str) -> None:
    """Check text/image credentials and effective provider URLs.

    Text uses ``SCHOLARSEED_ACCOUNT_TOKEN``. Images prefer ``IMAGE_API_KEY`` and
    fall back to ``SCHOLARSEED_ACCOUNT_TOKEN``.
    ``TEXT_BASE_URL`` / ``IMAGE_BASE_URL`` override the corresponding provider
    defaults in the profile; an unset override is therefore not itself a miss.
    """
    from runtime_model_client import runtime_available,RuntimeModelError
    try:has_runtime=runtime_available()
    except RuntimeModelError as exc:
        rep.add('providers','skill_model_client',False,True,detail=str(exc),
                hint='Repair the public runtime client; an incompatible runtime is not a direct-API fallback.')
        return
    if has_runtime:
        rep.add('providers','skill_model_client',True,True,
                detail='Public runtime client available; runtime validates connection and task context on each request. Local text/image API keys are not required.')
        return
    path = _slr_paths.model_config_path(profile)
    if not path.is_file():
        rep.add("providers", f"model_config.{profile}.json", False, True,
                detail=f"missing at {path}")
        return

    config = json.loads(path.read_text())
    providers = config.get("providers", {})
    stages = config.get("stages", {})
    used = {s.get("provider") for s in stages.values() if s.get("provider")}

    required_token = any(
        stage_id != "figures_image" for stage_id in stages
    )
    token = os.environ.get("SCHOLARSEED_ACCOUNT_TOKEN", "")
    rep.add(
        "providers", "SCHOLARSEED_ACCOUNT_TOKEN",
        _is_configured(token), required_token,
        detail="text model stages only",
        hint="export SCHOLARSEED_ACCOUNT_TOKEN before starting Codex",
    )
    if "figures_image" in stages:
        image_specific_token = os.environ.get("IMAGE_API_KEY", "").strip()
        image_token = image_specific_token or token.strip()
        image_source = ("IMAGE_API_KEY" if image_specific_token
                        else "SCHOLARSEED_ACCOUNT_TOKEN fallback")
        rep.add(
            "providers", "image credential",
            _is_configured(image_token), False,
            detail=f"image model stage; source: {image_source}",
            hint="export IMAGE_API_KEY or SCHOLARSEED_ACCOUNT_TOKEN before generating images",
        )

    url_env_by_provider = {
        "qwen": "TEXT_BASE_URL",
        "idealab": "IMAGE_BASE_URL",
    }

    for name in sorted(used):
        provider = providers.get(name)
        mine = {k: v for k, v in stages.items() if v.get("provider") == name}
        provider_required = any(
            stage_id != "figures_image"
            for stage_id in mine
        )
        driven = ", ".join(sorted(mine)) or "no stages"
        if provider is None:
            rep.add("providers", name, False, provider_required,
                    detail=f"stages {driven} reference an undeclared provider",
                    hint=f"add a providers.{name} block to config/model_config.{profile}.json")
            continue
        env_name = url_env_by_provider.get(name)
        env_url = os.environ.get(env_name, "").strip() if env_name else ""
        config_url = str(provider.get("base_url", ""))
        value = env_url or config_url
        source = env_name if env_url else f"providers.{name}.base_url"
        hint = (
            f"set {env_name} or providers.{name}.base_url in "
            f"config/model_config.{profile}.json"
            if env_name else
            f"set providers.{name}.base_url in config/model_config.{profile}.json"
        )
        rep.add("providers", f"{name}.base_url",
                _is_configured(value), provider_required,
                detail=f"source: {source}; drives: {driven}",
                hint=hint)


def check_endpoints(rep: Report, network: bool) -> None:
    # SLR downloads are independent of AS search. Local snapshots and trusted
    # abstracts remain usable without this optional network capability.
    services = _slr_paths.endpoints()
    rep.add('endpoints','SCHOLARSEED_API_KEY',
            _is_configured(os.environ.get('SCHOLARSEED_API_KEY','')), False,
            detail='PaperHub download credential; local PDFs and real abstract fallback do not require it',
            hint='export SCHOLARSEED_API_KEY before PaperHub downloads')
    required_services = {"paper_hub": False}
    for key, required in required_services.items():
        url = services.get(key, "")
        if not url:
            continue
        parsed = urlparse(url)
        host, port = parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)
        if not network:
            rep.add("endpoints", key, True, False, detail=f"{host}:{port} (not probed)")
            continue
        try:
            with socket.create_connection((host, port), timeout=4):
                rep.add("endpoints", key, True, False, detail=f"{host}:{port} reachable")
        except OSError as exc:
            hint = ("SLR full-text downloads may degrade to trusted abstracts; "
                    "AS owns search availability. PAPERHUB_URL overrides downloads.")
            rep.add("endpoints", key, False, required,
                    detail=f"{host}:{port} unreachable ({exc.__class__.__name__})",
                    hint=hint)


def check_layout(rep: Report, profile: str) -> None:
    profile_config = _slr_paths.config_path(f"profiles/{profile}.json")
    rep.add("layout", f"profiles/{profile}.json", profile_config.is_file(), True)
    for rel in (
        "templates/neurips/neurips_2026.sty",
        "unsrtnat_scholarseed.bst",
        "citation-styles/author-year/plainnat.bst",
        "citation-styles/ieee/IEEEtranN.bst",
        "citation-styles/acm/ACM-Reference-Format.bst",
        "citation-styles/manifest.json",
    ):
        rep.add("layout", f"assets/{rel}", _slr_paths.asset_path(rel).is_file(), False)

    if not profile_config.is_file():
        return

    # One row per stage, not one row for all of them. `slr run <stage>` is what
    # an operator types, so "which stage is broken" has to be answerable without
    # reading a semicolon-joined string -- and a per-stage list also makes the
    # count visible, which is how a stage silently dropped from the profile gets
    # noticed.
    stages = [s for s in json.loads(profile_config.read_text()).get("stages", [])
              if not s.get('legacy')]
    for stage in stages:
        commands = stage.get("steps") or [stage.get("command", [])]
        entries, missing = [], []
        for command in commands:
            for token in command:
                if token.startswith("${SLR_HOME}/"):
                    rel = token[len("${SLR_HOME}/"):]
                    entries.append(rel.rsplit("/", 1)[-1])
                    if not (_slr_paths.HOME / rel).exists():
                        missing.append(rel)
        shape = f"{len(commands)} steps" if stage.get("steps") else "1 command"
        optional = stage.get("optional", False)
        detail = f"{shape}: {', '.join(entries) or '(no ${SLR_HOME} entry point)'}"
        if optional:
            detail += "  [optional]"
        rep.add("stages", stage["id"], not missing, not optional,
                detail=detail if not missing else f"missing: {', '.join(missing)}",
                hint="the profile names a script that is not in this skill "
                     "directory — the install is incomplete")
    rep.add("stages", f"{len(stages)} stages declared", bool(stages), True,
            detail="`slr stages` prints them in order")


# Codex role briefs are ordinary skill references. They do not need a separate
# registry; the main agent passes the relevant brief to a context-isolated
# subagent, which reads it directly from the shared filesystem.


EXPECTED_ROLE_BRIEFS = (
    "slr-searcher.md",
    "slr-figure-planner.md",
)


def check_codex_skill(rep: Report) -> None:
    """Check the Codex-native skill metadata and delegated role briefs."""
    skill_file = _slr_paths.HOME / "SKILL.md"
    metadata_file = _slr_paths.HOME / "agents" / "openai.yaml"
    roles_dir = _slr_paths.HOME / "references" / "roles"

    rep.add("codex", "SKILL.md", skill_file.is_file(), True,
            detail="Codex skill entrypoint",
            hint="reinstall the complete skill directory")
    rep.add("codex", "agents/openai.yaml", metadata_file.is_file(), True,
            detail="Codex UI metadata and invocation policy",
            hint="reinstall the complete skill directory")

    for name in EXPECTED_ROLE_BRIEFS:
        path = roles_dir / name
        ok = path.is_file() and bool(path.read_text(encoding="utf-8").strip())
        rep.add("codex roles", name.removesuffix(".md"), ok, True,
                detail=f"references/roles/{name}",
                hint="reinstall the complete skill directory")

    for rel in ('scripts/workflow.py', 'scripts/main_view.py', 'scripts/operator_cli.py',
                'scripts/scripted_generation.py', 'scripts/chapter_pipeline.py',
                'scripts/manuscript.py', 'scripts/manuscript_publication.py'):
        rep.add('runtime entrypoints', rel, (_slr_paths.HOME / rel).is_file(), True,
                hint='reinstall the complete skill directory')


def check_templates(rep: Report) -> None:
    """Check the fixed PDF template and every offered citation-style asset."""
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    try:
        import templates as tpl
    except Exception as exc:                                    # noqa: BLE001
        rep.add("templates", "scripts/templates.py", False, False,
                detail=f"could not be imported ({exc.__class__.__name__}: {exc}); "
                       f"the outline stage has no template registry to offer")
        return

    for row in tpl.list_templates():
        status = row["status"]
        if status == "installed":
            rep.add("templates", row["id"], True, False,
                    detail=f"installed — {row['documentclass']} "
                           f"\\usepackage{{{row['package']}}}")
        else:   # broken: shipped asset is missing
            rep.add("templates", row["id"], False, True,
                    detail=f"BROKEN — {', '.join(row['missing_files'])} is not on "
                           f"disk though the registry claims it is",
                    hint=row["action"])

    for sid in tpl.CITATION_STYLES:
        row = tpl.resolve_citation_style(sid)
        where = row["bst_path"] or "NOWHERE"
        fidelity = "exact" if row["fidelity"] == "exact" else "APPROXIMATE"
        detail = (f"\\bibliographystyle{{{row['bibliography_style']}}} "
                  f"[{row['bst_source']}] {fidelity} — asked for "
                  f"{row['requested']}; {where}")
        rep.add("templates", f"cite:{sid}", row["available"], False,
                detail=detail, hint=row.get("action", ""))


def check_agentic_search_skill(rep: Report) -> None:
    """Check only that the atomic AS skill is discoverable and complete.

    AS owns its API version, tools, endpoint, authentication, and diagnostics.
    SLR deliberately does not inspect or compare those settings.
    """
    candidates: list[pathlib.Path] = []
    override = os.environ.get("AGENTIC_SEARCH_SKILL_DIR", "").strip()
    if override:
        candidates.append(pathlib.Path(override).expanduser())
    candidates.extend([
        _slr_paths.HOME.parent / "agentic-search",
        pathlib.Path.cwd() / ".agents" / "skills" / "agentic-search",
        pathlib.Path.home() / ".agents" / "skills" / "agentic-search",
        pathlib.Path.home() / ".codex" / "skills" / "agentic-search",
    ])

    found = next((p.resolve() for p in candidates
                  if (p / "SKILL.md").is_file()
                  and (p / "tools" / "paperhub.py").is_file()
                  and (p / "tools" / "doctor.py").is_file()), None)
    rep.add(
        "search", "independent agentic-search skill", found is not None, True,
        detail=str(found) if found else
               "agentic-search was not found as a sibling or installed Codex skill",
        hint="install the current agentic-search skill separately; it owns its own config",
    )


def check_audit(rep: Report) -> None:
    """Can this run be attributed afterwards?

    Neither of these blocks anything, and neither degrades the survey. They
    decide whether the finished run can be *audited* — whether a report can say
    which version produced it and point at the transcript that recorded it.
    Both facts are only observable from inside a run, so a missing one is
    unrecoverable the moment the run ends.
    """
    session = run_identity.session_id()
    rep.add("audit", "Codex task id", bool(session), False,
            detail=(f"{session}" if session else
                    "the Codex host did not expose a task identifier; the "
                    "workspace remains attributable by skill fingerprint"),
            hint="optional host metadata; harmless when absent")

    version = run_identity.skill_version(_slr_paths.HOME)
    by = version["skill_identified_by"]
    fp = version["skill_fingerprint"]
    clean = by == "git" and not version["skill_dirty"]
    if clean:
        detail = "%s @ %s" % (version["skill_commit"], version["skill_branch"])
    elif by == "git":
        detail = (f"the skill tree has uncommitted changes, so commit "
                  f"{version['skill_commit']} does not describe what ran — "
                  f"fingerprint {fp} does")
    elif fp:
        # Deliberately not a MISS. A fingerprint answers "was this the same
        # code?", which is what closes a run/audit/improve loop; it just
        # cannot answer "what changed?".
        detail = (f"not a git checkout — attributed by content fingerprint {fp} "
                  f"instead, which identifies the tree but cannot be diffed "
                  f"against another version")
    else:
        detail = ("neither a git checkout nor readable for fingerprinting — a "
                  "run here cannot be attributed to a version at all")
    rep.add("audit", "skill version", clean, False, detail=detail,
            hint="commit before a run you intend to audit; not required, and "
                 "the fingerprint is recorded either way")


def render(rep: Report, profile: str) -> None:
    symbols = {True: "  ok  ", False: " MISS "}
    current = None
    print(f"\nsystematic-literature-review preflight — profile: {profile}")
    print(f"skill home: {_slr_paths.HOME}")
    print(f"workspace : {_slr_paths.workspace()}\n")
    for item in rep.items:
        if item["group"] != current:
            current = item["group"]
            print(f"[{current}]")
        mark = symbols[item["ok"]]
        if not item["ok"]:
            mark = mark if item["required"] else " warn "
        line = f"  {mark} {item['name']}"
        if item["detail"]:
            line += f" — {item['detail']}"
        print(line)
        if not item["ok"] and item["hint"]:
            print(f"           → {item['hint']}")
    print()
    if rep.blocking:
        print(f"BLOCKED: {len(rep.blocking)} required check(s) failed. "
              f"The pipeline will not complete until these are resolved.")
    elif rep.warnings:
        print(f"READY, with {len(rep.warnings)} degraded capability/capabilities "
              f"(see 'warn' rows above).")
    else:
        print("READY.")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", choices=_slr_paths.PROFILES, default=None)
    ap.add_argument("--json", action="store_true", dest="as_json")
    ap.add_argument("--no-network", action="store_true",
                    help="skip endpoint reachability probes")
    ap.add_argument('--workspace',default=os.environ.get('SLR_WORKSPACE'))
    args = ap.parse_args()

    profile = args.profile or _slr_paths.resolve_profile()

    rep = Report()
    environment=runtime_info(_slr_paths.HOME,args.workspace)
    workspace_python=None
    if args.workspace:
        try:
            bound=discover_python(_slr_paths.HOME,workspace=args.workspace)
            binding_path=pathlib.Path(args.workspace)/'.slr-binding.json'
            binding=json.loads(binding_path.read_text(encoding='utf-8'))
            valid=(binding.get('skill')==str(_slr_paths.HOME)
                   and binding.get('version')==(_slr_paths.HOME/'VERSION').read_text().strip()
                   and binding.get('platform',sys.platform)==sys.platform
                   and binding.get('workspace',str(pathlib.Path(args.workspace).resolve()))==str(pathlib.Path(args.workspace).resolve())
                   and pathlib.Path(bound['python']).absolute()==pathlib.Path(sys.executable).absolute())
            rep.add('runtime','workspace binding',valid,True,detail=str(binding_path),
                    hint='restore the bound skill, workspace path and Python')
            if valid:workspace_python=bound['python']
        except (OSError,ValueError,KeyError) as exc:
            rep.add('runtime','workspace binding',False,True,detail=str(exc))
    check_python(rep,workspace_python)
    check_packages(rep)
    check_binaries(rep)
    check_templates(rep)
    check_layout(rep, profile)
    check_codex_skill(rep)
    check_providers(rep, profile)
    check_endpoints(rep, network=not args.no_network)
    check_agentic_search_skill(rep)
    check_audit(rep)
    available=lambda name: any(i['name']==name and i['ok'] for i in rep.items)
    common_pdf=('bibtex','tabularx.sty','booktabs.sty','forest.sty','natbib.sty','caption.sty','longtable.sty')
    chinese_fonts=('FandolSong-Regular.otf','FandolHei-Regular.otf','FandolKai-Regular.otf','FandolFang-Regular.otf') if os.name=='nt' else ()
    capabilities={'markdown':not rep.blocking,
                  'pdf_english':not rep.blocking and all(available(n) for n in ('pdflatex',*common_pdf)),
                  'pdf_chinese':not rep.blocking and all(available(n) for n in ('xelatex','ctexart.cls','xeCJK.sty','fontspec.sty',*common_pdf,*chinese_fonts)),
                  'pdf_render':available('pypdfium2') and available('pypdf'),
                  'search_skill_discoverable':available('independent agentic-search skill')}
    environment['setup']=command_spec([sys.executable,'-X','utf8',str(_slr_paths.HOME/'scripts/setup.py')])

    if args.as_json:
        print(json.dumps({"profile": profile,
                          "ready": not rep.blocking,
                          "runtime":environment,"capabilities":capabilities,
                          "items": rep.items}, indent=2, ensure_ascii=False))
    else:
        print(json.dumps({'runtime':environment,'capabilities':capabilities},ensure_ascii=False,indent=2))
        render(rep, profile)
    return 1 if rep.blocking else 0


if __name__ == "__main__":
    raise SystemExit(main())
