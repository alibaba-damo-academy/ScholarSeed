"""Publication dependencies, without identities or caches."""
from pathlib import Path
import re

COMMANDS = re.compile(r'\\(input|include|includegraphics|bibliography|addbibresource|usepackage|bibliographystyle)(?:\[[^]]*\])?\{([^}]+)\}')


def dependencies(source):
    source=Path(source).resolve();base=source.parent
    pending=[source];seen=set()
    while pending:
        path=pending.pop()
        if path in seen or not path.is_file():continue
        seen.add(path)
        if path.suffix not in ('.tex','.sty','.md'):continue
        text=re.sub(r'(?m)(?<!\\)%[^\n]*','',path.read_text(errors='replace'))
        if path.suffix=='.md':
            for name in re.findall(r'!\[[^]]*\]\(([^)]+)\)',text):
                name=name.strip().strip('<>')
                if not re.match(r'[a-zA-Z]+:',name):
                    pending.append((path.parent/name).resolve())
        for command,names in COMMANDS.findall(text):
            extensions={'input':['.tex'],'include':['.tex'],'includegraphics':['.pdf','.png','.jpg','.jpeg'],
                        'bibliography':['.bib'],'addbibresource':['.bib'],'usepackage':['.sty'],
                        'bibliographystyle':['.bst']}[command]
            for name in names.split(','):
                for folder in (path.parent,base,base.parent):
                    candidate=folder/name.strip()
                    choices=[candidate] if candidate.suffix else [candidate.with_suffix(e) for e in extensions]
                    found=next((p.resolve() for p in choices if p.is_file()),None)
                    if found:pending.append(found);break
    return seen


def source_bundle(source):
    source=Path(source).resolve();sources={'main':source.read_text()};paths={'main':source}
    files=dependencies(source)
    bib=source.parent/'citations.bib'
    if bib.is_file():files.add(bib)
    for path in sorted(files):
        if path==source or path.suffix not in ('.tex','.bib'):continue
        # Generated v1 is self-contained except local bibliography/includes.
        if not path.is_relative_to(source.parent):continue
        target=path.relative_to(source.parent).as_posix()
        sources[target]=path.read_text();paths[target]=path
    return sources,paths
