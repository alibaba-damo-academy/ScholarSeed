"""Dependency receipts for the existing material-processing substeps."""

import hashlib
import json
from copy import deepcopy
from pathlib import Path

from paper_materials import load, readiness
from reading import MARKER, preserves_task_card, validation_context

RECEIPT_VERSION = 1
COMPLETE_STATUSES = ("SUCCESS", "PARTIAL_SUCCESS")


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()


def files(workspace, names):
    result = {}
    for name in names:
        path = Path(workspace) / name
        if not path.is_file():
            result[name] = None
            continue
        payload = path.read_bytes()
        if path.suffix == ".json":
            try:
                payload = json.dumps(
                    json.loads(payload), sort_keys=True, ensure_ascii=False
                ).encode()
            except (ValueError, UnicodeError):
                pass
        result[name] = hashlib.sha256(payload).hexdigest()
    return result


def code_revision(home):
    home = Path(home)
    paths = [home / "VERSION", home / "scripts/generation/_fast/_utils.py"]
    paths += list((home / "lib").glob("*.py"))
    paths += list((home / "scripts/processing").glob("*.py"))
    return digest(files(home, sorted(p.relative_to(home).as_posix() for p in paths)))


def dependency_key(workspace, rule, command, revision):
    return digest(
        {
            "schema": RECEIPT_VERSION,
            "rule": rule,
            "command": command,
            "code_revision": revision,
            "inputs": files(workspace, rule.get("inputs", [])),
        }
    )


def reusable(workspace, rule, key, receipt):
    if rule.get("validator") == "paper_cards":
        # This is the same source/L1/quality validation used by extraction. It
        # deliberately does not require a bibliography that may not exist yet.
        context = validation_context(workspace)
        selected = load(Path(workspace) / "02_retrieval/selected_paper.json", {})
        cards = load(Path(workspace) / "03_process/paper_cards.json", {})
        info = load(Path(workspace) / "02_retrieval/paper_info.json", {})
        for pid in context.get("assets", {}):
            card = cards.get(pid)
            if pid in selected and not (isinstance(card, dict) and MARKER in card):
                if not preserves_task_card(selected[pid], info.get(pid), card):
                    return None  # The importer still has a new L1 projection to apply.
        state = readiness(workspace, reading_context=context)
        if (
            state["selected_count"]
            and state["usable_card_count"] == state["selected_count"]
            and not state["missing_card_ids"]
        ):
            return {
                "status": "SUCCESS",
                "processed": 0,
                "reused": True,
                "usable_card_count": state["usable_card_count"],
                "message": "Saved cards passed source, L1 and quality validation",
            }
        return None
    outputs = files(workspace, rule.get("outputs", []))
    if (
        receipt
        and receipt.get("version") == RECEIPT_VERSION
        and receipt.get("input_key") == key
        and outputs
        and all(outputs.values())
        and receipt.get("outputs") == outputs
        and receipt.get("result", {}).get("status") in COMPLETE_STATUSES
    ):
        return {**deepcopy(receipt["result"]), "reused": True}
    return None


def receipt(workspace, rule, key, result):
    outputs = files(workspace, rule.get("outputs", []))
    if not outputs or not all(outputs.values()) or result.get("status") not in COMPLETE_STATUSES:
        return None
    return {
        "version": RECEIPT_VERSION,
        "input_key": key,
        "outputs": outputs,
        "result": deepcopy(result),
    }
