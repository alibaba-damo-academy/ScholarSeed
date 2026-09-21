from task_fixtures import prepare_planned, planned_outline, plan_table, set_planned_assets
"""Figure-author evidence, request separation and caption transport contracts."""
import copy
import hashlib
from io import BytesIO
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import pypdfium2

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'lib'),str(ROOT/'scripts'),str(ROOT/'scripts/generation/figures/_fast')]
from figure_caption import caption_text, caption_latex, caption_errors
import manuscript as m
import test_manuscript
from operator_cli import figure_plan
from write_latex import _emit
from latex_to_markdown import scan_figures,render_figure_md
import generate_images
from PIL import Image,ImageDraw


class CaptionTest(unittest.TestCase):
    setUp=test_manuscript.ManuscriptTest.setUp
    put=test_manuscript.ManuscriptTest.put
    set_publication=test_manuscript.ManuscriptTest.set_publication
    draft=test_manuscript.ManuscriptTest.draft

    def test_packets_keep_section_intent_and_complete_evidence_without_stale_body(self):
        cards=m.read(self.ws/'03_process/paper_cards.json')
        cards['p1']['card']['experiments']={'result':'Relevant numeric result','conditions':['Only under a fixed budget'],'formula':'x = f(y)'}
        cards['p2']={**copy.deepcopy(cards['p1']),'title':'Other evidence'}
        self.put('03_process/paper_cards.json',cards)
        selected=m.read(self.ws/'02_retrieval/selected_paper.json');selected['p2']={**selected['p1'],'title':'Other evidence'}
        self.put('02_retrieval/selected_paper.json',selected)
        self.put('03_process/cite_keys.json',{'p1':'First2024','p2':'Second2024'})
        self.put('05_generation/section_drafts/1.json',{'body_md':'STALE MANUSCRIPT BODY'})
        out=prepare_planned(self.ws,{'figures':[{'figure_id':'F1','section_id':'1','caption':'Explain the mechanism','paper_ids':['p1']},
                                        {'figure_id':'F2','section_id':'2','caption':'Explain the evidence boundaries'}]})
        brief=m.read(self.ws/'05_generation/_internal/figure_brief.json')
        evidence=m.read(Path(brief['evidence_path']))['papers']
        self.assertEqual(evidence['p1']['card']['experiments'],cards['p1']['card']['experiments'])
        first=m.read(Path(brief['figures'][0]['authoring_packet']))
        second=m.read(Path(brief['figures'][1]['authoring_packet']))
        self.assertEqual(first['evidence']['paper_ids'],['p1'])
        self.assertEqual(second['evidence']['paper_ids'],['p1','p2'])
        self.assertEqual(second['figure']['evidence_scope'],'corpus')
        self.assertIn('Compare mechanisms',first['figure']['section_description'])
        self.assertNotIn('STALE MANUSCRIPT BODY',json.dumps(first)+json.dumps(brief)+json.dumps(evidence))
        self.assertEqual(first['preparation_id'],out['preparation_id'])

    def test_plain_caption_survives_latex_and_markdown(self):
        caption='The AT&T model_v2 compares 12% coverage, $5 cost and the literal { brace.'
        self.assertEqual(caption_text(r'12\% on AT\&T model\_v2.'),'12% on AT&T model_v2.')
        item={'figure_id':'F1','label':'fig:F1','_render_mode':'image','_generated':True,'_caption':caption}
        text=_emit(item)
        self.assertIn(r'12\%',text);self.assertIn(r'AT\&T',text);self.assertIn(r'model\_v2',text)
        figures=self.ws/'05_generation/figures';figures.mkdir(parents=True,exist_ok=True)
        (figures/'F1.tex').write_text(text)
        scanned=scan_figures(figures,[item])['F1']
        self.assertEqual(scanned['caption_plain'],caption)
        md=render_figure_md(scanned,1)
        self.assertIn('12% coverage',md);self.assertIn('AT&T',md);self.assertIn(r'model\_v2',md)
        self.assertIn('literal \\{ brace.',md)
        self.assertNotIn('\\caption',md)
        self.assertNotIn('\\label',md)
        import shutil,subprocess
        if shutil.which('pdflatex'):
            Image.new('RGB',(300,120),'navy').save(figures/'F1.png')
            document=figures.parent/'caption-test.tex'
            document.write_text(r'\documentclass{article}\usepackage[T1]{fontenc}\usepackage{graphicx}\begin{document}'+text+r'\end{document}')
            run=subprocess.run(['pdflatex','-interaction=nonstopmode','-halt-on-error',document.name],cwd=document.parent,capture_output=True,text=True)
            self.assertEqual(run.returncode,0,run.stdout[-2000:])
            with pypdfium2.PdfDocument(document.with_suffix('.pdf')) as pdf:
                rendered=' '.join(' '.join(pdf[index].get_textpage().get_text_bounded() for index in range(len(pdf))).split())
            self.assertIn('12% coverage',rendered)
            self.assertIn('AT&T',rendered)
            self.assertIn('literal { brace.',rendered)

    def test_bad_caption_is_rejected_atomically_before_generation(self):
        ready=prepare_planned(self.ws,{'figures':[{'figure_id':'F1','section_id':'1','caption':'Explain the mechanism','paper_ids':['p1']}]})
        path=self.ws/'05_generation/_internal/figures_worklist.json';before=path.read_bytes()
        for caption in ('Figure 1: Diagram',r'\caption{Nested caption}',r'Results \citep{First2024}.','First2024 explains it.'):
            plan={'preparation_id':ready['preparation_id'],'items':[{'figure_id':'F1','_render_mode':'image',
                    '_prompt':'Draw a conditional mechanism with two named stages.','_caption':caption,'_image_size':'wide'}]}
            with self.assertRaises(ValueError):figure_plan(self.ws,plan)
            self.assertEqual(path.read_bytes(),before)
        with self.assertRaises(ValueError):_emit({'figure_id':'F1','label':'fig:F1','caption_skeleton':'Not a final caption'})

    def test_caption_only_edit_reuses_raster_and_rewrites_wrapper(self):
        ready=prepare_planned(self.ws,{'figures':[{'figure_id':'F1','section_id':'1','caption':'Explain the mechanism'}]})
        plan={'preparation_id':ready['preparation_id'],'items':[{'figure_id':'F1','_render_mode':'image',
                '_prompt':'Draw a left-to-right pipeline labelled Input, Transformation and Output; arrows show the data flow.',
                '_caption':'The pipeline links input, transformation and output.','_image_size':'wide'}]}
        figure_plan(self.ws,plan)
        path=self.ws/'05_generation/_internal/figures_worklist.json';work=m.read(path);item=work['items'][0]
        cfg={'model':'fixture','_stage':'figures_image','base_url':'https://fixture.invalid'}
        canvas=Image.new('RGB',(600,300),'white');ImageDraw.Draw(canvas).rectangle((20,50,580,230),fill='navy')
        buf=BytesIO();canvas.save(buf,format='PNG')
        attempts=[{'ok':True,'model':'fixture','stage':'figures_image','size':'1536x1024'}]
        ws=types.SimpleNamespace(root=self.ws,figures_dir=self.ws/'05_generation/figures')
        with patch.object(generate_images,'_request_image',return_value=(buf.getvalue(),'',attempts)) as request:
            ok,error,extra=generate_images._generate_image(ws,cfg,item);self.assertTrue(ok,error)
            self.assertEqual(request.call_args.args[1],item['_prompt'])
            item.update(extra);item['_generated']=True;m.save(path,work)
            png=(ws.figures_dir/'F1.png').read_bytes();old_wrapper=_emit(item)
            figure_plan(self.ws,{'preparation_id':ready['preparation_id'],'items':[{'figure_id':'F1','_caption':'The three stages organize the input-to-output data flow.'}]})
            changed=m.read(path)['items'][0]
            ok,error,extra=generate_images._generate_image(ws,cfg,changed)
            self.assertTrue(ok,error);self.assertNotIn('cached',extra['_image_meta'])
            self.assertEqual(request.call_count,1);self.assertEqual(png,(ws.figures_dir/'F1.png').read_bytes())
            self.assertNotEqual(old_wrapper,_emit(changed))


if __name__=='__main__':unittest.main()
