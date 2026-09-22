"""Shared source visibility for publication and bibliography checks."""
import re

def _blank(match):
    return re.sub(r'[^\n]', ' ', match[0])


def visible_source(source, markdown=False):
    if markdown:
        source = re.sub(r'(?ms)^\s*(`{3,}|~{3,})[^\n]*\n.*?^\s*\1\s*$', _blank, source)
        source = re.sub(r'(`+)[^`\n]*?\1', _blank, source)
        return re.sub(r'<!--.*?-->', _blank, source, flags=re.S)
    source = re.sub(r'\\begin\{(verbatim\*?|lstlisting|minted)\}.*?\\end\{\1\}', _blank, source, flags=re.S)
    source = re.sub(r'\\verb\*?([^\w\s]).*?\1', _blank, source)
    return re.sub(r'(?<!\\)%[^\n]*', _blank, source)
