"""ScholarSeed MVP skill catalogue contract."""

# 测试隔离写法: 先设 SCHOLARSEED_HOME / 隔离 research db / 写 config, 再 import 首方模块;
# 因此 service.* 的 import 被隔离代码分隔，不能归组。
# pylint: disable=wrong-import-position,ungrouped-imports

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

TEST_HOME = Path(tempfile.mkdtemp(prefix="scholarseed-skill-home-")).resolve()
os.environ["SCHOLARSEED_HOME"] = str(TEST_HOME)
os.environ["SCHOLARSEED_CODEX_HOME"] = str(TEST_HOME / "codex")

from tests._isolate import isolate_research_db  # noqa: E402

isolate_research_db()
(TEST_HOME / "config.json").write_text(
    json.dumps(
        {
            "provider": "openai",
            "api_key": "test-key",
            "model_name": "test-model",
            "small_model_name": "test-model",
        }
    ),
    encoding="utf-8",
)

from service.bootstrap import create_app  # noqa: E402
from service.capabilities.service.skills import (  # noqa: E402
    load_skill_state,
    replace_skill_state,
    save_skill_state,
)
from service.identity.utils import LOCAL_USER_ID  # noqa: E402
from service.paths import SERVICE_BUNDLED_SKILLS_DIR  # noqa: E402
from service.settings.connections import ModelProfileStore, personal_model_key  # noqa: E402

REDACTION_SENTINEL = "codex-secret-from-runtime"
CONVERSATION_SKILLS = {
    "find-skill",
    "research-idea-partner",
    "design-research-validation",
    "literature-review",
    "precise-literature-search",
    "agentic-search",
    "plugin-create",
}


class _FailingRuntime:
    async def cached_skill_inventory(self, **_kwargs):
        raise RuntimeError(REDACTION_SENTINEL)


