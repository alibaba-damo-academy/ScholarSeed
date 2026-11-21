"""Real CLI, pipe, lock and process-tree behavior on every supported OS."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import venv
from types import SimpleNamespace
from unittest.mock import patch
import runpy

ROOT=Path(os.environ.get('TEST_SKILL_ROOT', Path(__file__).resolve().parents[1])).resolve()
sys.path[:0]=[str(ROOT/'lib'),str(ROOT/'scripts')]
from platform_runtime import command_spec, discover_python, runtime_info, utf8_env, venv_python
from platform_io import file_lock, run_stream
from workspace_binding import bind
import platform_runtime
import preflight


class InterpreterPolicyTest(unittest.TestCase):
    def test_plugin_identity_matches_the_skill_version(self):
        descriptor = json.loads((ROOT / '.scholarseed-plugin.json').read_text(encoding='utf-8'))
        self.assertEqual(descriptor['version'], (ROOT / 'VERSION').read_text().strip())

    @unittest.skipIf(os.name == 'nt', 'POSIX setup wrapper contract')
    def test_setup_wrapper_forwards_to_the_reviewed_launcher(self):
        with tempfile.TemporaryDirectory(prefix='slr setup ') as directory:
            temporary = Path(directory)
            launcher = temporary / 'scholarseed-skill-python'
            arguments = temporary / 'arguments.txt'
            launcher.write_text('#!/bin/sh\nprintf \'%s\\n\' "$@" > "$TEST_SETUP_ARGUMENTS"\nexit 23\n',
                                encoding='utf-8')
            launcher.chmod(0o755)
            environment = {**os.environ, 'PATH': str(temporary) + os.pathsep + os.environ['PATH'],
                           'TEST_SETUP_ARGUMENTS': str(arguments)}
            result = subprocess.run(['bash', str(ROOT / 'scripts/setup'), '--no-network'],
                                    env=environment, capture_output=True, text=True)
            self.assertEqual(result.returncode, 23)
            self.assertEqual(arguments.read_text().splitlines(),
                             [str(ROOT / 'scripts/bootstrap.py'), 'setup', '--no-network'])

    def test_child_environment_disables_bytecode_in_the_frozen_pack(self):
        self.assertEqual(utf8_env({}).get('PYTHONDONTWRITEBYTECODE'), '1')

    def test_windows_reported_cli_survives_a_fresh_task_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            workspace = Path(directory).resolve()
            with patch.object(platform_runtime, 'os', SimpleNamespace(name='nt', environ={})):
                installed = runtime_info(ROOT)
                bound = runtime_info(ROOT, workspace)
            self.assertEqual(installed['cli']['argv'], [str(ROOT / 'scripts/slr.cmd')])
            self.assertEqual(bound['cli']['argv'], [str(workspace / 'slr.cmd')])
            self.assertEqual(bound['python'], sys.executable)

    def test_probe_accepts_supported_python_and_rejects_other_versions(self):
        for version, accepted in [([3, 12, 13], True), ([3, 13, 0], True),
                                  ([3, 14, 10], True), ([3, 15, 0], True),
                                  ([3, 11, 9], False), ([4, 0, 0], False),
                                  ([], False), ([3], False), (["3", 14], False)]:
            with self.subTest(version=version):
                result = subprocess.CompletedProcess([], 0, json.dumps({
                    'python': sys.executable, 'version': version, 'prefix': sys.prefix}))
                with patch('platform_runtime.subprocess.run', return_value=result):
                    self.assertEqual(platform_runtime.probe_python([sys.executable]) is not None,
                                     accepted)

    def test_active_supported_interpreter_is_discovered(self):
        info = discover_python(ROOT, explicit=sys.executable)
        self.assertEqual(Path(info['python']).resolve(), Path(sys.executable).resolve())
        self.assertEqual(info['version'], list(sys.version_info[:3]))

    def test_conflicting_binding_remains_unchanged(self):
        with tempfile.TemporaryDirectory(prefix='slr binding ') as directory:
            workspace = Path(directory)
            bind(workspace, ROOT)
            binding = workspace / '.slr-binding.json'
            original = binding.read_bytes()
            with self.assertRaisesRegex(ValueError, 'conflicts'):
                discover_python(ROOT, explicit=str(workspace / 'other-python'), workspace=workspace)
            self.assertEqual(binding.read_bytes(), original)

    @unittest.skipIf(os.name == 'nt', 'POSIX virtual environments use symlinked Python entries')
    def test_different_virtual_environment_entries_keep_binding_immutable(self):
        with tempfile.TemporaryDirectory(prefix='slr environments ') as directory:
            folder = Path(directory)
            entries = []
            for name in ('first', 'second'):
                environment = folder / name
                venv.EnvBuilder(with_pip=False, symlinks=True).create(environment / '.venv')
                entries.append(venv_python(environment))
            first, second = entries
            self.assertNotEqual(first.absolute(), second.absolute())
            self.assertEqual(first.resolve(), second.resolve())
            self.assertTrue(platform_runtime.same_interpreter(
                first, second, mode=platform_runtime.INTERPRETER_RESOLVED))
            self.assertFalse(platform_runtime.same_interpreter(
                first, second, mode=platform_runtime.INTERPRETER_ABSOLUTE))
            self.assertFalse(platform_runtime.same_interpreter(
                str(first), str(second), mode=platform_runtime.INTERPRETER_LITERAL))
            workspace = folder / 'workspace'
            workspace.mkdir()
            with patch.object(sys, 'executable', str(first)):
                bind(workspace, ROOT)
            binding = workspace / '.slr-binding.json'
            before = binding.read_bytes()
            with self.subTest(boundary='explicit discovery'):
                with self.assertRaisesRegex(ValueError, 'conflicts'):
                    discover_python(ROOT, explicit=str(second), workspace=workspace)
            self.assertEqual(binding.read_bytes(), before)
            with self.subTest(boundary='binding reentry'), patch.object(sys, 'executable', str(second)):
                with self.assertRaisesRegex(ValueError, 'binding changed'):
                    bind(workspace, ROOT)
            self.assertEqual(binding.read_bytes(), before)

    def test_preflight_accepts_active_supported_runtime(self):
        report = preflight.Report()
        preflight.check_python(report)
        self.assertFalse(report.blocking)
        conflicting = preflight.Report()
        preflight.check_python(conflicting, str(ROOT / 'missing-python'))
        self.assertTrue(conflicting.blocking)

    def test_setup_uses_the_shared_policy_before_running_checks(self):
        entry = runpy.run_path(str(ROOT / 'scripts/setup.py'))['main']
        for version, accepted in [((3, 12, 13), True), ((3, 14, 10), True),
                                  ((3, 11, 9), False), ((4, 0, 0), False)]:
            with self.subTest(version=version):
                selected = SimpleNamespace(version_info=version, executable=sys.executable)
                with (patch.dict(entry.__globals__, {'sys': selected}),
                      patch('subprocess.run') as check,
                      patch('subprocess.call', return_value=0) as doctor):
                    if accepted:
                        self.assertEqual(entry(), 0)
                        check.assert_called_once()
                        doctor.assert_called_once()
                    else:
                        with self.assertRaisesRegex(SystemExit, 'required'):
                            entry()
                        check.assert_not_called()
                        doctor.assert_not_called()

    def test_stale_workspace_bindings_are_rejected_without_rewriting(self):
        for field, value in [('version', 'old-skill-version'), ('platform', 'other-os'),
                             ('workspace', 'moved-workspace'), ('python', 'missing-python')]:
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                workspace = Path(directory)
                bind(workspace, ROOT)
                binding = workspace / '.slr-binding.json'
                data = json.loads(binding.read_text(encoding='utf-8'))
                data[field] = value
                binding.write_text(json.dumps(data), encoding='utf-8')
                original = binding.read_bytes()
                result = subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/workspace_entry.py'),
                                         str(workspace), 'info'], capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(binding.read_bytes(), original)


@unittest.skipUnless(os.name == 'nt', 'Windows interpreter namespace semantics')
class WindowsInterpreterNamespaceTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='slr namespace ')
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name).resolve()
        executable = str(Path(sys.executable).resolve(strict=True))
        if executable.startswith('\\\\?\\UNC\\'):
            ordinary = '\\\\' + executable[8:]
        else:
            ordinary = executable.removeprefix('\\\\?\\')
        extended = ('\\\\?\\UNC\\' + ordinary[2:] if ordinary.startswith('\\\\')
                    else '\\\\?\\' + ordinary)
        self.spellings = ((extended, ordinary), (ordinary, extended))
        self.assertTrue(os.path.samefile(ordinary, extended))

    def workspace(self, index, python):
        workspace = self.folder / str(index)
        workspace.mkdir()
        with patch.object(sys, 'executable', python):
            bind(workspace, ROOT)
        return workspace

    def test_bootstrap_accepts_both_spellings_with_a_real_interpreter_probe(self):
        script = ROOT / 'scripts/bootstrap.py'
        entry = runpy.run_path(str(script))['main']
        for active, selected in self.spellings:
            with self.subTest(active=active), \
                 patch.object(sys, 'executable', active), \
                 patch.object(sys, 'argv', [str(script), 'init', '--describe-input', '--field', 'sources']), \
                 patch.dict(os.environ, {'SCHOLARSEED_PYTHON': selected}), \
                 patch('subprocess.call', return_value=0) as dispatch:
                # Keep real Win32 resolution and the real Python probe; only the
                # already-admitted CLI dispatch is outside this identity test.
                self.assertEqual(entry(), 0)
                self.assertEqual(dispatch.call_args.args[0][-4:],
                                 ['init', '--describe-input', '--field', 'sources'])

    def test_discovery_accepts_equivalent_explicit_binding_without_rewriting(self):
        for index, (active, bound) in enumerate(self.spellings):
            workspace = self.workspace(index, bound)
            binding = workspace / '.slr-binding.json'
            before = binding.read_bytes()
            with self.subTest(active=active), patch.object(sys, 'executable', active):
                info = discover_python(ROOT, explicit=active, workspace=workspace)
                self.assertTrue(os.path.samefile(info['python'], active))
                self.assertEqual(binding.read_bytes(), before)

    def test_workspace_entry_accepts_equivalent_interpreter_without_rewriting(self):
        script = ROOT / 'scripts/workspace_entry.py'
        entry = runpy.run_path(str(script))['main']
        for index, (active, bound) in enumerate(self.spellings):
            workspace = self.workspace(index, bound)
            binding = workspace / '.slr-binding.json'
            before = binding.read_bytes()
            with self.subTest(active=active), \
                 patch.object(sys, 'executable', active), \
                 patch.object(sys, 'argv', [str(script), str(workspace), 'info']), \
                 patch.dict(os.environ, {'SLR_WORKSPACE': ''}), \
                 patch('subprocess.call', return_value=0) as dispatch:
                with self.assertRaises(SystemExit) as exited:
                    entry()
                self.assertEqual(exited.exception.code, 0)
                dispatch.assert_called_once()
                self.assertEqual(binding.read_bytes(), before)

    def test_binding_reentry_preserves_bytes_for_equivalent_interpreter(self):
        for index, (active, bound) in enumerate(self.spellings):
            workspace = self.workspace(index, bound)
            binding = workspace / '.slr-binding.json'
            before = binding.read_bytes()
            with self.subTest(active=active), patch.object(sys, 'executable', active):
                self.assertEqual(bind(workspace, ROOT), workspace / 'slr.cmd')
                self.assertEqual(binding.read_bytes(), before)

    def test_doctor_accepts_equivalent_explicit_interpreter(self):
        for active, selected in self.spellings:
            report = preflight.Report()
            with self.subTest(active=active), \
                 patch.object(sys, 'executable', active), \
                 patch.dict(os.environ, {'SCHOLARSEED_PYTHON': selected}):
                preflight.check_python(report)
                self.assertFalse(report.blocking)

    def test_bootstrap_rejects_a_different_directory_even_for_a_hardlink(self):
        script = ROOT / 'scripts/bootstrap.py'
        entry = runpy.run_path(str(script))['main']
        original = self.folder / 'original' / 'python.exe'
        original.parent.mkdir()
        original.write_bytes(b'interpreter identity fixture')
        linked = self.folder / 'other' / 'python.exe'
        linked.parent.mkdir()
        os.link(original, linked)
        self.assertTrue(os.path.samefile(original, linked))
        selected = {'python': str(linked), 'version': list(sys.version_info[:3])}
        output = io.StringIO()
        with patch.object(sys, 'executable', str(original)), \
             patch.object(sys, 'argv', [str(script), 'init', '--describe-input']), \
             patch.dict(entry.__globals__, {'discover_python': lambda *args: selected}), \
             patch('subprocess.call') as dispatch, contextlib.redirect_stdout(output):
            self.assertEqual(entry(), 1)
        dispatch.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())['code'], 'RUNTIME_UNAVAILABLE')


class PlatformRuntimeTest(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory(prefix='slr 平台 空格 ')
        self.addCleanup(folder.cleanup)
        self.ws=Path(folder.name).resolve()
        self.env=utf8_env()
        self.env['SCHOLARSEED_PYTHON']=sys.executable

    def cli(self,*args):
        return subprocess.run([sys.executable,'-X','utf8',str(ROOT/'scripts/bootstrap.py'),*args],
                              cwd=self.ws,env=self.env,capture_output=True,encoding='utf-8',timeout=60)

    def test_bootstrap_init_and_bound_cli_from_another_directory(self):
        run=self.cli('init','--workspace',str(self.ws/'研究 & 主题'),'--intent','比较方法与条件')
        self.assertEqual(run.returncode,0,run.stdout+run.stderr)
        result=json.loads(run.stdout)
        binding=json.loads((Path(result['workspace'])/'.slr-binding.json').read_text(encoding='utf-8'))
        self.assertEqual(binding['schema_version'],2)
        self.assertEqual(binding['python'],sys.executable)
        invocation_environment=dict(self.env)
        if os.name=='nt':
            invocation_environment.update(PYTHONPATH='',PYTHONHOME='')
        argv=result['runtime']['cli']['argv']
        info=subprocess.run([*argv,'info'],cwd=self.ws,env=invocation_environment,capture_output=True,encoding='utf-8')
        self.assertEqual(info.returncode,0,info.stderr)
        self.assertEqual(json.loads(info.stdout)['workspace'],result['workspace'])
        conflict=subprocess.run([*argv,'status','--workspace',str(self.ws)],env=invocation_environment,capture_output=True)
        self.assertNotEqual(conflict.returncode,0)
        wrapper=subprocess.run([result['entrypoint'],'info'],cwd=self.ws,env=invocation_environment,
                               capture_output=True,encoding='utf-8')
        self.assertEqual(wrapper.returncode,0,wrapper.stdout+wrapper.stderr)
        self.assertEqual(json.loads(wrapper.stdout)['workspace'],result['workspace'])

    def test_doctor_reports_actual_runtime_and_capabilities(self):
        run=self.cli('doctor','--no-network','--json')
        value=json.loads(run.stdout)
        self.assertIn(run.returncode,(0,1),run.stderr)
        self.assertEqual(value['runtime']['python'],sys.executable)
        self.assertIn('pdf_chinese',value['capabilities'])
        self.assertIn('argv',value['runtime']['cli'])
        self.assertFalse((self.ws/'.slr-binding.json').exists())

    def test_doctor_starts_without_installed_skill_packages(self):
        empty=self.ws/'empty'
        venv.EnvBuilder(with_pip=False).create(empty)
        python=empty/('Scripts/python.exe' if os.name=='nt' else 'bin/python')
        env={**self.env,'SCHOLARSEED_PYTHON':str(python)}
        result=subprocess.run([str(python),'-X','utf8',str(ROOT/'scripts/bootstrap.py'),
                               'doctor','--no-network','--json'],env=env,
                              capture_output=True,encoding='utf-8',timeout=60)
        report=json.loads(result.stdout)
        self.assertEqual(result.returncode,1,result.stderr)
        self.assertFalse(report['ready'])
        self.assertTrue(any(i['group']=='packages' and not i['ok'] for i in report['items']))
        self.assertEqual(report['runtime']['setup']['argv'][0],str(python))

    def test_bound_doctor_does_not_need_selection_environment_variable(self):
        bind(self.ws,ROOT)
        env=dict(self.env);env.pop('SCHOLARSEED_PYTHON',None)
        result=subprocess.run([sys.executable,'-X','utf8',str(ROOT/'scripts/workspace_entry.py'),
                              str(self.ws),'doctor','--workspace',str(self.ws),'--no-network','--json'],
                              env=env,capture_output=True,encoding='utf-8')
        report=json.loads(result.stdout)
        self.assertTrue(next(i['ok'] for i in report['items'] if i['name']=='workspace binding'))
        self.assertTrue(next(i['ok'] for i in report['items'] if i['name']=='bound product Python'))

    def test_broken_binding_does_not_fall_back_to_system_python(self):
        bind(self.ws,ROOT)
        path=self.ws/'.slr-binding.json'
        value=json.loads(path.read_text(encoding='utf-8'))
        value['python']=str(self.ws/'absent-python')
        path.write_text(json.dumps(value),encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'Bound Python'):
            discover_python(ROOT,workspace=self.ws)

    def test_lock_excludes_another_process_and_releases_after_exit(self):
        path=self.ws/'task.lock'
        program=("import sys;sys.path.insert(0,sys.argv[1]);from platform_io import file_lock\n"
                 "try:\n with file_lock(sys.argv[2]):pass\n"
                 "except BlockingIOError:sys.exit(7)\n")
        command=[sys.executable,'-X','utf8','-c',program,str(ROOT/'lib'),str(path)]
        with file_lock(path):
            self.assertEqual(subprocess.run(command,env=self.env).returncode,7)
        self.assertEqual(subprocess.run(command,env=self.env).returncode,0)

    def test_stream_handles_split_utf8_and_progress(self):
        program=("import os,time,json; data=json.dumps({'event':'llm_progress','text':'中文'},"
                 "ensure_ascii=False).encode('utf-8')+b'\\n';"
                 "[(os.write(1,bytes([b]))) for b in data];print('finished',flush=True)")
        stream=io.StringIO()
        with contextlib.redirect_stderr(stream):
            code,out=run_stream([sys.executable,'-X','utf8','-c',program],self.ws,
                                self.ws/'stream.log',self.env,10,True)
        self.assertEqual(code,0)
        self.assertIn('中文',out)
        self.assertIn('中文',stream.getvalue())
        self.assertIn('finished',(self.ws/'stream.log').read_text(encoding='utf-8'))

    def test_timeout_terminates_descendants(self):
        marker=self.ws/'should-not-exist'
        child="import time,pathlib,sys;time.sleep(2);pathlib.Path(sys.argv[1]).write_text('orphan')"
        parent="import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2]]);print('spawned',flush=True);time.sleep(30)"
        start=time.monotonic()
        code,out=run_stream([sys.executable,'-c',parent,child,str(marker)],self.ws,
                           self.ws/'timeout.log',self.env,.8)
        self.assertEqual(code,124)
        self.assertIn('spawned',out)
        self.assertLess(time.monotonic()-start,10)
        time.sleep(2)
        self.assertFalse(marker.exists())

    def test_paths_and_shell_specific_commands(self):
        self.assertTrue(str(venv_python(self.ws,True)).endswith('Scripts/python.exe') or
                        str(venv_python(self.ws,True)).endswith(r'Scripts\python.exe'))
        spec=command_spec([r"C:\工具 空格\python.exe","O'Brien"])
        self.assertEqual(spec['argv'][1],"O'Brien")
        self.assertIn("'O''Brien'",spec['powershell'])
        self.assertIn('"C:\\A&B\\python.exe"',command_spec([r'C:\A&B\python.exe'])['cmd'])
        self.assertIsNone(command_spec([r'C:\%PROFILE%\python.exe'])['cmd'])

    @unittest.skipUnless(os.name=='nt','native Windows launcher')
    def test_windows_skill_wrapper(self):
        environment={**self.env, 'PYTHONPATH':'', 'PYTHONHOME':''}
        result=subprocess.run([str(ROOT/'scripts/slr.cmd'),'info'],env=environment,
                              capture_output=True,encoding='utf-8')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIsInstance(json.loads(result.stdout),dict)

    @unittest.skipUnless(os.name=='nt','native Windows launcher')
    def test_windows_entries_delegate_arguments_and_exit_status_without_module_paths(self):
        launcher=self.ws/'product & launcher.cmd'
        recorder=self.ws/'record.py'
        capture=self.ws/'arguments.json'
        recorder.write_text('import json,os,sys\nfrom pathlib import Path\n'
                            'Path(os.environ["SLR_CAPTURE"]).write_text(json.dumps(sys.argv[1:]), encoding="utf-8")\n'
                            'raise SystemExit(23)\n',encoding='utf-8')
        launcher.write_text('@echo off\nsetlocal DisableDelayedExpansion\n'
                            'if "%SLR_TEST_PYTHON:~0,4%"=="\\\\?\\" set "SLR_TEST_PYTHON=%SLR_TEST_PYTHON:~4%"\n'
                            '"%SLR_TEST_PYTHON%" "%~dp0record.py" %*\nexit /b %errorlevel%\n',
                            encoding='utf-8',newline='\r\n')
        environment={**self.env, 'PYTHONPATH':'', 'PYTHONHOME':'',
                     'SCHOLARSEED_SKILL_PYTHON':str(launcher), 'SLR_CAPTURE':str(capture),
                     'SLR_TEST_PYTHON':sys.executable}
        bound=bind(self.ws,ROOT)
        arguments=['writing','configure','--request','request & 中文 space.json']
        for entry, prefix in (
            (ROOT/'scripts/slr.cmd',[str(ROOT/'scripts/bootstrap.py')]),
            (bound,[str(ROOT/'scripts/workspace_entry.py'),str(self.ws)]),
        ):
            with self.subTest(entry=entry):
                result=subprocess.run([str(entry),*arguments],cwd=self.ws.parent,
                                      env=environment,capture_output=True,encoding='utf-8')
                self.assertEqual(result.returncode,23,result.stdout+result.stderr)
                observed=json.loads(capture.read_text(encoding='utf-8'))
                self.assertEqual(Path(observed[0]).resolve(),Path(prefix[0]).resolve())
                if len(prefix)>1:
                    self.assertEqual(Path(observed[1]).resolve(),self.ws)
                self.assertEqual(observed[len(prefix):],arguments)

    @unittest.skipUnless(os.name=='nt','native Windows launcher')
    def test_windows_missing_explicit_launcher_does_not_fall_back_to_python(self):
        environment={**self.env, 'PYTHONPATH':'', 'PYTHONHOME':'',
                     'SCHOLARSEED_SKILL_PYTHON':str(self.ws/'missing-launcher.cmd')}
        for entry in (ROOT/'scripts/slr.cmd',bind(self.ws,ROOT)):
            with self.subTest(entry=entry):
                result=subprocess.run([str(entry),'info'],cwd=self.ws.parent,
                                      env=environment,capture_output=True,encoding='utf-8')
                self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)


if __name__=='__main__':
    unittest.main()
