"""Externalize simple, planned LaTeX asset wrappers without dropping evidence."""
import copy
import re

from table_checks import _all_rows, _extract_env, _read_balanced_braces

FLOAT = re.compile(r"\\begin\{(figure\*?|table\*?)\}(?:\[[^\]]*\])?(.*?)\\end\{\1\}", re.S)


def has_comment(text):
    for match in re.finditer("%", text):
        i = match.start() - 1
        while i >= 0 and text[i] == "\\":
            i -= 1
        if (match.start() - i - 1) % 2 == 0:
            return True
    return False


def command(text, name):
    matches = list(re.finditer(r"\\" + re.escape(name) + r"\b(?:\[[^\]]*\])?\s*\{", text))
    if len(matches) != 1:
        return None
    m = matches[0]
    result = _read_balanced_braces(text, m.end() - 1)
    return (result[0], m.start(), result[1]) if result else None


def without(text, spans):
    for _, start, end in sorted(spans, key=lambda x: x[1], reverse=True):
        text = text[:start] + text[end:]
    text = re.sub(r"\\(?:centering|small|footnotesize|scriptsize)\b", "", text)
    return text.strip()


def table_grid(text):
    for env in ("tabularx", "tabular*", "tabular"):
        found = _extract_env(text, env)
        if found:
            rows = _all_rows(found[1])
            return (found[0].strip(), [[re.sub(r"\s+", " ", cell).strip() for cell in row] for row in rows])
    return None


def same_evidence_grid(actual, expected):
    """Allow plain layout changes and one row's sole citation moving cells."""
    if not actual or not expected:return False
    if actual[0]!=expected[0] and not re.fullmatch(r'[lcrX|\s]+',actual[0]):return False
    cite=re.compile(r'\\cite\w*\{([^}]+)\}')
    def row_key(row, header=False):
        keys={k.strip() for cell in row for group in cite.findall(cell) for k in group.split(',')}
        cells=[re.sub(r'\s+',' ',re.sub(r'^\s*\\hline\s*','',cell)).strip() for cell in row]
        if header:
            cells=[re.sub(r'^\\textbf\{([^{}]+)\}$',r'\1',cell) for cell in cells]
        return cells,keys
    arows=[r for r in actual[1] if any(row_key(r)[0])]
    brows=[r for r in expected[1] if any(row_key(r)[0])]
    if len(arows)!=len(brows):return False
    for index,(a,b) in enumerate(zip(arows,brows)):
        ac,ak=row_key(a,index==0);bc,bk=row_key(b,index==0)
        if ac==bc:continue
        if ak!=bk or len(ak)>1:return False
        if [cite.sub('',x).strip() for x in ac]!=[cite.sub('',x).strip() for x in bc]:return False
    return True


def placeholder_box(text):
    """Recognize only a layout box containing a literal editorial placeholder."""
    box=command(text,'fbox')
    if not box:return None
    inner=box[0].strip();par=command(inner,'parbox')
    if not par or par[1]!=0 or not re.fullmatch(r'(?:[0-9.]+)?\\(?:textwidth|linewidth)',par[0].strip()):return None
    pos=par[2]
    while pos<len(inner) and inner[pos].isspace():pos+=1
    content=_read_balanced_braces(inner,pos) if pos<len(inner) and inner[pos]=='{' else None
    if not content or inner[content[1]:].strip():return None
    visible=re.sub(r'\\centering\b|\\vspace\{[0-9.]+(?:cm|mm|pt|em|ex)\}','',content[0]).strip()
    bold=command(visible,'textbf')
    if bold and bold[1]==0 and bold[2]==len(visible):visible=bold[0]
    if not re.fullmatch(r'\[(?:Cartoon\s+)?(?:Illustration|Figure|Image)(?:\s+placeholder)?\]',visible,re.I):return None
    return box,visible


