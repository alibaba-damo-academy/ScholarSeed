"""Publication layouts shared by task validation, rendering and the template CLI."""
from pathlib import Path
import re
import shutil
import slr_paths

HOME = slr_paths.HOME

RENDERED_TEMPLATE = "neurips"
FALLBACK_TEMPLATE = RENDERED_TEMPLATE

LATEX_AUTHORING_GUIDANCE = r'''TEMPLATE CAPABILITIES
The assembled document uses the selected publication template. Standard Chinese
uses XeLaTeX and Fandol fonts; English uses the selected venue style. Its mathematical facilities
come from amsmath, amssymb and bm. Use standard LaTeX mathematics, aligned
equations, cases, operators and equation references. Blackboard-bold notation
uses \mathbb with uppercase Latin letters; indicator functions use an explicitly
defined uppercase blackboard-bold symbol. Bold mathematical symbols use \bm,
and upright bold Latin symbols use \mathbf. Define notation consistently and
preserve the meaning of every mathematical statement.

The template provides booktabs, array and tabularx for tables. Two-column layouts
(IEEE, ICML, AAAI) use column-bounded tables or table* for full-width tables;
longtable requires an explicitly single-column portion, restoring two columns afterward.
The single-column layouts also support longtable. The shared preamble provides
graphicx for images, caption for captions,
hyperref for links where supported, and natbib for citations. AAAI uses ordinary
references without hyperref; use \ref for its figure/table callouts. Chapter content supplies prose,
mathematics and its assigned native tables. The document assembler supplies
the preamble, package loading, bibliography and figure wrappers. Use the
supplied citation keys and asset labels within this shared document structure.'''

# Template identities are independent of the underlying TeX document class.
TEMPLATES: dict[str, dict] = {
    "standard_chinese": {"title":"标准中文模板", "language":"CHINESE", "documentclass":r"\documentclass{ctexart}",
                "package":"ctexart", "package_options":"", "files":["assets/templates/standard_chinese/standard_chinese.tex"], "notes":"Chinese renderer; requires XeLaTeX and ctexart.cls."},
    "neurips": {
        "title": "NeurIPS 2026 preprint",
        "documentclass": "\\documentclass{article}",
        "package": "neurips_2026",
        "package_options": "preprint",
        "loaded_packages": {"natbib": {"disabled_options": ["nonatbib"]}},
        "files": [
            "assets/templates/neurips/neurips_2026.sty",
        ],
        "notes": (
            "The generation pipeline's English preamble uses this vendored "
            "style. Chinese runs use ctexart."
        ),
    },
}


TEMPLATES.update({
    'ieee': {'title': 'IEEE Transactions', 'documentclass': r'\documentclass[journal]{IEEEtran}',
        'package': 'IEEEtran', 'package_options': '', 'files': ['assets/templates/ieee/IEEEtran.cls'],
        'notes': 'IEEE journal layout; bibliography style is selected independently.'},
    'iclr': {'title': 'ICLR 2026', 'documentclass': r'\documentclass{article}',
        'package': 'iclr2026_conference', 'package_options': '',
        'files': ['assets/templates/iclr/iclr2026_conference.sty','assets/templates/iclr/eso-pic.sty','assets/templates/iclr/phvb.tfm','assets/templates/iclr/uhvb8a.pfb','assets/templates/iclr/COPYING.font.txt'], 'notes': 'ICLR final-copy layout.'},
    'icml': {'title': 'ICML 2026', 'documentclass': r'\documentclass{article}',
        'package': 'icml2026', 'package_options': 'preprint',
        'files': ['assets/templates/icml/'+name for name in ('icml2026.sty','algorithm.sty','algorithmic.sty','fancyhdr.sty','forloop.sty','eso-pic.sty','float.sty')],
        'notes': 'ICML preprint two-column layout.'},

    'aaai': {'title': 'AAAI 2026', 'documentclass': r'\documentclass[letterpaper]{article}',
        'package': 'aaai2026', 'package_options': 'draft',
        'files': ['assets/templates/aaai/aaai2026.sty'],
        'notes': 'AAAI draft layout; selected bibliography formatting remains independent.'},
})
TEMPLATE_ALIASES = {'ctexart': 'standard_chinese'}


def canonical_template(value):
    return TEMPLATE_ALIASES.get(value, value)


