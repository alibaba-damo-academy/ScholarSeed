#!/usr/bin/env scholarseed-skill-python
"""
fetch_fulltext.py — acquire the full text of every selected paper.

Why this exists
---------------
A survey is only as good as what its extractor was allowed to read. A paper that
reaches `03_process` with nothing but its abstract produces a card built from a
150-word summary, and every claim the drafting stage later hangs on that card is
correspondingly thin. So full-text coverage is not a nice-to-have metric, it is
the single biggest lever on output quality in the whole pipeline.

PaperHub is queried with GET /paperdownload/?id=<ES document ID>&pdf=true and
a Bearer credential read only from SCHOLARSEED_API_KEY. PDF bytes use the same
framework parser and machine-asset input as library reading. The product owns
source versions, regions and extraction assets; the review consumes content.

The default profile tries PaperHub, then a known arXiv ID with a short fallback
deadline. Direct arXiv acquisition uses the configured request budget.
Explicit --sources options may add PDF URL/DOI sources. Table layout findings
are advisory; other fatal parsing failures remain explicit.

What it will not do
-------------------
Invent text. A paper that cannot be fetched is written as `null`, which
`step2_prepare._determine_reading_depth` correctly degrades to `metadata_only`.
A plausible-looking placeholder would be far worse: it would silently poison a
card, and nothing downstream can tell fabricated text from real text.

The output contract
-------------------
`02_retrieval/paper_info.json` is an object on the same keys as
`selected_paper.json`. Each value is `null` or a record whose `sentences` field
is the entire paper as one string, one sentence per line, each line prefixed
`#<n> ` starting at 1. That prefix is load-bearing: `run_pipeline` feeds the
string to `step2_prepare._parse_sentences_index` to resolve the sentence ids the
extractor cites back to their text, so a sentence containing a newline, or an
off-by-one in the numbering, breaks source mapping for that paper. The extractor
here guarantees exactly one line per sentence.

Coverage reporting
------------------
`02_retrieval/fulltext_report.json` breaks coverage down by `relevance_level`,
not just overall. This is the number the orchestrating agent should read: L1
papers are the ones the survey quotes in depth, so a corpus at 70% overall
coverage with every L1 paper missing is a far worse position than 70% spread
evenly, and the two are indistinguishable from a single percentage.

Usage
-----
    scholarseed-skill-python scripts/processing/fetch_fulltext.py <workspace> [--concurrency 8]

Exit status: 0 when the corpus is usable (SUCCESS or PARTIAL_SUCCESS), 1 when it
is not.
"""
from __future__ import annotations

# --- slr path bootstrap ---
import sys as _slr_sys, pathlib as _slr_pathlib
for _slr_anc in _slr_pathlib.Path(__file__).resolve().parents:
    if (_slr_anc / ".slr-home").is_file():
        _slr_sys.path.insert(0, str(_slr_anc / "lib"))
        break
else:
    raise RuntimeError("systematic-literature-review skill root not found above " + __file__)
import slr_paths as _slr_paths
_slr_paths.bootstrap(__file__)
# --- end slr path bootstrap ---

import argparse
from contextlib import nullcontext
import asyncio
import hashlib
import json
import os
import re
import threading
import time
import unicodedata
from datetime import datetime, timezone
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib import error, parse, request

import pypdfium2
from pypdf import PdfReader
from pypdf.errors import PdfReadError
import httpx
import paperhub_download

from reading import import_assets
from materials import local_document
from local_papers import file_hash, load_local
from service.literature.service.atomic import parse_source, parser_fingerprint, ParseError, usable_source
from paper_materials import material_state
from diagnostics import EvidenceLog, text_size

RETRIEVAL_DIR = "02_retrieval"
SELECTED_FILENAME = "selected_paper.json"
OUTPUT_FILENAME = "paper_info.json"
REPORT_FILENAME = "fulltext_report.json"
CACHE_DIRNAME = "_fulltext_cache/caption-sentences-v1"

MAX_PDF_BYTES = 50 * 1024 * 1024
DEFAULT_TIMEOUT = 30.0
DEFAULT_CONCURRENCY = 8
ARXIV_CONNECT_TIMEOUT = 3.0
ARXIV_TOTAL_TIMEOUT = 10.0
ARXIV_CONCURRENCY = 1
ARXIV_VERSION_PAGES = 2
ARXIV_VERSION_PATTERN = re.compile(r'arXiv:\s*([0-9]{4}\.[0-9]{4,5}v[0-9]+|[a-z.-]+/[0-9]{7}v[0-9]+)', re.I)
ARXIV_FILENAME_VERSION = re.compile(r'^([0-9]{4}\.[0-9]{4,5}v[0-9]+)(?:\.(?:tar\.gz|tgz|gz|zip|tex|pdf))?$', re.I)
DOWNLOAD_CHUNK_BYTES = 65536
_ARXIV_SLOTS = threading.BoundedSemaphore(ARXIV_CONCURRENCY)

# Consecutive *transport* failures before a source is written off for the run.
BREAKER_THRESHOLD = 5

ALL_SOURCES = ("paperhub", "pdf_url", "arxiv_pdf", "doi_pdf")
PDF_SOURCES = ("pdf_url", "arxiv_pdf", "doi_pdf")
DEFAULT_SOURCES = ("paperhub", "arxiv_pdf")


def parse_sources(raw: str) -> tuple[str, ...]:
    """`--sources` value to an ordered tuple. Raises ValueError on an unknown name."""
    if raw.strip().lower() in ("all", ""):
        return ALL_SOURCES
    chosen = {part.strip().lower() for part in raw.split(",") if part.strip()}
    unknown = chosen - set(ALL_SOURCES)
    if unknown:
        raise ValueError(f"unknown source(s): {', '.join(sorted(unknown))}; "
                         f"expected any of {', '.join(ALL_SOURCES)} (or 'all')")
    if not chosen:
        raise ValueError("--sources named nothing; expected at least one of "
                         + ", ".join(ALL_SOURCES))
    return tuple(s for s in ALL_SOURCES if s in chosen)

# Coverage at or above this is reported as SUCCESS. Below it the run still
# succeeds — an abstract-only paper is a degraded paper, not a broken one — but
# the orchestrator is told the fraction so it can decide whether to continue.
GOOD_COVERAGE = 0.80

# A PDF's own User-Agent hygiene: arXiv and several publishers serve a robot
# challenge page (HTTP 200, text/html) to the default urllib agent. The magic
# byte check below catches that anyway, but asking politely gets the real file.
USER_AGENT = "Mozilla/5.0 (compatible; slr-fulltext/1.0)"

_print_lock = threading.Lock()


def log(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)


# ------------------------------------------------------------ circuit breaker --

