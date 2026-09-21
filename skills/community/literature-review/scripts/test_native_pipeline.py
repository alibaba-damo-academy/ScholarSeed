"""Offline behavior tests for raw chapters, complete-v1 refinement and editable v2."""
import asyncio
import base64
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(ROOT/'lib'),str(ROOT/'scripts')]
import slr_paths
slr_paths.bootstrap(__file__)
from task_contract import configure,atomic_json
from paper_materials import source_identity
from chapter_pipeline import generate
from manuscript import prepare
from manuscript_delta import apply_delta
from manuscript_publication import publish,audit
from generation_errors import GenerationError

CFG={'provider':'qwen','model':'fixture','base_url':'http://fixture.invalid','api_key':'fixture',
     'context_window':1000000,'capacity_verified':{'model_max_output':131072},'max_tokens':32768,
     'max_attempts':1,'timeout':5,'request_deadline_sec':5,'figure_wait_timeout_sec':1}


class Model:
    def __init__(self):self.calls=[];self.systems=[];self.fail=None;self.bad_delta=False;self.active=0;self.peak=0
    async def chat_stream(self,messages,**kwargs):
        packet=json.loads(messages[1]['content']);self.calls.append(packet);self.systems.append(messages[0]['content'])
        assert 'response_format' not in kwargs  # Chapters are not JSON strings.
        if 'sources' in packet:
            if self.bad_delta:text='not a valid delta'
            else:text=json.dumps({'edits':[{'target':'main','before':'Mechanisms vary',
                    'after':'Mechanisms differ','reason':'Terminology'}] if 'Mechanisms vary' in packet['sources']['main'] else [],'issues':[]})
        else:
            sid=packet['chapter_ids'][0]
            self.active+=1;self.peak=max(self.peak,self.active)
            await asyncio.sleep(.01);self.active-=1
            if self.fail==sid:raise ConnectionError('fixture transport failure')
            text=(r'Mechanisms vary. $\bm{X}=\bm{U}\bm{V}^{\top}$. \citep{Keyp1}.'
                  if sid=='1' else 'A bounded synthesis of the evidence.')
            if packet['shared_figures']:text+=r' Figure~\ref{fig:F1} explains the relationship.'
        kwargs['_capture'].update(finish_reason='stop',usage={},partial_response=text)
        return text


