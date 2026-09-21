from task_fixtures import prepare_planned, planned_outline, plan_table, set_planned_assets
"""Offline behavioral regression: transport, requirements, artifacts and reuse."""
import asyncio
import copy
import json
from pathlib import Path
import sys
import shutil
import tempfile
import unittest
from unittest.mock import patch

import evidence as e
import manuscript as m
import scripted_generation as g
from generation_errors import GenerationError
import test_manuscript


CONFIG = {'provider':'qwen','model':'fixture','api_key':'never-log-this', 'max_tokens':64000,
          'context_window':1000000,'capacity_verified':'offline fixture','thinking':False,'max_attempts':2}


class FakeModel:
    def __init__(self, value, finish='stop', fault=None):
        self.value, self.finish, self.fault = value, finish, fault
        self.calls = []
    async def chat_stream(self, messages, **kwargs):
        self.calls.append(copy.deepcopy(messages))
        capture = kwargs['_capture']
        capture.update(finish_reason=self.finish, usage={'prompt_tokens':120, 'completion_tokens':30,
                       'prompt_tokens_details':{'cached_tokens':60}, 'completion_tokens_details':{'reasoning_tokens':0}},
                       response_models=['fixture'], partial_response='partial')
        if self.fault: raise self.fault
        return json.dumps(self.value, ensure_ascii=False)


class EvidenceTest(unittest.TestCase):
    def test_four_types_no_truncation_no_formula_or_results_in_outline(self):
        method={'paper_type':'method','common_fields':{'tldr':'Mechanism'}, 'card':{
            'method':{'name':'M','description':'x'*1200, 'key_formulas':['FORMULA']},'experiments':{'result':'RESULT'}}}
        fields, mapping=e.project(method)
        self.assertEqual(fields['Mechanism'], 'x'*1200)
        self.assertEqual(mapping['Mechanism'],'card.method.description')
        self.assertNotIn('FORMULA',json.dumps(fields));self.assertNotIn('RESULT',json.dumps(fields))
        self.assertIn('FORMULA',json.dumps(e.writing_content(method)))
        benchmark={'paper_type':'benchmark','card':{'dataset':{'name':'B','description':'Design','size':1234},
            'metrics':{'evaluation_protocol':'Fixed seeds','primary_metrics':['HV']}}}
        fields,_=e.project(benchmark);self.assertEqual(fields['Protocol'],'Fixed seeds')
        self.assertNotIn('1234',json.dumps(fields));self.assertNotIn('HV',json.dumps(fields))
        theory={'paper_type':'theory','common_fields':{'tldr':'Conditional theorem'},'card':{
            'implication':{'theoretical_impact':'Local implication','connections':['C']},
            'theorem_proof':{'key_assumptions':['Compact domain'],'proof_technique':'Induction','main_results':'BOUND'}}}
        fields,_=e.project(theory);self.assertEqual(fields['Impact'],'Local implication')
        self.assertNotIn('BOUND',json.dumps(fields))
        self.assertEqual(e.project(theory,['card.theorem_proof.key_assumptions'])[0]['card.theorem_proof.key_assumptions'],['Compact domain'])
        self.assertIn('BOUND',json.dumps(e.writing_content(theory)))
        survey={'paper_type':'survey','survey_outline_skeletons':[{'sections':[{'title':'OLD'}]}],
            'card':{'survey_outline':{'sections':[{'title':'Real','description':'Actual scope','subsections':[{'title':'Nested'}]}]}}}
        fields,mapping=e.project(survey);self.assertEqual(mapping['Survey outline'],'card.survey_outline.sections')
        self.assertNotIn('OLD',json.dumps(fields));self.assertIn('Nested',json.dumps(fields))
        del survey['card']['survey_outline'];self.assertIn('Legacy survey outline',e.project(survey)[0])
        del survey['survey_outline_skeletons'];survey['card']['summary']={'key_themes':['Theme']}
        self.assertIn('Themes (no extracted outline)',e.project(survey)[0])

    def test_actual_three_surveys(self):
        records=e.read(Path(__file__).parent/'fixtures/scripted_generation/surveys.json')
        self.assertEqual(len(records),3)
        for record in records.values():
            fields,mapping=e.project(record)
            self.assertEqual(mapping['Survey outline'],'card.survey_outline.sections')
            self.assertEqual(fields['Survey outline'],e.survey_sections(record['card']['survey_outline']['sections']))

    def test_placeholder_fallback_and_unknown_evidence(self):
        fields,mapping=e.project({'common_fields':{'tldr':'Not found'},'card':{'idea':'未找到信息'},'abstract':'Only abstract'})
        self.assertEqual(fields,{'Abstract (fallback)':'Only abstract'})
        self.assertEqual(e.clean(['A','A','N/A',None,0]),['A',0])

    def test_covers_all_40_and_fails_missing_identity_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            ws=Path(directory)
            cards={f'p{i}':{'paper_type':'method','title':f'Paper{i}','abstract':'Actual source abstract.', 'card':{'method':{'description':'Complete sentence.'}}} for i in range(40)}
            e.save(ws/'03_process/paper_cards.json',cards)
            e.save(ws/'02_retrieval/selected_paper.json',cards)
            keys={pid:'Key'+pid for pid in cards};e.save(ws/'03_process/cite_keys.json',keys)
            result=e.build(ws,'outline');self.assertEqual(result['papers'],40);self.assertEqual(result['model_calls'],0)
            text=Path(result['artifacts'][1]).read_text();self.assertIn('Keyp39',text);self.assertNotIn('sha256',text)
            with self.assertRaises(GenerationError) as caught:e.build(ws,'writing',{'max_input_bytes':1})
            self.assertEqual(caught.exception.code,'INPUT_TOO_LARGE')
            del keys['p39'];e.save(ws/'03_process/cite_keys.json',keys)
            with self.assertRaises(GenerationError) as caught:e.build(ws,'outline')
            self.assertEqual(caught.exception.code,'INPUT_MISSING')


