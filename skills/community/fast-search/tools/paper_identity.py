"""Pure paper-identifier syntax; the agent resolves opaque links, not this code."""
import re
from urllib.parse import parse_qsl, unquote, urlencode, urlsplit, urlunsplit

URL_PATTERN = re.compile(r"https?://[^\s<>\"`]+", re.I)
DOI_PATTERN = re.compile(r"10\.\d{4,9}/[-._;()/:a-z0-9]+", re.I)
ARXIV_PATTERN = re.compile(r"(?<!\d)(\d{4}\.\d{4,5})(?:v\d+)?(?!\d)", re.I)
TRACKING_KEYS = {"fbclid", "gclid", "msclkid"}


def urls(text):
    values = []
    for match in URL_PATTERN.finditer(str(text or "")):
        value = match.group().rstrip(".,;>]×")
        while value.endswith(")") and value.count(")") > value.count("("):
            value = value[:-1]
        values.append(value)
    return values


def canonical_url(value):
    try:
        parts = urlsplit(str(value or ""))
        if parts.scheme.lower() not in {"http", "https"} or not parts.hostname or parts.username:
            return ""
        # Preserve meaningful query parameters such as article IDs.
        params = sorted((key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
                        if not key.lower().startswith("utm_") and key.lower() not in TRACKING_KEYS)
        return urlunsplit(("https", parts.netloc.lower(), parts.path.rstrip("/"), urlencode(params), ""))
    except ValueError:
        return ""


def identifiers(text):
    text = unquote(str(text or ""))
    for url in urls(text):
        # Tracking parameters can contain unrelated paper IDs too.
        text = text.replace(url, canonical_url(url))
    dois = set()
    for match in DOI_PATTERN.finditer(text):
        value = match.group().rstrip(".,;").casefold()
        while value.endswith(")") and value.count(")") > value.count("("):
            value = value[:-1]
        dois.add(value)
    for url in urls(text):
        try:
            parts = urlsplit(url)
        except ValueError:
            continue
        # Nature article paths carry the DOI suffix. Never invent DOI prefixes
        # for opaque publisher numbers such as Elsevier PII or IEEE IDs.
        if parts.hostname in {"nature.com", "www.nature.com"}:
            match = re.fullmatch(r"/articles/([a-z0-9][a-z0-9._-]*?)(?:\.pdf)?/?", parts.path, re.I)
            if match:
                dois.add("10.1038/" + match.group(1).casefold())
    arxiv = {match.group(1) for match in ARXIV_PATTERN.finditer(text)}
    return {"doi": dois, "arxiv": arxiv}


def paper_identifiers(paper):
    values = identifiers(paper.get("url"))
    # A source's explicit identifier wins over one inferred from a landing URL.
    # Otherwise a wrong DOI can be hidden by a URL containing the requested DOI.
    for field, kind in (("doi", "doi"), ("arxiv_id", "arxiv")):
        parsed = identifiers(paper.get(field))
        explicit = parsed[kind]
        if explicit:
            values[kind] = explicit
        if field == "doi" and parsed["arxiv"]:
            values["arxiv"] = parsed["arxiv"]
    return values


def identifier_match(paper, query):
    wanted, actual = identifiers(query), paper_identifiers(paper)
    return any(wanted[key] & actual[key] for key in wanted)


def identifier_conflict(paper, query):
    wanted, actual = identifiers(query), paper_identifiers(paper)
    return any(wanted[key] and actual[key] and not wanted[key] & actual[key] for key in wanted)


def url_match(paper, query):
    actual = canonical_url(paper.get("url"))
    return bool(actual and actual in {canonical_url(url) for url in urls(query)})