class Breaker:
    """
    Per-source consecutive-failure counter.

    Only failures that blame the *source* count — a connection reset, a
    timeout, a 5xx. A 404, or an HTML landing page where a PDF was expected,
    says something about that one record, and tripping on those would disable
    arXiv the first time five non-arXiv papers went past it.
    """

    def __init__(self, threshold: int = BREAKER_THRESHOLD):
        self._threshold = threshold
        self._lock = threading.Lock()
        self._streak: Counter = Counter()
        self._tripped: dict[str, str] = {}

    def is_open(self, source: str) -> bool:
        with self._lock:
            return source in self._tripped

    def record_success(self, source: str) -> None:
        with self._lock:
            self._streak[source] = 0

    def record_failure(self, source: str, detail: str) -> bool:
        """Returns True if this failure is the one that tripped the breaker."""
        with self._lock:
            if source in self._tripped:
                return False
            self._streak[source] += 1
            if self._streak[source] >= self._threshold:
                self._tripped[source] = detail
                return True
            return False

    def snapshot(self) -> dict:
        with self._lock:
            return {
                s: {"disabled_after": self._threshold, "last_error": d}
                for s, d in self._tripped.items()
            }

    def any_tripped(self) -> bool:
        with self._lock:
            return bool(self._tripped)


# ------------------------------------------------------------- identifiers --

def _norm_arxiv_id(paper: dict) -> str:
    """The paper's arXiv id, or "". Accepts the `arXiv:` prefix and version suffix."""
    raw = paper.get("arxiv_id") or (paper.get("external_ids") or {}).get("ArXiv") or ""
    raw = str(raw).strip()
    if raw.lower().startswith("arxiv:"):
        raw = raw[6:].strip()
    return raw


def _norm_doi(paper: dict) -> str:
    raw = paper.get("doi") or (paper.get("external_ids") or {}).get("DOI") or ""
    raw = str(raw).strip()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if raw.lower().startswith(prefix):
            raw = raw[len(prefix):]
    return raw.strip()


def pdf_candidates(paper: dict) -> list[tuple[str, str]]:
    """
    The PDF URLs to try, in order, as (source_label, url).

    Order is by expected yield: a URL the search backend handed us is usually a
    direct link to the file; arXiv is a near-certain PDF when there is an id;
    a DOI almost always resolves to an HTML landing page and is tried last and
    without much hope. It costs one request and occasionally works, which is
    also precisely why the magic-byte check is not optional.
    """
    out: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(source: str, url: str) -> None:
        if url and url not in seen:
            seen.add(url)
            out.append((source, url))

    for url in paper.get("pdf_urls") or []:
        if isinstance(url, str) and url.strip():
            add("pdf_url", url.strip())

    arxiv_id = _norm_arxiv_id(paper)
    if arxiv_id:
        add("arxiv_pdf", f"https://arxiv.org/pdf/{parse.quote(arxiv_id, safe='./')}")

    doi = _norm_doi(paper)
    if doi:
        add("doi_pdf", f"https://doi.org/{parse.quote(doi, safe='/')}")

    return out


# ------------------------------------------------------------------ fetching --

class FetchError(Exception):
    """
    One failed attempt, carrying the two things the caller needs to decide.

    `outcome` is the typed label that lands in the report for *this paper*.
    `blames_source` is a separate axis: whether the failure says anything about
    the source itself. They genuinely come apart — a timeout is reported as
    `timeout` for the record and simultaneously counts against the source,
    because a host that times out repeatedly is a host that is down, and the
    whole point of the breaker is to stop a 200-paper run from spending
    200 x 30s discovering that one attempt at a time. A 404, by contrast, is
    the source working correctly and saying no.
    """

    def __init__(self, outcome: str, detail: str, blames_source: bool):
        super().__init__(detail)
        self.outcome = outcome
        self.detail = detail
        self.blames_source = blames_source


def _get(req: request.Request, timeout: float, max_bytes: int) -> tuple[dict, bytes]:
    """
    Fetch a request body, classifying every failure into a FetchError.

    The read is inside the same guard as the connect: a body that dies halfway
    (`IncompleteRead`, a reset socket) is a transport failure just as much as a
    refused connection, and leaving it uncaught would crash the worker rather
    than produce an outcome row.
    """
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            headers = dict(resp.headers)
            declared = headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) > max_bytes:
                raise FetchError("too_large", f"{int(declared)} bytes > cap {max_bytes}", False)
            # One byte past the cap, so an undeclared oversize body is caught too.
            return headers, resp.read(max_bytes + 1)
    except FetchError:
        raise
    except error.HTTPError as exc:
        # 4xx is about this record; 5xx is about the server.
        raise FetchError("fetch_failed", f"HTTP {exc.code}", exc.code >= 500) from exc
    except (TimeoutError, OSError) as exc:
        # urllib wraps socket timeouts inside URLError, so the string check is
        # the only reliable way to tell a timeout from a refused connection.
        if "timed out" in str(exc).lower():
            raise FetchError("timeout", f"timeout after {timeout:.0f}s", True) from exc
        raise FetchError("fetch_failed", str(exc), True) from exc
    except Exception as exc:
        raise FetchError("fetch_failed", f"{type(exc).__name__}: {exc}", True) from exc


def observed_parse(source, directory, paper_id, route, diagnostic=None, **options):
    context = diagnostic.measure('parse', paper_id, source=route) if diagnostic else nullcontext({})
    with context as detail:
        parsed = parse_source(source, directory, **options)
        detail.update(parsed_size=text_size(parsed.get('sentences', '')),
                      source_sha256=parsed.get('source_sha256'),
                      source_coverage=parsed.get('source_coverage'))
        return parsed


def fetch_paperhub(paper_id: str, base_url: str, timeout: float, cache_dir: Path, use_cache=True, diagnostic=None) -> dict:
    """GET /paperdownload/?id=ES_ID, then locally parse source into #N text."""
    try:
        observer = (lambda event, **values: diagnostic.event(event, paper_id=paper_id, source='paperhub', **values)) if diagnostic else None
        context = diagnostic.measure('download', paper_id, source='paperhub') if diagnostic else nullcontext({})
        with context as detail:
            source, meta = paperhub_download.download(paper_id, cache_dir, base_url, timeout, use_cache=use_cache,
                                                    **({'observer': observer} if observer else {}))
            detail.update(cached=meta.get('cached'), bytes=meta.get('bytes'), attempts=meta.get('attempts'))
        parsed = observed_parse(source, cache_dir / 'parsed', paper_id, 'paperhub', diagnostic)
        usable_source(parsed)
        record = blank_record('', parsed['info_type'], parsed['sentences'])
        record['paperhub_id'] = paper_id
        record['source_file'] = str(source)
        record['parse_report'] = {k:v for k,v in parsed.items() if k != 'sentences'}
        record['download'] = meta
        return record
    except paperhub_download.DownloadError as exc:
        outcome = 'not_in_paperhub' if exc.status == 404 else 'auth_failed' if exc.status in (401,403) else 'fetch_failed'
        raise FetchError(outcome, str(exc), exc.status in (None,429,500,502,503,504)) from exc
    except (ParseError, OSError, ValueError) as exc:
        raise FetchError('extract_failed', str(exc), False) from exc


