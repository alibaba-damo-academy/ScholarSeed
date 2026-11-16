<a id="desktop-国际化剩余覆盖审计"></a>
# Remaining Desktop Localization Coverage Audit

Status: Code remediation is complete; real acceptance has separate gaps. On 2026-09-14, commit `9deac33d3` from this batch was pushed to the localization branch and entered existing CR #29964071. Source remediation, contract verification, and real product acceptance are recorded separately.

<a id="当前目标与剩余代码工作"></a>
## Current Goal and Remaining Code Work

The current Goal is complete when all production pages and the main process have code-level English and Chinese localization, review, applicable checks, and a push. Gaps involving real PDF attachments, OAuth, and Windows are tracked separately and do not block code remediation. Existing CSS debt must not increase or be relaxed.

- Closed: HIL resolved/submissionError, request and recovery fallbacks, system open/reveal failures, recoverable runtime prefixes, and Composer permission/stop notices now use explicit display sources; original user answers, request control values, and canonical states are preserved.
- Delivered: `9deac33d3` was committed and pushed; the final staged checker passed. Resource generation, type checks, build, and cross-review are complete. Of 887 full Desktop tests, 884 passed; all three existing failures were reproduced on the unmodified baseline. See the verification record for details.
- Remediated in the worktree: assistant failure sources and new excerpt names; resource feedback and task-source registration display; account default display names; Crepe public configuration copy; reasoning-depth selector; deletion confirmation; update failure explanation; 30 PDF Reading application errors; Zotero import task states and errors; context compaction and artifact failure states. The commit and verification record are authoritative for the final result.
- The default session title source was implemented in `3fa36754e`, and English/Chinese title switching was completed in a real attachment-only session; an existing user title with the same name remains unchanged. Real regression coverage is still missing for default-source references in preview, rename, and cold recovery.

<a id="持久化引用的兼容性要求"></a>
## Compatibility Requirements for Persisted References

- Existing source resolution replaces `ref.label` with the real `source.title`. A new fallback must follow the resolved authoritative title: clear the marker when a real title exists, even if that title happens to be “Untitled conversation”; inherit an explicit existing marker only when the title is empty, without guessing about historical records.
- `assistant/service/context.py` includes `asdict(ref)` in `_admission_hash`. Even a new field defaulting to null changes the digest shape, so preserve existing reference identity serialization and exclude display metadata. The actual impact is concurrent/idempotency conflict detection in `create_snapshot`; normal restoration of existing snapshots validates by `question_hash`/`selection_revision`, so do not overstate this as inevitable failure of every old restore.
- Model cards and `model_card_hash` retain the existing label and input; display metadata must not enter model context.
- Current reference and snapshot tables use only additive nullable columns; without metadata, old data displays its original text. `16b63f278` and `4927f4c34` cover schema/routes, domain models, resolved sources, both storage types, historical surfaces, queue, preview, failure notices, and frontend rendering. The complete real Desktop path still needs acceptance.

<a id="已整改真实验收仍有缺口"></a>
## Remediated; Real Acceptance Gaps Remain

