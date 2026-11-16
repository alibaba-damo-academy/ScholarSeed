#!/usr/bin/env scholarseed-skill-python
"""Paper deduplication tool.

Usage:
    scholarseed-skill-python dedup.py --input papers.json
    cat papers.json | scholarseed-skill-python dedup.py
    
Reads a JSON array of paper objects, deduplicates by normalized title,
outputs deduplicated array.
"""

import argparse
import json
import re
import sys
import unicodedata
from catalog import merge_groups


def title_key(title):
    return "".join(c for c in unicodedata.normalize("NFKC", title or "").casefold() if c.isalnum())


def identifiers(paper):
    external = paper.get("external_ids") or {}
    doi = str(paper.get("doi") or external.get("DOI") or "").strip().casefold()
    doi = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", doi)
    arxiv = str(paper.get("arxiv_id") or external.get("ArXiv") or "").strip().casefold()
    arxiv = re.sub(r"^(?:https?://arxiv\.org/(?:abs|pdf)/|arxiv:\s*)", "", arxiv).removesuffix(".pdf")
    return doi, arxiv


def same_paper(left, right):
    ld, la = identifiers(left)
    rd, ra = identifiers(right)
    if ld and rd and ld != rd:
        return False
    if la and ra:
        if re.sub(r"v\d+$", "", la) != re.sub(r"v\d+$", "", ra):
            return False
        if re.search(r"v\d+$", la) and re.search(r"v\d+$", ra) and la != ra:
            return False
        return True
    if ld and rd:
        return True
    return bool(title_key(left.get("title")) and title_key(left.get("title")) == title_key(right.get("title"))
                and not (left.get("year") and right.get("year") and str(left["year"]) != str(right["year"])))


def paperhub_id(paper):
    value = paper.get("paperhub_id")
    if not value and paper.get("source") == "paperhub":
        value = paper.get("paper_id")
    return str(value) if value else ""


def merge_records(left, right):
    # Keep the provider's real ID and source even when the library record is first.
    primary, secondary = (right, left) if paperhub_id(right) and not paperhub_id(left) else (left, right)
    result = dict(primary)
    for key, value in secondary.items():
        if key not in ("paper_id", "source", "abstract", "abstract_truncated", "abstract_provenance") and result.get(key) in (None, "", []):
            result[key] = value
    for key in ("found_by", "library_refs"):
        values = list(dict.fromkeys([*left.get(key, []), *right.get(key, [])]))
        if values:
            result[key] = values
    if paperhub_id(primary):
        result["paperhub_id"] = paperhub_id(primary)
    # Abstract and its truncation marker belong to the same source record.
    def usable(paper):
        value = paper.get("abstract")
        if not isinstance(value, str) or not value.strip() or paper.get("abstract_truncated"):
            return False
        key = " ".join(value.split()).casefold().strip(". ")
        return key not in {"n/a", "na", "none", "null", "unknown", "not available", "not found",
                           "no abstract", "no abstract available", "abstract unavailable",
                           "abstract not available", "无摘要", "暂无摘要"} and not value.rstrip().endswith(("…", "...", "[truncated]", "[TRUNCATED]"))
    abstract_source = primary if usable(primary) or not usable(secondary) else secondary
    if "abstract" in abstract_source:
        result["abstract"] = abstract_source["abstract"]
    result.pop("abstract_provenance", None)
    if "abstract_provenance" in abstract_source:
        result["abstract_provenance"] = abstract_source["abstract_provenance"]
    result.pop("abstract_truncated", None)
    if "abstract_truncated" in abstract_source:
        result["abstract_truncated"] = abstract_source["abstract_truncated"]
    merge_groups(result, primary, secondary)
    return result


def is_same_paper(title1, title2):
    return bool(title_key(title1) and title_key(title1) == title_key(title2))


def deduplicate(papers):
    result = []
    index = {}
    def keys(paper):
        doi, arxiv = identifiers(paper)
        return [key for key in ("d:" + doi if doi else "", "a:" + re.sub(r"v\d+$", "", arxiv) if arxiv else "", "t:" + title_key(paper.get("title"))) if key]
    for paper in papers:
        if not isinstance(paper, dict) or not title_key(paper.get("title")):
            continue
        candidates = set().union(*(index.get(key, set()) for key in keys(paper)))
        matches = [i for i in candidates if same_paper(result[i], paper)]
        if len(matches) == 1:
            position = matches[0]
            result[position] = merge_records(result[position], paper)
        else:
            position = len(result)
            result.append(dict(paper))
        for key in keys(paper) + keys(result[position]):
            index.setdefault(key, set()).add(position)
    return result


def main():
    parser = argparse.ArgumentParser(description="Paper deduplication")
    parser.add_argument("--input", "-i", help="Input JSON file (default: stdin)")
    args = parser.parse_args()

    if args.input:
        with open(args.input) as f:
            papers = json.load(f)
    else:
        papers = json.load(sys.stdin)

    if isinstance(papers, dict):
        papers = papers.get("papers", papers.get("results", []))

    deduped = deduplicate(papers)

    json.dump({
        "papers": deduped,
        "original_count": len(papers),
        "deduped_count": len(deduped),
        "removed": len(papers) - len(deduped),
    }, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
