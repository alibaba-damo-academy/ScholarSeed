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
    def test_bound_launcher_activates_the_current_product_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workspace = root / 'survey'
            workspace.mkdir()
            skill = root / 'skills/literature-review'
            bridge = root / 'scholarseed-bridge'
            context = {'SCHOLARSEED_BRIDGE_TOKEN': 'token',
                       'SCHOLARSEED_BRIDGE_SESSION': 'session',
                       'SCHOLARSEED_BRIDGE_SOCKET': 'socket'}
            with patch.dict(os.environ, context), \
                 patch('workspace_entry.Path.cwd', return_value=root), \
                 patch('workspace_entry.shutil.which', return_value=str(bridge)), \
                 patch('workspace_entry.subprocess.run', return_value=SimpleNamespace(returncode=0)) as command:
                workspace_entry._activate(workspace, {'skill': str(skill), 'version': '1.2.0'}, skill, '1.2.0')
            args = command.call_args.args[0]
            self.assertEqual(args[:4], [str(bridge), 'task', 'activate', '--json'])
            payload = json.loads(args[4])
            self.assertEqual(payload['task_type'], 'literature_review')
            self.assertEqual(payload['workspace'], 'survey')
            self.assertTrue(payload['run_id'].startswith('slr-'))

    def test_bound_launcher_activates_before_dispatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / 'survey'
            workspace.mkdir()
            binding = {'skill': str(ROOT), 'version': (ROOT / 'VERSION').read_text().strip()}
            (workspace / '.slr-binding.json').write_text(json.dumps(binding))
            with patch('workspace_entry.sys.argv', ['workspace_entry.py', str(workspace), 'info']), \
                 patch('workspace_entry._activate') as activate, \
                 patch('workspace_entry.os.execv') as dispatch:
                workspace_entry.main()
            activate.assert_called_once_with(workspace.resolve(), binding, ROOT, binding['version'])
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
