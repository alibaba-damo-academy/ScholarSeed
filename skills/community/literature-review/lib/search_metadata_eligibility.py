"""SLR-owned source-metadata eligibility for imported search results.

No recovery calls, guessed years, or generated author/abstract placeholders.
This screen belongs to literature-review; agentic-search remains an unchanged
independent dependency.
"""
import re

PLACEHOLDERS={'n/a','na','none','null','unknown','not available','not found',
              'unknown author','unknown authors','anonymous','未找到信息','未知','佚名',
              '无作者','暂无作者','no author','no authors','not provided'}


def abstract_problem(paper):
    value=paper.get('abstract')
    if not isinstance(value,str) or not value.strip():return 'missing or non-text abstract'
    normalized=re.sub(r'\s+',' ',value).strip().casefold().strip('. ')
    if normalized in PLACEHOLDERS | {'no abstract','no abstract available','abstract unavailable',
                                    'abstract not available','无摘要','暂无摘要'}:
        return 'placeholder abstract'
    if not any(char.isalpha() for char in value):return 'abstract contains no text'
    if value.rstrip().endswith(('...','…','[truncated]','[TRUNCATED]')) or paper.get('abstract_truncated') is True:
        return 'explicitly truncated abstract'
    return None


def author_objects(authors):
    values=authors if isinstance(authors,list) else [authors]
    result=[]
    for item in values:
        name=(item.get('name') or item.get('normalized_name')) if isinstance(item,dict) else item
        if not isinstance(name,str):continue
        name=' '.join(name.split())
        if not name or name.casefold().strip('. ') in PLACEHOLDERS or not any(c.isalpha() for c in name):continue
        result.append({**item,'name':name} if isinstance(item,dict) else {'name':name})
    return result


def year_of(paper):
    value=paper.get('year')
    if type(value) is int and 1000<=value<=9999:return value
    if isinstance(value,str) and re.fullmatch(r'[1-9]\d{3}',value.strip()):return int(value.strip())
    # A source-provided publication date explicitly contains its publication
    # year. DOI/arXiv identifiers and filesystem timestamps are not used.
    date=paper.get('publication_date')
    if isinstance(date,str) and re.match(r'^[1-9]\d{3}(?:-|$)',date.strip()):return int(date.strip()[:4])
    return None


def problems(paper):
    issues=[];abstract=abstract_problem(paper)
    if abstract:issues.append({'rule':'usable_abstract','detail':abstract})
    if not author_objects(paper.get('authors')):
        issues.append({'rule':'usable_authors','detail':'missing, empty or placeholder author names'})
    if year_of(paper) is None:
        issues.append({'rule':'usable_year','detail':'missing or invalid source publication year'})
    return issues


