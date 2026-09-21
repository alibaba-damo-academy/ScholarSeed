"""Offline regressions for observed outline/caption/native-asset failures."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'lib'), str(ROOT/'scripts')]
from figure_caption import caption_errors
from native_asset_checks import inspect_native_assets, inspect_chapter_figures
from native_table_layout import inspect_native_tables
from chapter_pipeline import chapter_messages


def table(label='tab:T1', caption='Methods and assumptions.', env='table'):
    return (rf'\begin{{{env}}}\caption{{{caption}}}\label{{{label}}}'
            r'\begin{tabular}{ll}Method&Assumption\\ A&B\\\end{tabular}'
            rf'\end{{{env}}}')


def assets(*tables):
    return {'shared_tables':[{'label':label,'table_id':label.split(':')[1],'section_id':'1'} for label in tables],
            'shared_figures':[]}


class AssetChecksTest(unittest.TestCase):
    def codes(self, source, plan=None, format='latex_pdf'):
        return [x['code'] for x in inspect_native_assets({'main':source}, plan or assets(), format)['issues']]

    def test_caption_prefixes_with_and_without_punctuation(self):
        for caption in ('图1：2015—2026年方法演进。','表1总结了现有框架。','图2对比了架构。',
                        'Table 2 compares methods.', 'Fig. 3.1: Mechanism', '表 ２：方法', '图一展示了机制'):
            with self.subTest(caption=caption): self.assertTrue(caption_errors(caption))
        for caption in ('2015—2026年方法演进。','二维图表示的比较。','Figure-ground separation.',
                        'Tableau methods and their assumptions.', 'The comparison uses 12% coverage.'):
            with self.subTest(caption=caption): self.assertEqual(caption_errors(caption), [])

    def test_screenshot_case_retains_numbered_caption_warning(self):
        source=table('tab:extra')+table(caption='表1总结了现有L2O框架。')
        codes=self.codes(source,assets('tab:T1'))
        self.assertIn('asset_unplanned',codes)
        self.assertIn('caption_numbering_prefix',codes)
        self.assertNotIn('asset_missing',codes)

    def test_missing_duplicate_and_wrong_owner(self):
        self.assertIn('asset_missing',self.codes('',assets('tab:T1')))
        self.assertIn('asset_duplicate',self.codes(table()+table(),assets('tab:T1')))
        self.assertIn('asset_wrong_owner',self.codes(r'\section{Other}\label{sec:s2}'+table(),assets('tab:T1')))
        self.assertEqual(self.codes(r'\section{Owner}\label{sec:s1}'+table(),assets('tab:T1')),[])

    def test_subsection_ownership_uses_exact_assigned_owner(self):
        plan=assets('tab:T1');plan['shared_tables'][0]['section_id']='1.2'
        self.assertEqual(self.codes(r'\label{sec:s1}\label{sec:s1_2}'+table(),plan),[])
        self.assertIn('asset_wrong_owner',self.codes(r'\label{sec:s1}\label{sec:s1_1}'+table(),plan))

    def test_longtable_counts_as_one_and_is_not_reported_missing_by_layout(self):
        source=table(env='longtable')
        self.assertEqual(self.codes(source,assets('tab:T1')),[])
        report=inspect_native_tables(source,assets('tab:T1')['shared_tables'])
        self.assertNotIn('planned_table_missing_from_assembled_source',str(report))

    def test_duplicate_figure_shell_identified_without_removing_real_image(self):
        plan=assets();plan['shared_figures']=[{'label':'fig:F1','section_id':'1'}]
        real=r'\begin{figure}\includegraphics{F1.png}\caption{Relations.}\label{fig:F1}\end{figure}'
        shell=r'\begin{figure}\caption{图1展示了关系}\label{fig:F1}\end{figure}'
        codes=self.codes(real+shell,plan)
        self.assertIn('asset_duplicate',codes)
        self.assertIn('figure_wrapper_without_content',codes)
        self.assertEqual(self.codes(real,plan),[])
        self.assertTrue(inspect_chapter_figures({'1':shell}))
        self.assertFalse(inspect_chapter_figures({'1':r'图~\ref{fig:F1}解释了关系。'}))

    def test_comments_and_code_examples_are_not_live_assets(self):
        source='% '+table()+'\n'+r'\begin{verbatim}'+table()+r'\end{verbatim}'
        self.assertEqual(self.codes(source),[])
        md='```markdown\n|A|B|\n|---|---|\n|1|2|\n```\n<!-- ![x](x.png) -->'
        self.assertEqual(self.codes(md,format='markdown'),[])
        self.assertFalse(inspect_chapter_figures({'1':md},'markdown'))

    def test_native_caption_balanced_braces_and_escaped_literals(self):
        self.assertIn('caption_numbering_prefix',self.codes(table(caption=r'表1总结了{两类}方法及\{边界\}。'),assets('tab:T1')))
        self.assertEqual(self.codes(table(caption=r'2015—2026年{方法}及\{边界\}。'),assets('tab:T1')),[])

    def test_markdown_identity_caption_and_empty_plan(self):
        md='<a id="tab:T1"></a>\n\nMethods and assumptions.\n\n|Method|Condition|\n|---|---|\n|A|B|\n'
        self.assertEqual(self.codes(md,assets('tab:T1'),'markdown'),[])
        self.assertIn('asset_unplanned',self.codes(md,format='markdown'))
        self.assertIn('caption_numbering_prefix',self.codes(md.replace('Methods and assumptions.','表1总结了各方法。'),assets('tab:T1'),'markdown'))
        self.assertIn('asset_identity_missing_or_ambiguous',self.codes('|A|B|\n|---|---|\n|1|2|',format='markdown'))

    def test_markdown_official_figure_number_is_not_a_caption_prefix(self):
        plan=assets();plan['shared_figures']=[{'label':'fig:F1','section_id':'1'}]
        source='<a id="fig-F1"></a>\n\n![Figure 1](F1.png)\n\n**Figure 1.** Methods and conditions.\n'
        self.assertEqual(self.codes(source,plan,'markdown'),[])
        self.assertIn('asset_duplicate',self.codes(source+source,plan,'markdown'))
        self.assertIn('asset_identity_missing_or_ambiguous',self.codes(source+'\n![Extra](extra.png)',plan,'markdown'))
        self.assertIn('caption_numbering_prefix',self.codes(source.replace('Methods and conditions.','图1展示了关系。'),plan,'markdown'))
        self.assertEqual(self.codes('`![literal](example.png)`',format='markdown'),[])

    def test_diagnostics_across_included_sources_preserve_target_location(self):
        result=inspect_native_assets({'main':r'\input{part}', 'part.tex':table(caption='Table 1 compares methods.')}, assets('tab:T1'))
        self.assertEqual([x['target'] for x in result['issues']],['part.tex'])

    def test_sent_packet_derives_local_inventory_even_for_old_packets(self):
        packet={'chapter_ids':['1'],'chapter_kind':'section','chapter_opening':r'\section{Methods}',
                'output_format':'latex_pdf','shared_tables':[],'shared_figures':[],
                'confirmed_full_outline':{'outline_tree':[{'section_id':'2','tables':[{'table_id':'T9'}]}]}}
        sent=chapter_messages(packet)
        self.assertEqual(json.loads(sent[1]['content'])['asset_contract']['tables'],[])
        self.assertTrue(sent[-1]['content'].endswith(packet['chapter_opening']))
        self.assertNotIn('asset_contract',packet)
        packet['shared_tables']=[{'table_id':'T1','label':'tab:T1','section_id':'1.2','caption_draft':'Methods.'}]
        local=json.loads(chapter_messages(packet)[1]['content'])['asset_contract']['tables']
        self.assertEqual(local,[packet['shared_tables'][0]])
        self.assertNotIn('T9',json.dumps(local))


if __name__=='__main__': unittest.main()