def copy_template_assets(template, destination):
    for relative in TEMPLATES[canonical_template(template)]['files']:
        shutil.copyfile(HOME / relative, destination / Path(relative).name)


def template_preamble(template, language, chinese, english, publication=None):
    template = canonical_template(template or ('standard_chinese' if language == 'chinese' else 'neurips'))
    if template == 'standard_chinese':
        return chinese
    spec = TEMPLATES[template]
    base = english.replace(r'\documentclass{article}', spec['documentclass'])
    base = base.replace(r'\usepackage[T1]{fontenc}', r'\usepackage[T1]{fontenc}' + '\n' + r'\renewcommand{\ttdefault}{lmtt}\renewcommand{\sfdefault}{lmss}')
    if template != 'neurips':
        header = '' if template == 'ieee' else r'\usepackage' + ('['+spec['package_options']+']' if spec['package_options'] else '') + '{'+spec['package']+'}'
        if template in ('iclr', 'aaai'):
            header = r'\usepackage{times}' + '\n' + header
        if template == 'iclr':
            header = (r'\ifdefined\pdfmapline\pdfmapline{+phvb NimbusSanL-Bold <uhvb8a.pfb}'
                      r'\else\special{pdf:mapline phvb NimbusSanL-Bold <uhvb8a.pfb}\fi' + '\n' + header)
            header += '\n' + r'\iclrfinalcopy'
        if template in ('ieee', 'aaai'):
            header = r'\usepackage{natbib}' + '\n' + header
        if template == 'aaai':
            header = (r'\usepackage{natbib}' + '\n' + r'\makeatletter\let\slrBibliographyStyle\bibliographystyle'
                      r'\AddToHook{begindocument}[slr-bib]{\let\bibliographystyle\@gobble}'
                      r'\DeclareHookRule{begindocument}{slr-bib}{after}{natbib}'
                      r'\DeclareHookRule{begindocument}{slr-bib}{before}{aaai2026}\makeatother' + '\n' + header.removeprefix(r'\usepackage{natbib}' + '\n'))
        base = base.replace(r'\usepackage[preprint]{neurips_2026}', header)
        if template == 'aaai':
            base = re.sub(r'\\usepackage(?:\[[^]]*\])?\{hyperref\}', '', base)
            publication = publication or {}
            base = base.replace(r'\bibliographystyle{unsrtnat_scholarseed}', '')
            base += ('\n' + r'\AtBeginDocument{\let\bibliographystyle\slrBibliographyStyle\setcitestyle{'
                     + publication.get('natbib_options', 'numbers,sort') + r'}\bibliographystyle{'
                     + publication.get('bibliography_style', 'unsrtnat_scholarseed') + '}}')
    return base


def document_title(template, title, author=''):
    if canonical_template(template) == 'icml':
        return r'\twocolumn[\icmltitle{' + title + r'}\vskip 0.1in {\centering ' + author + r'\par}\vskip 0.3in]\makeatletter\global\icml@noticeprintedtrue\footnotetext{\Notice@String}\makeatother'
    return r'\maketitle'


def list_templates() -> list[dict]:
    rows: list[dict] = []
    for template_id, spec in TEMPLATES.items():
        missing = [path for path in spec["files"] if not (HOME / path).is_file()]
        row = {
            "id": template_id,
            "title": spec["title"], "language":spec.get("language","ENGLISH"),
            "notes": spec["notes"],
            "files": spec["files"],
            "documentclass": spec["documentclass"],
            "package": spec["package"],
            "package_options": spec["package_options"],
            "renders": True,
            "missing_files": missing,
            "status": "broken" if missing else "installed",
        }
        if missing:
            row["action"] = (
                f"{template_id} is registered but {', '.join(missing)} is missing; "
                "restore the complete skill package"
            )
        rows.append(row)
    return rows


def resolve_template(template_id: str) -> dict:
    template_id = canonical_template(template_id)
    if template_id not in TEMPLATES:
        return {
            "id": template_id,
            "status": "unknown",
            "usable": False,
            "fallback": FALLBACK_TEMPLATE,
            "action": (
                f"{template_id!r} is not supported. Use {FALLBACK_TEMPLATE}; "
                f"known templates: {', '.join(sorted(TEMPLATES))}."
            ),
        }
    row = next(item for item in list_templates() if item["id"] == template_id)
    row["usable"] = row["status"] == "installed"
    return row

