"""Local PDF/LaTeX -> indexed sentence text; captions retained, float bodies omitted.

Adapted from the supplied parse_paper.py. No TeX execution or model calls.
"""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import posixpath
import re
import tarfile
import zipfile
from collections import Counter
from pathlib import Path
from threading import Lock

import pdfplumber
import pdfscope
import pysbd

PARSER_VERSION = "caption-sentences-v1"
PDF_LAYOUT_PARAMETERS = {"boxes_flow": 0.5}
_PDF_LOCK = Lock()  # PDF layout code has process-wide state; downloads remain concurrent.
MAX_UNPACKED_BYTES = 160 * 1024 * 1024
MAX_MEMBERS = 6000
FLOATS = {
    "figure",
    "figure*",
    "table",
    "table*",
    "wrapfigure",
    "wraptable",
    "sidewaysfigure",
    "sidewaystable",
    "longtable",
    "longtable*",
}
DISCARD = {
    "tabular",
    "tabular*",
    "tabularx",
    "tabulary",
    "tikzpicture",
    "axis",
    "thebibliography",
    "verbatim",
    "lstlisting",
}
TABLE_ENVIRONMENTS = {
    name for name in FLOATS | DISCARD if "table" in name or name.startswith("tabular")
}
MATH_ENVS = {
    "equation",
    "equation*",
    "align",
    "align*",
    "gather",
    "gather*",
    "multline",
    "multline*",
    "displaymath",
    "eqnarray",
    "eqnarray*",
}
ENV = re.compile(r"\\(begin|end)\s*\{([^{}]+)\}")
COMMAND = re.compile(r"\\([A-Za-z@]+)\*?")
LAYOUT_WARNING = re.compile(
    r"^(?:float without caption:|unresolved (?:figure|table) environment;|"
    r"page \d+: (?:figure caption|table caption|table detection unavailable|full-page raster))"
)


class ParseError(ValueError):
    pass


def parser_fingerprint():
    return hashlib.sha256(
        Path(__file__).read_bytes() + Path(pdfscope.__file__).read_bytes()
    ).hexdigest()


def _sentence_parts(segmenter, paragraph):
    parts = []
    for part in segmenter.segment(paragraph):
        part = part.strip()
        # The list-number heuristic in pysbd can detach a sentence-final
        # integer from its noun and attach it to the following sentence.
        number = re.match(r"^(\d+\.)\s+(.*)$", part, flags=re.DOTALL)
        if number and parts and re.search(r"[\w)]$", parts[-1]):
            parts[-1] += " " + number.group(1)
            part = number.group(2)
        if part:
            parts.append(part)
    return parts


def _group(text, offset, opening="{", closing="}"):
    while offset < len(text) and text[offset].isspace():
        offset += 1
    if offset >= len(text) or text[offset] != opening:
        return None
    start = offset + 1
    depth = 1
    offset += 1
    while offset < len(text):
        if text[offset] == "\\" and offset + 1 < len(text) and text[offset + 1] in "{}[]%":
            offset += 2
            continue
        if text[offset] == opening:
            depth += 1
        elif text[offset] == closing:
            depth -= 1
            if not depth:
                return text[start:offset], offset + 1
        offset += 1
    return None


def _comments(text):
    return re.sub(r"(?m)(?<!\\)%[^\n]*", lambda m: " " * len(m.group()), text)


def _safe_name(name):
    name = name.replace("\\", "/")
    if name.startswith("/") or ".." in name.split("/") or re.match(r"^[A-Za-z]:", name):
        raise ParseError("unsafe archive path")
    return posixpath.normpath(name)


