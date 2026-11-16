"""Plain publication prose and LaTeX escaping, without caption-specific policy."""

import re

_SPECIAL = {
    "\\": r"\textbackslash{}",
    "%": r"\%",
    "&": r"\&",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}


def plain_text(value, field):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be nonempty publication prose")
    # Accept existing escaped literal specials without escaping them twice.
    value = re.sub(r"\\([%&$#_{}])", r"\1", value.strip())
    if re.search(r"\\(?:[A-Za-z]+|[()\[\]])", value):
        raise ValueError(
            f"{field} uses LaTeX commands; submit plain reader-facing prose, "
            "with mathematical symbols in Unicode"
        )
    if "\n\n" in value:
        raise ValueError(f"{field} must be one paragraph of publication prose")
    return value


def escape_latex(value):
    return "".join(_SPECIAL.get(ch, ch) for ch in value)


def latex(value, field):
    return escape_latex(plain_text(value, field))
