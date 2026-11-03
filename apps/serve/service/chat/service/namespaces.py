"""Request-scoped, reversible namespace projection for Chat Completions tools."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Mapping

TOOL_TYPE_FIELD = "type"
TOOL_NAME_FIELD = "name"
TOOL_NAMESPACE_FIELD = "namespace"
TOOLS_FIELD = "tools"
INPUT_FIELD = "input"
TOOL_CHOICE_FIELD = "tool_choice"
FUNCTION_TOOL_TYPE = "function"
NAMESPACE_TOOL_TYPE = "namespace"
FUNCTION_CALL_TYPE = "function_call"
TOOL_DESCRIPTION_FIELD = "description"
NAMESPACE_NAME_SEPARATOR = "__"
CHAT_TOOL_NAME_LIMIT = 64
CHAT_TOOL_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")
ENCODING = "utf-8"


@dataclass(frozen=True)
class ToolIdentity:
    namespace: str
    name: str

    @property
    def wire_name(self) -> str:
        if not self.namespace:
            return self.name
        qualified = NAMESPACE_NAME_SEPARATOR.join((self.namespace, self.name))
        if len(qualified) <= CHAT_TOOL_NAME_LIMIT and CHAT_TOOL_NAME_PATTERN.fullmatch(qualified):
            return qualified
        identity = json.dumps((self.namespace, self.name), ensure_ascii=True).encode(ENCODING)
        return hashlib.sha256(identity).hexdigest()


@dataclass(frozen=True)
class NamespaceTools:
    identities: Mapping[str, ToolIdentity]

    @classmethod
    def project(cls, payload: Mapping[str, Any]) -> tuple[dict[str, Any], NamespaceTools]:
        declarations = payload.get(TOOLS_FIELD) or []
        if not isinstance(declarations, list):
            raise ValueError("tool declarations must be a list")
        identities: dict[str, ToolIdentity] = {}
        tools: list[dict[str, Any]] = []
        for declaration in declarations:
            if not isinstance(declaration, Mapping):
                raise ValueError("invalid tool declaration")
            if declaration.get(TOOL_TYPE_FIELD) != NAMESPACE_TOOL_TYPE:
                groups = [("", [declaration], "")]
            else:
                namespace = declaration.get(TOOL_NAME_FIELD)
                children = declaration.get(TOOLS_FIELD)
                if (
                    not isinstance(namespace, str)
                    or not namespace.strip()
                    or not isinstance(children, list)
                ):
                    raise ValueError("invalid namespace declaration")
                groups = [(namespace, children, str(declaration.get(TOOL_DESCRIPTION_FIELD) or ""))]
            for namespace, children, description in groups:
                for child in children:
                    if not isinstance(child, Mapping):
                        raise ValueError("invalid namespace tool")
                    if child.get(TOOL_TYPE_FIELD) != FUNCTION_TOOL_TYPE:
                        if namespace:
                            raise ValueError("unsupported namespace tool")
                        tools.append(dict(child))
                        continue
                    name = child.get(TOOL_NAME_FIELD)
                    if not isinstance(name, str) or not name.strip():
                        raise ValueError("invalid function name")
                    identity = ToolIdentity(namespace, name)
                    if identity.wire_name in identities:
                        raise ValueError("ambiguous function name")
                    identities[identity.wire_name] = identity
                    projected = {**child, TOOL_NAME_FIELD: identity.wire_name}
                    if description:
                        projected[TOOL_DESCRIPTION_FIELD] = "\n".join(
                            value
                            for value in (description, str(child.get(TOOL_DESCRIPTION_FIELD) or ""))
                            if value
                        )
                    tools.append(projected)
        projection = cls(identities)
        result = {**payload, TOOLS_FIELD: tools}
        inputs = payload.get(INPUT_FIELD)
        if isinstance(inputs, list):
            result[INPUT_FIELD] = [
                (
                    projection._project_call(item)
                    if isinstance(item, Mapping) and item.get(TOOL_TYPE_FIELD) == FUNCTION_CALL_TYPE
                    else item
                )
                for item in inputs
            ]
        choice = payload.get(TOOL_CHOICE_FIELD)
        if isinstance(choice, Mapping) and choice.get(TOOL_TYPE_FIELD) == FUNCTION_TOOL_TYPE:
            result[TOOL_CHOICE_FIELD] = projection._project_call(choice)
        return result, projection

    def _project_call(self, call: Mapping[str, Any]) -> dict[str, Any]:
        name = call.get(TOOL_NAME_FIELD)
        namespace = call.get(TOOL_NAMESPACE_FIELD) or ""
        if not isinstance(name, str) or not isinstance(namespace, str):
            raise ValueError("invalid function identity")
        if namespace:
            wire_name = ToolIdentity(namespace, name).wire_name
        elif name in self.identities:
            wire_name = name
        else:
            matches = [
                wire_name
                for wire_name, identity in self.identities.items()
                if identity.name == name
            ]
            if len(matches) > 1:
                raise ValueError("ambiguous function identity")
            wire_name = matches[0] if matches else name
        result = {**call, TOOL_NAME_FIELD: wire_name}
        result.pop(TOOL_NAMESPACE_FIELD, None)
        return result

    def restore(self, call: dict[str, Any]) -> dict[str, Any]:
        identity = self.identities.get(str(call.get(TOOL_NAME_FIELD) or ""))
        if identity is None or not identity.namespace:
            return call
        return {**call, TOOL_NAME_FIELD: identity.name, TOOL_NAMESPACE_FIELD: identity.namespace}
