"""Plain publication captions and deterministic LaTeX serialization."""
import re

CAPTION_CONTENT_GUIDANCE = """CAPTION CONTENT
A caption names the asset's subject and explains its comparison, relationship or
necessary qualification. Start directly with that content. The publisher supplies
the figure/table name and display number; F1/T1 are stable identities, not printed
sequence numbers. Thus "图1：2015–2026年方法演进" becomes "2015–2026年方法演进";
"表1总结了各方法的假设" becomes "各方法的假设比较". This applies equally to
prefixes without punctuation such as "图2展示了" and "Table 2 compares".
Keep scientific meaning, years, units and supported qualifications. Numbered
callouts belong in surrounding prose, using the asset's supplied reference label,
not in its own caption. Caption text contains no drawing or pipeline instructions.
"""

# Require an asset noun plus a number (or explicit label punctuation), not a
# bare year or a scientific word beginning with Fig/Table. Chinese prose may
# immediately follow the number; English needs a word boundary.
_LABEL = re.compile(
    r'^\s*(?:(?:图|表)\s*(?:[A-Z]?\d+(?:[.．]\d+)*|[一二三四五六七八九十]+)'
    r'|(?:Figure|Fig|Table|Tab)\.?\s*[A-Z]?\d+(?:\.\d+)*\b'
    r'|(?:图|表|Figure|Fig|Table|Tab)\s*[.:：、．])', re.I)


def has_numbering_prefix(value):
    return isinstance(value, str) and bool(_LABEL.match(value))

_SPECIAL = {'\\':r'\textbackslash{}','%':r'\%','&':r'\&','$':r'\$',
            '#':r'\#','_':r'\_','{':r'\{','}':r'\}','~':r'\textasciitilde{}','^':r'\textasciicircum{}'}


def caption_text(value):
    if not isinstance(value,str) or not value.strip(): raise ValueError('_caption must be nonempty publication prose')
    value=value.strip()
    # ORIGIN's JSON authors escaped literal LaTeX specials. Accept those
    # spellings without escaping them a second time; store plain prose now.
    value=re.sub(r'\\([%&$#_{}])',r'\1',value)
    if has_numbering_prefix(value): raise ValueError('_caption must not contain a Figure/图 or Table/表 numbering prefix')
    if re.search(r'\\(?:[A-Za-z]+|[()\[\]])',value):
        raise ValueError('_caption uses LaTeX commands; submit plain reader-facing prose, with mathematical symbols in Unicode')
    if '\n\n' in value: raise ValueError('_caption must be one paragraph of publication prose')
    return value


def caption_errors(value, item=None, field="_caption"):
    try: text=caption_text(value)
    except ValueError as exc:return [str(exc).replace("_caption", field)]
    keys=[str(p.get('cite_key') or '') for p in (item or {}).get('related_papers',[])]
    leaked=[key for key in keys if key and re.search(r'(?<!\w)'+re.escape(key)+r'(?!\w)',text)]
    return [field+' contains internal citation keys: '+', '.join(leaked)] if leaked else []


def caption_latex(value):
    return ''.join(_SPECIAL.get(ch,ch) for ch in caption_text(value))


def caption_markdown(value):
    return re.sub(r'([\\`*_{}\[\]<>$])',r'\\\1',caption_text(value))
