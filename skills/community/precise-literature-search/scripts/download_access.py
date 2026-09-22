"""Keep download routing independent of evidence about access rights."""
from typing import Any
from post_open_gate import paper_arxiv_id


def download_access(paper: dict[str, Any] | None, route: str,
                    external: dict[str, Any] | None = None) -> dict[str, str]:
    paper = paper or {}
    external = external or {}
    discovery = external.get("discovery") or {}
    if not isinstance(discovery, dict):
        discovery = {}
    # Closed/unknown metadata is not proof that the acquired copy required
    # payment: the downloader may locate a repository copy independently.
    open_evidence = (
        paper_arxiv_id(paper) is not None
        or str(paper.get("open_access", "unknown")).casefold() == "yes"
        or discovery.get("provider_oa_asserted") is True
        or (discovery.get("independent_access") is True
            and discovery.get("acquisition_succeeded") is True)
    )
    return {"access_type": "open" if open_evidence else "unknown", "download_route": route}
