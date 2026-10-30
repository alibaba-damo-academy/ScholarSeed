"""Bounded, RAM-only verification of paper identities already supplied by the web batch.

This is metadata resolution, not another search round: exact DOI records or the
linked page's scholarly citation tags only. Never download PDFs or use snippets
as bibliographic records. Network workers are daemon threads; even a stuck DNS
resolver cannot extend the one-shot runner's verification deadline.
"""

import hashlib
from html import unescape
from html.parser import HTMLParser
import http.client
import ipaddress
import json
import queue
import re
import socket
import threading
import time
from urllib.parse import quote, urljoin, urlsplit

import paper_identity
import publication_window

MAX_CANDIDATES = 4
VERIFY_SECONDS = 8.0
MAX_BYTES = 1024 * 1024
MAX_REDIRECTS = 3
HTTPS_PORT = 443
REDIRECT_CODES = {301, 302, 303, 307, 308}
CROSSREF_WORKS = "https://api.crossref.org/works/"
PAPER_TYPES = {"journal-article", "proceedings-article", "posted-content"}
USER_AGENT = "fast-search/1.0 (paper metadata resolution)"


def title_key(value):
    return "".join(c for c in unescape(str(value or "")).casefold() if c.isalnum())


def _text(value):
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]*>", "", str(value or "")))).strip()


def _valid_url(value):
    """Syntactic guard; resolved addresses are checked and pinned at connect time."""
    url = paper_identity.canonical_url(value)
    parsed = urlsplit(url)
    if (not url or parsed.username or parsed.password or parsed.port not in (None, HTTPS_PORT)
            or not parsed.hostname or any(c.isspace() for c in url)):
        raise ValueError("invalid public paper URL")
    return url


def requests_for_plan(plan, query, best_title, required):
    """Keep only title + locator from the agent, never its claimed metadata."""
    entries = plan.get("web_papers", [])
    if not isinstance(entries, list):
        entries = []
    titles = {title_key(item["query"]) for item in plan.get("queries", [])
              if isinstance(item, dict) and item.get("mode") == "title"}
    candidates = []
    for item in entries[:MAX_CANDIDATES]:
        if not isinstance(item, dict) or not isinstance(item.get("title"), str):
            continue
        title = item["title"].strip()
        if not title_key(title) or title_key(title) not in titles:
            continue
        try:
            url = _valid_url(item.get("url"))
        except (TypeError, ValueError):
            continue
        candidates.append({"title": title, "url": url})
    # Only retain the supported evidence core in the persisted plan.
    if "web_papers" in plan:
        plan["web_papers"] = candidates
        plan["web_papers_ignored_count"] = len(entries) - len(candidates)
    target = None
    if required:
        links = paper_identity.urls(query)
        ids = paper_identity.identifiers(query)
        if len(links) == 1:
            target = {"title": best_title, "url": _valid_url(links[0]), "required": True}
        elif len(ids["doi"]) == 1:
            target = {"title": best_title, "url": "https://doi.org/" + next(iter(ids["doi"])), "required": True}
        elif len(ids["arxiv"]) == 1:
            target = {"title": best_title, "url": "https://arxiv.org/abs/" + next(iter(ids["arxiv"])), "required": True}
        else:
            target = next((dict(item, required=True) for item in candidates
                           if title_key(item["title"]) == title_key(best_title)), None)
    ordered = ([target] if target else []) + candidates
    unique = {}
    for item in ordered:
        ids = paper_identity.identifiers(item["url"])
        key = (tuple(sorted(ids["doi"])), tuple(sorted(ids["arxiv"]))) if any(ids.values()) else item["url"]
        unique.setdefault(key, item)
    return list(unique.values())[:MAX_CANDIDATES]