class ScriptedTest(unittest.TestCase):
    setUp = test_manuscript.ManuscriptTest.setUp
    put = test_manuscript.ManuscriptTest.put
    set_publication = test_manuscript.ManuscriptTest.set_publication
    draft = test_manuscript.ManuscriptTest.draft








    def test_truncated_and_unterminated_stream_are_not_accepted(self):
        for finish,code in [('length','OUTPUT_TRUNCATED'),(None,'STREAM_INTERRUPTED')]:
            client=FakeModel({},finish=finish)
            with self.assertRaises(GenerationError) as caught:
                asyncio.run(g.invoke(self.ws,'outline',[{'role':'user','content':'hello'}],CONFIG,'hash',client))
            self.assertEqual(caught.exception.code,code);self.assertEqual(len(client.calls),1 if finish=='length' else 2)
        self.assertEqual(len(list((self.ws/'_logs/llm').glob('*/attempt-1.json'))),2)

    def test_authentication_does_not_retry(self):
        class AuthError(Exception): status_code=401
        client=FakeModel({},fault=AuthError())
        with self.assertRaises(GenerationError) as caught:
            asyncio.run(g.invoke(self.ws,'outline',[],CONFIG,'hash',client))
        self.assertEqual(caught.exception.code,'API_AUTH');self.assertEqual(len(client.calls),1)




    def test_optional_projection_reaches_outline_prompt(self):
        cards=e.read(self.ws/'03_process/paper_cards.json')
        cards['p1']['card']={'method':{'novelty':'An optional detail'}}
        self.put('03_process/paper_cards.json',cards)
        e.build(self.ws,'outline',{'extra_fields':['card.method.novelty']})
        client=FakeModel(e.read(self.ws/'04_outline/outline.json'))
        (self.ws/'04_outline/outline.json').unlink()  # This tests initial generation, not a revision.
        asyncio.run(g.generate(self.ws,'outline',cfg=CONFIG,client=client))
        payload=json.loads(client.calls[0][1]['content'])
        self.assertIn('An optional detail',payload['evidence'])

    def test_sent_outline_example_has_valid_distinct_node_shapes(self):
        value=e.read(self.ws/'04_outline/outline.json')
        (self.ws/'04_outline/outline.json').unlink()
        client=FakeModel(value)
        asyncio.run(g.generate(self.ws,'outline',cfg=CONFIG,client=client))
        protocol=client.calls[0][0]['content']
        start=protocol.index('{"survey_title":"Review"')
        example,_=json.JSONDecoder().raw_decode(protocol[start:])
        parent=example['outline_tree'][0];child=parent['subsections'][0]
        self.assertEqual(parent['language'],'default')
        self.assertNotIn('language',child)
        from validate_outline import validate
        from asset_plan import plan_errors
        from chapter_plan import compile_plan
        self.assertEqual(validate(example,{'p1'}, {})[0],[])
        self.assertEqual(plan_errors(example,{'p1'}),[])
        compile_plan(example,{'p1'})

    def test_numbered_outline_caption_is_rejected_without_recall_or_raw_rewrite(self):
        from task_fixtures import planned_asset
        value=e.read(self.ws/'04_outline/outline.json')
        (self.ws/'04_outline/outline.json').unlink()
        value['outline_tree'][0]['tables']=[planned_asset({
            'table_id':'T1','caption':'表1总结了现有方法。'},'tables')]
        client=FakeModel(value)
        with self.assertRaises(GenerationError) as caught:
            asyncio.run(g.generate(self.ws,'outline',cfg=CONFIG,client=client))
        report=caught.exception.report()
        self.assertEqual(len(client.calls),1)
        self.assertIn('caption_draft',report['message'])
        self.assertEqual(json.loads(Path(report['candidate_path']).read_text()),value)
        self.assertFalse((self.ws/'04_outline/outline.json').exists())

    def test_invalid_outline_candidate_tells_main_to_repair_without_model_rerun(self):
        value=e.read(self.ws/'04_outline/outline.json')
        (self.ws/'04_outline/outline.json').unlink()
        value['outline_tree'][0]['paper_ids']=['not-in-corpus']
        client=FakeModel(value)
        with self.assertRaises(GenerationError) as caught:
            asyncio.run(g.generate(self.ws,'outline',cfg=CONFIG,client=client))
        report=caught.exception.report()
        self.assertEqual(len(client.calls),1)
        self.assertTrue(Path(report['candidate_path']).is_file())
        self.assertEqual(report['outline_recovery']['strategy'],'repair_saved_candidate')
        self.assertIn('outline configure --request',report['next_action'])
        self.assertIn('do not rerun outline generation',report['next_action'])

    def test_transient_retry_counts_each_attempt_including_missing_usage(self):
        class RateLimit(Exception):status_code=429
        class RetryModel(FakeModel):
            async def chat_stream(self,messages,**kwargs):
                if not self.calls:
                    self.calls.append(messages)
                    raise RateLimit()
                return await super().chat_stream(messages,**kwargs)
        client=RetryModel({'ok':True})
        with patch.object(g.asyncio,'sleep'):
            result,metrics=asyncio.run(g.invoke(self.ws,'outline',[],CONFIG,'hash',client))
        self.assertEqual(result,{'ok':True});self.assertEqual(metrics['model_calls'],2)
        self.assertIsNone(metrics['usage'][0]);self.assertEqual(len(client.calls),2)




if __name__=='__main__':unittest.main()
