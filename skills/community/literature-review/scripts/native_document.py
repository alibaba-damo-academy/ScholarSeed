"""Assemble native chapter text and completed figures into one editable document."""
from pathlib import Path
import importlib.util
import re
import shutil

ROOT = Path(__file__).resolve().parents[1]


def extension(fmt):
    return 'md' if fmt == 'markdown' else 'tex'


def chapter_frame(section, fmt):
    """Fixed opening/closing owned by the task, not authored by the model."""
    if section is None:
        return {'chapter_kind':'component','chapter_opening':'','chapter_closing':''}
    title=section['title']
    if fmt=='markdown':
        return {'chapter_kind':'abstract' if section.get('role')=='abstract' else 'section',
                'chapter_opening':'## '+title+'\n\n','chapter_closing':''}
    from figure_caption import caption_latex
    from writing_contract import section_label
    if section.get('role')=='abstract':
        return {'chapter_kind':'abstract',
                'chapter_opening':r'\renewcommand{\abstractname}{'+caption_latex(title)+'}\n'+r'\begin{abstract}'+'\n',
                'chapter_closing':'\n'+r'\end{abstract}'+'\n'}
    return {'chapter_kind':'section',
            'chapter_opening':r'\section{'+caption_latex(title)+'}\n'+r'\label{'+section_label(section['section_id'])+'}\n\n',
            'chapter_closing':''}


def complete_chapter(packet, continuation):
    """Keep the raw continuation intact; completed content defects go to refine."""
    return packet.get('chapter_opening','')+continuation+packet.get('chapter_closing','')


def load_renderer():
    path = ROOT/'scripts/generation/merge/_fast/phase05_merge_full_draft.py'
    spec = importlib.util.spec_from_file_location('native_template', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def figure_files(ws, items):
    """File availability only: no seals, receipts or content fingerprints."""
    missing = []
    for item in items:
        fid = item['figure_id']
        paths = [ws/f'05_generation/figures/{fid}.tex']
        if item.get('_render_mode') != 'forest_taxonomy':
            paths.append(ws/f'05_generation/figures/{fid}.png')
        missing.extend(str(p) for p in paths if not p.is_file())
    return missing


def assemble(ws, outline, packets, spec, figures):
    """Templates and actual figure wrappers are included before refinement."""
    from evidence import save
    from branding import review_byline
    gen = ws/'05_generation'; suffix = extension(spec['format'])
    language = spec.get('language', 'english').lower()
    markdown = suffix == 'md'
    renderer = load_renderer()
    if markdown:
        from latex_to_markdown import scan_figures,render_figure_md
        rendered_figures=scan_figures(gen/'figures',figures)
        parts = ['# '+outline['survey_title']] if outline.get('survey_title') else []
        if spec.get('output_scope') == 'survey':parts += ['_'+review_byline(language)+'_']
    else:
        from citation_styles import style_asset
        preamble = renderer._citation_preamble(language, spec)
        preamble += '\n'+r'\graphicspath{{figures/}{./}}'
        if language != 'chinese':
            shutil.copyfile(renderer.NEURIPS_TEMPLATE_DIR/renderer.NEURIPS_STY_FILENAME,
                            gen/renderer.NEURIPS_STY_FILENAME)
        shutil.copyfile(style_asset(spec['citation_style']), gen/(spec['bibliography_style']+'.bst'))
        parts = [preamble]
        if outline.get('survey_title'):
            from figure_caption import caption_latex
            parts += [r'\title{'+caption_latex(outline['survey_title'])+'}']
            if spec.get('output_scope') == 'survey':parts += [r'\author{'+review_byline(language, latex=True)+'}']
            parts += [r'\date{}']
        parts += [r'\begin{document}']
        if outline.get('survey_title'):parts += [r'\maketitle']
    by_id = {n['section_id']:n for n in outline.get('outline_tree', [])}
    for packet in packets:
        sid = packet['chapter_ids'][0]
        body = (gen/'chapters'/f'{sid}.{suffix}').read_text()
        node = by_id.get(sid)
        if 'chapter_opening' not in packet:
            # Previously prepared packets stored body-only results. Preserve
            # their recovery path without regenerating completed chapters.
            body=complete_chapter(chapter_frame(node,spec['format']),body)
        # Insert completed official figures within their owning chapter. The
        # chapter writes only callouts; no placeholder or image wrapper is used.
        for item in figures:
            if (item.get('section_id') or 'component').split('.')[0] != sid:continue
            fid = item['figure_id']; label = 'fig:'+fid
            if markdown:
                block = '\n\n'+render_figure_md(rendered_figures[fid],figures.index(item)+1,language)+'\n'
            else:
                block = '\n\n'+(gen/'figures'/f'{fid}.tex').read_text()+'\n'
            ref = re.search(r'\\(?:ref|autoref|cref)\{'+re.escape(label)+r'\}', body)
            if ref:
                end = body.find('\n\n',ref.end())
                end = len(body) if end < 0 else end
            else:end = len(body)
            body = body[:end]+block+body[end:]
        parts += [body]
    if not markdown:parts += [r'\bibliography{citations}', r'\end{document}']
    bib = ws/'03_process/references.bib'
    if bib.is_file():shutil.copyfile(bib,gen/'citations.bib')
    save(gen/'publication.json',spec)
    text = '\n\n'.join(parts)+'\n'
    save(gen/f'full_draft_v1.{suffix}',text)
    return text
