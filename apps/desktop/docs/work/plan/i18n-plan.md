# Localization implementation plan

The durable contract is [localization](../../architecture/localization.md),
[architecture](../../architecture/i18n.md) and [testing](../../quality/testing.md).

Implement the infrastructure first; migrating an entire page is not implied by a local change.
Visible copy, accessibility labels, parameters and locale switching must remain consistent across
English and Chinese. Preserve user content, protocol data and technical identifiers.

Validate touched dictionary keys, TypeScript consumers, actual locale changes and persistent
preferences. Static scans and historical migration logs do not establish current product acceptance.
Personal workspaces, execution transcripts and raw screenshots are not public engineering contracts.
