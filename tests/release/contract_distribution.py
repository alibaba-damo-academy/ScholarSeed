"""Build and inspect the three disjoint Python distributions used by ScholarSeed."""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import tomllib
import zipfile
from configparser import ConfigParser
from io import StringIO

PASS, FAIL = 0, 0
DEPENDENCY_PROJECTS = {"runtime": "scholarseed-runtime", "damoatrace": "damoatrace"}
FORBIDDEN_DAMOAGENT_PACKAGES = ("core", "work", "sdk", "bench")
FORBIDDEN_DAMOAGENT_REQUIREMENTS = (
    "anthropic",
    "claude-agent-sdk",
    "openai",
    "docker",
    "opensandbox",
)
REMOVED_ENTERPRISE_AUTH_MODULES = frozenset(
    {
        "service/identity/providers/buc.py",
        "service/identity/service/sso.py",
        "service/identity/service/cli.py",
    }
)
# 开源仓库的产品命令集: launcher 迁为 service.cli.desktop (apps/desktop 不是 Python
# 包, entry point 必须落在 serve 包里); scholarseed-account 属企业控制面, 不在开源仓库。
EXPECTED_PRODUCT_SCRIPTS = {
    "scholarseed": "service.cli.desktop:main",
    "scholarseed-desktop": "service.cli.desktop:main",
    "scholarseed-bridge": "service.cli.bridge:main",
    "scholarseed-serve": "service.cli.serve:serve_main",
    "scholarseed-skill-python": "service.cli.skill_python:main",
}


def check(name: str, condition: bool, detail: str = "") -> None:
    global PASS, FAIL
    if condition:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


def _build(root: pathlib.Path, project: pathlib.Path, output: pathlib.Path) -> pathlib.Path:
    try:
        project_label = project.relative_to(root)
    except ValueError:
        project_label = project.name
    result = subprocess.run(
        [
            sys.executable,
            str(root / "scripts" / "cd" / "wheel.py"),
            "--project",
            str(project),
            "--outdir",
            str(output),
        ],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
    )
    check(
        f"build wheel: {project_label if project != root else '.'}",
        result.returncode == 0,
        (result.stdout + result.stderr)[-2000:],
    )
    wheels = sorted(output.glob("*.whl"), key=lambda path: path.stat().st_mtime_ns)
    if result.returncode or not wheels:
        raise RuntimeError(f"wheel build failed for {project}")
    return wheels[-1]


def _check_stale_harness_exclusion(root: pathlib.Path, temporary: pathlib.Path) -> None:
    """Prove that the release builder cannot reuse a deleted package from build/lib."""
    source = temporary / "stale-source"
    output = temporary / "stale-wheel"
    shutil.copytree(root / "packages" / "runtime", source)
    stale_package = source / "build" / "lib" / "damoagent" / "core"
    stale_package.mkdir(parents=True, exist_ok=True)
    (stale_package / "probe.py").write_text("STALE = True\n", encoding="utf-8")
    output.mkdir()

    wheel = _build(root, source, output)
    members, _, _ = _inspect(wheel)
    check(
        "clean wheel builder rejects stale deleted Harness packages",
        "damoagent/core/probe.py" not in members,
    )


def _inspect(wheel: pathlib.Path) -> tuple[set[str], str, dict[str, str]]:
    with zipfile.ZipFile(wheel) as archive:
        members = set(archive.namelist())
        metadata_name = next(name for name in members if name.endswith(".dist-info/METADATA"))
        metadata = archive.read(metadata_name).decode("utf-8")
        entry_name = next(
            (name for name in members if name.endswith(".dist-info/entry_points.txt")), ""
        )
        entry_text = archive.read(entry_name).decode("utf-8") if entry_name else ""
    parser = ConfigParser()
    parser.read_file(StringIO(entry_text))
    scripts = dict(parser["console_scripts"]) if parser.has_section("console_scripts") else {}
    return members, metadata, scripts


