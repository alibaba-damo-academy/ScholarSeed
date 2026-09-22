"""Validate agent-authored JSON examples through their actual input interfaces."""
import copy
import json
from pathlib import Path
import re
import unittest
import subprocess
import sys
from unittest.mock import patch

import test_native_pipeline as fixtures
from evidence import build,read
from task_contract import configure,atomic_json
from operator_cli import configure_outline,figure_plan

ROOT=Path(__file__).resolve().parents[1]


def examples(relative):
    return [json.loads(s) for s in re.findall(r'```json\n(.*?)\n```',(ROOT/relative).read_text(),re.S)]


def description(operation,workspace=None):
    command=[sys.executable,str(ROOT/'scripts/slr.py'),*operation.split('.'),'--describe-input']
    if workspace:command+=['--workspace',str(workspace)]
    proc=subprocess.run(command,capture_output=True,text=True,timeout=30)
    if proc.returncode:raise AssertionError(proc.stdout+proc.stderr)
    return json.loads(proc.stdout)


class RequestExampleTest(unittest.TestCase):
    def fixture(self):
        f=fixtures.NativeTest();f.setUp();self.addCleanup(f.doCleanups)
        return f

    def test_configure_scenarios_use_supported_fields_and_real_history(self):
        count=0
        for value in description('writing.configure')['examples']:
            f=self.fixture()
            self.assertEqual(configure(f.ws,value)['status'],'SUCCESS')
            count+=1
        self.assertGreaterEqual(count,6)

    def test_template_type_errors_are_specific_in_configure_and_approve(self):
        from input_contracts import input_error
        from operator_cli import review_packet,approve
        f=self.fixture()
        with self.assertRaises(ValueError) as error:
            configure(f.ws,{'publication':{'template':{'type':'ctexart'}}})
        report=input_error('writing.configure',error.exception)
        self.assertEqual(report['field'],'publication.template')
        self.assertEqual(report['expected_type'],'string')
        choices={'formats':['latex_pdf'],'templates':[{'id':'neurips','usable':True}],
                 'citation_styles':[{'id':'numeric','usable':True}]}
        with patch('publication.publication_options',return_value=choices):
            packet=review_packet(f.ws)
            self.assertEqual(packet['confirmation']['state'],'auto')
            with self.assertRaises(ValueError) as error:
                approve(f.ws,{'packet_id':packet['packet_id'],'user_response':'Confirmed.',
                              'publication':{'template':{'type':'neurips'}}})
        report=input_error('writing.approve',error.exception)
        self.assertEqual(report['field'],'publication.template')
        self.assertFalse((f.ws/'04_outline/approval.json').exists())

    def test_verbatim_sources_and_contiguous_rule_match_documentation(self):
        from task_contract import validate_request
        from input_contracts import input_error
        data={'intent':'至少一张图，并包含一张比较表。',
              'user_instructions':'用中文写作。','user_requests':['正文限定三千字。'],
              'effective_requirements':'派生的新表述。'}
        for quote in ('至少一张图','用中文写作','正文限定三千字'):
            value={**data,'constraints':[{'id':'c','kind':'other','value':'Actual requirement','verbatim':quote}]}
            self.assertEqual(validate_request(value)['constraints'][0]['verbatim'],quote)
        for quote in ('至少一张图；一张比较表','至少 一张图','派生的新表述'):
            with self.assertRaises(ValueError) as error:
                validate_request({**data,'constraints':[{'id':'c','kind':'other','value':'Requirement','verbatim':quote}]})
            report=input_error('writing.configure',error.exception)
            self.assertEqual(report['field'],'constraints[0].verbatim')
            self.assertIn('user_requests[]',report['quote_sources'])
        shape_error=input_error('writing.configure',ValueError('constraints/0: expected id, kind, value, verbatim'))
        self.assertEqual(shape_error['field'],'constraints')

    def test_complete_outline_example_is_accepted(self):
        value=description('outline.configure')['examples'][0]
        f=self.fixture()
        selected=read(f.ws/'02_retrieval/selected_paper.json')
        selected['p2']={**selected['p1'],'paperId':'p2','title':'Second evidence'}
        atomic_json(f.ws/'02_retrieval/selected_paper.json',selected)
        cards=read(f.ws/'03_process/paper_cards.json')
        cards['p2']={**cards['p1'],'paperId':'p2','title':'Second evidence',
                     'material_sha256':fixtures.source_identity(selected['p2'],None)}
        atomic_json(f.ws/'03_process/paper_cards.json',cards)
        atomic_json(f.ws/'03_process/cite_keys.json',{'p1':'Keyp1','p2':'Keyp2'})
        result=configure_outline(f.ws,value)
        self.assertEqual(result['status'],'SUCCESS')
        saved=read(f.ws/'04_outline/outline.json')
        self.assertEqual(saved['outline_tree'][2]['figures'][0]['figure_id'],'F1')
        self.assertEqual(saved['outline_tree'][2]['subsections'][0]['tables'][0]['table_id'],'T1')

    def test_evidence_options_example_and_list_match_accepted_fields(self):
        from evidence import OPTIONAL
        interface=description('evidence.build')
        value=interface['examples'][0]
        f=self.fixture();result=build(f.ws,'outline',value)
        self.assertEqual(result['status'],'SUCCESS')
        documented=set(interface['fields']['extra_fields']['allowed'])
        self.assertEqual(documented,OPTIONAL)

    def test_all_figure_rendering_examples_submit_successfully(self):
        from manuscript import prepare
        modes=set()
        for value in description('figures.plan')['examples']:
            if 'items' not in value:continue
            f=self.fixture()
            f.outline['outline_tree'][1]['figures']=[{'figure_id':'F1','purpose':'Explain mechanisms.',
                'content_plan':'Show supported relations.','caption_draft':'The mechanism relates its parts.',
                'visual_guidance':'A clear diagram.','paper_ids':['p1']}]
            atomic_json(f.ws/'04_outline/outline.json',f.outline)
            prepared=prepare(f.ws)
            request=copy.deepcopy(value);request['preparation_id']=prepared['preparation_id']
            self.assertEqual(figure_plan(f.ws,request)['status'],'SUCCESS')
            modes.add(request['items'][0]['_render_mode'])
        self.assertEqual(modes,{'image','forest_taxonomy','data_chart'})

    def test_descriptions_are_read_only_and_current_outline_is_available(self):
        f=self.fixture()
        before={p.relative_to(f.ws):p.read_bytes() for p in f.ws.rglob('*') if p.is_file()}
        for operation in ('writing.configure','writing.approve','outline.configure','figures.plan','evidence.build','papers.import-local'):
            result=description(operation,f.ws)
            self.assertTrue(result['read_only'])
            if operation=='outline.configure':self.assertEqual(result['current_outline'],f.outline)
        self.assertEqual(before,{p.relative_to(f.ws):p.read_bytes() for p in f.ws.rglob('*') if p.is_file()})

    def test_field_error_returns_local_example_without_large_schema(self):
        f=self.fixture();path=f.ws/'bad-request.json'
        path.write_text(json.dumps({'retrieval':{'time_range':{'start':2010,'end':2020}}}))
        proc=subprocess.run([sys.executable,str(ROOT/'scripts/slr.py'),'writing','configure',
            '--workspace',str(f.ws),'--request',str(path)],capture_output=True,text=True)
        result=json.loads(proc.stdout)
        self.assertNotEqual(proc.returncode,0)
        self.assertEqual(result['field'],'retrieval.time_range')
        self.assertEqual(result['example']['retrieval']['time_range'],{'start_year':2010,'end_year':2020})
        self.assertIn('--describe-input',result['describe_input'])
        self.assertNotIn('fields',result)

    def test_main_revises_outline_without_any_model_call(self):
        import asyncio
        import scripted_generation
        f=self.fixture();value=description('outline.configure',f.ws)['current_outline']
        value['outline_tree'][1]['title']='Revised mechanisms'
        value['outline_tree'][1]['tables']=[{'table_id':'T1','purpose':'Compare conditions.',
            'content_plan':'Compare the supported settings.','caption_draft':'Settings and conditions.',
            'row_unit':'Setting','comparison_dimensions':['Conditions'],'paper_ids':['p1']}]
        with patch.object(scripted_generation,'invoke',side_effect=AssertionError('revision must not call LLM')):
            self.assertEqual(configure_outline(f.ws,value)['status'],'SUCCESS')
            result=asyncio.run(scripted_generation.generate(f.ws,'outline'))
        self.assertEqual(result['model_calls'],0)
        self.assertEqual(read(f.ws/'04_outline/outline.json')['outline_tree'][1]['title'],'Revised mechanisms')

    def test_removed_repair_command_and_missing_local_evidence_are_explicit(self):
        from paper_materials import readiness
        f=self.fixture()
        proc=subprocess.run([sys.executable,str(ROOT/'scripts/slr.py'),'papers','repair','--ids','p1'],capture_output=True,text=True)
        self.assertNotEqual(proc.returncode,0)
        selected=read(f.ws/'02_retrieval/selected_paper.json');selected['p1']['abstract']=''
        selected['p1']['source']='local_pdf'
        atomic_json(f.ws/'02_retrieval/selected_paper.json',selected)
        result=readiness(f.ws)
        self.assertFalse(result['ready_for_outline'])
        self.assertEqual(result['issues'][0]['reason'],'no_usable_source_text')
        atomic_json(f.ws/'02_retrieval/paper_info.json',{'p1':{'info_type':'origin_pdf','sentences':'Actual parsed local source text.'}})
        from paper_materials import material_state
        self.assertEqual(material_state(selected['p1'],read(f.ws/'02_retrieval/paper_info.json')['p1']),'fulltext')


if __name__=='__main__':unittest.main()