def main() -> int:
    # Native inventory mutations need an explicit personal connection. Product
    # config.json configures built-in models and no longer grants anonymous auth.
    ModelProfileStore().upsert(
        {
            "provider": "openai",
            "base_url": "https://skills-contract.example.test/v1",
            "api_key": "test-key",
            "selected_models": [{"id": "test-model", "label": ""}],
        }
    )
    workspace = TEST_HOME / "workspace"
    workspace.mkdir()
    skill_dir = TEST_HOME / "skills" / "demo-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: demo-skill\ndescription: ScholarSeed contract skill\n---\n",
        encoding="utf-8",
    )
    app = create_app(workspace, auth=False)
    with TestClient(app) as client:
        profile = ModelProfileStore().upsert(
            {
                "provider": "openai",
                "preview_name": "Contract inventory",
                "base_url": "https://personal.example.test/v1",
                "api_key": "test-key",
                "selected_models": [{"id": "test-model", "label": "Contract model"}],
            },
            owner_id=LOCAL_USER_ID,
            user_id=LOCAL_USER_ID,
        )
        selected = client.post(
            "/api/serve/models/default",
            json={"model_key": personal_model_key(profile["id"], "test-model")},
        )
        assert selected.status_code == 200, selected.text

        assert client.post("/api/capabilities/tools/paperhub.search/activate").status_code == 404
        assert client.delete("/api/capabilities/tools/paperhub.search/activate").status_code == 404

        listed = client.get("/api/capabilities/skills")
        assert listed.status_code == 200, listed.text
        skills = {item["name"]: item for item in listed.json()["skills"]}
        assert skills["demo-skill"]["active"] is True
        assert skills["demo-skill"]["enabled"] is True
        assert skills["demo-skill"]["toggleable"] is True

        conversation = client.get("/api/capabilities/skills?surface=conversation")
        assert conversation.status_code == 200, conversation.text
        conversation_skills = {item["name"]: item for item in conversation.json()["skills"]}
        assert set(conversation_skills) == CONVERSATION_SKILLS | {"demo-skill"}, set(
            conversation_skills
        )
        assert conversation_skills["research-idea-partner"]["descriptions"]["zh"]
        assert conversation_skills["design-research-validation"]["descriptions"]["zh"]
        for name in ("research-idea-partner", "design-research-validation"):
            assert conversation_skills[name]["requires_login"] is True
            assert conversation_skills[name]["unavailable_reason"] == "login_required"
            assert conversation_skills[name]["active"] is False
            assert conversation_skills[name]["toggleable"] is True
        assert conversation_skills["agentic-search"]["descriptions"]["zh"]
        assert conversation_skills["agentic-search"]["description"].startswith(
            "Tiered academic paper discovery"
        )
        assert conversation_skills["demo-skill"]["active"] is True
        settings = client.get("/api/capabilities/skills?surface=settings")
        assert settings.status_code == 200, settings.text
        settings_skills = {item["name"]: item for item in settings.json()["skills"]}
        assert settings_skills["find-skill"]["builtin"] is True
        assert settings_skills["find-skill"]["group"] == "scholarseed"
        assert settings_skills["find-skill"]["requires_login"] is False
        assert settings_skills["find-skill"]["active"] is True
        assert settings_skills["find-skill"]["toggleable"] is True
        assert set(settings_skills) == CONVERSATION_SKILLS | {"demo-skill"}, set(settings_skills)
        assert settings_skills["demo-skill"]["active"] is True
        assert client.get("/api/capabilities/skills?surface=unknown").status_code == 422

        web_search = skills["web-search"]
        assert web_search["group"] == "scholarseed"
        assert web_search["active"] is True
        assert web_search["enabled"] is True
        assert web_search["dependency_status"] == "ready"
        assert (
            Path(web_search["path"]).resolve()
            == (SERVICE_BUNDLED_SKILLS_DIR / "web-search" / "SKILL.md").resolve()
        )

        fast_search = skills["fast-search"]
        assert fast_search["enabled"] is True
        assert fast_search["active"] is False
        assert fast_search["requires_login"] is True
        assert fast_search["unavailable_reason"] == "login_required"
        assert fast_search["toggleable"] is True
        immutable_toggle = client.delete("/api/capabilities/skills/fast-search/activate")
        assert immutable_toggle.status_code == 200, immutable_toggle.text
        assert "fast-search" in load_skill_state().disabled_skills
        assert client.post("/api/capabilities/skills/fast-search/activate").status_code == 200

        builtin = skills["agentic-search"]
        state = load_skill_state()
        save_skill_state(
            replace_skill_state(
                state,
                disabled_skills=state.disabled_skills | {builtin["name"]},
                deleted_skills=state.deleted_skills | {builtin["name"]},
            )
        )
        skills = {
            item["name"]: item for item in client.get("/api/capabilities/skills").json()["skills"]
        }
        assert skills[builtin["name"]]["enabled"] is False
        assert skills[builtin["name"]]["runtime_enabled"] is None
        assert skills[builtin["name"]]["active"] is False
        assert skills[builtin["name"]]["toggleable"] is True
        assert skills[builtin["name"]]["removable"] is False
        enabled = client.post(f"/api/capabilities/skills/{builtin['name']}/activate")
        assert enabled.status_code == 200, enabled.text
        restored = {
            item["name"]: item for item in client.get("/api/capabilities/skills").json()["skills"]
        }
        assert restored[builtin["name"]]["runtime_enabled"] is None
        disabled = client.delete(f"/api/capabilities/skills/{builtin['name']}/activate")
        assert disabled.status_code == 200, disabled.text
        assert builtin["name"] in load_skill_state().disabled_skills
        refreshed = {
            item["name"]: item for item in client.get("/api/capabilities/skills").json()["skills"]
        }
        assert refreshed[builtin["name"]]["runtime_enabled"] is None
        assert refreshed[builtin["name"]]["active"] is False
        assert refreshed["fast-search"]["enabled"] is True
        assert refreshed["fast-search"]["runtime_enabled"] is None
        assert refreshed["fast-search"]["active"] is False
        immutable = client.delete(f"/api/capabilities/skills/{builtin['name']}")
        assert immutable.status_code == 403, immutable.text
        assert immutable.json()["detail"] == "内置技能不可删除"

        disabled = client.delete("/api/capabilities/skills/demo-skill/activate")
        assert disabled.status_code == 200, disabled.text
        skills = {
            item["name"]: item for item in client.get("/api/capabilities/skills").json()["skills"]
        }
        assert skills["demo-skill"]["active"] is False
        assert skills["demo-skill"]["runtime_enabled"] is None
        disabled_conversation = client.get("/api/capabilities/skills?surface=conversation")
        assert disabled_conversation.status_code == 200, disabled_conversation.text
        assert (
            next(
                item
                for item in disabled_conversation.json()["skills"]
                if item["name"] == "demo-skill"
            )["active"]
            is False
        )

        enabled = client.post("/api/capabilities/skills/demo-skill/activate")
        assert enabled.status_code == 200, enabled.text
        restored = {
            item["name"]: item for item in client.get("/api/capabilities/skills").json()["skills"]
        }
        assert restored["demo-skill"]["runtime_enabled"] is None

        app.state.runtime_service = _FailingRuntime()
        unavailable = client.get("/api/capabilities/skills")
        assert unavailable.status_code == 200, unavailable.text
        assert any(row["name"] == "demo-skill" for row in unavailable.json()["skills"])
        assert REDACTION_SENTINEL not in unavailable.text
        print("PASS: ScholarSeed skill catalogue + activation")
        return 0


if __name__ == "__main__":
    sys.exit(main())