def unpack(data):
    """Detect by bytes, not a possibly incorrect Content-Disposition extension."""
    if data.startswith(b"\x1f\x8b"):
        with gzip.GzipFile(fileobj=io.BytesIO(data)) as stream:
            data = stream.read(MAX_UNPACKED_BYTES + 1)
        if len(data) > MAX_UNPACKED_BYTES:
            raise ParseError("gzip exceeds expanded-size limit")
    if data.lstrip().startswith(b"%PDF"):
        return "pdf", data
    files = {}
    total = 0

    def keep(name, blob):
        nonlocal total
        name = _safe_name(name)
        total += len(blob)
        if total > MAX_UNPACKED_BYTES:
            raise ParseError("archive exceeds expanded-size limit")
        if name.lower().endswith((".tex", ".txt", ".bbl", ".bib", ".sty")):
            files[name] = blob

    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_MEMBERS or sum(x.file_size for x in entries) > MAX_UNPACKED_BYTES:
                raise ParseError("oversize zip archive")
            for item in entries:
                _safe_name(item.filename)
                if (item.external_attr >> 16) & 0o170000 == 0o120000:
                    raise ParseError("archive symlink not allowed")
                if not item.is_dir():
                    keep(item.filename, archive.read(item))
    else:
        try:
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
                entries = archive.getmembers()
                if len(entries) > MAX_MEMBERS or sum(x.size for x in entries) > MAX_UNPACKED_BYTES:
                    raise ParseError("oversize tar archive")
                for item in entries:
                    _safe_name(item.name)
                    if item.issym() or item.islnk():
                        raise ParseError("archive link not allowed")
                    if item.isfile():
                        keep(item.name, archive.extractfile(item).read())
        except tarfile.ReadError:
            if b"\\documentclass" in data or b"\\begin{document}" in data:
                files = {"main.tex": data}
            else:
                raise ParseError("unsupported binary format; not PDF, TeX, ZIP or TAR/GZIP")
    if not files:
        raise ParseError("archive contains no text source")
    return "latex", files


def _decode(blob):
    try:
        return blob.decode("utf-8")
    except UnicodeDecodeError:
        return blob.decode("latin-1")


def _main(files):
    candidates = []
    for name, blob in files.items():
        if not name.endswith((".tex", ".txt")):
            continue
        text = _comments(_decode(blob))
        if "\\documentclass" not in text and "\\begin{document}" not in text:
            continue
        score = (
            100 if Path(name).name in ["main.tex", "paper.tex", "ms.tex", "manuscript.tex"] else 0
        )
        score += text.count("\\input") * 4 + text.count("\\include") * 4
        if re.search(r"supp|appendix|rebuttal|slide", name, re.I):
            score -= 150
        candidates.append((score, len(text), name))
    if not candidates:
        raise ParseError("no main TeX document")
    return max(candidates)[2]


def _inline(name, files, warnings, stack=()):
    if name in stack:
        warnings.append("cyclic include: " + name)
        return ""
    text = _comments(_decode(files[name]))
    pattern = re.compile(
        r"\\(?:input|include|subfile)(?![A-Za-z@])\*?\s*(?:\{([^{}]+)\}|([^\s%{}]+))"
    )

    def replace(match):
        target = match.group(1) or match.group(2)
        choices = [
            posixpath.normpath(posixpath.join(posixpath.dirname(name), target)),
            posixpath.normpath(target),
        ]
        found = next(
            (p + suffix for p in choices for suffix in ["", ".tex"] if p + suffix in files), None
        )
        if found:
            return "\n" + _inline(found, files, warnings, (*stack, name)) + "\n"
        warnings.append("unresolved include in " + name + ": " + target)
        return "\n"

    return pattern.sub(replace, text)


def _env_spans(text):
    stack = []
    out = []
    for match in ENV.finditer(text):
        direction, name = match.groups()
        if direction == "begin":
            stack.append((name, match.start(), match.end()))
        elif stack and stack[-1][0] == name:
            _, start, body_start = stack.pop()
            out.append((start, match.end(), name, body_start, match.start()))
    return sorted(out)


def _captions(text):
    out = []
    for match in re.finditer(r"\\(captionof|caption|subcaption)\*?", text):
        end = match.end()
        if match.group(1) == "captionof":
            kind = _group(text, end)
            if not kind:
                continue
            end = kind[1]
        optional = _group(text, end, "[", "]")
        if optional:
            end = optional[1]
        arg = _group(text, end)
        if arg:
            out.append((arg[0], match.start(), arg[1]))
    return out


