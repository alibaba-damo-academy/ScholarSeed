"""Reviewed preset metadata; installation never implies authorization."""

from dataclasses import dataclass

API_KEY_LABEL = "API Key"


@dataclass(frozen=True)
class Connector:
    id: str
    name: str
    source: str
    url: str = ""
    oauth_url: str = ""
    issuer: str = ""
    scope: str = ""
    key_label: str = ""
    help_url: str = ""
    oauth_hosts: tuple[str, ...] = ()
    management_url: str = ""
    hosted_oauth: bool = False

    @property
    def methods(self) -> tuple[str, ...]:
        return (("key",) if self.key_label else ()) + (("oauth",) if self.oauth_url else ())


CATALOG = (
    Connector(
        "zotero",
        "Zotero",
        "https://github.com/54yyyu/zotero-mcp",
        key_label=API_KEY_LABEL,
        help_url="https://www.zotero.org/settings/keys",
    ),
    Connector(
        "firecrawl",
        "Firecrawl",
        "https://github.com/firecrawl/firecrawl-mcp-server",
        "https://mcp.firecrawl.dev/v2/mcp",
        "https://mcp.firecrawl.dev/v2/mcp-oauth",
        "https://www.firecrawl.dev",
        key_label=API_KEY_LABEL,
        help_url="https://www.firecrawl.dev/app/api-keys",
        oauth_hosts=("mcp.firecrawl.dev", "www.firecrawl.dev", "firecrawl.dev"),
    ),
    Connector(
        "github",
        "GitHub",
        "https://github.com/github/github-mcp-server",
        "https://api.githubcopilot.com/mcp/",
        "https://api.githubcopilot.com/mcp/",
        "https://github.com/login/oauth",
        key_label=API_KEY_LABEL,
        help_url="https://github.com/settings/tokens",
        oauth_hosts=("api.githubcopilot.com", "github.com"),
        management_url="https://github.com/settings/applications",
        hosted_oauth=True,
    ),
    Connector(
        "gitlab",
        "GitLab",
        "https://docs.gitlab.com/user/gitlab_duo/model_context_protocol/mcp_server/",
        "https://gitlab.com/api/v4/mcp",
        "https://gitlab.com/api/v4/mcp",
        "https://gitlab.com",
        "mcp",
        API_KEY_LABEL,
        "https://gitlab.com/-/user_settings/personal_access_tokens",
        ("gitlab.com",),
    ),
    Connector(
        "huggingface",
        "Hugging Face",
        "https://github.com/huggingface/hf-mcp-server",
        "https://huggingface.co/mcp",
        "https://huggingface.co/mcp?login",
        "https://huggingface.co",
        "read-mcp",
        API_KEY_LABEL,
        "https://huggingface.co/settings/tokens",
        ("huggingface.co",),
    ),
    Connector(
        "notion",
        "Notion",
        "https://developers.notion.com/docs/mcp",
        "https://mcp.notion.com/mcp",
        "https://mcp.notion.com/mcp",
        "https://mcp.notion.com",
        key_label=API_KEY_LABEL,
        help_url="https://developers.notion.com/docs/get-started-with-mcp",
        oauth_hosts=("mcp.notion.com", "www.notion.so", "notion.so"),
    ),
    Connector(
        "elicit",
        "Elicit",
        "https://elicit.com/api/mcp",
        "https://elicit.com/api/mcp",
        "https://elicit.com/api/mcp",
        "https://elicit.com/api/auth",
        "elicit.mcp offline_access",
        oauth_hosts=("elicit.com",),
    ),
)
CONNECTORS = {item.id: item for item in CATALOG}
RUNTIME_ID_PREFIX = "market-"
SECRET_PREFIX = "connector:"
ZOTERO_COMMAND = "zotero-mcp"
ZOTERO_API = "https://api.zotero.org"
ZOTERO_ENVIRONMENT = {"ZOTERO_LOCAL": "false"}
KEY_VALIDATION_URLS = {
    "huggingface": "https://huggingface.co/api/whoami-v2",
    "firecrawl": "https://api.firecrawl.dev/v2/team/credit-usage",
}


def connector(identifier: str) -> Connector:
    try:
        return CONNECTORS[identifier]
    except KeyError:
        raise ValueError("connector_unknown") from None
