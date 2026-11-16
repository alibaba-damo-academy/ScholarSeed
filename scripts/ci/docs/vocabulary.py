from dataclasses import dataclass, field
from pathlib import Path

from scripts.ci.docs.frontmatter import load_yaml


@dataclass
class Vocab:
    facets: dict = field(default_factory=dict)
    aliases: dict = field(default_factory=dict)

    @property
    def terms(self):
        return {term for terms in self.facets.values() for term in terms}

    def canonical(self, term):
        return self.aliases.get(term, term)

    def facet_of(self, term):
        return next(
            (facet for facet, terms in self.facets.items() if self.canonical(term) in terms),
            "other",
        )

    def validate(self, keywords):
        canonical = list(dict.fromkeys(self.canonical(term) for term in keywords))
        return [term for term in canonical if term in self.terms], [
            term for term in canonical if term not in self.terms
        ]


def load(path: Path):
    data = load_yaml(path.read_text(encoding="utf-8"))
    if (
        not isinstance(data, dict)
        or not isinstance(data.get("facets"), dict)
        or not isinstance(data.get("aliases", {}), dict)
    ):
        raise ValueError("invalid vocabulary mapping")
    facets = data["facets"]
    aliases = data.get("aliases", {})
    for facet, terms in facets.items():
        if (
            not isinstance(facet, str)
            or not facet.strip()
            or not isinstance(terms, list)
            or any(not isinstance(term, str) or not term.strip() for term in terms)
        ):
            raise ValueError("invalid vocabulary facet or term")
    vocab = Vocab({facet: sorted(set(terms)) for facet, terms in facets.items()}, aliases)
    if any(
        not isinstance(alias, str)
        or not alias.strip()
        or not isinstance(target, str)
        or target not in vocab.terms
        for alias, target in aliases.items()
    ):
        raise ValueError("invalid vocabulary alias")
    return vocab