def _expand_simple_macros(text):
    """Expand braced, non-optional source macros without executing TeX."""
    macros = {}
    ranges = []
    pattern = re.compile(
        r"\\(?:newcommand|renewcommand|providecommand)\*?\s*(?:\{\\([A-Za-z@]+)\}|\\([A-Za-z@]+))"
    )
    for match in pattern.finditer(text):
        name = match.group(1) or match.group(2)
        end = match.end()
        count = 0
        optional = _group(text, end, "[", "]")
        if optional:
            if not optional[0].isdigit():
                continue
            count = int(optional[0])
            end = optional[1]
            if _group(text, end, "[", "]"):
                continue  # Optional-argument semantics are not guessed.
        body = _group(text, end)
        if body and count <= 4:
            macros[name] = (count, body[0])
            ranges.append((match.start(), body[1]))
    for a, b in reversed(ranges):
        text = text[:a] + "\n" * text[a:b].count("\n") + text[b:]
    for _ in range(8):
        replacements = []
        for match in COMMAND.finditer(text):
            if match.group(1) not in macros:
                continue
            count, body = macros[match.group(1)]
            end = match.end()
            args = []
            for _ in range(count):
                arg = _group(text, end)
                if not arg:
                    break
                args.append(arg[0])
                end = arg[1]
            if len(args) != count:
                continue
            for i, arg in enumerate(args, 1):
                body = body.replace("#" + str(i), arg)
            replacements.append((match.start(), end, body))
        if not replacements:
            break
        # A replacement may contain commands within another macro argument.
        selected = []
        last = -1
        for a, b, body in replacements:
            if a >= last:
                selected.append((a, b, body))
                last = b
        for a, b, body in reversed(selected):
            text = text[:a] + body + text[b:]
        if len(text) > MAX_UNPACKED_BYTES:
            raise ParseError("macro expansion exceeds limit")
    return text, sorted(macros)


def _protect_math(text, protect):
    """Pair math delimiters in one forward pass, respecting TeX escape parity.

    Consuming a backslash pair before considering a dollar distinguishes a line
    break followed by math from an escaped currency symbol. Unclosed math stays
    as text; it never starts a backtracking search through the rest of the paper.
    """
    tokens = re.finditer(r"\\\\|\\[$()[\]]|\$\$|\$", text)
    closing = {"$": "$", "$$": "$$", r"\(": r"\)", r"\[": r"\]"}
    pending = None
    cursor = 0
    pieces = []
    for match in tokens:
        token = match.group()
        if pending is not None:
            if token == closing[pending[0]]:
                pieces.extend((text[cursor : pending[1]], protect(text[pending[1] : match.end()])))
                cursor = match.end()
                pending = None
        elif token in closing:
            pending = (token, match.start())
    pieces.append(text[cursor:])
    return "".join(pieces)


class Cleaner:
    def __init__(self):
        self.protected = {}

    def protect(self, value):
        key = f"ZZPROTECTED{len(self.protected):06d}ZZ"
        self.protected[key] = re.sub(r"\s+", " ", value).strip()
        return key

    def clean(self, text):
        # Protect mathematics before sentence splitting or formatting removal.
        spans = [x for x in _env_spans(text) if x[2] in MATH_ENVS]
        for a, b, _, _, _ in sorted(spans, reverse=True):
            text = text[:a] + self.protect(text[a:b]) + text[b:]
        text = _protect_math(text, self.protect)
        text = re.sub(
            r"\\(?:cite\w*|ref|eqref|autoref|cref|Cref)\*?(?:\[[^]]*\])*\{([^{}]+)\}",
            lambda m: self.protect(m.group()),
            text,
        )
        # Consume TeX line breaks before command matching: a line break followed
        # by a protected formula must not turn the placeholder into a command.
        text = text.replace("\\\\", " ")
        for match in list(COMMAND.finditer(text))[::-1]:
            name = match.group(1)
            start = match.start()
            end = match.end()
            if name in [
                "label",
                "includegraphics",
                "epsfig",
                "vspace",
                "hspace",
                "bibliography",
                "bibliographystyle",
                "author",
                "date",
                "thanks",
                "footnotetext",
                "fontsize",
                "setcounter",
                "addtocounter",
                "setlength",
                "addtolength",
                "pagestyle",
                "thispagestyle",
            ]:
                optional = _group(text, end, "[", "]")
                if optional:
                    end = optional[1]
                arg = _group(text, end)
                if arg:
                    end = arg[1]
                if name in ["fontsize", "setcounter", "addtocounter", "setlength", "addtolength"]:
                    arg = _group(text, end)
                    if arg:
                        end = arg[1]
                text = text[:start] + text[end:]
        text = re.sub(r"\\(?:begin|end)\s*\{[^{}]+\}", " ", text)
        text = re.sub(r"\\(?:item|State|STATE)\b(?:\[[^]]*\])?", "\n", text)
        text = re.sub(
            r"\\(?:section|subsection|subsubsection|chapter|paragraph)\*?(?:\[[^]]*\])?\s*\{([^{}]*)\}",
            r"\n\n\1.\n\n",
            text,
        )
        text = re.sub(
            r"\\(?:textbf|textit|emph|textrm|texttt|textnormal|mbox|textsc|underline)\b", "", text
        )
        text = (
            text.replace("\\%", "%")
            .replace("\\&", "&")
            .replace("\\_", "_")
            .replace("\\#", "#")
            .replace("\\$", "$")
        )
        text = re.sub(r"\\[A-Za-z@]+\*?", " ", text)
        text = text.replace("\\\\", " ").replace("{", "").replace("}", "").replace("~", " ")
        return re.sub(r"[ \t]+", " ", text).strip()

    def restore(self, text):
        for key, value in self.protected.items():
            text = text.replace(key, value)
        return re.sub(r"\s+", " ", text).strip()


