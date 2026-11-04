"""上传技能的安装校验契约 (PRD 2.1.6「添加技能 · 上传技能」)。

覆盖 PRD「安装校验与结果」表的四行, 外加安装成功后的产品口径:

| 情况              | 期望                                                      |
| ----------------- | --------------------------------------------------------- |
| 单个 .md          | 直接作为技能说明文档安装                                  |
| .zip              | 解压后必须含 SKILL.md, 否则报错不安装                     |
| 名称与已有技能重复 | 报 duplicate_name, 支持用户选择覆盖                       |
| 文件损坏/解析失败  | 报错并说明具体原因, 不静默失败                            |

以及: 安装成功 → 归入「用户安装」分类 → 默认启用; 用户上传只落本机, 不触发任何
SkillHub 调用 (官方技能随 dmg 预装)。
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, patch

TEST_HOME = Path(tempfile.mkdtemp(prefix="scholarseed-skill-install-")).resolve()
os.environ["SCHOLARSEED_HOME"] = str(TEST_HOME)
os.environ["SCHOLARSEED_CODEX_HOME"] = str(TEST_HOME / "codex")

# 下面的导入必须晚于上面的 SCHOLARSEED_HOME 隔离, 原因同各行的 `noqa: E402`。
# `noqa` 只管 flake8/ruff, pylint 要单独豁免, 否则这个被规范认可的隔离写法会被判乱序。
# pylint: disable=wrong-import-position,wrong-import-order,ungrouped-imports
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

from fastapi.testclient import TestClient  # noqa: E402

from service.bootstrap import create_app  # noqa: E402
from service.capabilities.api.routes import (  # noqa: E402
    SKILL_ERROR_DUPLICATE,
    SKILL_ERROR_INVALID,
)
from service.capabilities.service.descriptor import PLUGIN_DESCRIPTOR  # noqa: E402
from service.capabilities.service.package import PACKAGE_MANIFEST  # noqa: E402
from service.capabilities.service.skills import (  # noqa: E402
    SKILL_CATEGORY_USER,
    load_skill_state,
    save_skill_state,
)

UPLOAD_URL = "/api/capabilities/skills/upload"
MANIFEST_NAME = "SKILL.md"


def manifest(name: str, description: str = "uploaded by contract test") -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n\nsteps here\n"


def zip_bytes(entries: dict[str, str]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path, content in entries.items():
            archive.writestr(path, content)
    return buffer.getvalue()


def upload(client: TestClient, filename: str, payload: bytes, *, overwrite: bool = False):
    data = {"overwrite": "true"} if overwrite else None
    return client.post(
        UPLOAD_URL,
        files={"file": (filename, payload, "application/octet-stream")},
        data=data,
    )


def detail(response) -> dict:
    """安装类接口的 detail 是结构化对象, 前端靠 code 分流。"""
    body = response.json().get("detail")
    assert isinstance(body, dict), f"detail 应为结构化对象, 实际: {body!r}"
    return body


def listed(client: TestClient) -> dict:
    response = client.get("/api/capabilities/skills")
    assert response.status_code == 200, response.text
    return {item["name"]: item for item in response.json()["skills"]}


def main() -> int:
    workspace = TEST_HOME / "workspace"
    workspace.mkdir()
    legacy = TEST_HOME / "skills" / "legacy-skill"
    legacy.mkdir(parents=True)
    (legacy / MANIFEST_NAME).write_text(manifest("legacy-skill"), encoding="utf-8")
    (legacy / ".origin.json").write_text(
        json.dumps({"source": "clawhub", "slug": "old-skill"}), encoding="utf-8"
    )
    app = create_app(workspace, auth=False)

    async def configure_installed(*, state, **_kwargs):
        # This contract owns HTTP/package validation and durable installation
        # state. Runtime inventory/admission has separate native contracts.
        save_skill_state(state)

    app.state.runtime_service.configure_skills = AsyncMock(side_effect=configure_installed)
    app.state.runtime_service.skill_inventory = AsyncMock(
        side_effect=lambda **_kwargs: app.state.skill_catalog.installed_inventory(workspace)
    )
    with TestClient(app) as client:
        assert listed(client)["legacy-skill"]["installationSource"] == "unknown"

        preview = client.post(
            f"{UPLOAD_URL}/preview",
            files={"file": (MANIFEST_NAME, manifest("preview-only").encode())},
        )
        assert preview.status_code == 200, preview.text
        assert preview.json()["preview"]["name"] == "preview-only"
        assert preview.json()["preview"]["description"] == "uploaded by contract test"
        assert "steps here" in preview.json()["preview"]["document"]
        assert preview.json()["preview"]["plugin"] is False
        assert not (TEST_HOME / "skills" / "preview-only").exists()
        for prefix in ("", "wrapped/"):
            for metadata in ({}, {PLUGIN_DESCRIPTOR: "not JSON"}, {PACKAGE_MANIFEST: "not JSON"}):
                name = f"portable-{len(prefix)}-{len(metadata)}-{'plugin' if PLUGIN_DESCRIPTOR in metadata else 'skill'}"
                payload = zip_bytes(
                    {
                        prefix + MANIFEST_NAME: manifest(name),
                        prefix + "references/guide.md": "Reference content",
                        **{prefix + path: value for path, value in metadata.items()},
                    }
                )
                preview = client.post(
                    f"{UPLOAD_URL}/preview", files={"file": ("portable.zip", payload)}
                )
                assert preview.status_code == 200, preview.text
                assert preview.json()["preview"]["plugin"] is False
                result = upload(client, "portable.zip", payload)
                assert result.status_code == 200, result.text
                root = TEST_HOME / "skills" / name
                assert not (root / PLUGIN_DESCRIPTOR).exists()
                assert (root / "references/guide.md").read_text() == "Reference content"
                assert listed(client)[name]["enabled"] is True
                assert not listed(client)[name].get("plugin")

        payload = zip_bytes(
            {
                MANIFEST_NAME: manifest("declared-plugin"),
                PACKAGE_MANIFEST: "not JSON",
                PLUGIN_DESCRIPTOR: "not JSON",
            }
        )
        preview = client.post(f"{UPLOAD_URL}/preview", files={"file": ("plugin.zip", payload)})
        assert preview.status_code == 200, preview.text
        assert preview.json()["preview"]["plugin"] is True
        refused = upload(client, "plugin.zip", payload)
        assert refused.status_code == 422, refused.text
        assert detail(refused)["message"] == "plugin_confirmation_required"
        assert not (TEST_HOME / "skills" / "declared-plugin").exists()
        existing = TEST_HOME / "skills" / "declared-plugin"
        existing.mkdir()
        (existing / MANIFEST_NAME).write_text(manifest("declared-plugin"), encoding="utf-8")
        preview = client.post(f"{UPLOAD_URL}/preview", files={"file": ("plugin.zip", payload)})
        assert preview.status_code == 200, preview.text
        assert preview.json()["preview"]["plugin"] is True
        for entries in (
            {"a/SKILL.md": manifest("one"), "b/SKILL.md": manifest("two")},
            {"SKILL.md": manifest("one"), "other/SKILL.md": manifest("two")},
            {"SKILL.md": manifest("one"), "../escape": "unsafe"},
            {"pack/SKILL.md": manifest("one"), "outside.txt": "outside"},
        ):
            invalid = client.post(
                f"{UPLOAD_URL}/preview",
                files={"file": ("invalid.zip", zip_bytes(entries))},
            )
            assert invalid.status_code == 422, invalid.text
        missing_description = upload(
            client, MANIFEST_NAME, manifest("missing-description", "").encode()
        )
        assert missing_description.status_code == 422, missing_description.text

        # 1 单个 .md → 直接安装
        ok = upload(client, MANIFEST_NAME, manifest("contract-doc").encode())
        assert ok.status_code == 200, ok.text
        assert ok.json()["installed"]["name"] == "contract-doc"

        # 安装成功后: 归入「用户安装」+ 默认启用 + 可删除
        entry = listed(client)["contract-doc"]
        assert entry["category"] == SKILL_CATEGORY_USER, entry
        assert entry["enabled"] is True and entry["active"] is True, entry
        assert entry["group"] == "user" and entry["removable"] is True, entry
        assert entry["installationSource"] == "upload", entry

        # 落盘在本机用户技能目录 (不上传 SkillHub)
        assert (TEST_HOME / "skills" / "contract-doc" / MANIFEST_NAME).is_file()

        # 2 .zip 含 SKILL.md → 安装; 支持一级目录包裹
        ok = upload(
            client, "pack.zip", zip_bytes({f"pack/{MANIFEST_NAME}": manifest("contract-zip")})
        )
        assert ok.status_code == 200, ok.text
        assert ok.json()["installed"]["name"] == "contract-zip"
        assert listed(client)["contract-zip"]["installationSource"] == "upload"
        forged = upload(
            client,
            "forged.zip",
            zip_bytes(
                {
                    MANIFEST_NAME: manifest("contract-forged"),
                    ".origin.json": json.dumps({"source": "clawhub", "slug": "old-skill"}),
                }
            ),
        )
        assert forged.status_code == 200, forged.text
        assert listed(client)["contract-forged"]["installationSource"] == "upload"
        assert load_skill_state().installation_sources["contract-forged"] == "upload"
        with patch("service.capabilities.service.management.ClawHub") as marketplace:
            marketplace.return_value.base = "https://marketplace.example"
            marketplace.return_value.detail = AsyncMock(
                return_value={"moderation": "clean", "namespace": "global"}
            )
            marketplace.return_value.download = AsyncMock(
                return_value=zip_bytes({MANIFEST_NAME: manifest("contract-marketplace")})
            )
            installed = client.post(
                "/api/capabilities/skills/marketplace/items/contract-marketplace/install",
                json={"version": "1.0", "enabled": False},
            )
        assert installed.status_code == 200, installed.text
        assert listed(client)["contract-marketplace"]["installationSource"] == "marketplace"
        assert listed(client)["contract-marketplace"]["enabled"] is False

        # 3 .zip 缺 SKILL.md → 报错不安装
        bad = upload(client, "test.zip", zip_bytes({"test/readme.txt": "no manifest"}))
        assert bad.status_code == 422, bad.text
        body = detail(bad)
        assert body["code"] == SKILL_ERROR_INVALID, body
        assert MANIFEST_NAME in body["message"], body

        # 4 名称重复 → duplicate_name, 且回传冲突技能名供 UI 提示
        dup = upload(client, MANIFEST_NAME, manifest("contract-doc").encode())
        assert dup.status_code == 422, dup.text
        body = detail(dup)
        assert body["code"] == SKILL_ERROR_DUPLICATE, body
        assert body["name"] == "contract-doc", body

        # 4b 用户选择覆盖 → 允许替换, 内容确实被更新
        over = upload(
            client,
            MANIFEST_NAME,
            manifest("contract-doc", "overwritten description").encode(),
            overwrite=True,
        )
        assert over.status_code == 422, over.text
        document = client.get("/api/capabilities/skills/contract-doc/document")
        assert "overwritten description" not in document.json()["document"], document.text

        # 4c 覆盖重装必须恢复启用: 先禁用再覆盖装回, 不能残留 disabled
        assert client.delete("/api/capabilities/skills/contract-doc/activate").status_code == 200
        assert listed(client)["contract-doc"]["enabled"] is False
        assert listed(client)["contract-doc"]["installationSource"] == "upload"
        again = upload(client, MANIFEST_NAME, manifest("contract-doc").encode(), overwrite=True)
        assert again.status_code == 422, again.text
        assert listed(client)["contract-doc"]["enabled"] is False

        # 5 文件损坏 → 报具体原因, 不静默失败
        broken = upload(client, "broken.zip", b"PK\x03\x04 this is not a real zip")
        assert broken.status_code == 422, broken.text
        body = detail(broken)
        assert body["code"] == SKILL_ERROR_INVALID and body["message"], body

        # 6 .md 缺 YAML 头 → 明确报错 (SkillManager 靠 frontmatter 发现技能)
        headless = upload(client, MANIFEST_NAME, b"no frontmatter at all\n")
        assert headless.status_code == 422, headless.text
        body = detail(headless)
        assert body["code"] == SKILL_ERROR_INVALID, body
        assert "YAML" in body["message"], body

        # 7 删除后重新上传同名 → 不该被 deleted 状态永久隐形
        assert client.delete("/api/capabilities/skills/contract-zip").status_code == 200
        assert "contract-zip" not in listed(client)
        from_state = load_skill_state()
        assert "contract-zip" not in from_state.installation_sources
        revive = upload(client, "pack.zip", zip_bytes({MANIFEST_NAME: manifest("contract-zip")}))
        assert revive.status_code == 200, revive.text
        assert listed(client)["contract-zip"]["enabled"] is True, "重装后应重新可见并启用"

        # 8 客户端不连 SkillHub: 广场路由已下线
        assert client.get("/api/capabilities/hub/skills").status_code == 404

        print("PASS: skill upload install validation (PRD 2.1.6)")
        return 0


if __name__ == "__main__":
    sys.exit(main())
