"""Plain publication captions and deterministic LaTeX serialization."""
import re

_LABEL = re.compile(r'^\s*(?:图|表|Figure|Fig|Table|Tab)\s*\.?\s*(?:[A-Z]?\d+)?\s*[.:：、．]',re.I)
_SPECIAL = {'\\':r'\textbackslash{}','%':r'\%','&':r'\&','$':r'\$',
            '#':r'\#','_':r'\_','{':r'\{','}':r'\}','~':r'\textasciitilde{}','^':r'\textasciicircum{}'}


def caption_text(value):
    if not isinstance(value,str) or not value.strip(): raise ValueError('_caption must be nonempty publication prose')
    value=value.strip()
    # ORIGIN's JSON authors escaped literal LaTeX specials. Accept those
    # spellings without escaping them a second time; store plain prose now.
    value=re.sub(r'\\([%&$#_{}])',r'\1',value)
    if _LABEL.match(value): raise ValueError('_caption must not contain a Figure/图 numbering prefix')
    if re.search(r'\\(?:[A-Za-z]+|[()\[\]])',value):
        raise ValueError('_caption uses LaTeX commands; submit plain reader-facing prose, with mathematical symbols in Unicode')
    if '\n\n' in value: raise ValueError('_caption must be one paragraph of publication prose')
    return value


def caption_errors(value, item=None):
    try: text=caption_text(value)
    except ValueError as exc:return [str(exc)]
    keys=[str(p.get('cite_key') or '') for p in (item or {}).get('related_papers',[])]
    leaked=[key for key in keys if key and re.search(r'(?<!\w)'+re.escape(key)+r'(?!\w)',text)]
    return ['_caption contains internal citation keys: '+', '.join(leaked)] if leaked else []


def caption_latex(value):
    return ''.join(_SPECIAL.get(ch,ch) for ch in caption_text(value))


def caption_markdown(value):
    return re.sub(r'([\\`*_{}\[\]<>$])',r'\\\1',caption_text(value))