def _tex_blocks(files, warnings):
    main = _main(files)
    origin = _inline(main, files, warnings)
    # Disabled draft text must not become evidence. Handle nested iffalse blocks.
    for _ in range(16):
        changed = re.sub(
            r"(?s)\\iffalse\b(?:(?!\\if|\\fi).)*?\\fi\b",
            lambda m: "\n" * m.group().count("\n"),
            origin,
        )
        if changed == origin:
            break
        origin = changed
    origin, macros = _expand_simple_macros(origin)
    match = re.search(r"\\begin\s*\{document\}", origin)
    start = match.end() if match else 0
    stop = origin.rfind("\\end{document}")
    stop = stop if stop >= start else len(origin)
    text = origin[start:stop]
    blocks = []
    cursor = 0
    removed = []
    for a, b, kind, body_a, body_b in _env_spans(text):
        if a < cursor or kind not in FLOATS | DISCARD | MATH_ENVS:
            continue
        if a > cursor:
            blocks.append({"kind": "body", "raw": text[cursor:a], "offset": start + cursor})
        if kind in FLOATS:
            captions = _captions(text[body_a:body_b])
            for caption, offset, _ in captions:
                blocks.append(
                    {
                        "kind": "table_caption" if "table" in kind else "figure_caption",
                        "raw": caption,
                        "offset": start + body_a + offset,
                    }
                )
            if not captions:
                warnings.append("float without caption: " + kind)
            removed.append(
                {"kind": kind, "offset": start + a, "chars": b - a, "captions": len(captions)}
            )
        elif kind in MATH_ENVS:
            blocks.append({"kind": "equation", "raw": text[a:b], "offset": start + a})
        cursor = b
    if cursor < len(text):
        blocks.append({"kind": "body", "raw": text[cursor:], "offset": start + cursor})
    for block in blocks:
        block["source"] = {
            "merged_file": "origin.tex",
            "line_start": origin.count("\n", 0, block["offset"]) + 1,
        }
        if block["kind"] == "body":
            unresolved = {
                match.group(2)
                for match in ENV.finditer(block["raw"])
                if match.group(1) == "begin" and match.group(2) in FLOATS | DISCARD
            }
            if unresolved & TABLE_ENVIRONMENTS:
                warnings.append("unresolved table environment; body removal is unverified")
            if unresolved - TABLE_ENVIRONMENTS:
                warnings.append("unresolved figure environment; body removal is unverified")
    return (
        blocks,
        {"main_tex": main, "expanded_macros": macros, "removed_float_regions": removed},
        origin,
    )


def _reading_order(blocks, page_width):
    """Read two-column bands column-first; full-width blocks separate bands."""
    middle = page_width / 2
    left = [b for b in blocks if b[2] < middle + 5]
    right = [b for b in blocks if b[0] > middle - 5]
    if not left or not right:
        return sorted(blocks, key=lambda b: (b[1], b[0]))
    wide = sorted([b for b in blocks if b not in left and b not in right], key=lambda b: b[1])
    narrow = left + right
    ordered = []
    used = set()
    for divider in [*wide, None]:
        limit = divider[1] if divider is not None else float("inf")
        band = [(i, b) for i, b in enumerate(narrow) if i not in used and b[1] < limit]
        ordered.extend(b for i, b in sorted(band, key=lambda x: (x[1][0] >= middle, x[1][1])))
        used.update(i for i, _ in band)
        if divider is not None:
            ordered.append(divider)
    return ordered