def normalize(value, context, render_table):
    """Normalize proven publisher placeholders; never duplicate official captions."""
    if context.get("output_format") != "latex_pdf" or not isinstance(value, dict):
        return value, []
    body = value.get("body_md")
    if not isinstance(body, str) or re.search(r"\\verb\b|\\begin\{(?:verbatim|lstlisting|minted)\}", body):
        return value, []
    if not isinstance(value.get("warnings", []), list):
        return value, []
    item = context["item"]
    figures = {x["label"]: x for x in item.get("planned_figures", [])}
    tables = {x["label"]: x for x in item.get("planned_tables", [])}
    structured = {t.get("table_id"): t for t in value.get("tables", []) if isinstance(t, dict)} if isinstance(value.get("tables", []), list) else {}
    notes = []
    body, citation_fixes = re.subn(
        r"(?<!\\)\\\\(?=(?:citeyearpar|citeauthor|citeyear|citealt|citealp|citet|citep|cite)\*?(?:\[[^\]]*\])*\{)",
        lambda match: "\\", body)
    if citation_fixes:
        notes.append({"kind": "citation_escape", "count": citation_fixes,
                      "reason": "one JSON escaping layer too many in citation commands"})

    def replace(match):
        kind = match[1].rstrip("*")
        inner = match[2]
        prefix = body[body.rfind("\n", 0, match.start()) + 1:match.start()]
        if has_comment(prefix):
            return match[0]
        # A planned, empty float is only a publisher placeholder. Preserve its
        # caption and whole comment lines; do not discard any actual drawing.
        if kind == 'figure':
            comments=[line for line in inner.splitlines() if line.lstrip().startswith('%')]
            clean='\n'.join(line for line in inner.splitlines() if not line.lstrip().startswith('%'))
            label,caption=command(clean,'label'),command(clean,'caption')
            dummy=placeholder_box(clean)
            spans=[label,caption] if label and caption else []
            if dummy:spans.append(dummy[0])
            if (label and caption and label[0] in figures and not has_comment(clean)
                    and not without(clean,spans)):
                notes.append({'kind':'figure','label':label[0], 'caption_preserved':caption[0],
                              'reason':'empty planned float; caption retained in diagnostics only'})
                word='图' if item.get('language')=='chinese' else 'Figure'
                if dummy:comments.append('% '+dummy[1])
                return '\n'.join(comments)+'\n'+word+r'~\ref{'+label[0]+'}.'
        # Comments, nested floats, and extra material make removal ambiguous.
        if has_comment(inner) or re.search(r"\\verb\b|\\begin\{(?:figure|table)\*?\}", inner):
            return match[0]
        label = command(inner, "label")
        caption = command(inner, "caption")
        if not label or not caption or re.search(r"\\caption\s*\[", inner):
            return match[0]
        if kind == "figure":
            graphic = command(inner, "includegraphics")
            if label[0] not in figures or not graphic or without(inner, [label, caption, graphic]):
                return match[0]
            named_ids = re.findall(r"(?<![A-Za-z0-9])F\d+(?=[_.-]|$)", graphic[0].rsplit("/", 1)[-1])
            if any(fid != figures[label[0]]["figure_id"] for fid in named_ids):
                return match[0]
        else:
            spec = tables.get(label[0])
            table = structured.get(spec["table_id"]) if spec else None
            if not table:
                return match[0]
            try:
                expected = table_grid(render_table(table, spec, False))
                actual = table_grid(inner)
                if (not expected or not same_evidence_grid(actual,expected) or len(expected[1]) != len(table["rows"]) + 1
                        or any(len(row) != len(table["columns"]) for row in expected[1])):
                    return match[0]
            except (KeyError, TypeError, ValueError):
                return match[0]
            stripped = without(inner, [label, caption])
            # Do not discard non-grid explanations or a second table.
            table_match = re.fullmatch(r"\\begin\{(tabularx|tabular\*?)\}.*?\\end\{\1\}", stripped, re.S)
            if not table_match or len(re.findall(r"\\begin\{tabular", stripped)) != 1:
                return match[0]
        word = ("图" if kind == "figure" else "表") if item.get("language") == "chinese" else kind.title()
        notes.append({"kind": kind, "label": label[0], "caption_preserved": caption[0],
                      "reason": "planned image wrapper" if kind == "figure" else "identical structured table grid"})
        return word + r"~\ref{" + label[0] + "}."

    normalized = FLOAT.sub(replace, body)
    if not notes:
        return value, []
    result = copy.deepcopy(value)
    result["body_md"] = normalized
    result.setdefault("warnings", []).extend(
        "citation_escape_normalized: " + str(n["count"]) if n["kind"] == "citation_escape" else
        "external_asset_wrapper_normalized: " + n["label"] + "; caption retained in prose" for n in notes)
    return result, notes
