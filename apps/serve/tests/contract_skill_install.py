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

TEST_HOME = Path(tempfile.mkdtemp(prefix="scholarseed-skill-install-"))
os.environ["SCHOLARSEED_HOME"] = str(TEST_HOME)

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
from service.capabilities.service.skills import SKILL_CATEGORY_USER  # noqa: E402

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
    with TestClient(create_app(workspace, auth=False)) as client:

        # 1 单个 .md → 直接安装
        ok = upload(client, MANIFEST_NAME, manifest("contract-doc").encode())
        assert ok.status_code == 200, ok.text
        assert ok.json()["installed"]["name"] == "contract-doc"

        # 安装成功后: 归入「用户安装」+ 默认启用 + 可删除
        entry = listed(client)["contract-doc"]
        assert entry["category"] == SKILL_CATEGORY_USER, entry
        assert entry["enabled"] is True and entry["active"] is True, entry
        assert entry["group"] == "user" and entry["removable"] is True, entry

        # 落盘在本机用户技能目录 (不上传 SkillHub)
        assert (TEST_HOME / "skills" / "contract-doc" / MANIFEST_NAME).is_file()

        # 2 .zip 含 SKILL.md → 安装; 支持一级目录包裹
        ok = upload(
            client, "pack.zip", zip_bytes({f"pack/{MANIFEST_NAME}": manifest("contract-zip")})
        )
        assert ok.status_code == 200, ok.text
        assert ok.json()["installed"]["name"] == "contract-zip"

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
        assert over.status_code == 200, over.text
        document = client.get("/api/capabilities/skills/contract-doc/document")
        assert "overwritten description" in document.json()["document"], document.text

        # 4c 覆盖重装必须恢复启用: 先禁用再覆盖装回, 不能残留 disabled
        assert client.delete("/api/capabilities/skills/contract-doc/activate").status_code == 200
        assert listed(client)["contract-doc"]["enabled"] is False
        again = upload(client, MANIFEST_NAME, manifest("contract-doc").encode(), overwrite=True)
        assert again.status_code == 200, again.text
        assert listed(client)["contract-doc"]["enabled"] is True, "覆盖重装后应默认启用"

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
        revive = upload(client, "pack.zip", zip_bytes({MANIFEST_NAME: manifest("contract-zip")}))
        assert revive.status_code == 200, revive.text
        assert listed(client)["contract-zip"]["enabled"] is True, "重装后应重新可见并启用"

        # 8 客户端不连 SkillHub: 广场路由已下线
        assert client.get("/api/capabilities/hub/skills").status_code == 404

        print("PASS: skill upload install validation (PRD 2.1.6)")
        return 0


if __name__ == "__main__":
    sys.exit(main())
