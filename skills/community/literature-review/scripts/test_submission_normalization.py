from task_fixtures import prepare_planned, planned_outline, plan_table, set_planned_assets
import json,tempfile,unittest
from pathlib import Path
from submission_normalization import manuscript,outline_assets
from generation_errors import GenerationError
import manuscript as m
import test_manuscript

class NormalizationTest(unittest.TestCase):
 def test_nested_asset_ownership_and_reject_unowned(self):
  outline={'outline_tree':[{'section_id':'1','title':'Methods','description':'Compare',
    'figures':[{'figure_id':'F1','caption':'Mechanism'}]}]}
  result=outline_assets(outline)
  self.assertEqual(result['outline_tree'][0]['figures'][0]['figure_id'],'F1')
  self.assertNotIn('figures',result)
  outline['figures']=outline['outline_tree'][0].pop('figures')
  with self.assertRaises(GenerationError):outline_assets(outline)
  outline['figures'][0]['section_id']='1'
  with self.assertRaises(GenerationError):outline_assets(outline)
 def test_normalization_is_idempotent_for_latex_dependency_text(self):
  outline={'outline_tree':[{'section_id':'1','title':'Main','subsections':[
   {'section_id':'1.1','title':'A'},{'section_id':'1.2','title':'B'}]}]}
  value={'sections':[{'section_id':'1','body_md':r'\subsection{A}\label{sec:s1_1}'+'\n\nFirst.\n\n'+r'\subsection{B}\label{sec:s1_2}'+'\n\nSecond.'}],'tables':[]}
  once,_=manuscript(value,outline);twice,_=manuscript(once,outline)
  self.assertEqual(once,twice)
  self.assertEqual(once['sections'][0]['body_md'],value['sections'][0]['body_md'])
 def test_fold_children_and_normalize_only_owned_headings_without_losing_prose(self):
  outline={'outline_tree':[{'section_id':'1','title':'Methods','subsections':[
    {'section_id':'1.1','title':'One-Condition'},{'section_id':'1.2','title':'Second'}]}]}
  value={'sections':[{'section_id':'1','body_md':r'\subsection{Methods}\label{sec:old}'+'\nIntro evidence.\n'+r'\subsubsection{One Condition}\label{sec:first}'+'\nFirst evidence.'},
    {'section_id':'1.2','body_md':r'\subsubsection{Second}\label{sec:second}'+'\nSecond evidence.'}]}
  normalized,notes=manuscript(value,outline)
  self.assertEqual(len(normalized['sections']),1)
  body=normalized['sections'][0]['body_md']
  for text in ('Intro evidence.','First evidence.','Second evidence.',r'\subsection{One-Condition}',r'\label{sec:s1_2}'):
   self.assertIn(text,body)
  self.assertNotIn(r'\subsection{Methods}',body)
  self.assertEqual(len(value['sections']),2)
 def test_unknown_ids_and_unrelated_headings_are_not_guessed(self):
  outline={'outline_tree':[{'section_id':'1','title':'Methods'}]}
  value={'sections':[{'section_id':'9','body_md':'Unknown evidence'}]}
  self.assertEqual(manuscript(value,outline)[0],value)

class ArchiveTest(unittest.TestCase):
 setUp=test_manuscript.ManuscriptTest.setUp
 put=test_manuscript.ManuscriptTest.put
 set_publication=test_manuscript.ManuscriptTest.set_publication
 draft=test_manuscript.ManuscriptTest.draft
