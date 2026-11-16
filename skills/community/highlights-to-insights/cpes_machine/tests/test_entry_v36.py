"""The unified entry must use the declared candidate, not the legacy registry."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
import test_figure_source_selection as fixture

REPO=Path(__file__).resolve().parents[1]


class EntryTests(unittest.TestCase):
    def setUp(self):
        fixture.SourceSelection.setUp(self)

    def test_declared_versions_and_legacy_registry_unchanged(self):
        from cpes.entry import describe
        info=describe()
        self.assertEqual(info['entry_version'],'V36')
        self.assertEqual(info['figure_reader'],'V33')
        self.assertEqual(info['table_reader'],'V18')
        self.assertEqual(json.loads((REPO/'cpes-figure/versions/registry.json').read_text())['active'],'V11')

    def test_figure_preparation_uses_v33_wire_and_original_quote(self):
        from cpes.entry import prepare,request_for,assemble
        prepared=prepare('figure',self.job,self.root)
        self.assertNotIn('uniqueItems',str(request_for(prepared)['text']['format']['schema']))
        self.assertNotIn('panels',request_for(prepared)['text']['format']['schema']['properties'])
        original=copy.deepcopy(self.raw)
        card=assemble(prepared,json.dumps(self.raw))
        self.assertEqual(card['author_findings'][0]['claim_origin'],'source_quote')
        self.assertIn('Figure 2 and Table 3',card['author_findings'][0]['claim'])
        self.assertEqual(self.raw,original)

    def test_source_changed_before_send_blocks_transport(self):
        from cpes.entry import prepare,run_one
        p=prepare('figure',self.job,self.root)
        (self.root/'document.txt').write_text('changed')
        transport=Mock()
        with self.assertRaises(ValueError):run_one(p,self.root/'output',transport=transport)
        transport.assert_not_called()

    def test_one_call_keeps_raw_response_usage_and_completed_result_is_reused(self):
        from cpes.entry import prepare,run_one
        p=prepare('figure',self.job,self.root)
        raw=' \n'+json.dumps(self.raw)+'\n '
        transport=Mock(return_value={'output_text':raw,'usage':{'input_tokens':20,'output_tokens':10,'total_tokens':30}})
        out=self.root/'output'
        result=run_one(p,out,transport=transport)
        self.assertEqual(result['status'],'completed')
        self.assertEqual(result['usage']['total_tokens'],30)
        self.assertEqual(json.loads((out/'response.json').read_text())['output_text'],raw)
        self.assertEqual(run_one(p,out,transport=transport),result)
        self.assertEqual(transport.call_count,1)

    def test_changed_completed_card_is_not_silently_reused(self):
        from cpes.entry import prepare,run_one
        p=prepare('figure',self.job,self.root)
        transport=Mock(return_value={'output_text':json.dumps(self.raw),'usage':{'input_tokens':20,'output_tokens':10,'total_tokens':30}})
        out=self.root/'output';run_one(p,out,transport=transport)
        (out/'card.json').write_text('{}')
        with self.assertRaises(ValueError):run_one(p,out,transport=transport)
        self.assertEqual(transport.call_count,1)

    def test_transport_failure_keeps_unknown_usage_and_no_retry(self):
        from cpes.entry import prepare,run_one
        p=prepare('figure',self.job,self.root)
        transport=Mock(side_effect=TimeoutError('secret-provider-details'))
        result=run_one(p,self.root/'output',transport=transport)
        self.assertIsNone(result['model_calls'])
        self.assertIsNone(result['usage'])
        self.assertNotIn('secret-provider-details',json.dumps(result))
        run_one(p,self.root/'output',transport=transport)
        self.assertEqual(transport.call_count,1)

    def test_api_model_override_requires_new_preparation_even_for_completed_run(self):
        from cpes.entry import prepare,run_one
        p=prepare('figure',self.job,self.root)
        transport=Mock(return_value={'output_text':json.dumps(self.raw),'usage':{}})
        out=self.root/'output';run_one(p,out,transport=transport,backend='api')
        with self.assertRaises(ValueError):run_one(p,out,transport=transport,backend='api',model='other-model')
        self.assertEqual(transport.call_count,1)

    def test_external_incomplete_response_is_not_published(self):
        from cpes.entry import prepare
        from cpes.entry_cli import main
        from cpes.contracts import write_json
        p=self.root/'prepared.json';r=self.root/'response.json';out=self.root/'card.json'
        write_json(p,prepare('figure',self.job,self.root))
        write_json(r,{'status':'incomplete','output_text':json.dumps(self.raw)})
        with unittest.mock.patch('builtins.print'):
            code=main(['assemble','--prepared',str(p),'--response',str(r),'--output',str(out)])
        self.assertNotEqual(code,0)
        self.assertFalse(out.exists())

    def test_run_plan_caps_concurrency_and_counts_only_new_calls(self):
        from cpes.entry import prepare,run_plan,value_hash
        from cpes.contracts import write_json,digest
        from unittest.mock import patch
        import threading,time
        pdf=self.root/'paper.pdf';pdf.write_bytes(b'pdf')
        p=prepare('figure',self.job,self.root)
        jobs=[{'id':f'figure-{n}','prepared':p,'card':str(self.root/f'cards/{n}.json')} for n in range(9)]
        plan={'source_pdf':str(pdf),'pdf_sha256':digest(pdf),'jobs':jobs,'extraction_status':'completed','entry':p['entry']}
        plan['fingerprint']=value_hash(plan);write_json(self.root/'system/entry-plan.json',plan)
        lock=threading.Lock();active=0;peak=0;calls=0
        def fake(*args):
            nonlocal active,peak,calls
            with lock:active+=1;peak=max(peak,active);calls+=1
            time.sleep(.01)
            with lock:active-=1
            return {'output_text':json.dumps(self.raw),'usage':{'input_tokens':20,'output_tokens':10,'total_tokens':30}}
        with patch('cpes.entry.transport_for',return_value=fake):
            result=run_plan(self.root,concurrency=8)
            self.assertEqual(result['new_model_calls'],9)
            self.assertEqual(result['new_usage']['total_tokens'],270)
            again=run_plan(self.root)
            self.assertEqual(again['new_model_calls'],0)
            self.assertEqual(again['new_usage']['total_tokens'],0)
        self.assertEqual(calls,9);self.assertLessEqual(peak,8)
        with self.assertRaises(ValueError):run_plan(self.root,concurrency=9)

    def test_failed_generation_is_retained_and_not_retried(self):
        from cpes.entry import prepare,run_one
        p=prepare('figure',self.job,self.root)
        bad={**self.raw,'author_findings':[{'evidence_ids':['unknown']}]}
        transport=Mock(return_value={'output_text':json.dumps(bad),'usage':{'input_tokens':20,'output_tokens':10,'total_tokens':30}})
        out=self.root/'output';result=run_one(p,out,transport=transport)
        self.assertEqual(result['status'],'failed')
        self.assertFalse((out/'card.json').exists())
        self.assertEqual(run_one(p,out,transport=transport)['status'],'failed')
        self.assertEqual(transport.call_count,1)

    def test_prepared_job_tampering_rejected(self):
        from cpes.entry import prepare,request_for
        p=prepare('figure',self.job,self.root)
        p['prepared']['job']['context']['figure_source'][0]['text']='invented'
        with self.assertRaises(ValueError):request_for(p)

    def test_table_rules_are_v18_and_changed_source_blocks_assembly(self):
        from cpes.entry import prepare,request_for,assemble
        from cpes.tables import load_skill
        root=self.root;folder=root/'table-cards/table-1';folder.mkdir(parents=True)
        (folder/'table.png').write_bytes(b'image')
        (folder/'caption.md').write_text('Table 1: Results.\n')
        item={'object_id':'table-1','paper_id':'paper','printed_label':'Table 1','caption':'Table 1: Results.',
              'image':'table-cards/table-1/table.png','caption_path':'table-cards/table-1/caption.md',
              'pdf_locator':{'page_number':1},'extraction_method':'native'}
        skill=load_skill();job=skill.prepare(item,root,[],'Explain Table 1')
        p=prepare('table',job,root)
        prompt=request_for(p)['input'][0]['content'][0]['text']
        self.assertTrue(prompt.startswith((REPO/'cpes-table/versions/table-v18-model-instructions.md').read_text()))
        raw=skill.empty_content();raw['table_overview']='Result summary.'
        self.assertEqual(assemble(p,json.dumps(raw))['table_id'],'table-1')
        (folder/'caption.md').write_text('changed')
        with self.assertRaises(ValueError):assemble(p,json.dumps(raw))


if __name__=='__main__':unittest.main()
