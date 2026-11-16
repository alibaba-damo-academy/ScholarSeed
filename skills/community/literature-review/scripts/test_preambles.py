"""Publication oracle reads the renderer's literal and file-backed preambles."""

from unittest.mock import patch

import pytest
import smoke_publication


def test_real_preambles():
    sources = smoke_publication.preambles()
    template = smoke_publication.ROOT / "assets/templates/standard_chinese/standard_chinese.tex"
    assert sources["PREAMBLE_ZH"] == template.read_text(encoding="utf-8")
    assert r"\usepackage[preprint]{neurips_2026}" in sources["PREAMBLE_EN"]


@pytest.mark.parametrize(
    "expression",
    [
        "__import__('os').getcwd()",
        "(_slr_paths.HOME / '../outside.tex').read_text(encoding='utf-8')",
        "(_slr_paths.HOME / 'template.tex').read_text(errors='ignore')",
    ],
)
def test_unsupported_preamble_expressions_are_rejected(tmp_path, expression):
    source = tmp_path / "phase.py"
    source.write_text(f"PREAMBLE_EN = 'English'\nPREAMBLE_ZH = {expression}\n", encoding="utf-8")
    with (
        patch.object(smoke_publication, "PREAMBLE_SOURCE", source),
        patch.object(smoke_publication, "ROOT", tmp_path),
    ):
        with pytest.raises(ValueError):
            smoke_publication.preambles()


def test_missing_template_is_not_silently_replaced(tmp_path):
    source = tmp_path / "phase.py"
    source.write_text(
        "PREAMBLE_EN = 'English'\nPREAMBLE_ZH = (_slr_paths.HOME / 'missing.tex').read_text(encoding='utf-8')\n",
        encoding="utf-8",
    )
    with (
        patch.object(smoke_publication, "PREAMBLE_SOURCE", source),
        patch.object(smoke_publication, "ROOT", tmp_path),
    ):
        with pytest.raises(FileNotFoundError):
            smoke_publication.preambles()
