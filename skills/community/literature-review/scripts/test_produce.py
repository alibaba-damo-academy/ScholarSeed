import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from produce import run_components


class ProduceTest(unittest.TestCase):
    def test_components_start_together_and_keep_separate_reports(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            code = """import pathlib,sys,time,json
p=pathlib.Path(sys.argv[1]); name=sys.argv[2]; other=sys.argv[3]
(p/(name+'.started')).write_text('yes')
end=time.monotonic()+3
while not (p/(other+'.started')).exists() and time.monotonic()<end: time.sleep(.01)
ok=(p/(other+'.started')).exists()
print(json.dumps({'status':'SUCCESS' if ok else 'FAILED','name':name}))
raise SystemExit(0 if ok else 1)
"""
            commands = {name: [sys.executable, "-c", code, d, name, other]
                        for name, other in [("drafting", "figures"), ("figures", "drafting")]}
            result = asyncio.run(run_components(ws, commands))
            self.assertEqual(result["status"], "SUCCESS", result)
            self.assertEqual({r["report"]["name"] for r in result["components"]}, set(commands))
            self.assertEqual(len(list((ws / "_logs/produce").glob("*/*.log"))), 2)

    def test_failure_cancels_other_component_and_preserves_failure(self):
        with tempfile.TemporaryDirectory() as d:
            ws = Path(d)
            slow = "import pathlib,os,sys,time; pathlib.Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(30)"
            fail = """import pathlib,sys,time,json
p=pathlib.Path(sys.argv[1]); end=time.monotonic()+3
while not p.exists() and time.monotonic()<end: time.sleep(.01)
print(json.dumps({'status':'FAILED','reason':'fixture failure'})); raise SystemExit(1)
"""
            pidfile = ws / "slow.pid"
            result = asyncio.run(run_components(ws, {
                "drafting": [sys.executable, "-c", fail, str(pidfile)],
                "figures": [sys.executable, "-c", slow, str(pidfile)],
            }))
            self.assertEqual(result["status"], "FAILED")
            self.assertEqual({r["status"] for r in result["components"]}, {"FAILED", "CANCELLED"})
            with self.assertRaises(ProcessLookupError):
                os.kill(int(pidfile.read_text()), 0)

if __name__ == "__main__":
    unittest.main()
