from task_fixtures import prepare_planned, planned_outline, plan_table, set_planned_assets
import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from task_fixtures import task, set_publication
from unittest.mock import patch

import manuscript as m
from writing_contract import digest, load_outline

class ManuscriptTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.ws=Path(self.tmp.name)
        self.put('01_input/query.json',{'query':'Compare supported mechanisms','language':'english'})
        self.put('01_input/writing_request.json',{'output_scope':'survey'})
        cards={'p1':{'title':'First evidence','year':2024,'common_fields':{'tldr':'A conditional result.'},'card':{'method':{'description':'A conditional result.'}},'abstract':'Original abstract.'}}
        self.put('03_process/paper_cards.json',cards);self.put('03_process/cite_keys.json',{'p1':'First2024'})
        self.put('02_retrieval/selected_paper.json',{'p1':{'title':'First evidence','year':2024,'abstract':'Original abstract.','authors':['A. Author']}})
        self.put('04_outline/outline.json',{'survey_title':'Mechanisms','topic':'Mechanisms','outline_tree':[
            {'section_id':'1','title':'Mechanisms','description':'Compare mechanisms and assumptions.'},
            {'section_id':'2','title':'Limits','description':'Explain evidence limitations.'}]})
        self.set_publication({'format':'markdown','citation_style':'author_year'})
    def put(self,p,v):
        if p=="04_outline/outline.json":v=planned_outline(v)
        if p=='01_input/writing_request.json':
            v=task(v)
            if (self.ws/p).exists(): v['publication']=m.read(self.ws/p).get('publication',{})
        m.save(self.ws/p,v)
    def set_publication(self,value):set_publication(self.ws,value)
    def draft(self):return {'sections':[{'section_id':'1','body_md':r'A conditional mechanism follows from the evidence \citep{First2024}.'},
        {'section_id':'2','body_md':r'The evidence leaves important conditions unresolved \citep{First2024}.'}]}







if __name__=='__main__':unittest.main()
