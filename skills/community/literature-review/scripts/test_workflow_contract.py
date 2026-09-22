from task_fixtures import planned_outline, prepare_planned, planned_outline, plan_table, set_planned_assets
"""Offline regression scenarios for public task, source and interaction contracts."""
import contextlib
import copy
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'lib'),str(ROOT/'scripts'),str(ROOT/'scripts/generation')]
from task_contract import configure, read_request, atomic_json, structural_contract, sync_views
from paper_materials import readiness, require_ready, source_identity
from writing_contract import preparation_identity, require_approval
from structure_checks import actual_references, outline_structure_errors
from task_fixtures import task
import slr


class WorkspaceTest(unittest.TestCase):
    def test_section_roles_fail_at_configuration_without_writing_invalid_task(self):
        from chapter_plan import ROLES
        with tempfile.TemporaryDirectory() as folder:
            ws=Path(folder)
            configure(ws,task())
            path=ws/'01_input/writing_request.json';before=path.read_bytes()
            for role in ('algorithm_taxonomy','cross_problem_comparison',None,[],''):
                with self.subTest(role=role),self.assertRaisesRegex(ValueError,'role must be one of'):
                    configure(ws,{'constraints':[{'id':'topic','kind':'required_section',
                        'value':{'title':'Compare supported mechanisms','role':role},
                        'verbatim':'Compare supported mechanisms'}]})
                self.assertEqual(path.read_bytes(),before)
            for role in sorted(ROLES):
                configure(ws,{'constraints':[{'id':'topic','kind':'required_section',
                    'value':{'title':'Compare supported mechanisms','role':role},
                    'verbatim':'Compare supported mechanisms'}]})
                self.assertEqual(read_request(ws)['constraints'][0]['value']['role'],role)
            configure(ws,{'constraints':[{'id':'topic','kind':'required_section',
                'value':{'title':'Compare supported mechanisms'},
                'verbatim':'Compare supported mechanisms'}]})
            self.assertNotIn('role',read_request(ws)['constraints'][0]['value'])

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='slr contract ');self.addCleanup(self.tmp.cleanup);self.ws=Path(self.tmp.name)
        configure(self.ws,task())
        atomic_json(self.ws/'04_outline/outline.json',{'survey_title':'Mechanisms','topic':'Comparison',
            'outline_tree':[{'section_id':'1','title':'Mechanisms','description':'Compare conditional evidence.'}]})
    def corpus(self,n=40,gaps=0):
        papers={str(i):{'paperId':str(i),'title':f'Evidence {i}','abstract':'Actual source abstract.','authors':[{'name':'A. Author'}],'year':2024} for i in range(n)}
        cards={pid:{**p,'card':{'method':{'description':'Supported mechanism.'}},'material_sha256':source_identity(p,None)} for pid,p in papers.items() if int(pid)<n-gaps}
        atomic_json(self.ws/'02_retrieval/selected_paper.json',papers)
        atomic_json(self.ws/'02_retrieval/paper_info.json',{pid:None for pid in papers})
        atomic_json(self.ws/'03_process/paper_cards.json',cards)
        atomic_json(self.ws/'03_process/cite_keys.json',{pid:'Evidence'+pid for pid in papers})
        path=self.ws/'04_outline/outline.json'
        atomic_json(path,planned_outline(json.loads(path.read_text())))
        return papers,cards

    def test_old_file_and_derived_views_cannot_change_task(self):
        self.corpus(1)
        from task_input import task_input
        from output_spec import read_output_spec
        before=task_input(self.ws); identity=preparation_identity(self.ws)
        atomic_json(self.ws/'01_input/requirements.json',{'req_normal':{'length':{'min':999999}},'req_special':[{'kind':'figure_count','value':{'min':999}}]})
        self.assertEqual(before,task_input(self.ws));self.assertEqual(identity,preparation_identity(self.ws))
        atomic_json(self.ws/'01_input/query.json',{'query':'Unrelated task','language':'CHINESE'})
        atomic_json(self.ws/'04_outline/output_spec.json',{'format':'invalid'})
        self.assertEqual(before,task_input(self.ws));self.assertEqual(read_output_spec(self.ws)['format'],'latex_pdf')
        self.assertEqual(identity,preparation_identity(self.ws))
        sync_views(self.ws)
        self.assertEqual(json.loads((self.ws/'01_input/query.json').read_text())['query'],read_request(self.ws)['intent'])

    def test_task_update_is_validated_atomic_and_history_preserving(self):
        path=self.ws/'01_input/writing_request.json';before=path.read_bytes()
        with self.assertRaisesRegex(ValueError,'verbatim'):
            configure(self.ws,{'constraints':[{'id':'x','kind':'figure_count','value':{'min':5},'verbatim':'invented request'}]})
        self.assertEqual(path.read_bytes(),before)
        configure(self.ws,{'user_requests':['Only change the citation style.'],'effective_requirements':'Keep all content; change publication style.', 'publication':{'citation_style':'author_year'}})
        with self.assertRaisesRegex(ValueError,'history'):configure(self.ws,{'user_requests':[]})
        with self.assertRaisesRegex(ValueError,'original intent'):configure(self.ws,{'intent':'another topic'})
        changed=configure(self.ws,{'publication':{'format':'markdown'}})
        self.assertNotIn('retrieval',changed['affected_stages'])
        self.assertEqual(read_request(self.ws)['publication'],{'citation_style':'author_year','format':'markdown'})





    def test_set_coverage_empty_card_and_changed_source(self):
        papers,cards=self.corpus(40,2)
        cards['extra1']=copy.deepcopy(cards['0']);cards['extra2']=copy.deepcopy(cards['1'])
        atomic_json(self.ws/'03_process/paper_cards.json',cards)
        state=readiness(self.ws);self.assertEqual(state['usable_card_count'],38);self.assertFalse(state['ready_for_outline'])
        cards['0']={'card':{'method':{'description':None,'items':[]}}};papers['1']['abstract']='Changed actual source'
        atomic_json(self.ws/'03_process/paper_cards.json',cards);atomic_json(self.ws/'02_retrieval/selected_paper.json',papers)
        state=readiness(self.ws);self.assertEqual(state['usable_card_count'],36)
        self.assertEqual(next(x['reason'] for x in state['issues'] if x['paper_id']=='1'),'source_changed')

    def test_processing_last_success_cannot_hide_missing_cards(self):
        self.corpus(40,2)
        stage={'id':'processing','steps':[['scholarseed-skill-python','fixture'] for _ in range(4)],'writes':[], 'status':{'kind':'trailing_json'}}
        outputs=[(0,json.dumps({'status':'PARTIAL_SUCCESS','failed':2})),*[(0,json.dumps({'status':'SUCCESS'})) for _ in range(3)]]
        args=SimpleNamespace(profile='fast',workspace=str(self.ws),stage='processing',dry_run=False,tail=0)
        stream=io.StringIO()
        with patch.object(slr,'find_stage',return_value=stage),patch.object(slr,'run_command',side_effect=outputs),contextlib.redirect_stdout(stream):rc=slr.cmd_run(args)
        result=json.loads(stream.getvalue());self.assertNotEqual(rc,0);self.assertEqual(result['status'],'PARTIAL_SUCCESS')
        self.assertEqual(result['usable_card_count'],38);self.assertEqual(len(result['steps']),4);self.assertFalse(result['ready_for_outline'])
        self.assertEqual(slr.substitute(['scholarseed-skill-python','example'],self.ws)[0],sys.executable)

    def test_approval_requires_response_and_rejects_stale_packet(self):
        from operator_cli import review_packet, approve
        self.corpus(2); configure(self.ws,{'outline_review':'required','publication':{'format':'markdown'}})
        choices={'formats':['markdown'],'templates':[],'citation_styles':[{'id':'numeric','usable':True},{'id':'author_year','usable':True}]}
        with patch('publication.publication_options',return_value=choices):
            packet=review_packet(self.ws)
            self.assertEqual(packet['confirmation']['state'],'required')
            with self.assertRaises(ValueError):approve(self.ws,{'packet_id':packet['packet_id']})
            with self.assertRaises(ValueError):require_approval(self.ws)
            decision={'packet_id':packet['packet_id'],'user_response':'Approved, use author-year.', 'publication':{'citation_style':'author_year'}}
            receipt=approve(self.ws,decision);require_approval(self.ws)
            self.assertEqual(review_packet(self.ws)['confirmation']['state'],'approved')
            self.assertEqual(receipt['publication']['citation_style'],'author_year')
            configure(self.ws,{'publication':{'citation_style':'numeric'}})
            self.assertEqual(review_packet(self.ws)['confirmation']['state'],'required')
            with self.assertRaises(ValueError):require_approval(self.ws)
            configure(self.ws,{'effective_requirements':'A changed research scope, absent from the displayed packet.'})
            with self.assertRaisesRegex(ValueError,'stale'):approve(self.ws,decision)

    def test_component_and_survey_abstract_contracts(self):
        survey=task({'constraints':[]})
        self.assertEqual(structural_contract(survey)['required_sections'][0]['role'],'abstract')
        self.assertTrue(outline_structure_errors(survey,{'outline_tree':[]}))
        self.assertFalse(outline_structure_errors(survey,{'outline_tree':[{'section_id':'0','title':'Abstract'}]}))
        excluded=task();self.assertTrue(outline_structure_errors(excluded,{'outline_tree':[{'section_id':'0','title':'Abstract'}]}))
        self.assertEqual(structural_contract(task({'output_scope':'section','constraints':[]}))['required_sections'],[])
        with self.assertRaisesRegex(ValueError,'authorization'):configure(self.ws,{'auto_authorization':''})

    def test_comment_or_code_labels_are_not_body_references(self):
        self.assertNotIn('tab:T1',actual_references('% \\ref{tab:T1}\nLiteral tab:T1'))
        self.assertNotIn('tab:T1',actual_references('`\\ref{tab:T1}`\n<!-- \\ref{tab:T1} -->',True))
        self.assertEqual(actual_references('See Table~\\ref{tab:T1}.'),{'tab:T1'})

    def test_short_entry_independent_processes_spaces_and_conflicting_workspace(self):
        from workspace_binding import bind
        initialized=subprocess.run([str(ROOT/'scripts/slr'),'init','--workspace',str(self.ws)],capture_output=True,text=True)
        self.assertEqual(initialized.returncode,0,initialized.stdout+initialized.stderr)
        entry=Path(json.loads(initialized.stdout)['entrypoint'])
        def run(*args):return subprocess.run([str(entry),*args],cwd=self.ws.parent,capture_output=True,text=True)
        first=run('info');second=run('info')
        self.assertEqual(first.returncode,0,first.stderr);self.assertEqual(json.loads(second.stdout)['workspace'],str(self.ws.resolve()))
        rejected=run('status','--workspace',str(self.ws.parent));self.assertNotEqual(rejected.returncode,0)
        with tempfile.TemporaryDirectory() as another:
            other=Path(another);other_entry=bind(other,ROOT)
            result=subprocess.run([str(other_entry),'info'],capture_output=True,text=True)
            self.assertEqual(json.loads(result.stdout)['workspace'],str(other.resolve()))
            self.assertEqual(json.loads(run('info').stdout)['workspace'],str(self.ws.resolve()))

    def test_required_abstract_first_response_failure_preserves_candidate(self):
        import asyncio
        from test_scripted_generation import FakeModel, CONFIG
        import scripted_generation as generation
        from generation_errors import GenerationError
        self.corpus(1); configure(self.ws,{'constraints':[]})
        old=(self.ws/'04_outline/outline.json').read_bytes()
        (self.ws/'04_outline/outline.json').unlink()  # Exercise the first model response only.
        client=FakeModel(json.loads(old))
        with self.assertRaises(GenerationError) as caught:
            asyncio.run(generation.generate(self.ws,'outline',cfg=CONFIG,client=client))
        self.assertEqual(len(client.calls),1)
        self.assertFalse((self.ws/'04_outline/outline.json').exists())
        self.assertTrue(list((self.ws/'_logs/llm').rglob('candidate.json')))
        context=json.loads(client.calls[0][1]['content'])
        self.assertEqual(context['required_outline_nodes'][0]['section_id'],'0')
        outline=json.loads(old);outline['outline_tree'].insert(0,{'section_id':'0','title':'Abstract','description':'Summarize supported evidence.'})
        accepted=FakeModel(planned_outline(outline))
        asyncio.run(generation.generate(self.ws,'outline',cfg=CONFIG,client=accepted))
        self.assertEqual(len(accepted.calls),1)

    def test_figure_plan_validates_transaction_without_internal_json_edits(self):
        import manuscript
        from operator_cli import figure_plan
        self.corpus(1)
        result=prepare_planned(self.ws,{'figures':[{'figure_id':'F1','section_id':'1','caption':'Supported mechanism'}]})
        path=self.ws/'05_generation/_internal/figures_worklist.json';before=path.read_bytes()
        plan={'preparation_id':result['preparation_id'],'items':[{'figure_id':'F1','_render_mode':'image','_prompt':'Show the supported relation','_caption':'Conditional mechanism','_image_size':'wide'}]}
        bad=copy.deepcopy(plan);bad['items'][0]['section_id']='9'
        with self.assertRaises(ValueError):figure_plan(self.ws,bad)
        self.assertEqual(path.read_bytes(),before)
        stale=copy.deepcopy(plan);stale['preparation_id']='older'
        with self.assertRaises(ValueError):figure_plan(self.ws,stale)
        self.assertEqual(figure_plan(self.ws,plan)['updated_ids'],['F1'])
        saved=json.loads(path.read_text())['items'][0]
        self.assertEqual(saved['section_id'],'1');self.assertEqual(saved['_caption'],'Conditional mechanism')





if __name__=='__main__':unittest.main()