def _remaining(deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError("metadata verification deadline")
    return remaining


class _PublicHTTPS(http.client.HTTPSConnection):
    def connect(self):
        # Resolve once, reject the whole mixed answer if any address is private,
        # and connect to a pinned public IP (TLS still verifies the real host).
        addresses = socket.getaddrinfo(self.host, HTTPS_PORT, type=socket.SOCK_STREAM)
        ips = [item[4][0] for item in addresses]
        if not ips or any(not ipaddress.ip_address(ip).is_global for ip in ips):
            raise ValueError("non-public destination")
        sock = socket.create_connection((ips[0], HTTPS_PORT), timeout=self.timeout)
        try:
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        except BaseException:
            sock.close()
            raise


def fetch(url, deadline):
    """Anonymous HTTPS only; no cookies, credentials, proxies or response logging."""
    for _ in range(MAX_REDIRECTS + 1):
        url = _valid_url(url)
        parsed = urlsplit(url)
        connection = _PublicHTTPS(parsed.hostname, timeout=_remaining(deadline))
        try:
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query
            connection.request("GET", path, headers={"User-Agent": USER_AGENT,
                "Accept": "application/json, text/html", "Accept-Encoding": "identity"})
            response = connection.getresponse()
            if response.status in REDIRECT_CODES:
                url = urljoin(url, response.getheader("Location", ""))
                continue
            if response.status != 200:
                raise ValueError("metadata source unavailable")
            kind = response.getheader("Content-Type", "").lower()
            if not any(value in kind for value in ("application/json", "text/html", "application/xhtml+xml")):
                raise ValueError("not a metadata response")
            body = bytearray()
            while len(body) <= MAX_BYTES:
                if connection.sock is not None:
                    connection.sock.settimeout(_remaining(deadline))
                chunk = response.read1(min(65536, MAX_BYTES + 1 - len(body)))
                if not chunk:
                    return bytes(body), url, kind
                body.extend(chunk)
            raise ValueError("metadata response too large")
        finally:
            connection.close()
    raise ValueError("too many metadata redirects")


def _date(value):
    try:
        publication_window.date_interval(value)
    except (TypeError, ValueError):
        return None
    return str(value)


def _record(title, authors, url, source, *, doi="", arxiv="", date=None, venue=""):
    title = _text(title)
    if not title:
        raise ValueError("missing scholarly title")
    identity = "doi:" + doi if doi else ("arxiv:" + arxiv if arxiv else
        "url:" + hashlib.sha256(url.encode()).hexdigest()[:24])
    paper = {"paper_id": "external:" + identity, "title": title,
        "authors": [_text(value) for value in authors if _text(value)],
        "url": url, "source": source, "found_by": ["verified_metadata:" + source],
        "verification_url": url}
    if doi:
        paper["doi"] = doi
    if arxiv:
        paper["arxiv_id"] = arxiv
    if venue:
        paper["venue"] = _text(venue)
    if date and _date(date):
        paper["publication_date"] = str(date)
        paper["year"] = publication_window.date_interval(date)[0].year
    return paper


def crossref_record(body, doi):
    item = json.loads(body)["message"]
    if not isinstance(item, dict):
        raise ValueError("invalid DOI metadata record")
    if str(item.get("DOI", "")).casefold() != doi or item.get("type") not in PAPER_TYPES:
        raise ValueError("DOI or scholarly record type mismatch")
    title = next(iter(item.get("title") or []), "")
    authors = [" ".join(filter(None, [author.get("given"), author.get("family")]))
               or author.get("name", "") for author in item.get("author", []) if isinstance(author, dict)]
    date = None
    for key in ("published-online", "published", "published-print", "issued"):
        parts = (item.get(key) or {}).get("date-parts") or []
        if parts and parts[0]:
            value = "-".join(str(p) if index == 0 else "%02d" % p for index, p in enumerate(parts[0]))
            if _date(value):
                date = value
                break
    paper = _record(title, authors, "https://doi.org/" + doi, "crossref", doi=doi,
                    date=date, venue=next(iter(item.get("container-title") or []), ""))
    paper["verification_url"] = CROSSREF_WORKS + quote(doi, safe="/")
    return paper


class CitationTags(HTMLParser):
    """Read scholarly Highwire tags, not page text, OpenGraph headlines or abstracts."""
    FIELDS = {"citation_title", "citation_author", "citation_doi", "citation_arxiv_id",
              "citation_publication_date", "citation_date", "citation_journal_title",
              "citation_conference_title"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.values = {}

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "meta":
            return
        attrs = dict(attrs)
        name = (attrs.get("name") or "").lower()
        if name in self.FIELDS and attrs.get("content"):
            self.values.setdefault(name, []).append(_text(attrs["content"]))


def page_record(body, url):
    parser = CitationTags()
    parser.feed(body.decode("utf-8", errors="replace"))
    values = parser.values
    titles = list(dict.fromkeys(values.get("citation_title", [])))
    authors = values.get("citation_author", [])
    if len(titles) != 1 or not authors:
        raise ValueError("page lacks unambiguous scholarly metadata")
    ids = paper_identity.identifiers(" ".join(values.get("citation_doi", []) +
                                               values.get("citation_arxiv_id", [])))
    if any(len(group) > 1 for group in ids.values()):
        raise ValueError("page has conflicting identifiers")
    first = lambda field: next(iter(values.get(field, [])), "")
    return _record(titles[0], authors, url, "publisher_page",
                   doi=next(iter(ids["doi"]), ""), arxiv=next(iter(ids["arxiv"]), ""),
                   date=first("citation_publication_date") or first("citation_date"),
                   venue=first("citation_journal_title") or first("citation_conference_title"))


def resolve(request, deadline):
    """Verify the locator's record, with one article-page fallback for absent DOIs."""
    url = request["url"]
    ids = paper_identity.identifiers(url)
    paper = None
    if len(ids["doi"]) == 1 and not ids["arxiv"]:
        doi = next(iter(ids["doi"]))
        try:
            body, _, _ = fetch(CROSSREF_WORKS + quote(doi, safe="/"), deadline)
            paper = crossref_record(body, doi)
        except (OSError, ValueError, KeyError, TypeError, AttributeError, http.client.HTTPException):
            pass  # A publisher page can still verify a DOI absent from Crossref.
    if paper is None:
        source = "https://arxiv.org/abs/" + next(iter(ids["arxiv"])) if len(ids["arxiv"]) == 1 else url
        body, final_url, _ = fetch(source, deadline)
        paper = page_record(body, final_url)
    if paper_identity.identifier_conflict(paper, url):
        raise ValueError("linked paper identifier conflict")
    if any(ids.values()) and not paper_identity.identifier_match(paper, url):
        raise ValueError("page did not confirm the requested identifier")
    # Input identifiers/linked article metadata define a direct lookup. For
    # optional topic evidence, require the planned title to match exactly too.
    if not request.get("required") and title_key(paper["title"]) != title_key(request["title"]):
        raise ValueError("web title does not match the verified scholarly record")
    paper["url"] = url
    if request.get("title") and title_key(paper["title"]) == title_key(request["title"]):
        paper["found_by"].append("title:" + request["title"])
    return paper


def start(requests):
    results = queue.Queue()
    deadline = time.monotonic() + VERIFY_SECONDS

    def worker(index, request):
        try:
            paper = resolve(request, deadline)
            results.put((index, paper, "verified"))
        except (OSError, ValueError, KeyError, TypeError, AttributeError, http.client.HTTPException):
            results.put((index, None, "unverified"))

    for index, request in enumerate(requests):
        threading.Thread(target=worker, args=(index, request), daemon=True).start()
    return requests, results, deadline


def finish(job):
    requests, results, deadline = job
    received = {}
    while len(received) < len(requests):
        try:
            index, paper, status = results.get(timeout=max(0, deadline - time.monotonic()))
            received[index] = (paper, status)
        except queue.Empty:
            break
    papers, audit = [], []
    for index, request in enumerate(requests):
        paper, status = received.get(index, (None, "timeout"))
        if paper:
            papers.append(paper)
        audit.append({"url": request["url"], "status": status,
                      "source": paper.get("source") if paper else None})
    return papers, audit


def merge_missing(papers, verified):
    """Prefer retrieved records, but never merge a conflicting preprint/journal DOI."""
    combined = list(papers)
    added = 0
    for paper in verified:
        match = next((index for index, prior in enumerate(combined) if same_record(prior, paper)), None)
        if match is None:
            combined.append(paper)
            added += 1
        else:
            # Enrich only missing metadata; do not invent a PaperHub identity or
            # overwrite a retrieved version's existing identifiers/dates.
            prior = dict(combined[match])
            for key in ("doi", "arxiv_id", "url", "authors", "year", "publication_date", "venue"):
                if not prior.get(key) and paper.get(key):
                    prior[key] = paper[key]
            combined[match] = prior
    return combined, added


def same_record(prior, paper):
    locator = " ".join(str(paper.get(key) or "") for key in ("doi", "arxiv_id", "url"))
    if paper_identity.identifier_conflict(prior, locator):
        return False
    if paper_identity.identifier_match(prior, locator) or paper_identity.url_match(prior, paper["url"]):
        return True
    # Separate explicit identities must not be collapsed by title alone (e.g.
    # arXiv preprint vs. a publisher's version of record).
    if any(paper_identity.paper_identifiers(prior).values()) and any(paper_identity.paper_identifiers(paper).values()):
        return False
    if prior.get("year") and paper.get("year") and str(prior["year"]) != str(paper["year"]):
        return False
    return bool(title_key(paper["title"]) and title_key(prior.get("title")) == title_key(paper["title"]))