#: 本地安装器（npm workspace scripts）必须具备的特征。
#
# 为何用字符串包含而非真跑 npm 安装入口: 真跑会联网装包、耗时数分钟，且在无网环境下
# 必失败。这里只守「安装路径没被静默改掉」这一不变量。
UV_DISCOVERY = "function uvExecutable"
PIP_INDEX_DISCOVERY = ("pip3", "global.index-url")
UV_SYNC_COMMAND = "'sync',"
UV_INDEX_FORWARDING = "UV_DEFAULT_INDEX"


def _check_install_script(root: pathlib.Path) -> None:
    """本地安装器的不变量。

    开源布局用 `uv sync --all-packages` 走 workspace（uv.lock 为唯一事实源），
    而不是逐包 `uv pip install -e`。镜像源转发必须保留: uv 不读 pip.conf，
    只能访内网镜像的机器上丢了它就会直连 PyPI 超时。
    """

    installer = (root / "scripts" / "shared" / "python.cjs").read_text("utf-8")
    package = (root / "package.json").read_text("utf-8")
    print("── local environment installer ──")
    check("npm installer discovers uv when available", UV_DISCOVERY in installer)
    check(
        "npm installer discovers the configured pip index",
        all(part in installer for part in PIP_INDEX_DISCOVERY),
    )
    check(
        "npm installer syncs the whole uv workspace",
        UV_SYNC_COMMAND in installer and "--all-packages" in installer,
    )
    check(
        "npm installer selects the locked Desktop skill dependencies",
        "DESKTOP_GROUP" in installer and "desktop" in installer,
    )
    check("npm installer forwards the configured index to uv", UV_INDEX_FORWARDING in installer)
    node = shutil.which("node")
    check("Node is available for the ops installer contract", node is not None)
    if node is None:
        return
    result = subprocess.run(
        [
            node,
            "-e",
            "const {resolveCommand}=require(process.argv[1]);"
            "process.stdout.write(JSON.stringify(resolveCommand(['pre','install','python']).steps))",
            str(root / "scripts" / "shared" / "commands.cjs"),
        ],
        cwd=root,
        text=True,
        capture_output=True,
        check=True,
    )
    check(
        "root ops exposes the existing Python installer",
        json.loads(package)["scripts"]["ops"] == "node scripts/ops-cli.cjs"
        and json.loads(result.stdout) == [{"kind": "workspace", "method": "install", "args": []}],
    )


