"""Provenance is opt-in at the actual destination, not a model-name feature."""

import hashlib
import json

from service.inference.source import SOURCE_FIELD, SOURCE_UNAVAILABLE, accepts_source, attach_source

DESTINATIONS = ("https://gateway.example/v1",)


def main() -> int:
    assert accepts_source("https://gateway.example/v1/responses", DESTINATIONS)
    assert not accepts_source("https://gateway.example.evil/v1/responses", DESTINATIONS)
    assert not accepts_source("http://gateway.example/v1/responses", DESTINATIONS)
    assert not accepts_source("https://personal.example/v1/responses", DESTINATIONS)
    body = {"model": "same-model", "input": [{"role": "user", "content": "context and question"}]}
    result = attach_source(body, session_id="s", turn_id="t", text="question")
    assert SOURCE_FIELD not in body
    assert result["input"] == body["input"]
    assert result[SOURCE_FIELD]["text"] == "question"
    try:
        attach_source(body, session_id="s", turn_id="t", text="")
    except ValueError as error:
        assert str(error) == SOURCE_UNAVAILABLE
    else:
        raise AssertionError("empty source text must be rejected before gateway submission")
    assert (
        result[SOURCE_FIELD]["request_sha256"]
        == hashlib.sha256(
            json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
    )
    print("content source: destination isolation, unchanged model input, digest: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
