"""Chapter packet and prerequisite behavior; native end-to-end tests are separate."""
import copy
import json
import unittest
from pathlib import Path
from test_native_pipeline import NativeTest as _Fixture
from chapter_plan import compile_plan
from chapter_pipeline import packet_for
from asset_plan import derive
from task_contract import atomic_json
from manuscript import prepare
from figure_dependencies import context

# Do not collect the imported fixture class a second time.
Fixture=_Fixture
del _Fixture

class PacketTest(unittest.TestCase):
    def setUp(self):
        self.fixture=Fixture();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.ws=self.fixture.ws

    def test_terminal_packets_receive_full_corpus_and_raw_protocol(self):
        prepare(self.ws)
        p=json.loads((self.ws/'05_generation/_internal/chapter_packets/0.json').read_text())
        self.assertEqual(p['assigned_paper_ids'],['p1'])
        self.assertNotIn('response_skeleton',p)
        self.assertIn('conditional mechanism',p['evidence'])
        self.assertEqual(len(p['confirmed_full_outline']['outline_tree']),3)

    def test_dependency_cycle_rejected_before_call(self):
        outline=copy.deepcopy(self.fixture.outline)
        outline['outline_tree'][1]['depends_on']=['2']
        with self.assertRaisesRegex(ValueError,'cycle'):compile_plan(outline,{'p1'})

    def test_figure_context_reads_completed_native_chapter(self):
        outline=self.fixture.outline
        outline['outline_tree'][0]['role']='foundation';outline['outline_tree'][0]['paper_ids']=['p1']
        outline['prerequisites']=[{'id':'P1','kind':'notation','requirement':'Define notation','owner_section_id':'0'}]
        outline['outline_tree'][1]['requires']=['P1']
        outline['outline_tree'][1]['figures']=[{'figure_id':'F1','purpose':'Show relation','content_plan':'Actual relation',
            'caption_draft':'Relation.','visual_guidance':'Simple','paper_ids':['p1']}]
        atomic_json(self.ws/'04_outline/outline.json',outline);prepare(self.ws)
        self.assertEqual(context(self.ws,'F1')['status'],'WAITING')
        p=self.ws/'05_generation/chapters/0.tex';p.parent.mkdir(parents=True);p.write_text('Actual prerequisite prose.')
        result=context(self.ws,'F1')
        self.assertEqual(result['status'],'READY')
        self.assertEqual(result['sections'][0]['body_md'],'Actual prerequisite prose.')

def load_tests(loader,tests,pattern):
    return loader.loadTestsFromTestCase(PacketTest)
