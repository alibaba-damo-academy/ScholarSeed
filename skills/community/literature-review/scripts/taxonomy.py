"""Render linked native forest sources into publication images without a model."""

import os
import re
import shutil
import subprocess
import tempfile
from statistics import median
from pathlib import Path
from urllib.parse import unquote

import pypdfium2
from figure_caption import caption_latex
from generation_errors import GenerationError

NATIVE_LINK = re.compile(r"!\[[^\]]*\]\((?P<path>[^)]+\.tex)\)")
FOREST = re.compile(r"\\begin\{forest\}[\s\S]*?\\end\{forest\}")
CITATION = re.compile(r"\\(?:cite|citep|citet)\*?\{([^}]+)\}")
REFERENCE_LINK = re.compile(r"\[([\s\S]*?)\]\(#ref-[^)]+\)")
RENDER_TIMEOUT_SECONDS = 60
RENDER_SCALE = 2
MAX_RENDER_PIXELS = 16000000
PADDING_POINTS = 6
MIN_PROJECTED_LABEL_POINTS = 7


def projected_label_size(page, box):
    """Measure native text at the same physical fit used by the DOCX exporter."""
    text = page.get_textpage()
    try:
        sizes = [pypdfium2.raw.FPDFText_GetFontSize(text, index)
                 for index in range(text.count_chars())
                 if text.get_text_range(index, 1).isalnum()]
    finally:
        text.close()
    sizes = [size for size in sizes if size > 0]
    if not sizes:
        return None  # Missing font evidence does not establish legibility.
    width, height = page.get_size()
    return median(sizes) * min(box[0] / width, box[1] / height)


def tree_sources(text, root):
    root = Path(root).resolve()
    result = {}
    for match in NATIVE_LINK.finditer(text):
        relative = match["path"].strip().strip("<>")
        if (root / unquote(relative)).is_symlink():
            raise ValueError("native figure source must not be a symbolic link")
        source = (root / unquote(relative)).resolve()
        if not source.is_relative_to(root) or not source.is_file():
            raise ValueError(
                "native figure source is missing or outside its publication directory: " + relative
            )
        body = source.read_text(encoding="utf-8")
        forests = FOREST.findall(body)
        if len(forests) != 1:
            raise ValueError("native figure requires exactly one forest body: " + relative)
        result[relative] = (source, forests[0])
    return result


def render_trees(text, root, resolver, *, image_box=None):
    sources = tree_sources(text, root)
    if not sources:
        return text, []
    engine = shutil.which("xelatex")
    if not engine:
        raise ValueError("native figure export requires the configured XeLaTeX executable")
    records = []
    replacements = {}
    for relative, (source, body) in sources.items():

        def citation(match):
            keys = [key.strip() for key in match[1].split(",")]
            if any(key not in resolver.order for key in keys):
                raise ValueError("native figure contains an unresolved citation")
            label = REFERENCE_LINK.sub(lambda link: link[1], resolver.rewrite(match[0]))
            return "{" + caption_latex(label) + "}"

        body = CITATION.sub(citation, body)
        folder = source.parent / "_native" / source.stem
        if not folder.resolve().is_relative_to(Path(root).resolve()):
            raise ValueError("native figure scratch directory is outside the publication directory")
        folder.mkdir(parents=True, exist_ok=True)
        preamble = (
            r"\documentclass{article}"
            + "\n"
            + r"\usepackage[UTF8,fontset=fandol]{ctex}"
            + "\n"
            + r"\usepackage{forest}"
            + "\n"
            + r"\pagestyle{empty}\newsavebox{\diagram}"
            + "\n"
            + r"\begin{document}\sbox{\diagram}{"
            + body
            + "}\n"
            + r"\newdimen\diagramwidth\newdimen\diagramheight"
            + "\n"
            + r"\diagramwidth=\wd\diagram\advance\diagramwidth by "
            + str(PADDING_POINTS * 2)
            + "pt\n"
            + r"\diagramheight=\ht\diagram\advance\diagramheight by \dp\diagram"
            + "\n"
            + r"\advance\diagramheight by "
            + str(PADDING_POINTS * 2)
            + "pt\n"
            + r"\hoffset=-1in\voffset=-1in"
            + "\n"
            + r"\shipout\vbox{\special{papersize=\the\diagramwidth,\the\diagramheight}"
            + r"\offinterlineskip\kern"
            + str(PADDING_POINTS)
            + r"pt\hbox{\kern"
            + str(PADDING_POINTS)
            + r"pt\usebox{\diagram}\kern"
            + str(PADDING_POINTS)
            + r"pt}\kern"
            + str(PADDING_POINTS)
            + "pt}\n"
            + r"\end{document}"
            + "\n"
        )
        (folder / "figure.tex").write_text(preamble, encoding="utf-8")
        environment = {**os.environ, "openin_any": "p", "openout_any": "p"}
        completed = subprocess.run(
            [
                engine,
                "-no-shell-escape",
                "-interaction=nonstopmode",
                "-halt-on-error",
                "-file-line-error",
                "figure.tex",
            ],
            cwd=folder,
            env=environment,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=RENDER_TIMEOUT_SECONDS,
        )
        (folder / "command.log").write_text(completed.stdout + completed.stderr, encoding="utf-8")
        pdf = folder / "figure.pdf"
        if completed.returncode or not pdf.is_file():
            raise ValueError("native figure compilation failed: " + str(folder / "command.log"))
        destination = source.with_suffix(".png")
        if destination.is_symlink():
            raise ValueError("native figure output must not replace a symbolic link")
        with pypdfium2.PdfDocument(pdf) as document:
            if len(document) != 1:
                raise ValueError("native figure compilation must produce exactly one page")
            page = document[0]
            try:
                width, height = page.get_size()
                label_points = projected_label_size(page, image_box) if image_box else None
                if label_points is not None and label_points < MIN_PROJECTED_LABEL_POINTS:
                    raise GenerationError('FIGURE_LABELS_TOO_SMALL',
                                          f'Native figure labels project to {label_points:.2f}pt in the publication image box.',
                                          str(source), next_action='Reflow the native figure and wrap labels within the document width; preserve all nodes, relationships and qualifications, then republish. Do not shrink text or omit content to pass the size check.')
                if width * height * RENDER_SCALE**2 > MAX_RENDER_PIXELS:
                    raise ValueError("native figure exceeds the export pixel budget")
                bitmap = page.render(scale=RENDER_SCALE)
                try:
                    with tempfile.NamedTemporaryFile(
                        dir=source.parent, suffix=".png", delete=False
                    ) as temporary:
                        temporary_path = Path(temporary.name)
                    try:
                        bitmap.to_pil().save(temporary_path)
                        temporary_path.replace(destination)
                    finally:
                        temporary_path.unlink(missing_ok=True)
                finally:
                    bitmap.close()
            finally:
                page.close()
        replacements[relative] = Path(relative).with_suffix(".png").as_posix()
        records.append(
            {
                "source": relative,
                "image": replacements[relative],
                "engine": engine,
                "pages": 1,
                "width": width,
                "height": height,
                "projected_label_points": label_points,
            }
        )
    rendered = NATIVE_LINK.sub(
        lambda match: match[0].replace(
            match["path"], replacements[match["path"].strip().strip("<>")]
        ),
        text,
    )
    return rendered, records
