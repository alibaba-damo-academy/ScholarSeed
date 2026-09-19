#!/usr/bin/env python3
"""Offline paper-dl CLI double used by integration tests and smoke_test.py."""

from __future__ import annotations

import argparse
import json
import os
import re
import time
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--storage", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--paper-timeout")
    parser.add_argument("--prefer-oa", action="store_true")
    parser.add_argument("--config")
    parser.add_argument("--profile")
    parser.add_argument("--email")
    parser.add_argument("--autodev", action="store_true")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--no-headless", action="store_true")
    parser.add_argument("--connect-cdp")
    parser.add_argument("--keep-open", action="store_true")
    parser.add_argument("--no-zotero", action="store_true")
    parser.add_argument("--zotero-save", action="store_true")
    args = parser.parse_args()
    pid_file = os.getenv("PAPER_DL_TEST_DOWNLOADER_PID_FILE")
    if pid_file:
        Path(pid_file).write_text(str(os.getpid()), encoding="utf-8")
    delay = float(os.getenv("PAPER_DL_TEST_DOWNLOADER_DELAY", "0"))
    if delay > 0:
        time.sleep(delay)
    interactive = bool(args.connect_cdp)
    desktop_first_config = False
    if args.config:
        config_text = Path(args.config).read_text(encoding="utf-8")
        desktop_first_config = (
            "zotero:" in config_text
            and "enabled: true" in config_text
            and "silent: true" in config_text
        )
    if sum((args.no_zotero, args.zotero_save, desktop_first_config)) != 1:
        raise SystemExit("fake requires exactly one supported Zotero mode")
    if args.no_zotero:
        zotero_mode = "off"
    elif args.zotero_save:
        zotero_mode = "fallback"
    elif desktop_first_config:
        zotero_mode = "desktop-first"
    unattended_flags = args.autodev and args.headless and zotero_mode == "off"
    interactive_flags = (
        interactive
        and args.no_headless
        and args.keep_open
        and not args.autodev
        and not args.headless
    )
    if not (unattended_flags or interactive_flags):
        raise SystemExit("fake requires either safe autodev or interactive CDP flags")
    if interactive:
        print(f"[FAKE CDP] attached to {args.connect_cdp}", flush=True)
    print(
        f"[FAKE OA] prefer={'oa' if args.prefer_oa else 'unspecified'}",
        flush=True,
    )
    print(f"[FAKE ZOTERO] mode={zotero_mode}", flush=True)
    identifiers = [
        line.strip() for line in args.input.read_text(encoding="utf-8").splitlines() if line.strip()
    ]
    results = []
    unable = 0
    for identifier in identifiers:
        if "viewer" in identifier.lower():
            unable += 1
            results.append(
                {
                    "identifier": {"kind": "doi", "value": identifier, "original": identifier},
                    "status": "unable",
                    "reason": "download_failed",
                    "action_reason": "viewer_open_capture_failed",
                    "title": f"Fake visible PDF for {identifier}",
                    "source_url": f"https://doi.org/{identifier}",
                    "pdf_url": (
                        "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/"
                        "index.html?file=https%3A%2F%2Fpublisher.example%2Fpaper.pdf"
                    ),
                    "content_type": "pdf",
                    "clean_path": None,
                    "original_path": None,
                    "manual_challenge": False,
                }
            )
            continue
        if "manual" in identifier.lower():
            unable += 1
            if interactive:
                print(
                    "! CAPTCHA / bot challenge detected — please solve it in the browser window",
                    flush=True,
                )
            results.append(
                {
                    "identifier": {"kind": "doi", "value": identifier, "original": identifier},
                    "status": "unable",
                    "reason": "needs_manual_solve",
                    "title": f"Fake manual challenge for {identifier}",
                    "content_type": "pdf",
                    "clean_path": None,
                    "original_path": None,
                    "manual_challenge": True,
                }
            )
            continue
        if "login" in identifier.lower():
            unable += 1
            if interactive:
                print(
                    "! Institutional login required — complete SSO in the browser window",
                    flush=True,
                )
            results.append(
                {
                    "identifier": {"kind": "doi", "value": identifier, "original": identifier},
                    "status": "unable",
                    "reason": "needs_institutional_login",
                    "title": f"Fake institutional login for {identifier}",
                    "content_type": "pdf",
                    "clean_path": None,
                    "original_path": None,
                    "manual_challenge": False,
                }
            )
            continue
        slug = re.sub(r"[^a-zA-Z0-9._-]+", "_", identifier)
        pdf_path = (args.storage / slug / "original.pdf").resolve()
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_path.write_bytes(b"%PDF-1.4\n% offline fake\n%%EOF\n")
        results.append(
            {
                "identifier": {"kind": "doi", "value": identifier, "original": identifier},
                "status": "success",
                "reason": None,
                "title": f"Fake downloaded paper for {identifier}",
                "content_type": "pdf",
                "clean_path": str(pdf_path),
                "original_path": str(pdf_path),
            }
        )
    report = {
        "summary": {
            "total": len(results),
            "success": len(results) - unable,
            "cached": 0,
            "unable": unable,
            "needs_manual": unable,
            "manual_challenge": unable,
        },
        "started_at": "2026-01-01T00:00:00Z",
        "finished_at": "2026-01-01T00:00:01Z",
        "results": results,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return 1 if unable else 0


if __name__ == "__main__":
    raise SystemExit(main())
