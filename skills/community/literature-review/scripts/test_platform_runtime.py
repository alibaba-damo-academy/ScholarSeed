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

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'lib'),str(ROOT/'scripts')]
from platform_runtime import command_spec, discover_python, utf8_env, venv_python
from platform_io import file_lock, run_stream
from workspace_binding import bind


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
        argv=result['runtime']['cli']['argv']
        info=subprocess.run([*argv,'info'],cwd=self.ws,env=self.env,capture_output=True,encoding='utf-8')
        self.assertEqual(info.returncode,0,info.stderr)
        self.assertEqual(json.loads(info.stdout)['workspace'],result['workspace'])
        conflict=subprocess.run([*argv,'status','--workspace',str(self.ws)],env=self.env,capture_output=True)
        self.assertNotEqual(conflict.returncode,0)
        wrapper=subprocess.run([result['entrypoint'],'info'],cwd=self.ws,env=self.env,
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
        self.assertTrue(next(i['ok'] for i in report['items'] if i['name']=='bound Python 3.12.x'))

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
        result=subprocess.run([str(ROOT/'scripts/slr.cmd'),'info'],env=self.env,
                              capture_output=True,encoding='utf-8')
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIsInstance(json.loads(result.stdout),dict)


if __name__=='__main__':
    unittest.main()
