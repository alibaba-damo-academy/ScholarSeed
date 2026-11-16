# Localization verification contract

This page records reusable acceptance requirements, not a personal execution diary or a claim that
the current revision passed. Historical logs and raw screenshots are separate non-public records.

Verify touched dictionary keys, interpolation parameters, fallback behavior and actual language
switching using [localization](../architecture/localization.md), [i18n architecture](../architecture/i18n.md)
and the [testing contract](../quality/testing.md). Preserve user content, protocol values and identifiers.

Run the registered i18n checks and affected type/unit tests, then exercise the changed public UI in
English and Chinese. Inspect accessibility labels, errors, tooltips, theme, narrow windows and persisted
language preferences as applicable. Static inventories do not prove live locale switching or product
acceptance. Report the exact revision, actual commands/results and unverified scope; never recycle a
past screenshot or migration checklist as evidence for the final revision.