async def _arxiv_bytes(url: str, budget: float) -> bytes:
    limits = httpx.Timeout(budget, connect=min(ARXIV_CONNECT_TIMEOUT, budget))
    async with httpx.AsyncClient(timeout=limits, follow_redirects=True, trust_env=True) as client:
        async with client.stream('GET', url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/pdf'}) as response:
            if response.status_code != 200:
                raise FetchError('fetch_failed', f'HTTP {response.status_code}',
                                 response.status_code == 429 or response.status_code >= 500)
            declared = response.headers.get('content-length', '')
            if declared.isdigit() and int(declared) > MAX_PDF_BYTES:
                raise FetchError('too_large', f'{declared} bytes > cap {MAX_PDF_BYTES}', False)
            data = bytearray()
            async for chunk in response.aiter_bytes(DOWNLOAD_CHUNK_BYTES):
                data.extend(chunk)
                if len(data) > MAX_PDF_BYTES:
                    raise FetchError('too_large', f'body exceeds cap {MAX_PDF_BYTES}', False)
            return _validated_pdf(bytes(data), MAX_PDF_BYTES)


async def _arxiv_request(url: str, budget: float) -> bytes:
    return await asyncio.wait_for(_arxiv_bytes(url, budget), timeout=budget)


def download_arxiv(url: str, timeout: float | None = None) -> bytes:
    budget = ARXIV_TOTAL_TIMEOUT if timeout is None else float(timeout)
    if not 0 < budget < float('inf'):
        raise ValueError('arXiv request budget must be finite and positive')
    started = time.monotonic()
    if not _ARXIV_SLOTS.acquire(timeout=budget):
        raise FetchError('timeout', 'arXiv download queue exceeded its deadline', False)
    try:
        remaining = budget - (time.monotonic() - started)
        if remaining <= 0:
            raise FetchError('timeout', 'arXiv download deadline exhausted', False)
        return asyncio.run(_arxiv_request(url, remaining))
    except httpx.TimeoutException as exc:
        elapsed = time.monotonic() - started
        raise FetchError('timeout', f'arXiv {type(exc).__name__} after {elapsed:.3f}s '
                         f'(request budget {budget:g}s, connect cap {min(ARXIV_CONNECT_TIMEOUT, budget):g}s)', True) from exc
    except TimeoutError as exc:
        elapsed = time.monotonic() - started
        raise FetchError('timeout', f'arXiv overall deadline exhausted after {elapsed:.3f}s '
                         f'(request budget {budget:g}s)', True) from exc
    except httpx.HTTPError as exc:
        raise FetchError('fetch_failed', f'{type(exc).__name__}: {exc}', True) from exc
    finally:
        _ARXIV_SLOTS.release()


def _validated_pdf(data: bytes, max_bytes: int) -> bytes:
    if len(data) > max_bytes:
        raise FetchError('too_large', f'body exceeds cap {max_bytes}', False)
    if not data.lstrip().startswith(b'%PDF'):
        raise FetchError('not_a_pdf', 'response has no PDF magic bytes', False)
    return data


def download_pdf(url: str, timeout: float, max_bytes: int = MAX_PDF_BYTES) -> bytes:
    """
    Fetch a URL and return it only if it is really a PDF.

    Validating the `%PDF` magic bytes is the whole point. The dominant failure
    mode is not a 404 — it is a publisher paywall or a robot check returning an
    HTML page with HTTP 200, which the PDF parser would reject with an opaque error
    several steps later, or worse, parse into a page of navigation chrome that
    then gets extracted as if it were the paper.
    """
    req = request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/pdf,*/*",
    })
    _, data = _get(req, timeout, max_bytes)

    return _validated_pdf(data, max_bytes)


# ---------------------------------------------------------------- extraction --

# Periods that do not end a sentence. Protected before splitting, restored after.
_ABBREVIATIONS = re.compile(
    r"\b(?:e\.g|i\.e|et\s?al|cf|vs|resp|approx|ca|viz|etc"
    r"|Figs?|Eqs?|Secs?|Tabs?|Refs?|Alg|Thm|Defn?|Prop|Lem|Cor|App"
    r"|Dr|Prof|Mr|Mrs|Ms|St|Inc|Ltd|Univ|Dept|No|Vol|pp|Ch)\.",
    re.IGNORECASE,
)
_INITIAL = re.compile(r"\b[A-Z]\.")
_DECIMAL = re.compile(r"\d\.\d")
_DOT = "\x00"

_SENTENCE_END = re.compile(r"[.!?]+[\'\")\]]*(?:\s+|$)")
_PAGE_FURNITURE = re.compile(
    r"^(?:\d{1,4}|[ivxlcdm]{1,7}|page\s+\d+(?:\s+of\s+\d+)?|arxiv:\S+)$", re.IGNORECASE
)

# Headings, recognised on the raw line before paragraphs are assembled. Kept
# deliberately narrow — a numbered section line, or one of the handful of
# canonical unnumbered ones — because the cost of a false positive (a wrapped
# body line promoted to a heading, splitting a sentence in two) is real.
_CANONICAL_HEADINGS = (
    r"abstract|introduction|background|related\s+works?|preliminaries|method(?:s|ology)?"
    r"|approach|experiments?|experimental\s+setup|results?|evaluation|discussion"
    r"|analysis|ablations?|limitations?|conclusions?|future\s+work"
    r"|acknowledg(?:e)?ments?|appendix|references|bibliography|参考文献"
)
_HEADING = re.compile(
    rf"^(?:(?:\d+(?:\.\d+)*\.?|[IVXLC]+\.)\s+\S.{{0,70}}|(?:{_CANONICAL_HEADINGS})\s*)$",
    re.IGNORECASE,
)
_HEADING_REFERENCES = re.compile(
    rf"^(?:\d+(?:\.\d+)*\.?\s*|[IVXLC]+\.?\s*)?(?:references|bibliography|参考文献)\s*$",
    re.IGNORECASE,
)

# A "sentence" longer than this is a table, an equation block or a failed split.
# Hard-wrapping keeps one line per record without ever dropping characters.
MAX_SENTENCE_CHARS = 1200
MIN_USEFUL_CHARS = 500


def clean_lines(raw: str) -> list[str]:
    """
    PDF text -> content lines, with the artefacts of print layout undone.

    `""` is kept in the output as an explicit paragraph break. Merging to
    paragraphs has to happen *after* the references cut below, because a PDF
    bibliography has no blank line between its heading and its first entry —
    merge first and the heading stops being a line anyone can recognise.
    """
    text = unicodedata.normalize("NFKC", raw.replace("\r\n", "\n").replace("\r", "\n"))
    # Justified two-column typesetting hyphenates across the line break; rejoining
    # matters because "transfor- mer" survives into the card as two broken tokens.
    text = re.sub(r"(\w)[-‐‑]\n(\w)", r"\1\2", text)

    lines: list[str] = []
    for line in text.split("\n"):
        line = re.sub(r"\s+", " ", line).strip()
        if not line or _PAGE_FURNITURE.match(line):
            if lines and lines[-1]:
                lines.append("")
            continue
        lines.append(line)
    while lines and not lines[-1]:
        lines.pop()
    return lines


def drop_references(lines: list[str]) -> list[str]:
    """
    Cut everything from a standalone References heading onward.

    The bibliography is often a third of a paper's characters and contributes
    nothing an extractor reads — PaperHub returns it separately as `bib_info`,
    and a hundred truncated citation fragments only dilute the L2 truncation
    budget. Guarded to the back half of the document so a related-work sentence
    that happens to read "References" cannot truncate a paper at page two.
    """
    floor = len(lines) // 2
    for i in range(len(lines) - 1, floor - 1, -1):
        if lines[i] and _HEADING_REFERENCES.match(lines[i]):
            return lines[:i]
    return lines


def paragraphs_from(lines: list[str]) -> list[str]:
    """Merge wrapped lines into paragraphs, leaving headings standing alone."""
    out: list[str] = []
    buffer: list[str] = []

    def flush() -> None:
        if buffer:
            out.append(" ".join(buffer))
            buffer.clear()

    for line in lines:
        if not line:
            flush()
        elif _HEADING.match(line):
            flush()
            out.append(line)
        else:
            buffer.append(line)
    flush()
    return [p for p in out if p.strip()]


def split_sentences(paragraph: str) -> list[str]:
    """Split one paragraph into sentences, none of which contains a newline."""
    protected = paragraph
    for pattern in (_ABBREVIATIONS, _INITIAL, _DECIMAL):
        protected = pattern.sub(lambda m: m.group(0).replace(".", _DOT), protected)

    pieces: list[str] = []
    start = 0
    for match in _SENTENCE_END.finditer(protected):
        piece = protected[start:match.end()].strip()
        if piece:
            pieces.append(piece)
        start = match.end()
    tail = protected[start:].strip()
    if tail:
        pieces.append(tail)

    out: list[str] = []
    for piece in pieces:
        piece = piece.replace(_DOT, ".")
        # A fragment this short is punctuation debris ("2.", ")"); glue it back
        # rather than spending a sentence id on it.
        if out and len(piece) < 3:
            out[-1] = f"{out[-1]} {piece}"
            continue
        while len(piece) > MAX_SENTENCE_CHARS:
            cut = piece.rfind(" ", 0, MAX_SENTENCE_CHARS)
            cut = cut if cut > 0 else MAX_SENTENCE_CHARS
            out.append(piece[:cut].strip())
            piece = piece[cut:].strip()
        if piece:
            out.append(piece)
    return out


def number_sentences(sentences: list[str]) -> str:
    """
    Render sentences in the `#N ` form `_parse_sentences_index` reads back.

    Every embedded newline is collapsed first. The parser's regex is anchored
    per line (`^#(\\d+)\\s+(.*)$`) and `.` does not match a newline, so a
    sentence spanning two lines would lose its tail and shift nothing else —
    a silent, unnoticeable corruption of the source map.
    """
    lines = []
    for i, sentence in enumerate(sentences, start=1):
        flat = re.sub(r"\s+", " ", sentence).strip()
        if flat:
            lines.append(f"#{i} {flat}")
    return "\n".join(lines)


def extract_pdf_text(pdf_bytes: bytes) -> str:
    """PDF bytes -> the `#N `-numbered full text. Raises FetchError on failure."""
    try:
        with pypdfium2.PdfDocument(pdf_bytes, password="") as document:
            pages = [
                document[index].get_textpage().get_text_bounded()
                for index in range(len(document))
            ]
    except FetchError:
        raise
    except Exception as exc:
        raise FetchError("extract_failed", f"{type(exc).__name__}: {exc}", False) from exc

    paragraphs = paragraphs_from(drop_references(clean_lines("\n".join(pages))))
    sentences: list[str] = []
    for paragraph in paragraphs:
        sentences.extend(split_sentences(paragraph))

    blob = number_sentences(sentences)
    # A scanned PDF with no text layer extracts to a handful of stray glyphs.
    # Passing that on would look like full text downstream and read like noise.
    if len(blob) < MIN_USEFUL_CHARS:
        raise FetchError("extract_failed",
                         f"only {len(blob)} chars of text (scanned or image-only PDF?)",
                         False)
    return blob


# --------------------------------------------------------------------- cache --

class Cache:
    """Raw PDFs and extracted text on disk so a re-run costs no network."""

    def __init__(self, root: Path):
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)

    def path_for(self, paper_id: str, ext: str) -> Path:
        # paper_ids carry slashes, colons and dots (arXiv ids, DOIs). Keep a
        # readable prefix for grep-ability and a hash for the uniqueness the
        # prefix loses. Built by concatenation, never `with_suffix` — a paper_id
        # like "10.1145/3372297" leaves a dot in the stem, and with_suffix would
        # eat the digest along with it and collapse two papers into one file.
        safe = re.sub(r"[^A-Za-z0-9_-]+", "_", paper_id)[:48]
        digest = hashlib.sha1(paper_id.encode("utf-8")).hexdigest()[:10]
        return self.root / f"{safe}.{digest}{ext}"

    def read_text(self, paper_id: str) -> str | None:
        try:
            return self.path_for(paper_id, ".txt").read_text(encoding="utf-8") or None
        except OSError:
            return None

    def write_text(self, paper_id: str, blob: str) -> None:
        try:
            self.path_for(paper_id, ".txt").write_text(blob, encoding="utf-8")
        except OSError:
            pass  # a cache that cannot be written is slow, not broken

    def read_pdf(self, paper_id: str) -> bytes | None:
        try:
            return self.path_for(paper_id, ".pdf").read_bytes() or None
        except OSError:
            return None

    def write_pdf(self, paper_id: str, data: bytes) -> None:
        try:
            self.path_for(paper_id, ".pdf").write_bytes(data)
        except OSError:
            pass


# ------------------------------------------------------------------- records --

def source_access(record, route):
    revision = (record.get('parse_report') or {}).get('source_sha256')
    if not re.fullmatch(r'[0-9a-f]{64}', str(revision or '')):
        return
    record['source_access'] = {'at': datetime.now(timezone.utc).isoformat(),
                               'kind': 'original_source_consultation', 'route': route,
                               'source_sha256': revision,
                               'arxiv_version': record.get('actual_arxiv_id') or record.get('declared_arxiv_id')}


def blank_record(arxiv_id: str, info_type: str, sentences: str) -> dict:
    """
    The output contract, with everything the PDF path cannot know left empty.

    `{}` rather than `null` for the five hub-only fields: `run_pipeline` reaches
    into them with `.get(...)` and an explicit empty mapping keeps the "hub gave
    us nothing here" case on the same code path as "hub gave us an empty one".
    """
    return {
        "arxiv_id": arxiv_id or "",
        "info_type": info_type,
        "paper_type": "",
        "sentences": sentences,
        "bib_info": {},
        "paper_card": {},
        "delta": {},
        "source_mapping": {},
        "ideation": {},
    }


def normalise_hub_record(result: dict, arxiv_id: str) -> dict:
    """
    Pass the hub's own record through, filling only what is absent.

    Deliberately non-destructive. A hub result with `info_type: "card"` and a
    populated `paper_card` activates the cache-reuse branch in `run_pipeline`,
    which skips a whole card-extraction LLM call for that paper — rewriting or
    normalising those fields here would throw that away for nothing.
    """
    record = dict(result)
    record.setdefault("arxiv_id", arxiv_id)
    record.setdefault("info_type", "origin_latex")
    record.setdefault("paper_type", "")
    record.setdefault("sentences", "")
    # Absent or null becomes {}, so consumers can index without a type check.
    # A present-but-odd value is left exactly as the hub sent it — this function
    # fills gaps, it does not correct the hub.
    for key in ("bib_info", "paper_card", "delta", "source_mapping", "ideation"):
        if record.get(key) is None:
            record[key] = {}
    return record


def hub_result_is_useful(record: dict) -> bool:
    """
    Whether a hub record is worth stopping the cascade for.

    The hub answers 200 with an essentially empty record more often than it
    errors. Treating that as a hit is how the old script reported success while
    handing `run_pipeline` nothing to read. Either real text or a reusable card
    counts; anything else falls through to the PDF path.
    """
    if isinstance(record.get("sentences"), str) and record["sentences"].strip():
        return True
    card = record.get("paper_card")
    return isinstance(card, dict) and bool(card.get("card"))


def record_has_text(record: dict | None) -> bool:
    return bool(record and isinstance(record.get("sentences"), str)
                and record["sentences"].strip())


def record_is_usable(record: dict | None) -> bool:
    """Non-null and carrying something better than the abstract."""
    if not record:
        return False
    return record_has_text(record) or bool((record.get("paper_card") or {}).get("card"))


# ------------------------------------------------------------------ per-paper --

def observed_arxiv_version(source: Path, requested: str) -> str | None:
    """Read a version from actual PDF furniture; unknown versions stay unknown."""
    with source.open('rb') as handle:
        if not handle.read(16).lstrip().startswith(b'%PDF'):
            return None
        handle.seek(0)
        try:
            document = PdfReader(handle)
            matches = set()
            for page in document.pages[:ARXIV_VERSION_PAGES]:
                matches.update(ARXIV_VERSION_PATTERN.findall(page.extract_text() or ''))
        except (PdfReadError, ValueError, KeyError, IndexError, TypeError):
            return None
    if len(matches) != 1:
        return None
    actual = next(iter(matches)).casefold()
    requested = requested.casefold()
    if requested and (re.sub(r'v\d+$','',requested) != re.sub(r'v\d+$','',actual)
                      or re.search(r'v\d+$', requested) and requested != actual):
        raise ValueError('downloaded arXiv source does not match the requested identity/version')
    return actual


def acquire(paper_id: str, paper: dict, *, hub_base: str, cache: Cache,
            breaker: Breaker, timeout: float,
            sources: tuple[str, ...] = DEFAULT_SOURCES,
            use_cache: bool = True, diagnostic=None) -> tuple[dict | None, dict]:
    """
    Run the cascade for one paper. Returns (record_or_None, outcome_row).

    Never raises: every failure mode is a typed outcome, because one paper's
    dead link must not take down a 200-paper run.

    `sources` narrows the cascade. A paper that no enabled source can serve is
    written null, which is the correct degradation — never a placeholder.
    """
    row = {
        "paper_id": paper_id,
        "title": (paper.get("title") or "")[:120],
        "relevance_level": paper.get("relevance_level") or "L3",
        "outcome": "no_identifier",
        "source": None,
        "info_type": None,
        "detail": "",
        "chars": 0,
        "failures": [],
    }
    arxiv_id = _norm_arxiv_id(paper)

    # Reuse raw downloads, then reparse when parser identity changes; old bare
    # text caches cannot establish the caption-only policy or sentence identity.
    attempts: list[str] = []
    last_outcome = "fetch_failed"

    def note_failure(source: str, err: FetchError) -> None:
        nonlocal last_outcome
        last_outcome = err.outcome
        attempts.append(f"{source}: {err.detail}")
        row['failures'].append({'source': source, 'outcome': err.outcome, 'detail': err.detail})
        if diagnostic:
            diagnostic.event('source_failed', paper_id=paper_id, source=source,
                             outcome=err.outcome, error=err.detail)
        if not err.blames_source:
            breaker.record_success(source)  # the source answered; this record missed
        elif breaker.record_failure(source, err.detail):
            log(f"[breaker] {source} disabled for the rest of the run after "
                f"{BREAKER_THRESHOLD} consecutive failures ({err.detail})")

    # User bytes have priority even when network sources are disabled.
    if paper.get('local_source'):
        local=paper['local_source'];source=Path(local['path'])
        try:
            if file_hash(source)!=local['sha256']:raise ValueError('local snapshot hash mismatch; reimport the PDF')
            parsed=observed_parse(source,source.parent/'parsed',paper_id,'local_pdf',diagnostic,
                                  materialized_text=local.get('format')=='text')
            usable_source(parsed)
            record=blank_record(arxiv_id,parsed['info_type'],parsed['sentences'])
            record['actual_arxiv_id']=observed_arxiv_version(source, arxiv_id)
            record.update(source_file=str(source),local_source_sha256=local['sha256'],
                          parse_report={k:v for k,v in parsed.items() if k!='sentences'})
            source_access(record, 'local_pdf')
            row.update(outcome='ok_local_pdf',source='local_pdf',info_type=record['info_type'],
                       chars=len(record['sentences']),detail='user PDF parsed locally; no network request')
            return record,row
        except (OSError,ValueError) as exc:
            row.update(outcome='extract_failed',source='local_pdf',detail=str(exc))
            return None,row

    # --- source 1: PaperHub binary source, addressed by ES document ID --------
    hub_id = paper.get('paperhub_id')
    if not hub_id and str(paper_id).isdigit() and 'paperhub' in str(paper.get('source','')).lower():
        hub_id = paper_id
    if 'paperhub' not in sources:
        attempts.append('paperhub: disabled by --sources')
    elif not hub_id:
        attempts.append('paperhub: no verified PaperHub document ID')
    elif not breaker.is_open('paperhub'):
        try:
            record = fetch_paperhub(str(hub_id), hub_base, timeout,
                                   cache.path_for(paper_id, '.source'), use_cache,
                                   **({'diagnostic': diagnostic} if diagnostic else {}))
            record['arxiv_id'] = arxiv_id
            record['actual_arxiv_id'] = observed_arxiv_version(Path(record['source_file']), arxiv_id)
            declared = ARXIV_FILENAME_VERSION.fullmatch(str(record.get('download', {}).get('filename', '')))
            if declared:
                version = declared[1].casefold()
                if record['actual_arxiv_id'] and record['actual_arxiv_id'] != version:
                    raise ValueError('PaperHub source filename and actual PDF version conflict')
                if arxiv_id and (re.sub(r'v\d+$','',arxiv_id.casefold()) != re.sub(r'v\d+$','',version)
                                 or re.search(r'v\d+$',arxiv_id) and arxiv_id.casefold()!=version):
                    raise ValueError('PaperHub source filename conflicts with the requested arXiv version')
                record['declared_arxiv_id'] = version
                record['version_basis'] = 'download_content_disposition'
            elif record['actual_arxiv_id']:
                record['version_basis'] = 'original_pdf_header'
            breaker.record_success('paperhub')
            source_access(record, 'paperhub')
            row.update(outcome='ok_paperhub', source='paperhub', info_type=record['info_type'],
                       chars=len(record['sentences']), detail='downloaded source parsed locally; figure/table bodies omitted, captions retained')
            return record, row
        except (FetchError, ValueError) as exc:
            err = exc if isinstance(exc, FetchError) else FetchError('version_mismatch', str(exc), False)
            note_failure('paperhub', err)
    else:
        attempts.append('paperhub: disabled by circuit breaker')

    # --- source 2: PDF download ----------------------------------------------
    allowed_pdf = tuple(s for s in PDF_SOURCES if s in sources)
    candidates = [(s, u) for s, u in pdf_candidates(paper) if s in allowed_pdf]

    if not allowed_pdf:
        # PaperHub-only policy. Everything the hub could not serve stops here,
        # and it gets its own outcome: `not_in_paperhub` is a paper the hub does
        # not hold, which is a very different fact from `no_identifier` — a paper
        # the search never returned an id for. Folding them together would make
        # the policy's cost look like a metadata problem.
        row.update(outcome=last_outcome if attempts and hub_id else "no_identifier",
                   detail="; ".join(attempts) or "no PaperHub document ID, and pdf sources are disabled")
        return None, row

    if not candidates and not arxiv_id:
        if 'arxiv_pdf' in sources:
            attempts.append('arxiv_pdf: no known arXiv ID; use supplied abstract')
        row.update(outcome=last_outcome if hub_id else 'no_identifier',
                   detail='; '.join(attempts) or 'no arxiv_id, no doi, no pdf_urls')
        return None, row

    pdf_bytes = cache.read_pdf(paper_id) if use_cache else None
    used_source = "cache" if pdf_bytes else None
    if pdf_bytes and diagnostic:
        diagnostic.event('download_cache_hit', paper_id=paper_id, source='pdf_cache', bytes=len(pdf_bytes))

    if pdf_bytes is None:
        for source, url in candidates:
            if breaker.is_open(source):
                attempts.append(f"{source}: disabled by circuit breaker")
                continue
            arxiv_request = None
            if source == 'arxiv_pdf':
                fallback = bool(row['failures'])
                budget = min(timeout, ARXIV_TOTAL_TIMEOUT) if fallback else timeout
                arxiv_request = {'url': url, 'timeout_sec': budget,
                                 'role': 'fallback' if fallback else 'primary'}
                row['arxiv_request'] = arxiv_request
            request_started = time.monotonic()
            try:
                if diagnostic:
                    diagnostic.event('download_started', paper_id=paper_id, source=source)
                pdf_bytes = (download_arxiv(url, timeout=budget) if source == 'arxiv_pdf'
                             else download_pdf(url, timeout))
                if arxiv_request is not None:
                    arxiv_request['outcome'] = 'downloaded'
                if diagnostic:
                    diagnostic.event('download_completed', paper_id=paper_id, source=source,
                                     bytes=len(pdf_bytes), elapsed_seconds=time.monotonic()-request_started)
                breaker.record_success(source)
                used_source = source
                cache.write_pdf(paper_id, pdf_bytes)
                break
            except FetchError as err:
                if diagnostic:
                    diagnostic.event('download_failed', paper_id=paper_id, source=source,
                                     elapsed_seconds=time.monotonic()-request_started, outcome=err.outcome)
                if arxiv_request is not None:
                    arxiv_request.update(outcome=err.outcome, detail=err.detail)
                note_failure(source, err)
            finally:
                if arxiv_request is not None:
                    arxiv_request['elapsed_sec'] = round(time.monotonic() - request_started, 3)

    if pdf_bytes is None:
        row.update(outcome=last_outcome if attempts else "no_identifier",
                   detail="; ".join(attempts))
        return None, row

    # --- source 3: extraction -------------------------------------------------
    try:
        source = cache.path_for(paper_id, '.pdf')
        if not source.exists(): source.write_bytes(pdf_bytes)
        parsed = observed_parse(source, cache.path_for(paper_id, '.parsed'), paper_id, used_source, diagnostic)
        blob = usable_source(parsed)
        actual_arxiv_id = observed_arxiv_version(source, arxiv_id)
    except (FetchError, ValueError, OSError) as exc:
        err = exc if isinstance(exc, FetchError) else FetchError("extract_failed", str(exc), False)
        attempts.append(f"extract: {err.detail}")
        row.update(outcome=err.outcome, source=used_source, detail="; ".join(attempts))
        return None, row

    cache.write_text(paper_id, blob)
    row.update(outcome="ok_pdf", source=used_source, info_type="origin_pdf",
               chars=len(blob), detail="; ".join(attempts))
    record = blank_record(arxiv_id, "origin_pdf", blob)
    record['actual_arxiv_id'] = actual_arxiv_id
    record['parse_report'] = {k:v for k,v in parsed.items() if k != 'sentences'}
    record['source_file'] = str(source)
    source_access(record, used_source)
    return record, row


# ---------------------------------------------------------------------- run --

def build_report(rows: list[dict], records: dict, breaker: Breaker,
                 skipped: int, elapsed: float,
                 sources: tuple[str, ...] = ALL_SOURCES) -> dict:
    """Per-source hits, the outcome table, and coverage sliced by relevance_level."""
    total = len(rows)
    per_level: dict[str, dict] = {}
    for row in rows:
        level = row["relevance_level"]
        bucket = per_level.setdefault(level, {"total": 0, "with_full_text": 0, "usable": 0})
        bucket["total"] += 1
        record = records.get(row["paper_id"])
        source_file = (record or {}).get('source_file')
        source_format = (record or {}).get('parse_report', {}).get('source_format')
        if not source_format:
            source_format = {'origin_pdf': 'pdf', 'origin_latex': 'latex'}.get((record or {}).get('info_type'))
        row.update(text_ready=record_has_text(record), source_format=source_format,
                   pdf_ready=bool(source_format == 'pdf' and source_file and Path(source_file).is_file()),
                   l1_ready=row['outcome']=='saved_l1', actual_arxiv_id=(record or {}).get('actual_arxiv_id'),
                   declared_arxiv_id=(record or {}).get('declared_arxiv_id'),
                   source_sha256=(record or {}).get('parse_report', {}).get('source_sha256'))
        if record_has_text(record):
            bucket["with_full_text"] += 1
        if record_is_usable(record):
            bucket["usable"] += 1
    for bucket in per_level.values():
        bucket["coverage"] = round(bucket["usable"] / bucket["total"], 3) if bucket["total"] else 0.0

    usable = sum(1 for r in rows if record_is_usable(records.get(r["paper_id"])))
    with_text = sum(1 for r in rows if record_has_text(records.get(r["paper_id"])))

    return {
        "total_papers": total,
        "attempted": total,
        "skipped_already_present": skipped,
        "resolved": usable,
        "with_full_text": with_text,
        "partial_source_ids": [pid for pid, record in records.items()
                               if (record or {}).get("parse_report", {}).get("source_coverage", {}).get("complete") is False],
        # `coverage` counts every paper that will NOT be abstract-only downstream,
        # which includes a hub record that carried a reusable card but no text.
        "coverage": round(usable / total, 3) if total else 0.0,
        "full_text_coverage": round(with_text / total, 3) if total else 0.0,
        "coverage_by_relevance_level": dict(sorted(per_level.items())),
        "by_source": dict(Counter(r["source"] for r in rows if r["source"])),
        "by_outcome": dict(Counter(r["outcome"] for r in rows)),
        "by_failure": dict(Counter(failure['outcome'] for row in rows for failure in row.get('failures', []))),
        # Which sources this run was allowed to use. Without it, a deliberately
        # narrowed cascade and a broadly failing one produce the same numbers.
        "sources_enabled": list(sources),
        "sources_disabled": [s for s in ALL_SOURCES if s not in sources],
        "circuit_breakers": breaker.snapshot(),
        "papers": sorted(rows, key=lambda r: (r["relevance_level"], r["paper_id"])),
        "elapsed_sec": round(elapsed, 1),
    }


def decide_status(report: dict, breaker: Breaker) -> dict:
    """
    SUCCESS / PARTIAL_SUCCESS / FAILED.

    The distinction that matters is between "this topic's papers have no
    reachable PDFs" and "the network is down". Both look like zero coverage;
    only the second is a FAILED run the agent should stop and report, and
    calling an outage a content problem sends the user off rewriting a query
    that was never the issue.
    """
    total = report["total_papers"]
    if total == 0:
        return {"status": "FAILED", "task": "FULLTEXT",
                "status_reason": "selected_paper.json contains no papers"}

    if report['by_outcome'].get('auth_failed') or report.get('by_failure', {}).get('auth_failed'):
        return {'status':'FAILED','task':'FULLTEXT',
                'status_reason':'PaperHub authentication failed; check SCHOLARSEED_API_KEY. This is not a missing-paper result.'}

    coverage = report["coverage"]
    if report["resolved"] == 0 and breaker.any_tripped():
        dead = ", ".join(report["circuit_breakers"])
        return {"status": "FAILED", "task": "FULLTEXT",
                "status_reason": f"no full text acquired, and every source went dark "
                                 f"mid-run ({dead}) — this is a reachability failure, not "
                                 f"a corpus without PDFs; check the network before "
                                 f"changing the query"}

    reasons = []
    starved = [f"{lvl} {b['usable']}/{b['total']}"
               for lvl, b in report["coverage_by_relevance_level"].items()
               if b["total"] and b["usable"] / b["total"] < GOOD_COVERAGE]
    if coverage >= GOOD_COVERAGE and not starved:
        return {"status": "SUCCESS", "task": "FULLTEXT",
                "status_reason": f"full text for {report['resolved']}/{total} papers "
                                 f"({coverage:.0%})"}

    reasons.append(f"full-text coverage {report['resolved']}/{total} ({coverage:.0%}); "
                   f"the remainder are abstract-only")
    # Say this before the agent reads the number, not after. With the web
    # sources off, low coverage is the configured policy doing exactly what it
    # was told — re-running or widening retrieval will not move it, and only
    # this line distinguishes that from a corpus of unreachable papers.
    missed = report["by_outcome"].get("not_in_paperhub", 0)
    if report.get("sources_disabled"):
        reasons.append(
            f"sources disabled by configuration: {', '.join(report['sources_disabled'])}"
            + (f" — {missed} paper(s) PaperHub does not hold were degraded to "
               f"abstract-only without a download attempt" if missed else ""))
    if starved:
        reasons.append("under-covered levels: " + ", ".join(starved))
    if report["circuit_breakers"]:
        reasons.append("sources disabled mid-run: " + ", ".join(report["circuit_breakers"]))
    return {"status": "PARTIAL_SUCCESS", "task": "FULLTEXT",
            "status_reason": "; ".join(reasons)}


def run(workspace: Path, concurrency: int, timeout: float, force: bool,
        sources: tuple[str, ...] = DEFAULT_SOURCES) -> tuple[dict, dict]:
    retrieval = workspace / RETRIEVAL_DIR
    selected_path = retrieval / SELECTED_FILENAME
    output_path = retrieval / OUTPUT_FILENAME

    if not selected_path.is_file():
        return ({}, {"status": "FAILED", "task": "FULLTEXT",
                     "status_reason": f"{selected_path} not found — run the retrieval stage first"})
    try:
        selected = json.loads(selected_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        return ({}, {"status": "FAILED", "task": "FULLTEXT",
                     "status_reason": f"{SELECTED_FILENAME} unreadable: {exc}"})
    if not isinstance(selected, dict):
        return ({}, {"status": "FAILED", "task": "FULLTEXT",
                     "status_reason": f"{SELECTED_FILENAME} is not an object keyed by paper_id"})

    diagnostic = EvidenceLog(workspace, 'fulltext')

    reuse = import_assets(workspace)
    library_documents = {}
    document_errors = {}
    for pid, paper in selected.items():
        if isinstance(paper, dict) and paper.get("local_source"):
            continue  # Explicit user-supplied bytes keep priority over a library match.
        try:
            document = local_document(workspace, pid)
            if document:
                library_documents[pid] = document
        except (OSError, ValueError, TypeError) as error:
            document_errors[pid] = str(error)


    # Merge, never overwrite: paper_info.json may hold entries for papers that
    # are no longer selected, and re-running must not discard them.
    paper_info: dict = {}
    if output_path.is_file():
        try:
            loaded = json.loads(output_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                paper_info = loaded
        except (json.JSONDecodeError, OSError):
            paper_info = {}

    hub_base = _slr_paths.endpoints().get("paper_hub", "").rstrip("/")
    cache = Cache(retrieval / CACHE_DIRNAME)
    breaker = Breaker()

    load_local(workspace)  # validate supplied snapshots even when parsed text is cached
    fingerprint = parser_fingerprint()
    pending = [(pid, p) for pid, p in selected.items()
               if isinstance(p, dict) and pid not in reuse['imports'] and (force or not paper_info.get(pid) or
                   (paper_info[pid].get('parse_report') or {}).get('parser_sha256') != fingerprint or
                   p.get('local_source') and paper_info[pid].get('local_source_sha256')!=p['local_source']['sha256'] or
                   pid in document_errors or pid in library_documents and paper_info[pid].get('local_source_sha256') != library_documents[pid]['sha256'])]
    skipped = len(selected) - len(pending)

    log(f"fulltext: {len(selected)} papers ({len(pending)} to fetch, {skipped} already done, "
        f"workers={concurrency}, hub={hub_base or 'unconfigured'}, "
        f"sources={'+'.join(sources)})")

    rows: list[dict] = []
    write_lock = threading.Lock()
    started = time.perf_counter()
    last_snapshot = [started]

    def snapshot(final: bool = False) -> None:
        """Caller must hold write_lock.

        Time-based rather than per-paper: paper_info.json holds every paper's
        full text and runs to tens of megabytes, so rewriting it after each of
        200 completions costs more than the downloads do.
        """
        now = time.perf_counter()
        if not final and now - last_snapshot[0] < 15:
            return
        last_snapshot[0] = now
        tmp = output_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(paper_info, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, output_path)

    def worker(pid: str, paper: dict) -> dict:
        paper_started = time.monotonic()
        diagnostic.event('paper_started', paper_id=pid)
        try:
            if pid in document_errors:
                raise ValueError(document_errors[pid])
            # Ephemeral acquisition input only: never change selected papers or
            # user-supplied PDF sizing/exclusion policy.
            source_paper = {**paper, 'local_source': library_documents[pid]} if pid in library_documents else paper
            record, row = acquire(pid, source_paper, hub_base=hub_base, cache=cache,
                                  breaker=breaker, timeout=timeout,
                                  sources=sources, use_cache=not force, diagnostic=diagnostic)
            if pid in library_documents and record:
                record['library_source'] = library_documents[pid]
                row['source'] = 'library_pdf'
                row['detail'] = 'selection-bound library PDF parsed locally; no network request'
        except Exception as exc:  # last-resort net: an unforeseen bug is one null, not a dead run
            record, row = None, {
                "paper_id": pid, "title": (paper.get("title") or "")[:120],
                "relevance_level": paper.get("relevance_level") or "L3",
                "outcome": "extract_failed", "source": None, "info_type": None,
                "detail": f"unhandled {type(exc).__name__}: {exc}", "chars": 0,
            }
        with write_lock:
            paper_info[pid] = record
            snapshot()
        diagnostic.event('paper_finished', paper_id=pid, elapsed_seconds=time.monotonic()-paper_started,
                         outcome=row['outcome'], source=row['source'], failures=row.get('failures', []))
        log(f"  {row['outcome']:<14} {pid[:36]:<36} {row['source'] or '-':<10} "
            f"{row['chars'] or '':>8} {row['detail'][:70]}")
        return row

    output_path.parent.mkdir(parents=True, exist_ok=True)
    if pending:
        with ThreadPoolExecutor(max_workers=max(1, min(concurrency, len(pending)))) as pool:
            futures = [pool.submit(worker, pid, paper) for pid, paper in pending]
            for future in as_completed(futures):
                rows.append(future.result())

    # Rows for papers skipped as already-fetched, so the report covers the whole
    # corpus and not just this run's slice. Only non-null entries land here — a
    # null one is indistinguishable from unfetched and goes back through pending.
    done = {r["paper_id"] for r in rows}
    for pid, paper in selected.items():
        if pid in done:
            continue
        paper = paper if isinstance(paper, dict) else {}
        record = paper_info.get(pid) or {}
        diagnostic.event('paper_reused', paper_id=pid, source='saved_l1' if pid in reuse['imports'] else 'already_present',
                         parsed_size=text_size(record.get('sentences') or ''))
        carried = bool(record)
        rows.append({
            "paper_id": pid,
            "title": (paper.get("title") or "")[:120],
            "relevance_level": paper.get("relevance_level") or "L3",
            "outcome": "saved_l1" if pid in reuse['imports'] else ("ok_pdf" if record.get("info_type") == "origin_pdf" else "ok_paperhub")
                       if carried else "no_identifier",
            "source": "saved_l1" if pid in reuse['imports'] else "already_present" if carried else None,
            "info_type": record.get("info_type"),
            "detail": "verified saved L1; source coverage retained in card" if pid in reuse['imports'] else "carried over from a previous run" if carried
                      else "selected_paper entry is not an object; nothing to fetch",
            "chars": len(record.get("sentences") or ""),
        })

    with write_lock:
        snapshot(final=True)

    report = build_report(rows, paper_info, breaker, skipped,
                          time.perf_counter() - started, sources)
    (retrieval / REPORT_FILENAME).write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    counts = {state:sum(material_state(p, paper_info.get(pid))==state for pid,p in selected.items())
              for state in ('fulltext','abstract_only','no_text')}
    unresolved=[pid for pid,p in selected.items() if material_state(p,paper_info.get(pid))=='no_text']
    report.update(material_counts=counts,unresolved_ids=unresolved,reading_reuse=reuse,
        material_usage={'saved_l1': len(reuse['imports']), 'library_pdf': sum(bool((paper_info.get(pid) or {}).get('library_source')) for pid in selected),
                        'acquisition_this_run': dict(Counter(row['source'] for row in rows if row.get('source') not in (None, 'saved_l1', 'already_present'))),
                        'historical_l1_cost': 'excluded_from_this_run; report separately', 'model_calls_in_acquisition': 0})
    (retrieval / REPORT_FILENAME).write_text(json.dumps(report,ensure_ascii=False,indent=2))
    status = decide_status(report, breaker)
    if counts['no_text']:
        status.update(status='FAILED', status_reason='Selected papers have neither usable source text nor an abstract. Check local PDF parsing/import or upstream metadata; no abstract recovery is performed.')
    elif counts['fulltext'] + counts['abstract_only']:
        status.update(status='SUCCESS', status_reason='Selected source text is available; reading depth is recorded per paper.')
    status.update(material_counts=counts, unresolved_ids=unresolved,reading_reused_count=reuse['reused_count'])
    diagnostic.event('run_finished', status=status['status'], elapsed_seconds=report['elapsed_sec'],
                     papers=report['total_papers'], resolved=report['resolved'])
    return report, status


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("workspace", nargs="?", default=".",
                    help="workspace directory holding 02_retrieval/ (default: cwd)")
    ap.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY,
                    help=f"parallel fetch threads (default {DEFAULT_CONCURRENCY})")
    ap.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT,
                    help=f"per-request timeout in seconds (default {DEFAULT_TIMEOUT:.0f})")
    ap.add_argument("--force", action="store_true",
                    help="re-fetch papers that already have a non-null paper_info entry")
    ap.add_argument("--sources", default=','.join(DEFAULT_SOURCES),
                    help=f"comma-separated acquisition sources to use, from "
                         f"{', '.join(ALL_SOURCES)} (default: {','.join(DEFAULT_SOURCES)}). `--sources paperhub` "
                         f"restricts acquisition to the hub; every paper it does not hold "
                         f"is written null and degrades to abstract-only")
    ap.add_argument("--json", action="store_true",
                    help="print the full report rather than the status line")
    args = ap.parse_args()

    if args.concurrency < 1:
        ap.error("--concurrency must be >= 1")
    try:
        sources = parse_sources(args.sources)
    except ValueError as exc:
        ap.error(str(exc))

    report, status = run(Path(args.workspace).resolve(), args.concurrency,
                         args.timeout, args.force, sources)

    if args.json:
        print(json.dumps({**status, "report": report}, indent=2, ensure_ascii=False))
    else:
        print(json.dumps({
            **status,
            "resolved": report.get("resolved"),
            "total": report.get("total_papers"),
            "coverage_by_relevance_level": report.get("coverage_by_relevance_level"),
            "by_outcome": report.get("by_outcome"),
            "sources_enabled": report.get("sources_enabled"),
        }, indent=2, ensure_ascii=False))
    return 0 if status["status"] in ("SUCCESS", "PARTIAL_SUCCESS") else 1


if __name__ == "__main__":
    raise SystemExit(main())
