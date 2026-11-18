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
    def test_init_description_is_compact_mode_aware_and_queryable(self):
        for mode, budget in [('quick', 900), ('standard', 2400)]:
            with self.subTest(mode=mode):
                output = self.cli('init', '--mode', mode, '--describe-input')
                description = json.loads(output)
                self.assertEqual(description['operation'], 'init')
                self.assertEqual(description['defaults']['budget_seconds'], budget)
                self.assertEqual(description['examples'][0]['execution']['mode'], mode)
                self.assertLess(len(output.splitlines()), 100)
                self.assertLess(len(output.encode()), 4000)
                self.assertIn('local_pdfs', description['optional_fields'])
                self.assertNotIn('publication_example', description)
        detail = json.loads(self.cli('init', '--mode', 'quick', '--describe-input',
                                     '--field', 'constraints.values.required_section'))
        self.assertEqual(detail['field'], 'constraints.values.required_section')
        self.assertIn('title', detail['definition'])
        self.assertNotIn('citation_style', detail['definition'])
        detail = json.loads(self.cli('init', '--mode', 'quick', '--describe-input',
                                     '--field', 'publication.format'))
        self.assertEqual(detail['definition'], ['markdown'])

    def test_init_normalizes_the_selected_mode_once_and_keeps_explicit_budget(self):
        cases = [('quick', None, 900, 'whole'), ('standard', None, 2400, 'chapter_delta'),
                 ('quick', 600, 600, 'whole'), ('standard', 1800, 1800, 'chapter_delta')]
        for mode, supplied_budget, expected_budget, strategy in cases:
            with self.subTest(mode=mode, supplied_budget=supplied_budget), tempfile.TemporaryDirectory() as directory:
                workspace = Path(directory)/'review'
                request = Path(directory)/'request.json'
                execution = {'mode': mode}
                if supplied_budget is not None:
                    execution['budget_seconds'] = supplied_budget
                request.write_text(json.dumps({'intent': 'Review the selected papers.',
                    'execution': execution, 'publication': {'format': 'markdown'}}))
                self.cli('init', '--workspace', str(workspace), '--request', str(request), cwd=directory)
                current = json.loads((workspace/'01_input/writing_request.json').read_text())
                self.assertEqual(current['execution']['budget_seconds'], expected_budget)
                self.assertEqual(current['writing_strategy'], strategy)

    def test_plan_resolve_cli_consumes_complete_response_without_retyped_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)/'review'
            slr.configure(workspace, {'intent': 'Review these papers.', 'execution': {'mode': 'quick'},
                          'sources': {'policy': 'provided_only', 'refs': ['literature:one']}})
            plan = slr.planning.packet(workspace)
            response = {'ok': True, 'next_action': 'Consume this unchanged response.',
                        'confirmation': {'packet_id': plan['packet_id'],
                            'snapshot_id': slr.planning.digest(plan['snapshot']),
                            'request_id': 'exact-product-question', 'started_at': 0, 'deadline_at': 300,
                            'decision': {'answers': {'exact-product-question': 'Proceed.'}}}}
            source = Path(directory)/'response.json'
            source.write_text(json.dumps(response))
            result = json.loads(self.cli('writing', 'plan-resolve', '--workspace', str(workspace),
                                         '--request', str(source), '--action', 'proceed'))
            self.assertEqual(result['state'], 'approved')
            self.assertTrue(result['can_continue'])
            slr.planning.require_plan(workspace)
            self.assertEqual(json.loads(source.read_text()), response)
            self.assertEqual(json.loads((workspace/result['source_response']).read_text()), response)

    def test_init_unknown_field_query_is_read_only_and_actionable(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory)/'absent'
            result = subprocess.run([sys.executable, str(ROOT/'scripts/slr.py'), 'init',
                '--workspace', str(workspace), '--describe-input', '--field', 'publication.nonexistent'],
                capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('available here', result.stdout)
            self.assertFalse(workspace.exists())

    def test_runtime_check_does_not_probe_execution_capabilities(self):
        output = io.StringIO()
        with patch('preflight.sys.argv', ['preflight.py', '--scope', 'runtime', '--json']), \
             patch.dict(os.environ, {'SLR_WORKSPACE': '', 'SCHOLARSEED_PYTHON': sys.executable}), \
             patch('preflight.check_packages', side_effect=AssertionError('execution probe')), \
             patch('preflight.check_providers', side_effect=AssertionError('provider probe')), \
             patch('preflight.check_templates', side_effect=AssertionError('template probe')), \
             patch('preflight.check_endpoints', side_effect=AssertionError('network probe')), \
             patch('preflight.check_audit', side_effect=AssertionError('audit probe')), \
             contextlib.redirect_stdout(output):
            result = preflight.main()
        report = json.loads(output.getvalue())
        self.assertEqual(result, 0)
        self.assertEqual(report['scope'], 'runtime')
        self.assertTrue(report['ready'])
        self.assertIsNone(report['pipeline_ready'])
        self.assertEqual(report['capabilities'], {})
        self.assertTrue(all(item['group'] == 'runtime' for item in report['items']))
        self.assertIn('doctor --scope full', report['next_action'])

    def test_runtime_check_retains_interpreter_failure(self):
        output = io.StringIO()
        def reject(report, workspace_python):
            report.add('runtime', 'bound Python', False, True)
        with patch('preflight.sys.argv', ['preflight.py', '--scope', 'runtime', '--json']), \
             patch.dict(os.environ, {'SLR_WORKSPACE': ''}), \
             patch('preflight.check_python', side_effect=reject), \
             contextlib.redirect_stdout(output):
            self.assertEqual(preflight.main(), 1)
        self.assertFalse(json.loads(output.getvalue())['ready'])

    def test_runtime_check_rejects_broken_workspace_binding(self):
        output = io.StringIO()
        with patch('preflight.sys.argv', ['preflight.py', '--scope', 'runtime', '--json',
                                          '--workspace', 'missing-bound-workspace']), \
             patch('preflight.discover_python', side_effect=ValueError('Bound Python is unavailable')), \
             patch('preflight.check_packages', side_effect=AssertionError('execution probe')), \
             contextlib.redirect_stdout(output):
            self.assertEqual(preflight.main(), 1)
        report = json.loads(output.getvalue())
        self.assertFalse(report['ready'])
        self.assertEqual(report['items'][0]['name'], 'workspace binding')
        self.assertIn('Restore', report['next_action'])

    def test_full_check_still_checks_execution_and_reports_blocking_dependencies(self):
        calls = []
        output = io.StringIO()
        checks = ('check_packages', 'check_proxy_transport', 'check_binaries', 'check_templates',
                  'check_layout', 'check_codex_skill', 'check_providers', 'check_endpoints',
                  'check_agentic_search_skill', 'check_audit')
        def observe(name, report, *args, **kwargs):
            calls.append(name)
            if name == 'check_packages':
                report.add('packages', 'required dependency', False, True)
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch('preflight.sys.argv', ['preflight.py', '--json', '--no-network']))
            stack.enter_context(patch.dict(os.environ, {'SLR_WORKSPACE': ''}))
            stack.enter_context(contextlib.redirect_stdout(output))
            for name in checks:
                stack.enter_context(patch('preflight.' + name,
                    side_effect=lambda report, *args, name=name, **kwargs: observe(name, report, *args, **kwargs)))
            self.assertEqual(preflight.main(), 1)
        self.assertEqual(calls, list(checks))
        self.assertFalse(json.loads(output.getvalue())['ready'])

    def test_doctor_runtime_cli_returns_launch_scope_without_creating_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = {**os.environ, 'SLR_WORKSPACE': '', 'SCHOLARSEED_PYTHON': sys.executable}
            result = subprocess.run([sys.executable, str(ROOT/'scripts/slr.py'), 'doctor',
                                     '--scope', 'runtime', '--no-network', '--json'],
                                    cwd=directory, env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report['scope'], 'runtime')
            self.assertEqual(report['runtime']['python'], sys.executable)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_init_reads_original_intent_and_requirements_from_one_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / 'survey'
            request = Path(directory) / 'request.json'
            original = '仅用两篇论文写中文单章，不补检，保留公式，交付Markdown。'
            request.write_text(json.dumps({'intent': original,
                'execution': {'mode': 'quick'}, 'output_scope': 'section',
                'deliverable': {'kind': 'chapter', 'unit': 'chapter'},
                'sources': {'policy': 'provided_only', 'refs': ['literature:one', 'literature:two']},
                'publication': {'format': 'markdown'}}))
            result = subprocess.run([sys.executable, str(ROOT/'scripts/slr.py'), 'init',
                                     '--workspace', str(workspace), '--request', str(request)],
                                    cwd=directory, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            current = json.loads((workspace/'01_input/writing_request.json').read_text())
            self.assertEqual(current['intent'], original)
            self.assertEqual(current['execution']['mode'], 'quick')
            self.assertEqual(current['sources']['refs'], ['literature:one', 'literature:two'])
            self.assertEqual(current['deliverable'], {'kind': 'chapter', 'unit': 'chapter'})
            self.assertEqual(current['language'], 'CHINESE')

    def test_init_describes_shared_request_without_creating_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / 'not-created'
            result = subprocess.run([sys.executable, str(ROOT/'scripts/slr.py'), 'init',
                                     '--workspace', str(workspace), '--describe-input'],
                                    cwd=directory, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            description = json.loads(result.stdout)
            self.assertTrue(description['read_only'])
            self.assertEqual(description['operation'], 'init')
            self.assertIn('deliverable', description['fields'])
            self.assertFalse(workspace.exists())

    def test_invalid_init_request_leaves_no_task_and_corrected_retry_succeeds(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace=Path(directory)/'survey'
            request=Path(directory)/'request.json'
            request.write_text(json.dumps({'deliverable':{'kind':'full_review','unit':'document'}}))
            command=[sys.executable,str(ROOT/'scripts/slr.py'),'init','--workspace',str(workspace),
                     '--intent','Review scientific agents','--mode','quick','--request',str(request)]
            failed=subprocess.run(command,cwd=directory,capture_output=True,text=True)
            self.assertNotEqual(failed.returncode,0)
            self.assertIn('survey',failed.stdout)
            self.assertFalse((workspace/'01_input/writing_request.json').exists())
            self.assertFalse((workspace/'.slr-binding.json').exists())
            request.write_text(json.dumps({'deliverable':{'kind':'survey','unit':'document'},
                                          'sources':{'policy':'provided_only'},
                                          'publication':{'format':'markdown'}}))
            successful=subprocess.run(command,cwd=directory,capture_output=True,text=True)
            self.assertEqual(successful.returncode,0,successful.stdout+successful.stderr)
            current=json.loads((workspace/'01_input/writing_request.json').read_text())
            self.assertEqual(current['execution']['mode'],'quick')
            self.assertEqual(current['sources']['policy'],'provided_only')
            self.assertEqual(current['deliverable'],{'kind':'survey','unit':'document'})
            self.assertTrue((workspace/'.slr-binding.json').is_file())

    def test_init_request_without_intent_is_not_silently_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace=Path(directory)/'survey'
            request=Path(directory)/'request.json'
            request.write_text('{}')
            result=subprocess.run([sys.executable,str(ROOT/'scripts/slr.py'),'init',
                                   '--workspace',str(workspace),'--request',str(request)],
                                  cwd=directory,capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertFalse((workspace/'.slr-binding.json').exists())

    def test_initial_request_cannot_replace_original_intent(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace=Path(directory)/'survey'
            request=Path(directory)/'request.json'
            request.write_text(json.dumps({'intent':'A different task'}))
            result=subprocess.run([sys.executable,str(ROOT/'scripts/slr.py'),'init',
                                   '--workspace',str(workspace),'--intent','Original task',
                                   '--request',str(request)],cwd=directory,capture_output=True,text=True)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('original intent',result.stdout)
            self.assertFalse((workspace/'01_input/writing_request.json').exists())

    def test_init_accepts_explicit_json_without_changing_default_report(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory) / 'survey'
            report = json.loads(self.cli('init', '--workspace', str(workspace),
                                         '--intent', 'Review scientific agents', '--json', cwd=directory))
            self.assertEqual(report['status'], 'SUCCESS')
            self.assertTrue((workspace / '.slr-binding.json').is_file())
            self.assertTrue((workspace / '01_input/writing_request.json').is_file())

    def test_every_subcommand_accepts_shared_output_options(self):
        commands = ('workflow', 'doctor', 'info', 'stages', 'import-search', 'run',
                    'resume', 'compile', 'init', 'evidence', 'outline', 'templates',
                    'citations', 'figures', 'manuscript', 'writing',
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
                                    cwd=directory, capture_output=True, text=True)
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

    def cli(self, *args, cwd=None):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/slr.py'), *args],
                                cwd=cwd, capture_output=True, text=True)
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
