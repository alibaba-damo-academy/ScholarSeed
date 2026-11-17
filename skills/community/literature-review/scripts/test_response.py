import copy
import json
import unittest

import test_native_pipeline as fixtures
from evidence import ensure, read, save
from generation.output_spec import read_output_spec
from outlining import build_prompt
from response import import_outline
from task_contract import configure, read_request
from task_input import task_input


class ResponseBindingTest(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.NativeTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.workspace=self.fixture.ws
        self.request_id='a'*32
        self.directory=self.workspace/'_logs/llm'/self.request_id
        evidence=read(ensure(self.workspace,'outline')['artifacts'][0])
        messages,adapter=build_prompt(task_input(self.workspace),read_request(self.workspace),
                                      evidence,read_output_spec(self.workspace)['format'])
        adapter['request_id']=self.request_id
        save(self.directory/'outline_adapter.json',adapter)
        save(self.directory/'request.json',{'stage':'outline','messages':messages})
        outline=copy.deepcopy(self.fixture.outline)
        for section in outline['outline_tree']:
            section['paper_ids']=['P01'] if section['paper_ids'] else []
        outline['outline_tree'][1]['description']='Explain [[paper:P01]] under its stated conditions.'
        self.source=self.workspace/'external.json'
        save(self.source,outline)
        self.value={'request_id':self.request_id,'response_path':str(self.source)}

    def test_import_retains_each_raw_response_and_conversion_record(self):
        original=self.source.read_bytes()
        first=import_outline(self.workspace,self.value)
        second=import_outline(self.workspace,self.value)
        self.assertNotEqual(first['candidate_path'],second['candidate_path'])
        self.assertEqual(self.source.read_bytes(),original)
        self.assertEqual(len(list((self.directory/'imports').glob('*/response.txt'))),2)
        report=read(first['normalization'])
        self.assertTrue(any(change.get('cite_key')=='Keyp1' for change in report['changes']))
        self.assertIn(r'\cite{Keyp1}',read(self.workspace/'04_outline/outline.json')['outline_tree'][1]['description'])

    def test_map_edit_cannot_silently_rebind_a_response(self):
        original=(self.workspace/'04_outline/outline.json').read_bytes()
        adapter=read(self.directory/'outline_adapter.json')
        adapter['papers']['P01']['cite_key']='Wrong2024'
        save(self.directory/'outline_adapter.json',adapter)
        with self.assertRaisesRegex(ValueError,'mapping changed'):
            import_outline(self.workspace,self.value)
        self.assertEqual((self.workspace/'04_outline/outline.json').read_bytes(),original)

    def test_task_revision_cannot_consume_an_old_request(self):
        configure(self.workspace,{'language':'CHINESE'})
        with self.assertRaisesRegex(ValueError,'inputs changed'):
            import_outline(self.workspace,self.value)


if __name__=='__main__':
    unittest.main()
