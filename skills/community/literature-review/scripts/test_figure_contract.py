import copy
from pathlib import Path
import unittest
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'lib'))
from figure_contract import image_prompt
from figure_authoring import authoring_packet, PROMPT_GUIDANCE, CAPTION_GUIDANCE


class FigureContractTest(unittest.TestCase):
    def test_only_authored_prompt_reaches_image_api(self):
        item={'figure_id':'F1','_prompt':'Draw two stages with Chinese labels and a blue data-flow arrow.',
              '_caption':'The two stages exchange data.','caption_skeleton':'Explain the mechanism',
              'task':{'effective_requirements':'SECRET_TASK_CONTEXT'},'outline_plan':{'note':'PLAN_METADATA'}}
        before=copy.deepcopy(item)
        self.assertEqual(image_prompt(item),item['_prompt'])
        self.assertEqual(item,before)
        changed={**item,'_caption':'Revised publication wording.','caption_skeleton':'Changed source brief'}
        self.assertEqual(image_prompt(changed),image_prompt(item))
        self.assertNotEqual(image_prompt({**item,'_prompt':'Draw a different mechanism.'}),image_prompt(item))

    def test_task_exceptions_belong_in_authoring_packet(self):
        request={'effective_requirements':'Chinese caption; English labels only in F2; cartoon style.'}
        item={'figure_id':'F2','paper_ids':['p1'],'section_description':'Explain a conditional relation.'}
        packet=authoring_packet(item,request,'evidence.json','preparation')
        self.assertEqual(packet['task'],request)
        self.assertEqual(packet['prompt_guidance'],PROMPT_GUIDANCE)
        self.assertEqual(packet['caption_guidance'],CAPTION_GUIDANCE)
        self.assertEqual(packet['evidence']['paper_ids'],['p1'])
        self.assertEqual(packet['figure']['section_description'],item['section_description'])
        self.assertNotEqual(packet['prompt_guidance'],packet['caption_guidance'])


if __name__=='__main__':unittest.main()
