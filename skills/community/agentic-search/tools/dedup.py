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


def title_key(title):
    """Normalize title for dedup matching."""
    return re.sub(r"[^a-z0-9]+", "", (title or "").lower())


def is_same_paper(title1, title2):
    """Check if two titles refer to the same paper."""
    k1 = title_key(title1)
    k2 = title_key(title2)
    if not k1 or not k2:
        return False
    if k1 == k2:
        return True
    if len(k1) > 20 and len(k2) > 20:
        if k1 in k2 or k2 in k1:
            shorter = min(len(k1), len(k2))
            longer = max(len(k1), len(k2))
            if shorter / longer > 0.8:
                return True
    return False


def deduplicate(papers):
    """Deduplicate papers by title_key. First occurrence wins."""
    seen = {}
    result = []
    for p in papers:
        key = title_key(p.get("title", ""))
        if not key:
            continue
        if key not in seen:
            seen[key] = len(result)
            result.append(p)
        else:
            existing = result[seen[key]]
            if not existing.get("abstract") and p.get("abstract"):
                p["_also_found_by"] = existing.get("source", "")
                result[seen[key]] = p
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
