"""Current dependency checks and isolated compatibility discovery, offline."""
import contextlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'scripts'), str(ROOT / 'lib')]
import preflight
import slr
import package_skill
import workspace_entry


class CurrentSurfaceTest(unittest.TestCase):
    def test_init_accepts_explicit_json_without_changing_default_report(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / 'survey'
            report = json.loads(self.cli('init', '--workspace', str(workspace),
                                         '--intent', 'Review scientific agents', '--json'))
            self.assertEqual(report['status'], 'SUCCESS')
            self.assertTrue((workspace / '.slr-binding.json').is_file())
            self.assertTrue((workspace / '01_input/writing_request.json').is_file())

    def test_every_subcommand_accepts_shared_output_options(self):
        commands = ('workflow', 'doctor', 'info', 'stages', 'import-search', 'run',
                    'resume', 'compile', 'init', 'evidence', 'outline', 'templates',
                    'citations', 'figures', 'manuscript', 'writing', 'finalize',
                    'status', 'papers')
        for command in commands:
            with self.subTest(command=command):
                help_text = self.cli(command, '--json', '--full', '--help')
                self.assertIn('--json', help_text)
                self.assertIn('--full', help_text)

    def test_unknown_output_flag_still_fails_without_creating_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / 'survey'
            result = subprocess.run([sys.executable, str(ROOT / 'scripts/slr.py'),
                                     'init', '--workspace', str(workspace), '--unknown-output'],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('unrecognized arguments', result.stderr)
            self.assertFalse(workspace.exists())

    def test_bound_launcher_dispatches_without_bridge_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / 'survey'
            workspace.mkdir()
            binding = {'skill': str(ROOT), 'version': (ROOT / 'VERSION').read_text().strip()}
            (workspace / '.slr-binding.json').write_text(json.dumps(binding))
            with patch('workspace_entry.sys.argv', ['workspace_entry.py', str(workspace), 'info']), \
                 patch('workspace_entry.subprocess.call', return_value=0) as dispatch:
                with self.assertRaises(SystemExit) as result:
                    workspace_entry.main()
                self.assertEqual(result.exception.code, 0)
            dispatch.assert_called_once()

    def cli(self, *args):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/slr.py'), *args],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def test_only_current_roles_are_required_and_missing_current_role_blocks(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            for rel in ('SKILL.md', 'agents/openai.yaml',
                        'references/roles/slr-searcher.md', 'references/roles/slr-figure-planner.md',
                        'scripts/workflow.py', 'scripts/main_view.py', 'scripts/operator_cli.py',
                        'scripts/scripted_generation.py', 'scripts/chapter_pipeline.py',
                        'scripts/manuscript.py', 'scripts/manuscript_publication.py'):
                path = home / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture')
            with patch.object(preflight._slr_paths, 'HOME', home):
                report = preflight.Report()
                preflight.check_codex_skill(report)
                self.assertFalse(report.blocking)
                self.assertEqual({r['name'] for r in report.items if r['group'] == 'codex roles'},
                                 {'slr-searcher', 'slr-figure-planner'})
                (home / 'references/roles/slr-figure-planner.md').unlink()
                report = preflight.Report()
                preflight.check_codex_skill(report)
                self.assertEqual([r['name'] for r in report.blocking], ['slr-figure-planner'])

    def test_doctor_ignores_missing_legacy_stage_but_checks_current_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            profile = home / 'profile.json'
            profile.write_text(json.dumps({'stages': [
                {'id': 'current', 'command': ['scholarseed-skill-python', '${SLR_HOME}/current.py']},
                {'id': 'old', 'legacy': True, 'command': ['scholarseed-skill-python', '${SLR_HOME}/absent.py']}]}))
            (home / 'current.py').write_text('')
            with patch.object(preflight._slr_paths, 'HOME', home), \
                 patch.object(preflight._slr_paths, 'config_path', return_value=profile):
                report = preflight.Report()
                preflight.check_layout(report, 'fast')
                self.assertFalse(report.blocking)
                self.assertNotIn('old', [r['name'] for r in report.items])
                (home / 'current.py').unlink()
                report = preflight.Report()
                preflight.check_layout(report, 'fast')
                self.assertEqual([r['name'] for r in report.blocking], ['current'])

    def test_current_dependencies_do_not_request_old_audit_tools(self):
        report = preflight.Report()
        with patch('preflight.importlib.util.find_spec', return_value=object()), \
             patch('preflight.shutil.which', return_value=None):
            preflight.check_packages(report)
            preflight.check_binaries(report)
        names = {r['name'] for r in report.items}
        self.assertTrue(any('pysbd' in name for name in names))
        self.assertTrue({'pypdfium2', 'pdfplumber', 'pypdf'} <= names)
        self.assertNotIn('pdftoppm', names)
        self.assertFalse({'jieba', 'pdftotext', 'pdfinfo'} & names)

    def test_proxy_transport_probe_uses_bound_python_and_inherited_environment(self):
        report = preflight.Report()
        with patch('preflight.subprocess.run', return_value=SimpleNamespace(returncode=1, stdout='ImportError\n')) as run:
            preflight.check_proxy_transport(report)
        self.assertEqual(run.call_args.args[0][:2], [sys.executable, '-B'])
        self.assertNotIn('env', run.call_args.kwargs)
        self.assertIn('httpx.Client(trust_env=True)', run.call_args.args[0][-1])
        self.assertIn('httpx.AsyncClient(trust_env=True)', run.call_args.args[0][-1])
        self.assertEqual([item['name'] for item in report.blocking], ['bound HTTP proxy transport'])
        self.assertEqual(report.blocking[0]['detail'], 'ImportError')

        with patch('preflight.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='')):
            report = preflight.Report()
            preflight.check_proxy_transport(report)
        self.assertFalse(report.blocking)

        with patch('preflight.subprocess.run', side_effect=subprocess.TimeoutExpired('python', preflight.PROXY_PROBE_TIMEOUT_SECONDS)):
            report = preflight.Report()
            preflight.check_proxy_transport(report)
        self.assertEqual(report.blocking[0]['detail'], 'TimeoutExpired')

    def test_download_outage_is_not_a_blocker_for_local_or_abstract_evidence(self):
        report = preflight.Report()
        with patch.dict('os.environ', {}, clear=True), \
             patch('preflight.socket.create_connection', side_effect=OSError('offline')):
            preflight.check_endpoints(report, network=True)
        self.assertFalse(report.blocking)
        self.assertTrue(report.warnings)

    def test_default_discovery_omits_legacy_but_explicit_discovery_retains_it(self):
        normal = self.cli('--help')
        legacy = self.cli('--legacy-help')
        for name in ('resume', 'finalize'):
            self.assertNotIn(name, normal)
            self.assertIn(name, legacy)
        self.assertNotIn('produce', self.cli('writing', '--help'))
        self.assertIn('produce', self.cli('--legacy-help', 'writing', '--help'))
        self.assertNotIn('read-cards', self.cli('manuscript', '--help'))
        self.assertNotIn('generation_prep', self.cli('stages'))
        self.assertIn('generation_prep', self.cli('stages', '--include-legacy'))
        self.assertNotIn('generation_merge', json.loads(self.cli('info'))['stages'])

    def test_hidden_compatibility_invocation_still_dispatches(self):
        with patch.object(sys, 'argv', ['slr', 'writing', 'produce', '--dry-run']), \
             patch.object(slr, 'cmd_writing', return_value=0) as command:
            self.assertEqual(slr.main(), 0)
        self.assertEqual(command.call_args.args[0].action, 'produce')
        self.assertTrue(command.call_args.args[0].dry_run)

    def test_current_imports_do_not_load_old_verifiers_or_jieba(self):
        program = '''import sys, importlib.abc
from pathlib import Path
root = Path.cwd()
sys.path[:0] = [str(root / 'scripts'), str(root / 'lib')]
class RejectLegacy(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'jieba' or fullname.startswith('verify.postcheck') or fullname.startswith('verify.fast_audit'):
            raise ImportError('obsolete dependency loaded: ' + fullname)
sys.meta_path.insert(0, RejectLegacy())
import slr_paths
slr_paths.bootstrap(str(root / 'scripts/slr.py'))
import manuscript, scripted_generation, manuscript_publication, workflow
'''
        result = subprocess.run([sys.executable, '-c', program], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_doctor_pipeline_smoke_imports_succeed_without_retired_postcheck(self):
        report = preflight.Report()
        with patch.object(preflight, 'PACKAGES', []):
            preflight.check_packages(report)
        self.assertEqual(len(report.items), 1)
        self.assertEqual(report.items[0]['name'], 'required pipeline imports')
        self.assertFalse(report.blocking, report.items)

    def test_runtime_markdown_links_and_package_have_only_active_role_briefs(self):
        paths = [ROOT / 'SKILL.md', ROOT / 'README.md', *(ROOT / 'references').rglob('*.md')]
        for path in paths:
            for target in re.findall(r'\]\(([^)]+)\)', path.read_text()):
                if '://' in target or target.startswith('#'):
                    continue
                self.assertTrue((path.parent / target.split('#')[0]).exists(), (path, target))
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp) / 'skill'
            shutil.copytree(ROOT, stage, ignore=package_skill._ignore)
            package_skill._validate_stage(stage)
            self.assertEqual({p.name for p in (stage / 'references/roles').glob('*.md')},
                             {'slr-searcher.md', 'slr-figure-planner.md'})
            self.assertFalse((stage / 'DESIGN.md').exists())
            self.assertFalse((stage / 'scripts/verify/postcheck.py').exists())


if __name__ == '__main__':
    unittest.main()
