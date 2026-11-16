"""Streaming previews must arrive early without exposing draft metadata."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import cpes_machine  # Register the bundled runtime before importing its exceptions.


class PreviewTests(unittest.TestCase):
    def test_untitled_opening_streams_without_a_transient_empty_heading(self):
        from cpes_machine.draft_stream import DraftPreview
        chunks = []
        preview = DraftPreview(chunks.append)
        for char in '{"title":"文章","sections":[{"title":"':
            preview.feed(char)
        self.assertEqual(''.join(chunks), '# 文章\n\n')
        preview.feed('","paragraphs":[{"text":"问题与贡献')
        self.assertEqual(''.join(chunks), '# 文章\n\n问题与贡献')
        preview.feed('"}]},{"title":"方法","paragraphs":[{"text":"后续正文"}]}]}')
        self.assertEqual(''.join(chunks), '# 文章\n\n问题与贡献\n\n## 方法\n\n后续正文\n\n')

    def test_partial_body_unicode_escapes_and_hidden_metadata(self):
        from cpes_machine.draft_stream import DraftPreview
        chunks = []
        preview = DraftPreview(chunks.append)
        preview.feed('{"title":"笔记","sections":[{"title":"主题","paragraphs":[{"text":"前半')
        self.assertEqual(''.join(chunks), '# 笔记\n\n## 主题\n\n前半')
        preview.feed(r'\n\"引文\"\uD83D')
        preview.feed(r'\uDE00后半","source_ids":["A055"],"identity":"mixed","explanation":"隐藏"}]}],"omissions":[]}')
        self.assertEqual(''.join(chunks), '# 笔记\n\n## 主题\n\n前半\n"引文"😀后半\n\n')

    def test_reordered_fields_are_rendered_in_article_order(self):
        from cpes_machine.draft_stream import DraftPreview
        chunks = []
        preview = DraftPreview(chunks.append)
        raw = '{"sections":[{"paragraphs":[{"source_ids":["B001"],"text":"正文"}],"title":"主题"}],"title":"文章"}'
        for char in raw:
            preview.feed(char)
        self.assertEqual(''.join(chunks), '# 文章\n\n## 主题\n\n正文\n\n')


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.seen = self.root / 'preview-seen'
        self.calls = self.root / 'calls.jsonl'
        self.executable = self.root / 'fake-codex'

    def backend(self, mode='success'):
        from cpes_machine.stream_backend import StreamingBackend
        script = '''import json,sys,time
from pathlib import Path
seen=Path(SEEN); calls=Path(CALLS)
def send(x): print(json.dumps(x),flush=True)
for line in sys.stdin:
 x=json.loads(line); method=x.get('method')
 with calls.open('a') as f: f.write(json.dumps(x)+'\\n')
 if method=='initialize': send({'id':x['id'],'result':{'userAgent':'fake'}})
 elif method=='thread/start':
  assert x['params']['ephemeral'] is True
  assert x['params']['sandbox']=='read-only'
  send({'id':x['id'],'result':{'thread':{'id':'thread-1'}}})
 elif method=='turn/start':
  assert x['params']['outputSchema']['type']=='object'
  send({'id':x['id'],'result':{'turn':{'id':'turn-1'}}})
  def notify(method,extra): send({'method':method,'params':{'threadId':'thread-1','turnId':'turn-1',**extra}})
  notify('item/started',{'item':{'type':'agentMessage','id':'message-1','phase':'final_answer','text':''}})
  raw='{"title":"文章","sections":[{"title":"主题","paragraphs":[{"text":"正文","source_ids":["B001"],"identity":"paper_summary"}]}],"omissions":[]}'
  if MODE=='unknown': raw=raw.replace('B001','B999')
  split=raw.index('正文')+1
  notify('item/agentMessage/delta',{'itemId':'message-1','delta':raw[:split]})
  deadline=time.monotonic()+2
  while not seen.exists() and time.monotonic()<deadline: time.sleep(.01)
  if not seen.exists(): sys.exit(7)
  notify('thread/tokenUsage/updated',{'tokenUsage':{'total':{'inputTokens':100,'cachedInputTokens':60,'outputTokens':30,'reasoningOutputTokens':10,'totalTokens':130},'last':{},'modelContextWindow':10000}})
  if MODE=='hang': time.sleep(30)
  if MODE=='tool': notify('item/started',{'item':{'type':'commandExecution','id':'tool-1'}})
  notify('item/agentMessage/delta',{'itemId':'message-1','delta':raw[split:]})
  notify('item/completed',{'item':{'type':'agentMessage','id':'message-1','phase':'final_answer','text':raw if MODE!='mismatch' else '{}'}})
  notify('turn/completed',{'turn':{'id':'turn-1','status':'failed' if MODE=='failed' else 'completed','error':None}})
'''
        script = script.replace('SEEN', repr(str(self.seen))).replace('CALLS', repr(str(self.calls))).replace('MODE', repr(mode))
        self.executable.write_text(f'#!{sys.executable}\n'+script)
        self.executable.chmod(0o700)
        return StreamingBackend(executable=str(self.executable), timeout=1 if mode=='hang' else 5)

    def run_backend(self, mode='success'):
        from cpes_machine.draft_stream import DraftPreview
        chunks = []
        def emit(text):
            chunks.append(text)
            self.seen.touch()
        response = self.backend(mode).generate('Evidence', {'type':'object'}, [], DraftPreview(emit).feed)
        return response, ''.join(chunks)

    def test_real_process_streams_before_completion_and_starts_one_turn(self):
        response, preview = self.run_backend()
        self.assertEqual(preview, '# 文章\n\n## 主题\n\n正文\n\n')
        self.assertEqual(json.loads(response['output_text'])['title'], '文章')
        self.assertEqual(response['usage']['usage_events'][0]['cached_input_tokens'], 60)
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertEqual(sum(c.get('method')=='turn/start' for c in calls), 1)

    def test_unsupported_profile_fails_before_starting_a_process(self):
        from cpes_machine.stream_backend import StreamingBackend
        from cpes.contracts import CpesError
        with self.assertRaises(CpesError) as cm:
            StreamingBackend(executable='/nonexistent/hint-codex',profile='custom').generate(
                'Evidence',{'type':'object'},[],lambda _:None)
        self.assertEqual(cm.exception.code,'stream_profile_unsupported')

    def test_failed_turn_preserves_usage(self):
        from cpes.contracts import CpesError
        with self.assertRaises(CpesError) as cm:
            self.run_backend('failed')
        self.assertEqual(cm.exception.details['usage']['usage_events'][0]['input_tokens'],100)

    def test_timeout_does_not_hang_on_blocked_stdout(self):
        from cpes.contracts import CpesError
        with self.assertRaises(CpesError) as cm:
            self.run_backend('hang')
        self.assertEqual(cm.exception.code, 'model_timeout')

    def test_tool_turn_is_rejected_instead_of_continuing_generation(self):
        from cpes.contracts import CpesError
        with self.assertRaises(CpesError):
            self.run_backend('tool')

    def test_final_message_cannot_silently_disagree_with_preview(self):
        from cpes.contracts import CpesError
        with self.assertRaises(CpesError):
            self.run_backend('mismatch')

    def writer_request(self):
        from pdf_fixture import simple_pdf
        from cpes_machine.writer import prepare_request
        from reading_pipeline import prepare
        pdf = self.root / 'paper.pdf'
        simple_pdf(pdf)
        prepare(pdf,self.root/'reading')
        request=self.root/'request.json'
        prepare_request(self.root/'reading/reading.json',request)
        return request

    def test_writer_publishes_only_validated_files_and_replays_without_dispatch(self):
        from unittest.mock import patch
        from cpes_machine.writer import execute
        request=self.writer_request()
        chunks=[]
        def emit(text):
            chunks.append(text)
            self.seen.touch()
        with patch('cpes_machine.writer.StreamingBackend',return_value=self.backend()):
            first=execute(request,self.root/'result',on_text=emit)
        self.assertTrue(Path(first['note']).exists())
        mapping=json.loads(Path(first['source_map']).read_text())
        self.assertEqual(mapping['paragraphs'][0]['source_ids'],['B00001'])
        with patch('cpes_machine.writer.StreamingBackend',side_effect=AssertionError('No second dispatch')):
            second=execute(request,self.root/'result',on_text=chunks.append)
        self.assertEqual(second['new_model_calls'],0)
        self.assertEqual(''.join(chunks),2*'# 文章\n\n## 主题\n\n正文\n\n')
        Path(first['note']).write_text('changed')
        with self.assertRaisesRegex(ValueError,'changed'):
            execute(request,self.root/'result',on_text=chunks.append)

    def test_failed_stream_leaves_no_formal_note_and_refuses_retry(self):
        from unittest.mock import patch
        from cpes_machine.writer import execute
        request=self.writer_request()
        with patch('cpes_machine.writer.StreamingBackend',return_value=self.backend('failed')):
            with self.assertRaises(Exception):
                execute(request,self.root/'result',on_text=lambda _:self.seen.touch())
            with self.assertRaisesRegex(ValueError,'automatic retry'):
                execute(request,self.root/'result',on_text=lambda _:None)
        self.assertFalse((self.root/'result/final').exists())
        receipt=json.loads((self.root/'result/receipt.json').read_text())
        self.assertEqual(receipt['status'],'failed')
        self.assertEqual(receipt['usage']['input_tokens'],100)

    def test_unknown_source_in_completed_stream_is_not_published(self):
        from unittest.mock import patch
        from cpes_machine.writer import execute
        request=self.writer_request()
        with patch('cpes_machine.writer.StreamingBackend',return_value=self.backend('unknown')):
            with self.assertRaisesRegex(ValueError,'Unknown source'):
                execute(request,self.root/'result',on_text=lambda _:self.seen.touch())
        self.assertTrue((self.root/'result/response.json').exists())
        self.assertFalse((self.root/'result/final').exists())

    def test_cli_stdout_is_markdown_and_stderr_reports_validated_files(self):
        import os
        import subprocess
        request=self.writer_request()
        self.backend()
        (self.root/'codex').symlink_to(self.executable)
        env={**os.environ,'PATH':str(self.root)+os.pathsep+os.environ.get('PATH','')}
        # The fake producer requires an early consumer acknowledgement.
        # This test covers CLI output; the earlier test covers early delivery.
        self.seen.touch()
        result=subprocess.run([sys.executable,str(ROOT/'scripts/writing.py'),'run',
            '--request',str(request),'--out-dir',str(self.root/'result'),'--stream'],
            env=env,text=True,capture_output=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(result.stdout,'# 文章\n\n## 主题\n\n正文\n\n')
        metadata=json.loads(result.stderr.splitlines()[-1])
        self.assertEqual(metadata['new_model_calls'],1)
        self.assertTrue(Path(metadata['source_map']).exists())


if __name__ == '__main__':
    unittest.main()
