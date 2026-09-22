"""Publisher-owned reference lists; no bibliographic metadata rewriting."""
from collections import Counter
import re

from markup import visible_source

def is_bibliography_title(title):
    normalized=re.sub(r'[^a-z\u3400-\u9fff]','',str(title).casefold())
    return normalized in {'参考文献','参考书目','引用文献','文献清单','references',
                          'bibliography','workscited','references参考文献','参考文献references'}


def inspect_bibliography(sources, markdown=False, automatic_markdown=True):
    """Detect duplicate publication structures, ignoring comments and code examples."""
    automatic,manual,headings,items=[],[],[],[]
    def location(target,text,match):
        return {'target':target,'source_line':text.count('\n',0,match.start())+1}
    for target,raw in sources.items():
        if target!='main' and not target.endswith(('.tex','.md')):
            continue
        text=visible_source(raw,markdown)
        for match in re.finditer(r'\\(?:bibliography\s*\{[^}]+\}|printbibliography\b)',text):
            automatic.append(location(target,text,match))
        for match in re.finditer(r'\\begin\s*\{thebibliography\}',text):
            manual.append(location(target,text,match))
        for match in re.finditer(r'\\bibitem\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}',text):
            items.append((match[1],location(target,text,match)))
        pattern=(r'(?m)^#{1,6}\s+(.+?)\s*#*\s*$' if markdown else
                 r'\\(?:sub)*section\*?\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}')
        for match in re.finditer(pattern,text):
            if is_bibliography_title(match[1]):
                headings.append(location(target,text,match))
    issues=[]
    if len(automatic)>1 or len(manual)>1 or (automatic and (manual or items)):
        issues.append({'code':'duplicate_bibliography','automatic':automatic,'manual':manual,
                       'message':'Keep one publisher-owned bibliography; remove chapter-authored reference lists.'})
    if headings and (automatic or manual or (markdown and automatic_markdown)):
        issues.append({'code':'authored_bibliography_heading','locations':headings,
                       'message':'Reference-list headings belong to the publisher, not outline chapters.'})
    duplicates=sorted(key for key,count in Counter(key for key,_ in items).items() if count>1)
    if duplicates:
        issues.append({'code':'duplicate_bibitem_keys','keys':duplicates})
    return {'status':'FAILED' if issues else 'SUCCESS','blocking':bool(issues),'issues':issues}


def duplicate_citation_definitions(log):
    return [line.strip() for line in log.splitlines()
            if re.search(r'Citation.+multiply defined|multiply defined citations',line,re.I)]
