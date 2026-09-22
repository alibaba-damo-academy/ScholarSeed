"""Joint outline planning, immutable derivation, and owning-section callouts."""
from pathlib import Path
import sys
sys.path[:0]=[str(Path(__file__).resolve().parents[1]/'lib'),str(Path(__file__).resolve().parents[1]/'scripts')]
import asyncio
import copy
import json
import unittest
import manuscript as m
import scripted_generation as generation
from test_scripted_generation import FakeModel, CONFIG
import test_manuscript
from task_contract import configure,atomic_json
from task_fixtures import planned_outline
from writing_contract import approval_snapshot,require_approval
from operator_cli import configure_outline
from asset_plan import derive,reference_issues,table_columns
from generation_errors import GenerationError


def figure():
    return {'figure_id':'F1','purpose':'Explain how the mechanism preserves conditional evidence.',
            'content_plan':'Two evidence-processing stages exchange supported information; this is an illustration, not a convergence proof.',
            'caption_draft':'The stages exchange conditional evidence.','visual_guidance':'Use a cartoon style with blue arrows.',
            'paper_ids':['p1'],'qualifications':['Illustrative relationship only.']}


def table(tid):
    return {'table_id':tid,'purpose':'Compare mechanisms using the same evidence conditions.',
            'content_plan':'Each row represents a method; compare conditions and supported results without asserting superiority.',
            'caption_draft':'Methods are compared by their conditions and available evidence.',
            'row_unit':'Method','comparison_dimensions':['Conditions','Evidence'],'paper_ids':['p1']}


class AssetPlanTest(unittest.TestCase):
    setUp=test_manuscript.ManuscriptTest.setUp
    put=test_manuscript.ManuscriptTest.put
    set_publication=test_manuscript.ManuscriptTest.set_publication
    draft=test_manuscript.ManuscriptTest.draft

    def outline(self):
        return planned_outline({'survey_title':'Conditional mechanisms','topic':'Mechanisms','outline_tree':[
            {'section_id':'1','title':'Mechanisms','description':'Explain the conditional mechanism.', 'figures':[figure()],
             'subsections':[{'section_id':'1.1','title':'Comparison','description':'Compare assumptions and evidence.','tables':[table('T1')]}]},
            {'section_id':'2','title':'Limitations','description':'Compare the evidence limitations.','tables':[table('T2')]}]})

    def submission(self):
        return {'sections':[
            {'section_id':'1','body_md':r'Figure~\ref{fig:F1} illustrates the conditional relation \citep{First2024}.'+'\n\n### Comparison\n\n'+r'Table~\ref{tab:T1} compares conditions \citep{First2024}.'},
            {'section_id':'2','body_md':r'Table~\ref{tab:T2} collects limitations \citep{First2024}.'}],
            'tables':[{'table_id':tid,'section_id':sid,'caption':'The comparison retains the evidence conditions.',
                       'columns':['Method','Conditions','Evidence'],
                       'rows':[[r'Method A \citep{First2024}','Conditional setting','Supported result']]} for tid,sid in [('T1','1.1'),('T2','2')]]}

    def prepared(self):
        outline=self.outline();configure_outline(self.ws,outline);m.prepare(self.ws)
        return outline

    def accept(self,value):
        source=self.ws/'candidate.json';atomic_json(source,value);return m.accept(self.ws,source)

    def test_outline_example_preserves_nested_ownership_and_rejects_root_move(self):
        protocol=generation.OUTLINE_PROTOCOL
        example,_=json.JSONDecoder().raw_decode(protocol[protocol.index('{"survey_title":"Review"'):])
        from asset_plan import plan_errors
        from submission_normalization import outline_assets
        self.assertEqual(plan_errors(example,{'p1'}),[])
        self.assertNotIn('figures',example)
        self.assertNotIn('tables',example)
        owner=example['outline_tree'][0]
        self.assertEqual(owner['figures'][0]['figure_id'],'F1')
        self.assertEqual(owner['subsections'][0]['tables'][0]['table_id'],'T1')
        example['figures']=owner.pop('figures')
        with self.assertRaises(GenerationError): outline_assets(example)

    def test_table_minimum_is_checked_in_first_outline_response(self):
        configure(self.ws,{'user_instructions':'At least two tables.','constraints':[
            {'id':'tables','kind':'table_count','value':{'min':2},'verbatim':'At least two tables.'},
            {'id':'omit','kind':'forbidden_section','value':{'title':'Abstract'},'verbatim':'No abstract.'}]})
        before=(self.ws/'04_outline/outline.json').read_bytes()
        value=self.outline();value['outline_tree'][1]['tables']=[]
        (self.ws/'04_outline/outline.json').unlink()  # Fresh initial outline request.
        author=FakeModel(value)
        with self.assertRaisesRegex(GenerationError,'at least 2'):
            asyncio.run(generation.generate(self.ws,'outline',cfg=CONFIG,client=author))
        self.assertEqual(len(author.calls),1);self.assertFalse((self.ws/'04_outline/outline.json').exists())

    def test_cross_chapter_callout_rejected_even_when_owner_callout_exists(self):
        outline=self.outline();value=self.submission()
        self.assertEqual(reference_issues(derive(outline),outline,value['sections'],True),[])
        value['sections'][1]['body_md']+=r' See Figure~\ref{fig:F1}.'
        issues=reference_issues(derive(outline),outline,value['sections'],True)
        issue=next(x for x in issues if x['code']=='ASSET_CROSS_CHAPTER_REF')
        self.assertEqual((issue['asset_id'],issue['section_id'],issue['owner_section_id']),('fig:F1','2','1'))





    def test_explicit_outline_update_invalidates_approval_and_display_shows_asset_fields(self):
        configure(self.ws,{'outline_review':'required'})
        value=self.outline();configure_outline(self.ws,value)
        atomic_json(self.ws/'04_outline/approval.json',{'user_response':'Approved.','snapshot':approval_snapshot(self.ws)})
        require_approval(self.ws)
        text=(self.ws/'04_outline/outline.md').read_text()
        for phrase in ('    - Figure F1: The stages exchange conditional evidence.', '    - 1.1 Comparison', '        - Table T1: Methods are compared by their conditions and available evidence.'):
            self.assertIn(phrase,text)
        moved=value['outline_tree'][0]['subsections'][0]['tables'].pop();value['outline_tree'][1]['tables'].append(moved)
        configure_outline(self.ws,value)
        with self.assertRaisesRegex(ValueError,'review required'):require_approval(self.ws)


    def test_review_packet_contains_display_ready_chapters_and_asset_tables(self):
        from operator_cli import review_packet
        self.prepared();packet=review_packet(self.ws)
        text=packet['outline_markdown']
        for phrase in ('- 1 Mechanisms','    - Figure F1:', '    - 1.1 Comparison', '        - Table T1:', '- 2 Limitations', '    - Table T2:'):
            self.assertIn(phrase,text)
        self.assertIn('1-2 sentences',packet['display_instructions'])
        self.assertIn('citation format and template',packet['display_instructions'])
        for hidden in ('Visual guidance:', '| Figure |', 'purpose', 'What it shows'):
            self.assertNotIn(hidden,text)






if __name__=='__main__':unittest.main()