class NativeTest(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix='slr-native-');self.addCleanup(temp.cleanup)
        self.ws=Path(temp.name)
        configure(self.ws,{'intent':'Review mechanisms; continue automatically.',
            'outline_review':'auto','auto_authorization':'continue automatically',
            'publication':{'format':'latex_pdf'},'language':'ENGLISH'})
        paper={'paperId':'p1','title':'Evidence','year':2024,'authors':[{'name':'Ada Example'}],
            'abstract':'A bounded supported result.','reading_depth':'metadata_only','paper_type':'method',
            'card':{'method':{'description':'A conditional mechanism'}}}
        card={**paper,'material_sha256':source_identity(paper,None)}
        atomic_json(self.ws/'02_retrieval/selected_paper.json',{'p1':paper})
        atomic_json(self.ws/'03_process/paper_cards.json',{'p1':card})
        atomic_json(self.ws/'03_process/cite_keys.json',{'p1':'Keyp1'})
        (self.ws/'03_process/references.bib').write_text('@article{Keyp1,author={Ada Example},title={Evidence},year={2024},journal={Journal}}')
        def chapter(sid,title,role):return {'section_id':sid,'title':title,'role':role,
            'description':'Explain conditional evidence.','paper_ids':['p1'] if role=='analysis' else [],
            'requires':[],'analysis_tasks':[{'task_id':'A1','kind':'compare','question':'Which mechanisms?',
                'completion':'State supported differences.'}] if role=='analysis' else []}
        self.outline={'survey_title':'Mechanisms','topic':'Mechanisms','description':'Conditional mechanisms',
            'review_thesis':'What mechanisms are supported?','organizing_axis':'Conditions', 'prerequisites':[],
            'outline_tree':[chapter('0','Abstract','abstract'),chapter('1','Mechanisms','analysis'),
                            chapter('2','Conclusion','conclusion')]}
        atomic_json(self.ws/'04_outline/outline.json',self.outline)

    def run_pipeline(self,model):return asyncio.run(generate(self.ws,CFG,CFG,model))

    def test_raw_parallel_complete_template_refinement_and_handoff(self):
        model=Model();out=self.run_pipeline(model)
        self.assertEqual(model.peak,3);self.assertEqual(len(model.calls),4)
        self.assertEqual(out['status'],'SUCCESS')
        refine=model.calls[-1];self.assertIn(r'\documentclass',refine['sources']['main'])
        self.assertIn(r'\usepackage{bm}',refine['sources']['main'])
        self.assertIn('citations.bib',refine['sources'])
        self.assertIn('conditional',refine['evidence'].lower())
        self.assertEqual(refine['resolved_section_languages'],
                         {'0':'english','1':'english','2':'english'})
        gen=self.ws/'05_generation';v2=gen/'full_draft_v2.tex'
        self.assertIn('Mechanisms differ',v2.read_text())
        self.assertIn('Mechanisms vary',(gen/'full_draft_v1.tex').read_text())
        self.assertFalse((gen/'manuscript.json').exists())
        self.assertFalse((gen/'full_draft_v3.tex').exists())
        for p in gen.rglob('*.json'):
            if p.name in ('writing_evidence.json','evidence_index.json'):continue
            self.assertNotIn('sha256',p.read_text(),str(p))
        v2.write_text(v2.read_text()+'\n% Main edit\n')
        self.run_pipeline(model);self.assertEqual(len(model.calls),4)
        self.assertIn('Main edit',v2.read_text())

    def test_fixed_opening_is_last_prompt_and_saved_once(self):
        from chapter_pipeline import chapter_messages
        self.run_pipeline(Model())
        gen=self.ws/'05_generation'
        packet=json.loads((gen/'_internal/chapter_packets/1.json').read_text())
        opening=packet['chapter_opening']
        self.assertEqual(opening,'\\section{Mechanisms}\n\\label{sec:s1}\n\n')
        messages=chapter_messages(packet)
        self.assertTrue(messages[-1]['content'].endswith(opening))
        chapter=(gen/'chapters/1.tex').read_text();v1=(gen/'full_draft_v1.tex').read_text()
        self.assertTrue(chapter.startswith(opening))
        self.assertEqual(chapter.count(r'\section{Mechanisms}'),1)
        self.assertEqual(v1.count(r'\section{Mechanisms}'),1)
        self.assertEqual(v1.count(r'\label{sec:s1}'),1)
        abstract=(gen/'chapters/0.tex').read_text()
        self.assertEqual(abstract.count(r'\begin{abstract}'),1)
        self.assertEqual(abstract.count(r'\end{abstract}'),1)
        self.assertEqual(v1.count(r'\begin{abstract}'),1)

    def test_default_and_override_languages_are_hard_injected_into_chapter_packets(self):
        configure(self.ws,{'language':'CHINESE'})
        self.outline['outline_tree'][0]['title']='摘要'
        self.outline['outline_tree'][0]['language']='english'
        self.outline['outline_tree'][1]['language']='default'
        self.outline['outline_tree'][1]['figures']=[{'figure_id':'F1','purpose':'Explain mechanisms',
            'content_plan':'Show the supported relationship','caption_draft':'机制关系。',
            'visual_guidance':'Simple diagram','paper_ids':['p1']}]
        self.outline['outline_tree'][2]['language']='default'
        atomic_json(self.ws/'04_outline/outline.json',self.outline)
        prepare(self.ws)
        packets=self.ws/'05_generation/_internal/chapter_packets'
        abstract=json.loads((packets/'0.json').read_text())
        body=json.loads((packets/'1.json').read_text())
        contract=json.loads((self.ws/'05_generation/_internal/manuscript_contract.json').read_text())
        self.assertEqual((abstract['output_language'],abstract['language_source']),('english','outline_override'))
        self.assertEqual((body['output_language'],body['language_source']),('chinese','default'))
        self.assertEqual(contract['resolved_section_languages'],{'0':'english','1':'chinese','2':'chinese'})
        self.assertEqual(contract['publication']['language'],'chinese')
        figures=json.loads((self.ws/'05_generation/_internal/figures_worklist.json').read_text())
        self.assertEqual(figures['items'][0]['language'],'chinese')
        self.assertIn('packet\'s output_language',__import__('chapter_pipeline').CHAPTER_GUIDANCE)

    def test_chinese_default_keeps_default_abstract_chinese(self):
        configure(self.ws,{'language':'CHINESE'})
        self.outline['outline_tree'][0]['title']='摘要'
        for section in self.outline['outline_tree']:section['language']='default'
        atomic_json(self.ws/'04_outline/outline.json',self.outline)
        prepare(self.ws)
        packet=json.loads((self.ws/'05_generation/_internal/chapter_packets/0.json').read_text())
        self.assertEqual(packet['chapter_kind'],'abstract')
        self.assertEqual(packet['output_language'],'chinese')
        self.assertEqual(packet['language_source'],'default')

    def test_table_guidance_is_conditional_and_preflight_dynamically_guides_refine(self):
        self.outline['outline_tree'][1]['tables']=[{
            'table_id':'T1','purpose':'Compare mechanisms.','content_plan':'One row per mechanism.',
            'caption_draft':'Mechanism comparison.','row_unit':'Mechanism',
            'comparison_dimensions':['Guarantee','Assumption'],'paper_ids':['p1']}]
        atomic_json(self.ws/'04_outline/outline.json',self.outline)
        class BareTable(Model):
            async def chat_stream(self,messages,**kwargs):
                packet=json.loads(messages[1]['content'])
                if packet.get('chapter_ids')==['1']:
                    self.calls.append(packet);self.systems.append(messages[0]['content'])
                    text=(r'Mechanisms vary. Table~\ref{tab:T1} compares them. '
                          r'\begin{table}[htbp]\centering\caption{Comparison}\label{tab:T1}'
                          r'\begin{tabular}{lllll}\toprule A&B&C&D&E\\\midrule\ '
                          r'Method\citep{Keyp1}&Long mechanism&Long guarantee&Long assumption&Limit\\'
                          r'\bottomrule\end{tabular}\end{table}')
                    kwargs['_capture'].update(finish_reason='stop',usage={},partial_response=text)
                    return text
                return await super().chat_stream(messages,**kwargs)
        model=BareTable();self.run_pipeline(model)
        chapter_index=next(i for i,p in enumerate(model.calls) if p.get('chapter_ids')==['1'])
        self.assertIn('TABLE AUTHORING CONTRACT',model.systems[chapter_index])
        refine=model.calls[-1]
        self.assertIn('table_layout_warnings',refine)
        self.assertIn('bare_tabular_without_resizebox_or_tabularx',
                      str(refine['table_layout_warnings']))
        self.assertIn('stray_backslash_after_rule_command',
                      str(refine['table_layout_warnings']))
        self.assertIn('TABLE LAYOUT REPAIR',model.systems[-1])

    def test_passing_tables_add_nothing_table_specific_to_refinement(self):
        self.outline['outline_tree'][1]['tables']=[{
            'table_id':'T1','purpose':'Compare mechanisms.','content_plan':'One row per mechanism.',
            'caption_draft':'Mechanism comparison.','row_unit':'Mechanism',
            'comparison_dimensions':['Guarantee'],'paper_ids':['p1']}]
        atomic_json(self.ws/'04_outline/outline.json',self.outline)
        class SafeTable(Model):
            async def chat_stream(self,messages,**kwargs):
                packet=json.loads(messages[1]['content'])
                if packet.get('chapter_ids')==['1']:
                    self.calls.append(packet);self.systems.append(messages[0]['content'])
                    text=(r'Mechanisms vary. Table~\ref{tab:T1} compares them. '
                          r'\begin{table}[htbp]\centering\caption{Comparison}\label{tab:T1}'
                          r'\begin{tabularx}{\linewidth}{>{\raggedright\arraybackslash}X'
                          r'>{\raggedright\arraybackslash}X}\toprule Mechanism&Guarantee\\\midrule '
                          r'\citet{Keyp1}&Conditional result\\\bottomrule\end{tabularx}\end{table}')
                    kwargs['_capture'].update(finish_reason='stop',usage={},partial_response=text)
                    return text
                return await super().chat_stream(messages,**kwargs)
        model=SafeTable();self.run_pipeline(model)
        refine=model.calls[-1]
        self.assertNotIn('table_layout_warnings',refine)
        self.assertNotIn('TABLE LAYOUT REPAIR',model.systems[-1])
        self.assertNotIn('table layout',model.systems[-1].lower())
        report=json.loads((self.ws/'05_generation/_status/table_layout_precheck.json').read_text())
        self.assertEqual(report['status'],'SUCCESS',report)

    def test_asset_warnings_feed_single_refinement_preserving_raw_chapters(self):
        self.outline['outline_tree'][1]['tables']=[{
            'table_id':'T1','purpose':'Compare mechanisms.','content_plan':'One row per mechanism.',
            'caption_draft':'Mechanism comparison.','row_unit':'Mechanism',
            'comparison_dimensions':['Guarantee'],'paper_ids':['p1']}]
        atomic_json(self.ws/'04_outline/outline.json',self.outline)
        from test_native_asset_checks import table
        planned=table(caption='表1总结了现有方法。')
        extra=table('tab:extra','Additional supported comparison.')
        class RepairAssets(Model):
            async def chat_stream(self,messages,**kwargs):
                packet=json.loads(messages[1]['content'])
                if packet.get('chapter_ids')==['1']:
                    self.calls.append(packet);self.systems.append(messages[0]['content'])
                    text='Supported mechanisms. '+planned+extra
                elif 'sources' in packet:
                    self.calls.append(packet);self.systems.append(messages[0]['content'])
                    text=json.dumps({'edits':[
                        {'target':'main','before':r'\caption{表1总结了现有方法。}',
                         'after':r'\caption{现有方法的比较。}','reason':'Remove self-numbering'},
                        {'target':'main','before':extra,
                         'after':r'Additional supported comparison in prose. \citep{Keyp1}.',
                         'reason':'Retain evidence as prose, not an unplanned table'}], 'issues':[]})
                else:return await super().chat_stream(messages,**kwargs)
                kwargs['_capture'].update(finish_reason='stop',usage={},partial_response=text)
                return text
        model=RepairAssets();out=self.run_pipeline(model)
        self.assertEqual(len(model.calls),4)
        self.assertEqual(sum('sources' in p for p in model.calls),1)
        codes={i['code'] for i in model.calls[-1]['asset_contract_warnings']}
        self.assertTrue({'asset_unplanned','caption_numbering_prefix'} <= codes)
        self.assertEqual(out['asset_contract']['status'],'SUCCESS',out['asset_contract'])
        gen=self.ws/'05_generation'
        self.assertIn(extra,(gen/'chapters/1.tex').read_text())
        self.assertIn(extra,(gen/'full_draft_v1.tex').read_text())
        self.assertNotIn(extra,(gen/'full_draft_v2.tex').read_text())
        self.assertIn('Additional supported comparison in prose.',(gen/'full_draft_v2.tex').read_text())
        self.run_pipeline(model)
        self.assertEqual(len(model.calls),4)  # Existing v2 never launches another model.

    def test_unresolved_asset_warnings_return_to_main_without_new_gate(self):
        from test_native_asset_checks import table
        class ExtraTable(Model):
            async def chat_stream(self,messages,**kwargs):
                packet=json.loads(messages[1]['content'])
                if packet.get('chapter_ids')==['1']:
                    self.calls.append(packet);self.systems.append(messages[0]['content'])
                    text=table('tab:extra','表1总结了方法。')
                    kwargs['_capture'].update(finish_reason='stop',usage={},partial_response=text)
                    return text
                return await super().chat_stream(messages,**kwargs)
        model=ExtraTable();out=self.run_pipeline(model)
        self.assertEqual(out['status'],'SUCCESS')
        self.assertEqual(out['state'],'main_editable')
        self.assertEqual(len(model.calls),4)
        self.assertEqual(out['asset_contract']['status'],'WARNING')
        self.assertIn('asset_unplanned',str(out['asset_contract']))
        from main_view import compact
        self.assertEqual(compact(out)['asset_contract'],out['asset_contract'])

    def test_markdown_chapter_opening_not_repeated_by_assembly(self):
        configure(self.ws,{'publication':{'format':'markdown'}})
        self.run_pipeline(Model());gen=self.ws/'05_generation'
        self.assertTrue((gen/'chapters/1.md').read_text().startswith('## Mechanisms\n\n'))
        self.assertEqual((gen/'full_draft_v1.md').read_text().count('## Mechanisms\n'),1)

    def test_unsectioned_component_has_no_invented_opening(self):
        configure(self.ws,{'output_scope':'section'})
        atomic_json(self.ws/'04_outline/outline.json',{'survey_title':'','topic':'Mechanisms',
            'description':'Only a related-work paragraph.','outline_tree':[]})
        model=Model();self.run_pipeline(model);gen=self.ws/'05_generation'
        packet=model.calls[0]
        self.assertEqual(packet['chapter_opening'],'');self.assertEqual(packet['chapter_closing'],'')
        self.assertEqual((gen/'chapters/component.tex').read_text(),'A bounded synthesis of the evidence.')
        source=(gen/'full_draft_v1.tex').read_text()
        self.assertNotIn(r'\section{',source);self.assertNotIn(r'\begin{abstract}',source)

    def test_completed_repeated_heading_goes_to_refine_without_retry(self):
        class RepeatsOpening(Model):
            async def chat_stream(self,messages,**kwargs):
                result=await super().chat_stream(messages,**kwargs)
                packet=json.loads(messages[1]['content'])
                return packet.get('chapter_opening','')+result if 'sources' not in packet else result
        model=RepeatsOpening();self.run_pipeline(model)
        self.assertEqual(len(model.calls),4)
        self.assertEqual(model.calls[-1]['sources']['main'].count(r'\section{Mechanisms}'),2)

    def test_failed_call_retries_only_failed_chapter(self):
        model=Model();model.fail='1'
        with self.assertRaises(GenerationError):self.run_pipeline(model)
        self.assertEqual(len(model.calls),3)
        before=(self.ws/'05_generation/chapters/0.tex').read_bytes()
        model.fail=None;self.run_pipeline(model)
        self.assertEqual(len(model.calls),5)
        self.assertEqual(model.calls[3]['chapter_ids'],['1'])
        self.assertEqual(before,(self.ws/'05_generation/chapters/0.tex').read_bytes())

    def test_preparation_failure_does_not_leave_success_contract(self):
        with patch('chapter_pipeline.prepare_packets',side_effect=ValueError('capacity')):
            with self.assertRaisesRegex(ValueError,'capacity'):prepare(self.ws)
        self.assertFalse((self.ws/'05_generation/_internal/manuscript_contract.json').exists())
        prepare(self.ws);self.assertTrue((self.ws/'05_generation/_internal/chapter_packets.json').exists())
        self.run_pipeline(Model())

    def test_markdown_publication_exports_images(self):
        gen=self.ws/'05_generation';(gen/'figures').mkdir(parents=True)
        (gen/'full_draft_v2.md').write_text('# Review\n\n![F1](figures/F1.png)\n\nCaption.')
        png=gen/'figures/F1.png';png.write_bytes(b'fixture image bytes')
        self.assertEqual(publish(self.ws)['status'],'SUCCESS')
        self.assertEqual((self.ws/'06_output/figures/F1.png').read_bytes(),png.read_bytes())

    @unittest.skipUnless(shutil.which('pdflatex'),'TeX unavailable')
    def test_outline_titles_are_escaped_by_assembler(self):
        self.outline['outline_tree'][1]['title']='Methods & Applications: 50% #1'
        atomic_json(self.ws/'04_outline/outline.json',self.outline)
        self.run_pipeline(Model())
        self.assertEqual(publish(self.ws)['status'],'SUCCESS')

    def test_malformed_refine_hands_v1_to_main_without_new_calls(self):
        model=Model();model.bad_delta=True;out=self.run_pipeline(model)
        gen=self.ws/'05_generation'
        self.assertFalse(out['refinement_applied']);self.assertTrue(out['issues'])
        self.assertEqual((gen/'full_draft_v1.tex').read_bytes(),(gen/'full_draft_v2.tex').read_bytes())
        self.run_pipeline(model);self.assertEqual(len(model.calls),4)

    def test_complete_but_editorially_broken_chapter_is_not_retried(self):
        model=Model();prepare(self.ws)
        p=self.ws/'05_generation/chapters/1.tex';p.parent.mkdir(parents=True,exist_ok=True)
        p.write_text('Mechanisms vary. '+r'\undefinedMacro{content}')
        atomic_json(self.ws/'_status/writing.json',{'jobs':{'1':{'state':'complete'}}})
        self.run_pipeline(model)
        self.assertEqual(len(model.calls),3)
        self.assertIn(r'\undefinedMacro',model.calls[-1]['sources']['main'])

    def test_figure_join_before_v1_and_refine(self):
        self.outline['outline_tree'][1]['figures']=[{'figure_id':'F1','purpose':'Explain mechanisms',
            'content_plan':'Show a conditional relation','caption_draft':'Mechanism diagram.',
            'visual_guidance':'Simple schematic','paper_ids':['p1']}]
        atomic_json(self.ws/'04_outline/outline.json',self.outline);prepare(self.ws)
        from operator_cli import figure_plan
        contract=json.loads((self.ws/'05_generation/_internal/manuscript_contract.json').read_text())
        figure_plan(self.ws,{'preparation_id':contract['preparation_id'],'items':[{
            'figure_id':'F1','_render_mode':'forest_taxonomy','_caption':'Actual completed caption.',
            '_latex_body':r'\begin{forest}[Mechanism[Condition]]\end{forest}'}]})
        async def finish_figure():
            await asyncio.sleep(.08)
            self.assertFalse((self.ws/'05_generation/full_draft_v1.tex').exists())
            from manuscript import run_script
            run_script(self.ws,'scripts/generation/figures/_fast/write_latex.py')
            atomic_json(self.ws/'05_generation/_status/figures_plan_generate.json',{'status':'SUCCESS'})
        model=Model()
        async def run():await asyncio.gather(generate(self.ws,CFG,CFG,model),finish_figure())
        asyncio.run(run())
        source=model.calls[-1]['sources']['main']
        self.assertIn(r'\begin{figure}',source);self.assertIn('Actual completed caption.',source)
        self.assertNotIn('placeholder',source)

    @unittest.skipUnless(shutil.which('pdflatex'),'TeX unavailable')
    def test_publish_after_removing_generation_json_and_editing_dependencies(self):
        self.run_pipeline(Model());gen=self.ws/'05_generation';v2=gen/'full_draft_v2.tex'
        for folder in ('01_input','02_retrieval','03_process','04_outline','05_generation/_internal','_status'):
            shutil.rmtree(self.ws/folder)
        extra=gen/'extra.tex';extra.write_text(r'Added evidence \citep{NewKey}.')
        v2.write_text(v2.read_text().replace(r'\bibliography{citations}',r'\input{extra.tex}'+'\n'+r'\bibliography{citations}'))
        with (gen/'citations.bib').open('a') as f:f.write('\n@article{NewKey,author={B. Author},title={Added},year={2025},journal={J}}')
        result=publish(self.ws);self.assertEqual(result['status'],'SUCCESS',result)
        self.assertEqual(Path(result['deliverable']).name,'Mechanisms.pdf')
        self.assertFalse((self.ws/'06_output/survey.pdf').exists())
        self.assertFalse(next(c for c in result['checks'] if c['id']=='unknown_citations')['unknown'])
        extra.write_text('Changed dependency.');before=v2.read_bytes()
        result=publish(self.ws);self.assertEqual(result['status'],'SUCCESS')
        self.assertEqual(before,v2.read_bytes())
        self.assertEqual((self.ws/'06_output/extra.tex').read_text(),'Changed dependency.')
        proc=subprocess.run([sys.executable,str(ROOT/'scripts/slr.py'),'workflow','publish','--workspace',str(self.ws)],capture_output=True,text=True)
        self.assertEqual(proc.returncode,0,proc.stdout+proc.stderr)

    @unittest.skipUnless(shutil.which('pdflatex'),'TeX unavailable')
    def test_compile_failure_direct_repair_same_entry(self):
        self.run_pipeline(Model());v2=self.ws/'05_generation/full_draft_v2.tex';original=v2.read_text()
        v2.write_text(original.replace(r'\end{document}',r'\brokenCommand\end{document}'))
        self.assertEqual(publish(self.ws)['status'],'FAILED')
        v2.write_text(original);self.assertEqual(publish(self.ws)['status'],'SUCCESS')

    def test_real_cli_sse_raw_chapters_and_json_delta(self):
        import os,threading
        from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
        model=Model();requests=[];errors=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                try:
                    req=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    requests.append(req)
                    assert req['stream'] and 'response_format' not in req
                    text=asyncio.run(model.chat_stream(req['messages'],_capture={}))
                    self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
                    for i in range(0,len(text),23):
                        event={'id':'fixture','object':'chat.completion.chunk','created':1,'model':'fixture',
                               'choices':[{'index':0,'delta':{'content':text[i:i+23]},'finish_reason':None}]}
                        self.wfile.write(('data: '+json.dumps(event)+'\n\n').encode());self.wfile.flush()
                    event={'id':'fixture','object':'chat.completion.chunk','created':1,'model':'fixture',
                           'choices':[{'index':0,'delta':{},'finish_reason':'stop'}],
                           'usage':{'prompt_tokens':100,'completion_tokens':50,'total_tokens':150}}
                    self.wfile.write(('data: '+json.dumps(event)+'\n\ndata: [DONE]\n\n').encode());self.wfile.flush()
                except Exception as exc:errors.append(str(exc));raise
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        env={**os.environ,'TEXT_BASE_URL':f'http://127.0.0.1:{server.server_port}/v1','SCHOLARSEED_ACCOUNT_TOKEN':'fixture'}
        try:
            proc=subprocess.run([sys.executable,str(ROOT/'scripts/slr.py'),'manuscript','generate','--workspace',str(self.ws)],
                                env=env,capture_output=True,text=True,timeout=45)
        finally:server.shutdown();server.server_close();thread.join()
        self.assertFalse(errors);self.assertEqual(proc.returncode,0,proc.stdout+proc.stderr)
        self.assertEqual(len(requests),4)
        self.assertIn(r'\bm{X}',(self.ws/'05_generation/chapters/1.tex').read_text())
        self.assertIn('Mechanisms differ',(self.ws/'05_generation/full_draft_v2.tex').read_text())

    def test_transient_stream_recovery_does_not_retry_content(self):
        from scripted_generation import invoke
        class Interrupted:
            def __init__(self):self.calls=0
            async def chat_stream(self,messages,**kwargs):
                self.calls+=1
                kwargs['_capture'].update(finish_reason=None if self.calls==1 else 'stop',partial_response='partial')
                return r'\badButCompleted{body}'
        model=Interrupted()
        with patch('scripted_generation.asyncio.sleep',return_value=None):
            text,metrics=asyncio.run(invoke(self.ws,'chapter_1',[],{**CFG,'max_attempts':2},client=model,json_output=False))
        self.assertEqual(model.calls,2);self.assertEqual(metrics['model_calls'],2)
        self.assertEqual(text,r'\badButCompleted{body}')


class DeltaTest(unittest.TestCase):
    def test_atomic_matching_without_hashes(self):
        sources={'main':'One.\n\nTwo.','table.tex':'Table.'}
        changed,_=apply_delta(sources,{'edits':[{'target':'main','before':'One.','after':'First.'}]})
        self.assertEqual(changed['main'],'First.\n\nTwo.');self.assertEqual(sources['main'],'One.\n\nTwo.')
        for edits in ([{'target':'main','before':'missing','after':'x'}],
                      [{'target':'main','before':'One.','after':'x'}]*2):
            with self.assertRaises(GenerationError):apply_delta(sources,{'edits':edits})


if __name__=='__main__':unittest.main()