| Area | Implementation evidence | Verification boundary |
| --- | --- | --- |
| Persisted untitled references | `16b63f278`, `4927f4c34`: explicitly propagate session source across layers; clear it for authoritative real titles; preserve frozen original text for empty preview titles | Serve 201 contracts and Desktop 91 related contracts passed; real selection/send/language-switch/preview was completed for same-name user sessions, real tool reads, and English/Chinese screenshots. Cold-restart preview is unverified; the empty-title entry is constrained by the list's default projection |
| Selection source titles | `bcca839b1`, `aabb63001`: propagate `selection_source_label` on both sides, remove suffix truncation, separate full/basic display, and preserve original text in failure/queue/history | Serve 238, storage 20, and Desktop 94 tests passed; real selection flow still needs an accessible regression with actual file selection/PDF/literature data |
| Workbench save notice and PDF labels | `2e9f93c93`: save toast subscribes to language as a ReactNode; PDF ratio aria uses complete interpolation; Crop page number reuses a resource | 42 contracts and type/checker passed; real toast hot switching and corresponding PDF flow remain unverified |
| Search failures and notices | `69d1a7e9e`, `1f9fe49f4`: stable failure codes, translated display, and delivered notices redraw on language change | Chromium notice lifecycle tested; real search failure/degradation/import still needs coverage |
| Public Markdown evidence and PDF popover | `8cb882e1a`: evidence level/source shell, task/image fallbacks, close/resize aria | Component contracts tested; full regression through a real PDF entry point remains outstanding |
| Project/review/AI search labels | `4a70b1131`: translate application labels by kind/metadata | Preserve original query/tab identity; real multi-tab switching remains to be regressed |
| Crepe native input | `d97be4e26`: image/search/link configuration | Real bilingual image placeholder was previously verified; a fixed `editorLanguage` takes effect after closing and reopening |
| Account settings and model presets | `e955e1fa1`, `f01a128ab`, `a26c9176a` | In build `d12807adb`, the Settings dialog, eight English presets, and bilingual Bailian notices were observed; the local Ollama explanation was read in an English screenshot. No new credentials were connected or saved |
| Answer-selection document template | `fff5586d4`: three headings use the language at creation time | 26 API contracts passed; real saving of a selection remains unverified; existing files are not rewritten |
| Excerpt/subscription lists | `8bb1407a9`: singular/plural, complete result messages, and list separators | Related contracts passed; real excerpt and subscription states remain to be regressed |
| Subscription titles/excerpt save count | `bdba29894`: connection name + status and saved selection count use complete interpolated messages | 57 related contracts and typecheck/checker passed; real operations remain unaccepted |
| Reading drafts and evidence page numbers | `c734b56b8`: PDF selection/summary follow-up drafts use the language at click time without changing original parameters; evidence buttons use complete messages | 18 PDF contracts and typecheck/checker passed; both real PDF entry points remain unverified. TableViewer completed bilingual draft regression through a normal TSV resource entry; CSV routes into Office and does not provide evidence for this button |
| Office font failure | `d0ed8a320`: stable code maps to an existing resource | 25 contracts passed; real unreadable-font branch remains unverified |
| Markdown narrow-pane toolbar | `9df01fb75`: wraps, adapts height, and keeps the action group from shrinking | Bilingual screenshots at a roughly 560px narrow pane, Source/Edit switching, and real save passed in a focused regression |
| Model catalog and answer provider | `3afe3ea9e`, `927793295`: catalog explicitly identifies preset/original model labels, freezes ModelRun source, and redraws through one catalog | Backend and frontend contracts passed; actual menu pending state and bilingual new answers remain unverified |
| Native startup failure body | `47e8449fd`: separates reason descriptor from raw diagnostics and preserves diagnostics before failed-handle cleanup | 6 contracts and node checks passed; the new real main-process failure branch and Windows remain unverified |

<a id="实际可达性与内容边界待核对"></a>
## Reachability and Content Boundaries to Confirm

- Residual Office native PO entries do not equal the number of production translation gaps. Real Writer/Calc menu and dialog evidence is needed; language-resource failure fallback notices also remain to be verified.
- No custom application Menu template was found on macOS; the actual language of the default Electron menu remains to be confirmed. Windows uses `setMenu(null)`; do not infer coverage of other native UI from this.
- Long PDF Reading hints first enter the editable composer as application-generated visible drafts. `c734b56b8` migrated the template while preserving original user/AI interpolation. The TableViewer template completed real bilingual operation through a normal TSV project-resource entry; changing language does not rewrite an existing draft, and table text and paths remain unchanged. The CSV entry routes to Office and is outside this button's acceptance. `6a2ceced6` translated the application-added prefix and suffix of the suggested save-dialog name according to the click-time language, while preserving the original file basename/extension and existing path; excerpt parent directory, saved path, and canonical label remain unchanged.
- Office search location's native page number is currently metadata only; OfficeDocument displays translated status and counts. Do not reconnect an old helper with no production consumer solely for localization.

<a id="完成所需证据"></a>
## Evidence Required for Completion

The final resource/staged checker, typecheck, build, and related tests must correspond to the committed content. Existing failures must be recorded separately and checked against the baseline; do not claim everything passed. Outstanding real-platform acceptance remains documented but is not a prerequisite for this round's code-remediation Goal. See the [verification record](i18n-verification.md) for recent focused checks and cross-review evidence.
