"""Compact presentation and SLR-owned metadata screening; no AS modifications."""
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'lib'),str(ROOT/'scripts')]
from outline.render_outline_md import render
from retrieval.adapt_search_output import run as adapt
from search_metadata_eligibility import problems,author_objects,year_of
from task_contract import configure


class CompactPresentationTest(unittest.TestCase):
    def test_exact_hierarchy_nested_captions_and_no_internal_planning_leak(self):
        outline={'survey_title':'个性化综述','review_thesis':'INTERNAL THESIS',
                 'prerequisites':[{'id':'P1','requirement':'INTERNAL DEFINITION'}],
                 'outline_tree':[{'section_id':'1','title':'背景','description':'INTERNAL DESCRIPTION',
                    'paper_ids':['p1'],'figures':[{'figure_id':'F1','caption_draft':'总体框架',
                    'purpose':'INTERNAL PURPOSE','visual_guidance':'INTERNAL DRAWING'}],
                    'subsections':[{'section_id':'1.1','title':'方法比较','tables':[
                        {'table_id':'T1','caption_draft':'方法与适用条件','content_plan':'INTERNAL CELLS'}]}]},
                    {'section_id':'2','title':'局限'}]}
        original=copy.deepcopy(outline)
        text=render(outline,{'p1':'INTERNAL PAPER'},'INTERNAL RATIONALE')
        self.assertEqual(text,'**个性化综述**\n\n- 1 背景\n    - 图 F1: 总体框架\n    - 1.1 方法比较\n        - 表 T1: 方法与适用条件\n- 2 局限\n')
        self.assertNotIn('INTERNAL',text);self.assertEqual(outline,original)

    def test_outline_view_shows_only_nondefault_chapter_languages(self):
        outline={'survey_title':'综述','outline_tree':[
            {'section_id':'0','title':'Abstract','language':'english'},
            {'section_id':'1','title':'正文','language':'default'},
            {'section_id':'2','title':'结论'}]}
        text=render(outline)
        self.assertIn('- 0 Abstract [language: english]',text)
        self.assertNotIn('1 正文 [language:',text)
        self.assertNotIn('2 结论 [language:',text)


class MetadataPolicyTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.base=Path(self.tmp.name)
        self.good={'paper_id':'good','title':'Complete paper','authors':[{'name':'Ada Lovelace'}],
                   'year':2025,'abstract':'We establish the result under stated conditions.','tier':1,'reason':'Relevant result','doi':'10.1234/good'}

    def command(self,*args,ok=True):
        result=subprocess.run([sys.executable,*map(str,args)],capture_output=True,text=True)
        if ok:self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        else:self.assertNotEqual(result.returncode,0)
        return result

    def candidates(self):
        return [self.good,
                {**self.good,'paper_id':'no_abstract','title':'No abstract','abstract':''},
                {**self.good,'paper_id':'no_author','title':'No author','authors':[{'name':'  '}]},
                {**self.good,'paper_id':'no_year','title':'No year','year':None},
                {**self.good,'paper_id':'all_missing','title':'All missing','abstract':'N/A','authors':['Unknown'],'year':0}]

    def test_valid_author_shapes_source_year_and_placeholders(self):
        self.assertEqual(author_objects('Ada Lovelace'),[{'name':'Ada Lovelace'}])
        self.assertEqual(author_objects([{'normalized_name':'Ada Lovelace'}])[0]['name'],'Ada Lovelace')
        for authors in ([],None,['N/A'],[{}],['...']):
            self.assertIn('usable_authors',{p['rule'] for p in problems({**self.good,'authors':authors})})
        for year in (None,0,True,'n.d.','0000'):
            self.assertIsNone(year_of({'year':year}))
        self.assertEqual(year_of({'year':None,'publication_date':'2024-03-15'}),2024)
        self.assertIsNone(year_of({'year':None,'arxiv_id':'2403.12345'}))

    def test_adapter_excludes_before_dedup_and_reports_all_missing_fields(self):
        ws=self.base/'survey';configure(ws,{'intent':'Review mechanisms'})
        target=ws/'02_retrieval';target.mkdir(exist_ok=True)
        papers=self.candidates();papers[2]['title']=self.good['title']
        (target/'metadata.json').write_text(json.dumps({'papers':[papers[2],*papers[:2],*papers[3:]]}))
        corpus,report,status=adapt(ws)
        self.assertEqual(set(corpus),{'good'})
        self.assertEqual(report['metadata_filter']['rejected_count'],4)
        self.assertEqual(report['metadata_filter']['reason_counts'],{'usable_abstract':2,'usable_authors':2,'usable_year':2})
        self.assertEqual(len(report['dropped']),4);self.assertEqual(status['status'],'PARTIAL_SUCCESS')

    def test_each_search_mode_is_screened_without_modifying_imported_metadata(self):
        for mode in ('balanced','quality','quick','web_only'):
            with self.subTest(mode=mode):
                ws=self.base/mode;configure(ws,{'intent':'Review mechanisms'})
                folder=ws/'02_retrieval';folder.mkdir(exist_ok=True)
                path=folder/'metadata.json'
                path.write_text(json.dumps({'search_summary':{'mode':mode},'papers':self.candidates()}))
                original=path.read_bytes();corpus,report,_=adapt(ws)
                self.assertEqual(set(corpus),{'good'})
                self.assertEqual(report['metadata_filter']['rejected_count'],4)
                self.assertEqual(path.read_bytes(),original)

    def test_no_eligible_search_result_is_failure(self):
        ws=self.base/'empty';configure(ws,{'intent':'Review mechanisms'})
        folder=ws/'02_retrieval';folder.mkdir(exist_ok=True)
        (folder/'metadata.json').write_text(json.dumps({'papers':self.candidates()[1:]}))
        corpus,report,status=adapt(ws)
        self.assertEqual(corpus,{})
        self.assertEqual(status['status'],'FAILED')
        self.assertEqual(report['metadata_filter']['rejected_count'],4)

    def test_complete_source_date_supplies_year_without_identifier_guessing(self):
        ws=self.base/'dated';configure(ws,{'intent':'Review mechanisms'})
        folder=ws/'02_retrieval';folder.mkdir(exist_ok=True)
        dated={**self.good,'year':None,'publication_date':'2024-02-15'}
        (folder/'metadata.json').write_text(json.dumps({'papers':[dated]}))
        corpus,_,_=adapt(ws)
        self.assertEqual(corpus['good']['year'],2024)

    def test_out_of_range_foundation_is_retained_and_counted(self):
        ws=self.base/'foundation'
        configure(ws,{'intent':'Review 2020-2025 work with foundations',
            'retrieval':{'time_range':{'start_year':2020,'end_year':2025}}})
        folder=ws/'02_retrieval';folder.mkdir(exist_ok=True)
        foundation={**self.good,'paper_id':'foundation','title':'Foundational paper','year':1998}
        (folder/'metadata.json').write_text(json.dumps({'papers':[foundation,self.good]}))
        corpus,report,status=adapt(ws)
        self.assertEqual(set(corpus),{'foundation','good'})
        self.assertEqual(report['outside_time_range_retained']['count'],1)
        self.assertEqual(report['outside_time_range_retained']['papers'][0]['paper_id'],'foundation')
        self.assertFalse(any(row.get('rule')=='time_range' for row in report['dropped']))
        self.assertIn('retained 1 upstream-selected foundational paper',status['status_reason'])


if __name__=='__main__':unittest.main()