def main() -> int:
    root = pathlib.Path(__file__).resolve().parents[2]
    _check_install_script(root)
    # 开源布局: 产品发行包在 apps/serve, 依赖包在 packages/ 下。根 pyproject 只是
    # uv workspace 编排器, 不再是可安装发行包。
    product_meta = tomllib.loads((root / "apps" / "serve" / "pyproject.toml").read_text("utf-8"))[
        "project"
    ]
    dependency_meta = {
        name: tomllib.loads((root / "packages" / name / "pyproject.toml").read_text("utf-8"))[
            "project"
        ]
        for name in DEPENDENCY_PROJECTS
    }

    print("── distribution metadata ──")
    for name, project in dependency_meta.items():
        check(f"{name} distribution name is stable", project["name"] == DEPENDENCY_PROJECTS[name])
        requirement = f"{DEPENDENCY_PROJECTS[name]}=={project['version']}"
        check(
            f"ScholarSeed pins {name} exactly",
            requirement in product_meta["dependencies"],
            requirement,
        )

    with tempfile.TemporaryDirectory(prefix="scholarseed-distributions-") as temporary:
        temp_root = pathlib.Path(temporary)
        _check_stale_harness_exclusion(root, temp_root)
        # 开源布局: 依赖包在 packages/<name>/, 产品发行包在 apps/serve/。
        wheels = {
            name: _build(root, root / "packages" / name, temp_root / name)
            for name in DEPENDENCY_PROJECTS
            for _ in [(temp_root / name).mkdir()]
        }
        product_out = temp_root / "scholarseed"
        product_out.mkdir()
        wheels["scholarseed"] = _build(root, root / "apps" / "serve", product_out)
        inspected = {name: _inspect(wheel) for name, wheel in wheels.items()}

    agent_members, agent_metadata, agent_scripts = inspected["runtime"]
    trace_members, trace_metadata, trace_scripts = inspected["damoatrace"]
    product_members, _, product_scripts = inspected["scholarseed"]
    check(
        "Community wheel excludes removed enterprise authentication modules",
        not product_members.intersection(REMOVED_ENTERPRISE_AUTH_MODULES),
    )

    print("── wheel ownership ──")
    check(
        "Runtime owns only the scholarseed_runtime namespace",
        not any(
            name.startswith(("damoagent/", "work/", "service/", "ui/", "damoatrace/", "tracekit/"))
            for name in agent_members
        ),
    )
    check(
        "Runtime Python wheel contains no terminal frontend",
        not any("opentui" in name.lower() or "/tui/" in name.lower() for name in agent_members),
    )
    forbidden_prefixes = ("damoagent/",) + tuple(
        f"scholarseed_runtime/{package}/" for package in FORBIDDEN_DAMOAGENT_PACKAGES
    )
    check(
        "Runtime wheel excludes removed self-developed Harness packages",
        not any(name.startswith(forbidden_prefixes) for name in agent_members),
        str(sorted(name for name in agent_members if name.startswith(forbidden_prefixes))[:8]),
    )
    normalized_agent_metadata = agent_metadata.lower()
    check(
        "Runtime contract wheel has no Harness/provider dependencies",
        not any(
            f"requires-dist: {requirement}" in normalized_agent_metadata
            for requirement in FORBIDDEN_DAMOAGENT_REQUIREMENTS
        ),
    )
    check(
        "DamoATrace owns only the damoatrace namespace",
        not any(
            name.startswith(("damoagent/", "work/", "service/", "ui/", "tracekit/"))
            for name in trace_members
        ),
    )
    check(
        "DamoATrace wheel includes its public typing marker",
        "damoatrace/py.typed" in trace_members,
    )
    check(
        "ScholarSeed owns no dependency namespace",
        not any(
            name.startswith(
                (
                    "damoagent/",
                    "damoatrace/",
                    "scholarseed_runtime/",
                    "scholarseed_codex/",
                    "scholarseed_dsh/",
                )
            )
            for name in product_members
        ),
    )
    check(
        "ScholarSeed Python wheel excludes Electron source trees",
        not any(name.startswith("apps/desktop/") for name in product_members),
    )
    owned = {
        name: {member for member in members if ".dist-info/" not in member}
        for name, (members, _, _) in inspected.items()
    }
    overlaps = (owned["runtime"] & owned["damoatrace"]) | (
        owned["scholarseed"] & (owned["runtime"] | owned["damoatrace"])
    )
    check("all distribution file ownership is disjoint", not overlaps, str(sorted(overlaps)[:8]))

    print("── installed command contracts ──")
    check(
        "Runtime contract package exposes no self-developed agent CLI",
        not agent_scripts,
    )
    check("DamoATrace exposes its own CLI", set(trace_scripts) == {"damoatrace"})
    check(
        "ScholarSeed exposes only business product commands",
        product_scripts == EXPECTED_PRODUCT_SCRIPTS,
    )
    check(
        "DamoATrace is independent of runtime and adapter packages",
        not any(
            f"requires-dist: {dependency}" in trace_metadata.lower()
            for dependency in (
                "damoagent",
                "scholarseed-runtime",
                "scholarseed-codex",
                "scholarseed-dsh",
                "scholarseed;",
            )
        ),
    )
    check(
        "runtime wheel exposes its contract and gateway",
        {
            "scholarseed_runtime/contract/event.py",
            "scholarseed_runtime/gateway/catalog.py",
            "scholarseed_runtime/gateway/driver.py",
        }.issubset(agent_members),
    )

    print(f"\nPASS={PASS} FAIL={FAIL}")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
