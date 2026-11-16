"""Move reader assets into per-Figure folders and rebind catalog references."""
import json
import re
from pathlib import Path
from .contracts import CpesError,digest,write_json


def publish_figures(root,output,catalog):
    from .converter import checked_artifact
    if catalog.get('artifact_base')=='run':return catalog
    entries=[catalog['layout'],*catalog.get('native_context',{}).get('artifacts',[])]
    if catalog.get('figure_index'):entries.append(catalog['figure_index'])
    for domain in catalog['domains'].values():
        entries.extend(domain.get('artifacts',[]))
        for figure in domain.get('figures',[]):entries.extend(figure['artifacts'])
    paths={entry['path']:checked_artifact(output,entry) for entry in entries}
    moves={}
    for figure in catalog['domains']['figure'].get('figures',[]):
        number=figure['figure_number']
        if not re.fullmatch(r'[A-Za-z]?\d+[A-Za-z0-9.-]*',number):raise CpesError('invalid_figure_number','图号不能用作目录名。')
        folder=root/'figure-cards'/f'figure-{number}'
        for entry in figure['artifacts']:
            source=paths[entry['path']]
            if source.name in ('figure.png','caption.md'):
                target=folder/source.name
                if target.exists() or target in moves.values():raise CpesError('output_exists','图片或图注目标路径已存在。')
                moves[source]=target
    for source,target in moves.items():
        target.parent.mkdir(parents=True,exist_ok=True);source.rename(target)
    for figure in catalog['domains']['figure'].get('figures',[]):
        metadata=next(paths[e['path']] for e in figure['artifacts'] if paths[e['path']].name=='figure.json')
        caption=next(moves[paths[e['path']]] for e in figure['artifacts'] if paths[e['path']].name=='caption.md')
        value=json.loads(metadata.read_text(encoding='utf-8'))
        value['caption']['content_ref']=caption.relative_to(root).as_posix()
        value['caption']['content_ref_base']='run'
        write_json(metadata,value)
    for entry in entries:
        path=paths[entry['path']];path=moves.get(path,path)
        entry.update(path=path.relative_to(root).as_posix(),sha256=digest(path),bytes=path.stat().st_size)
    for figure in catalog['domains']['figure'].get('figures',[]):
        figure['directory']=f"figure-cards/figure-{figure['figure_number']}"
    catalog['artifact_base']='run'
    write_json(output/'catalog.json',catalog)
    return catalog
