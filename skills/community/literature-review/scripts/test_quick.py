import unittest
import pdf_fixture
import hashlib
import re
import asyncio
import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from evidence import project
import test_native_pipeline as native_fixture
import task_contract
from task_contract import configure, read_request, digest, atomic_json
from planning import packet, complete, decide, require_plan
from operator_cli import review_packet, approve
from writing_contract import require_approval
from materials import import_materials
from local_papers import load_local, import_pdfs
from generation_errors import GenerationError


class QuickEvidenceTest(unittest.TestCase):


    def amendment_fixture(self, local=False):
        fixture=native_fixture.NativeTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        configure(fixture.ws,{'execution':{'mode':'standard'},'outline_review':'required',
                              'publication':{'format':'markdown'}})
        if local:
            source=fixture.ws/'provided.pdf'
            document=pdf_fixture.open()
            page=document.new_page()
            page.insert_text((50,90),'A source-backed finding.')
            document.save(source)
            document.close()
            import_pdfs(fixture.ws,{'files':[{'path':str(source),'title':'Actual source',
                                             'authors':['Actual Author'],'year':2024}]})
        plan=packet(fixture.ws)
        complete(fixture.ws,{'packet_id':plan['packet_id'],'snapshot_id':digest(plan['snapshot']),
                 'request_id':'request','started_at':0,'deadline_at':300,
                 'decision':{'answers':{'request':'Proceed.'}}})
        resolution={'packet_id':plan['packet_id'],'action':'proceed'}
        decide(fixture.ws,resolution)
        choices={'formats':['markdown'],'templates':[],
                 'citation_styles':[{'id':'numeric','usable':True},{'id':'author_year','usable':True}]}
        options=patch('publication.publication_options',return_value=choices)
        options.start()
        self.addCleanup(options.stop)
        outline=review_packet(fixture.ws)
        decision={'packet_id':outline['packet_id'],'user_response':'Approve and use author-year citations.',
                  'publication':{'citation_style':'author_year'}}
        return fixture,decision,resolution

    def test_publication_amendment_continues_and_replays(self):
        fixture,decision,_=self.amendment_fixture()
        approved=approve(fixture.ws,decision)
        require_plan(fixture.ws)
        require_approval(fixture.ws)
        self.assertEqual(read_request(fixture.ws)['publication']['citation_style'],'author_year')
        self.assertEqual(approve(fixture.ws,decision),approved)
        with self.assertRaises(ValueError):
            approve(fixture.ws,{**decision,'user_response':'Different decision'})
        configure(fixture.ws,{'effective_requirements':'An unrelated research scope change.'})
        with self.assertRaises(ValueError):
            approve(fixture.ws,decision)

    def test_publication_amendment_preserves_local_material_binding(self):
        fixture,decision,_=self.amendment_fixture(local=True)
        before=json.loads((fixture.ws/'_status/plan_decision.json').read_text())['approved_snapshot']['local_materials']
        approve(fixture.ws,decision)
        require_plan(fixture.ws)
        require_approval(fixture.ws)
        after=json.loads((fixture.ws/'_status/plan_decision.json').read_text())['approved_snapshot']['local_materials']
        self.assertEqual(after,before)

    def test_publication_amendment_recovers_configuration_failure(self):
        fixture,decision,resolution=self.amendment_fixture()
        with patch('operator_cli.configure',side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):
                approve(fixture.ws,decision)
        path=fixture.ws/'_status/plan_decision.json'
        pending=path.read_bytes()
        with self.assertRaises(ValueError):
            decide(fixture.ws,resolution)
        self.assertEqual(path.read_bytes(),pending)
        with self.assertRaises(ValueError):
            approve(fixture.ws,{**decision,'user_response':'Different decision'})
        self.assertEqual(path.read_bytes(),pending)
        approve(fixture.ws,decision)
        require_plan(fixture.ws)
        require_approval(fixture.ws)

    def test_publication_format_amendment_records_the_actual_template(self):
        fixture,decision,_=self.amendment_fixture()
        decision['publication']={'format':'docx'}
        decision['user_response']='Approve this outline and deliver Word.'
        choices={'formats':['markdown','docx'],'templates':[],
                 'citation_styles':[{'id':'numeric','usable':True}]}
        with patch('publication.publication_options',return_value=choices):
            result=approve(fixture.ws,decision)
        self.assertEqual(result['publication']['template'],'word')
        require_plan(fixture.ws)
        require_approval(fixture.ws)

    def test_publication_amendment_recovers_approval_failure(self):
        fixture,decision,_=self.amendment_fixture()
        def interrupted(destination,value):
            if Path(destination)==fixture.ws/'04_outline/approval.json':
                raise OSError('interrupted')
            return atomic_json(destination,value)
        with patch('operator_cli.atomic_json',side_effect=interrupted):
            with self.assertRaises(OSError):
                approve(fixture.ws,decision)
        with self.assertRaises(ValueError):
            require_plan(fixture.ws)
        approve(fixture.ws,decision)
        require_plan(fixture.ws)
        require_approval(fixture.ws)

    def test_pending_publication_amendment_rejects_scope_change(self):
        fixture,decision,_=self.amendment_fixture()
        with patch('operator_cli.configure',side_effect=OSError('interrupted')):
            with self.assertRaises(OSError):
                approve(fixture.ws,decision)
        configure(fixture.ws,{'effective_requirements':'An unrelated research scope change.'})
        with self.assertRaises(ValueError):
            approve(fixture.ws,decision)
        with self.assertRaises(ValueError):
            require_plan(fixture.ws)


    def test_publication_amendment_recovers_request_written_before_view_failure(self):
        fixture,decision,_=self.amendment_fixture()
        with patch('task_contract.sync_views',side_effect=OSError('views interrupted')):
            with self.assertRaises(OSError):
                approve(fixture.ws,decision)
        self.assertEqual(read_request(fixture.ws)['publication']['citation_style'],'author_year')
        with patch('task_contract.sync_views',wraps=task_contract.sync_views) as synchronize:
            approve(fixture.ws,decision)
            synchronize.assert_called_once()
        require_plan(fixture.ws)
        require_approval(fixture.ws)
    def test_extra_outline_approval_keeps_unchanged_task_and_front_plan(self):
        fixture=native_fixture.NativeTest()
        fixture.setUp()
        try:
            configure(fixture.ws,{'execution':{'mode':'standard'},'outline_review':'required',
                                  'publication':{'format':'markdown'}})
            plan=packet(fixture.ws)
            complete(fixture.ws,{'packet_id':plan['packet_id'],'snapshot_id':digest(plan['snapshot']),
                     'request_id':'request','started_at':0,'deadline_at':300,
                     'decision':{'answers':{'request':'Proceed.'}}})
            decide(fixture.ws,{'packet_id':plan['packet_id'],'action':'proceed'})
            before=(fixture.ws/'01_input/writing_request.json').read_bytes()
            choices={'formats':['markdown'],'templates':[],
                     'citation_styles':[{'id':'numeric','usable':True}]}
            with patch('publication.publication_options',return_value=choices):
                outline=review_packet(fixture.ws)
                approve(fixture.ws,{'packet_id':outline['packet_id'],'user_response':'Use this outline.',
                                    'publication':outline['publication']})
            self.assertEqual((fixture.ws/'01_input/writing_request.json').read_bytes(),before)
            require_plan(fixture.ws)
            require_approval(fixture.ws)
        finally:
            fixture.doCleanups()

    def test_standard_docx_retains_one_markdown_source_refinement(self):
        fixture=native_fixture.NativeTest()
        fixture.setUp()
        try:
            configure(fixture.ws,{'execution':{'mode':'standard'},'outline_review':'plan',
                                  'publication':{'format':'docx'}})
            plan=packet(fixture.ws)
            complete(fixture.ws,{'packet_id':plan['packet_id'],'snapshot_id':digest(plan['snapshot']),
                     'request_id':'request','started_at':0,'deadline_at':300,
                     'decision':{'answers':{'request':'Proceed.'}}})
            decide(fixture.ws,{'packet_id':plan['packet_id'],'action':'proceed'})
            model=native_fixture.Model()
            result=fixture.run_pipeline(model)
            self.assertIn('start the actual publication step using the new revision',result['next_action'])
            self.assertIn('Run workflow publish only after publication is in_progress',result['next_action'])
            self.assertEqual(len(model.calls),4)
            self.assertIn('sources',model.calls[-1])
            self.assertEqual(model.calls[-1]['output_format'],'markdown')
            self.assertEqual(native_fixture.publish(fixture.ws)['format'],'docx')
            configure(fixture.ws,{'publication':{'format':'latex_pdf'}})
            with self.assertRaisesRegex(ValueError,'different native source'):
                native_fixture.publish(fixture.ws)
        finally:
            fixture.doCleanups()



    def test_selected_material_is_bound_to_actual_reference_and_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            workspace = root/'review'
            configure(workspace, {'intent':'Use selected papers only', 'output_scope':'section',
                                 'sources':{'policy':'provided_only','refs':['literature:one']}})
            target = workspace/'01_input/paper.txt'
            payload = b'A real source paragraph with a bounded supported finding.'
            target.write_bytes(payload)
            receipt = {'ok':True,'state':'ready','ref_id':'literature:one',
                       'target':'review/01_input/paper.txt','revision':'actual-revision',
                       'digest':hashlib.sha256(payload).hexdigest(),'text_bytes':len(payload),
                       'page_count':1,'materializer_version':'pdfium-text-v2','reused':False}
            request = {'items':[{'ref_id':'literature:one','title':'Actual paper','receipt':receipt}]}
            with patch('materials.Path.cwd',return_value=root):
                import_materials(workspace,request)
                self.assertEqual(len(load_local(workspace)),1)
                receipt['ref_id']='literature:other'
                with self.assertRaises(ValueError):
                    import_materials(workspace,request)


if __name__ == '__main__':
    unittest.main()