def _box_area(box):
    return max(0, box[2] - box[0]) * max(0, box[3] - box[1])


def _intersection_ratio(left, right):
    overlap = (
        max(left[0], right[0]),
        max(left[1], right[1]),
        min(left[2], right[2]),
        min(left[3], right[3]),
    )
    return _box_area(overlap) / max(_box_area(left), 1)


def _pdf_blocks(data, warnings):
    document = pdfplumber.open(io.BytesIO(data), laparams=PDF_LAYOUT_PARAMETERS)
    blocks = []
    removed = []
    try:
        scope = pdfscope.select(data, len(document.pages))
        for number in scope["selected_pages"]:
            i = number - 1
            page = document.pages[i]
            regions = []
            page_box = (0, 0, float(page.width), float(page.height))
            for image in page.images:
                rect = (
                    float(image["x0"]),
                    float(image["top"]),
                    float(image["x1"]),
                    float(image["bottom"]),
                )
                if _box_area(rect) > 0.85 * _box_area(page_box):
                    warnings.append(
                        f"page {i+1}: full-page raster requires OCR/layout-aware parsing"
                    )
                else:
                    regions.append(("image", rect))
            try:
                regions.extend(
                    ("table", tuple(map(float, table.bbox))) for table in page.find_tables()
                )
            except Exception as exc:
                warnings.append(f"page {i+1}: table detection unavailable ({type(exc).__name__})")
            for drawing in [*page.curves, *page.rects]:
                rect = (
                    float(drawing["x0"]),
                    float(drawing["top"]),
                    float(drawing["x1"]),
                    float(drawing["bottom"]),
                )
                if (
                    rect[2] - rect[0] > 20
                    and rect[3] - rect[1] > 20
                    and _box_area(rect) < 0.7 * _box_area(page_box)
                ):
                    regions.append(("vector_graphic", rect))
            raw = []
            for number, block in enumerate(page.objects.get("textboxhorizontal", ())):
                text = str(block.get("text") or "").strip()
                if text:
                    raw.append(
                        (
                            float(block["x0"]),
                            float(block["top"]),
                            float(block["x1"]),
                            float(block["bottom"]),
                            text,
                            number,
                            0,
                        )
                    )
            if not raw:
                for number, line in enumerate(
                    page.extract_text_lines(layout=False, return_chars=False)
                ):
                    text = str(line.get("text") or "").strip()
                    if text:
                        raw.append(
                            (
                                float(line["x0"]),
                                float(line["top"]),
                                float(line["x1"]),
                                float(line["bottom"]),
                                text,
                                number,
                                0,
                            )
                        )
            raw = _reading_order(raw, page.width)
            for block in raw:
                if len(block) > 6 and block[6] != 0:
                    continue
                bbox = tuple(block[:4])
                text = block[4].strip()
                if not text:
                    continue
                marginal = bbox[1] < 45 or bbox[3] > page.height - 40
                if marginal and re.fullmatch(r"\d+", text):
                    continue
                caption = re.match(r"^(?:Fig(?:ure)?\.?|Table|图|表)\s*\d+[\s.:：]", text, re.I)
                overlaps = any(_intersection_ratio(bbox, rect) > 0.5 for _, rect in regions)
                if overlaps and not caption:
                    continue
                if overlaps and caption:
                    caption_kind = (
                        "table caption"
                        if re.match(r"^(?:Table|表)", text, re.I)
                        else "figure caption"
                    )
                    warnings.append(
                        f"page {i+1}: {caption_kind} overlaps a removed region; caption/data boundary is unverified"
                    )
                if (
                    caption
                    and re.match(r"^(?:Table|表)", text, re.I)
                    and not any(k == "table" for k, _ in regions)
                ):
                    warnings.append(
                        f"page {i+1}: table caption without a detected table region; table-body removal is unverified"
                    )
                if (
                    caption
                    and not re.match(r"^(?:Table|表)", text, re.I)
                    and not any(k in ("image", "vector_graphic") for k, _ in regions)
                ):
                    warnings.append(
                        f"page {i+1}: figure caption without a detected graphic region; graphic-label removal is unverified"
                    )
                text = re.sub(r"(?<=[A-Za-z])-\n(?=[a-z])", "", text)
                kind = (
                    (
                        "table_caption"
                        if re.match(r"^(?:Table|表)", text, re.I)
                        else "figure_caption"
                    )
                    if caption
                    else "body"
                )
                blocks.append(
                    {
                        "kind": kind,
                        "raw": text,
                        "marginal": marginal,
                        "source": {"page": i + 1, "bbox": list(bbox)},
                    }
                )
            removed.extend(
                {"page": i + 1, "kind": kind, "bbox": list(rect)} for kind, rect in regions
            )
        repeated = Counter(b["raw"] for b in blocks if b["marginal"] and len(b["raw"]) < 160)
        page_count = len(scope["selected_pages"])
        blocks = [
            b
            for b in blocks
            if not (b["marginal"] and repeated[b["raw"]] >= max(3, (page_count + 1) // 2))
        ]
    finally:
        document.close()
    return blocks, {**scope, "removed_regions": removed}


def parse_source(path, output_dir=None):
    path = Path(path)
    data = path.read_bytes()
    kind, content = unpack(data)
    warnings = []
    if kind == "latex":
        blocks, details, origin = _tex_blocks(content, warnings)
    else:
        with _PDF_LOCK:
            blocks, details = _pdf_blocks(content, warnings)
        origin = None
    cleaner = Cleaner()
    segmenter = pysbd.Segmenter(language="en", clean=False)
    sentences = []
    caption_blocks = []
    for block in blocks:
        cleaned = cleaner.clean(block["raw"]) if kind == "latex" else block["raw"]
        if block["kind"].endswith("_caption"):
            cleaned = re.sub(
                r"^(?:Fig(?:ure)?\.?|Table|图|表)\s*\d+[\s.:：]+",
                lambda m: cleaner.protect(m.group()) + " ",
                cleaned,
                flags=re.I,
            )
        first = len(sentences) + 1
        for paragraph in re.split(r"\n\s*\n", cleaned):
            paragraph = re.sub(r"\s+", " ", paragraph).strip()
            if not paragraph:
                continue
            for part in _sentence_parts(segmenter, paragraph):
                text = cleaner.restore(part)
                if not text:
                    continue
                sentences.append(
                    {
                        "id": len(sentences) + 1,
                        "text": text,
                        "kind": block["kind"],
                        "source": block["source"],
                    }
                )
        if block["kind"].endswith("_caption"):
            caption_blocks.append(
                {
                    "kind": block["kind"],
                    "text": cleaner.restore(cleaned),
                    "sentence_ids": list(range(first, len(sentences) + 1)),
                }
            )
    if not sentences:
        raise ParseError("no extractable text; PDF may require OCR")
    numbered = "\n".join(f"#{s['id']} {s['text']}" for s in sentences) + "\n"
    # Layout uncertainty is diagnostic; any successfully extracted text is usable.
    fatal_warnings = [warning for warning in warnings if not LAYOUT_WARNING.match(warning)]
    result = {
        "status": "partial" if fatal_warnings else "ok",
        "info_type": "origin_latex" if kind == "latex" else "origin_pdf",
        "sentences": numbered,
        "n_sentences": len(sentences),
        "caption_count": len(caption_blocks),
        "parser_version": PARSER_VERSION,
        "parser_sha256": parser_fingerprint(),
        "source_sha256": hashlib.sha256(data).hexdigest(),
        "source_filename": path.name,
        "warnings": warnings,
        "fatal_warnings": fatal_warnings,
        **details,
    }
    if output_dir:
        out = Path(output_dir)
        out.mkdir(parents=True, exist_ok=True)
        (out / "sentences.txt").write_text(numbered)
        (out / "sentence_index.json").write_text(
            json.dumps(sentences, ensure_ascii=False, indent=2) + "\n"
        )
        (out / "captions.json").write_text(
            json.dumps(caption_blocks, ensure_ascii=False, indent=2) + "\n"
        )
        (out / "parse_report.json").write_text(
            json.dumps(
                {k: v for k, v in result.items() if k != "sentences"}, ensure_ascii=False, indent=2
            )
            + "\n"
        )
        if origin is not None:
            (out / "origin.tex").write_text(origin)
    return result
