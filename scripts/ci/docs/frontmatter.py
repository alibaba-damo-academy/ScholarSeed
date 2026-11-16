from __future__ import annotations

import yaml

DOC_TYPES = (
    "architecture",
    "research",
    "proposal",
    "design",
    "review",
    "prototype",
    "bug",
    "release",
)
STATUSES = ("active", "draft", "implemented", "superseded", "legacy", "archived", "open", "fixed")
REQUIRED = ("id", "title", "doc_type", "category", "status", "keywords", "summary")
LIST_FIELDS = ("keywords", "related", "code_refs", "sources")
MERGE_TAG = "tag:yaml.org,2002:merge"


class UniqueLoader(yaml.SafeLoader):
    def __init__(self, stream):
        self.checked_mappings = set()
        super().__init__(stream)

    def flatten_mapping(self, node):
        if node not in self.checked_mappings:
            keys = set()
            for key_node, _ in node.value:
                key = (
                    key_node.value if key_node.tag == MERGE_TAG else self.construct_object(key_node)
                )
                if not isinstance(key, str) or key in keys:
                    raise ValueError(f"invalid or duplicate YAML key: {key}")
                keys.add(key)
            self.checked_mappings.add(node)
        super().flatten_mapping(node)


def mapping(loader, node, deep=False):
    loader.flatten_mapping(node)
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)


def load_yaml(text):
    return yaml.load(text, Loader=UniqueLoader)


def split(text):
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return None, text
    for index, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            metadata = load_yaml("".join(lines[1:index]))
            if not isinstance(metadata, dict):
                raise ValueError("frontmatter must be a YAML mapping")
            return metadata, "".join(lines[index + 1 :])
    raise ValueError("unclosed frontmatter")


def validate_meta(metadata):
    errors = []
    for field in REQUIRED:
        if field not in metadata or metadata[field] in (None, "", []):
            errors.append(f"missing required field: {field}")
    for field, allowed in (("doc_type", DOC_TYPES), ("status", STATUSES)):
        if field in metadata and metadata[field] not in allowed:
            errors.append(f"invalid {field}: {metadata[field]}")
    if "id" in metadata and (not isinstance(metadata["id"], str) or not metadata["id"].strip()):
        errors.append("id must be a nonempty string")
    for field in LIST_FIELDS:
        if field not in metadata:
            continue
        values = metadata[field]
        if not isinstance(values, list):
            errors.append(f"{field} must be a list")
        elif any(not isinstance(value, str) or not value.strip() for value in values):
            errors.append(f"{field} items must be nonempty strings")
        elif field == "code_refs" and not values:
            errors.append("code_refs requires at least one path")
    return errors
