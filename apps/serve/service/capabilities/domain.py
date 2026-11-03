"""Skill identity and execution-admission request contract."""

from pydantic import BaseModel, ConfigDict, Field, field_validator

from service.platform.vocabulary import ARTIFACT_PATH_CHARS, BRIDGE_ROUTE_PREFIX

SKILL_MANIFEST_NAME = "SKILL.md"
PACKAGE_MANIFEST = ".scholarseed-package.json"
COMPONENT_ANSWER_CAPABILITY = "interaction.answer"
SKILL_CAPABILITY = "skill"
SKILL_ADMISSION_OPERATION = "admit"
SKILL_ADMISSION_ROUTE = BRIDGE_ROUTE_PREFIX + "skill/admit"
SKILL_MANAGEMENT_ROUTE = BRIDGE_ROUTE_PREFIX + "skill/"
SKILL_ID_PATTERN = r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$"
SKILL_NAME_PATTERN = r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$"
SKILL_QUERY_MAX = 200
SKILL_CURSOR_MAX = 2048
SKILL_CONFIRM_TIMEOUT_SECONDS = 120.0
SKILL_REPLAY_LIMIT = 256
SKILL_CONFIRM_APPROVE = "确认执行"
SKILL_CONFIRM_DENY = "取消"
SKILL_ERROR_IMMUTABLE = "immutable_skill"
SKILL_MANAGEMENT_SCOPE = "device_skills"


class SkillRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, hide_input_in_errors=True)


class SkillSearch(SkillRequest):
    query: str = Field(default="", max_length=SKILL_QUERY_MAX)
    cursor: str = Field(default="", max_length=SKILL_CURSOR_MAX)
    locale: str = Field(default="zh", pattern=r"^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$")

    @field_validator("query")
    @classmethod
    def validate_query(cls, value: str) -> str:
        if value and not value.strip():
            raise ValueError("Whitespace is not a search query")
        return value


class SkillDetail(SkillRequest):
    slug: str = Field(pattern=SKILL_ID_PATTERN)
    version: str = Field(default="", max_length=128)
    locale: str = Field(default="zh", pattern=r"^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$")


class SkillLocal(SkillRequest):
    name: str = Field(pattern=SKILL_NAME_PATTERN)


class SkillMutation(SkillRequest):
    client_op_id: str = Field(min_length=1, max_length=128, pattern=SKILL_ID_PATTERN)


class SkillInstall(SkillMutation):
    slug: str = Field(pattern=SKILL_ID_PATTERN)
    version: str = Field(pattern=SKILL_ID_PATTERN)
    enabled: bool = True


class SkillLocalMutation(SkillMutation, SkillLocal):
    pass


class SkillUpdate(SkillLocalMutation):
    version: str = Field(pattern=SKILL_ID_PATTERN)
    expected_version: str = Field(min_length=1, max_length=128)


SKILL_MANAGEMENT_REQUESTS: dict[str, type[BaseModel]] = {
    "search": SkillSearch,
    "detail": SkillDetail,
    "list": SkillRequest,
    "document": SkillLocal,
    "install": SkillInstall,
    "enable": SkillLocalMutation,
    "disable": SkillLocalMutation,
    "update": SkillUpdate,
    "delete": SkillLocalMutation,
}
SKILL_MUTATIONS = frozenset({"install", "enable", "disable", "update", "delete"})


class SkillAdmission(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    path: str = Field(min_length=1, max_length=ARTIFACT_PATH_CHARS)
