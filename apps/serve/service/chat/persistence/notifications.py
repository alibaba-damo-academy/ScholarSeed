"""Chat-owned invalidation rules for committed catalog and event mutations."""

from __future__ import annotations

from service.chat.constants import (
    PRODUCT_EVENT_ARTIFACT_CHANGED,
    PRODUCT_EVENT_ARTIFACT_PUBLISHED,
    PRODUCT_EVENT_FILE_CHANGED,
    PRODUCT_EVENT_HIL_REQUESTED,
    PRODUCT_EVENT_HIL_RESOLVED,
    PRODUCT_EVENT_PRODUCT_DATA_CHANGED,
    PRODUCT_EVENT_REVIEW_READY,
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
)
from service.chat.persistence.attention import ATTENTION_CLOCK_TABLE
from service.chat.persistence.catalog import (
    SESSION_CATALOG_TABLE,
    SESSION_HIL_TABLE,
    SESSION_MESSAGE_QUEUE_TABLE,
    SESSION_TURN_SETTLEMENT_TABLE,
    SESSION_UNCERTAINTY_TABLE,
)
from service.chat.persistence.events import PRODUCT_EVENT_TABLE
from service.persistence.notifications import NotificationConnection, NotificationRule
from service.platform.notifications import ChangeHub, ChangeTopic

SESSION_STATE_FIELDS = (
    "title",
    "title_fallback",
    "status",
    "last_turn_id",
    "last_turn_status",
    "pinned",
    "archived",
    "project_path",
)
SUMMARY_KINDS = (
    PRODUCT_EVENT_SESSION_STATE,
    PRODUCT_EVENT_HIL_REQUESTED,
    PRODUCT_EVENT_HIL_RESOLVED,
    PRODUCT_EVENT_TURN_COMPLETED,
    PRODUCT_EVENT_TURN_FAILED,
    PRODUCT_EVENT_TURN_INTERRUPTED,
    PRODUCT_EVENT_TURN_UNKNOWN,
    PRODUCT_EVENT_REVIEW_READY,
)
RESOURCE_KINDS = (
    PRODUCT_EVENT_ARTIFACT_CHANGED,
    PRODUCT_EVENT_ARTIFACT_PUBLISHED,
    PRODUCT_EVENT_FILE_CHANGED,
    PRODUCT_EVENT_REVIEW_READY,
    PRODUCT_EVENT_PRODUCT_DATA_CHANGED,
)
OPERATIONS = ("INSERT", "UPDATE", "DELETE")


def observe_chat(connection: NotificationConnection, hub: ChangeHub, *, shared: bool) -> None:
    rules = [
        NotificationRule(ATTENTION_CLOCK_TABLE, "UPDATE", ChangeTopic.ATTENTION),
    ]
    for operation in OPERATIONS:
        row = "OLD" if operation == "DELETE" else "NEW"
        owner = "''" if shared else f"{row}.principal_id"
        predicate = (
            " OR ".join(f"NEW.{field} IS NOT OLD.{field}" for field in SESSION_STATE_FIELDS)
            if operation == "UPDATE"
            else "1"
        )
        rules.append(
            NotificationRule(
                SESSION_CATALOG_TABLE,
                operation,
                ChangeTopic.SESSIONS,
                owner,
                f"{row}.session_id",
                predicate,
            )
        )
        owner = (
            "''"
            if shared
            else (
                f"(SELECT principal_id FROM {SESSION_CATALOG_TABLE} WHERE session_id={row}.session_id)"
            )
        )
        for table in (
            SESSION_HIL_TABLE,
            SESSION_MESSAGE_QUEUE_TABLE,
            SESSION_TURN_SETTLEMENT_TABLE,
            SESSION_UNCERTAINTY_TABLE,
        ):
            rules.append(
                NotificationRule(
                    table,
                    operation,
                    ChangeTopic.SESSIONS,
                    f"COALESCE({owner},'')",
                    f"{row}.session_id",
                    f"EXISTS (SELECT 1 FROM {SESSION_CATALOG_TABLE} WHERE session_id={row}.session_id)",
                )
            )
    owner = (
        "''"
        if shared
        else (f"(SELECT principal_id FROM {SESSION_CATALOG_TABLE} WHERE session_id=NEW.session_id)")
    )
    for topic, kinds in (
        (ChangeTopic.SESSIONS, SUMMARY_KINDS),
        (ChangeTopic.RESOURCES, RESOURCE_KINDS),
        (ChangeTopic.LITERATURE, (PRODUCT_EVENT_PRODUCT_DATA_CHANGED,)),
    ):
        choices = ",".join(f"'{kind}'" for kind in kinds)
        rules.append(
            NotificationRule(
                PRODUCT_EVENT_TABLE,
                "INSERT",
                topic,
                owner,
                "NEW.session_id",
                f"NEW.kind IN ({choices})",
            )
        )
    connection.observe(hub.publish, rules)
