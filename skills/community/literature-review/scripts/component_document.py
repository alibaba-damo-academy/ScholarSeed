"""Render unsectioned prose/tables without manufacturing a survey wrapper."""
import importlib.util
from pathlib import Path
import shutil


def emit(ws, body, tables, outline, language):
    from output_spec import read_output_spec
    from evidence import save
    root = Path(__file__).resolve().parents[1]
    spec = read_output_spec(ws)
    title = outline.get('survey_title') or ''
    if spec['format'] == 'markdown':
        from latex_to_markdown import scan_tables, render_table_md
        parsed = scan_tables(ws/'05_generation/tables')
        blocks = [render_table_md(parsed[tid], number, language) for number, tid in enumerate(tables, 1)]
        text = '\n\n'.join(([f'# {title}'] if title else []) + [body, *blocks])
        save(ws/'05_generation/full_draft_v1.md', text.strip()+'\n')
    else:
        path = root/'scripts/generation/merge/_fast/phase05_merge_full_draft.py'
        loader = importlib.util.spec_from_file_location('component_merge', path)
        module = importlib.util.module_from_spec(loader); loader.loader.exec_module(module)
        preamble = module._citation_preamble(language, spec) + '\n' + r'\usepackage{bibentry}'
        if language != 'chinese':
            shutil.copyfile(module.NEURIPS_TEMPLATE_DIR/module.NEURIPS_STY_FILENAME,
                            ws/'05_generation'/module.NEURIPS_STY_FILENAME)
        from citation_styles import style_asset
        shutil.copyfile(style_asset(spec['citation_style']), ws/'05_generation'/f"{spec['bibliography_style']}.bst")
        lines = [preamble, r'\begin{document}']
        if title: lines += [r'\section*{'+title+'}']
        lines += [body, *[r'\input{05_generation/tables/'+tid+'.tex}' for tid in tables],
                  r'\nobibliography{citations}', r'\end{document}']
        save(ws/'05_generation/full_draft_v1.tex', '\n\n'.join(lines))
    save(ws/'05_generation/_status/phase05_merge_full_draft.json',
         {'status':'SUCCESS', 'mode':'unsectioned_component', 'model_calls':0})
