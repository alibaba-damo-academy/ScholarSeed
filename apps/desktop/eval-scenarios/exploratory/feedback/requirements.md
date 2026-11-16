<a id="问题反馈与操作记录候选需求"></a>
# Candidate Requirements for Feedback and Activity Records

<a id="用途与入口"></a>
## Purpose and Entry Points

Users describe a problem through the problem-feedback entry point in the main interface and may use an activity record to provide context when available. A feedback entry point may be available during startup or workspace failures. The target installed build's entry point, identity conditions, requirement version, and adoption state remain unverified. This page is a candidate based on historical user confirmation and current source, not an adopted criterion or a conclusion from this run.

**Reference screenshot gap:** No complete window screenshot has been verified for the target build's real feedback form, activity record, and submission receipt in a form approved for reuse. Historical component previews, simulated receipts, and real user diagnostic data are not substitutes. The missing image does not prevent recording this candidate, and does not mean the feature passed.

<a id="候选功能"></a>
## Candidate Features

<a id="问题反馈与截图预览-feedback-cand-001-需求版本待确认"></a>
<a id="问题反馈与截图预览feedback-cand-001需求版本待确认"></a>
### Problem Feedback and Screenshot Preview (`FEEDBACK-CAND-001`; requirement version pending confirmation)

The user opens the feedback form from an authorized entry point, enters a synthetic problem description, and checks attachments and diagnostic options. If an automatic screenshot or manually added image is available, the user can open it at full size; closing the preview returns to the same feedback draft without losing its content or attachments. Screenshots and attachments must come from an authorized isolated state or synthetic material; do not use the real system screen or another user's content as test input. Confirm complete rules for empty input, image count/size, and error feedback separately against approved requirements.

As distinguishable manual attachment inputs, optionally use the [synthetic evaluation-project image](../../../../../examples/projects/evaluation/files/icon.png) and [second synthetic image](../../../../../examples/projects/image-secondary/files/secondary.png), first checking each file's manifest identity and digest. A user must confirm file selection. These source images are not product screenshots and do not prepopulate a feedback or upload result. Opening the form may trigger an automatic screenshot; verify authorization separately for capture, diagnostics, and feedback submission.

<a id="反馈真实提交-feedback-cand-002-需求版本待确认"></a>
<a id="反馈真实提交feedback-cand-002需求版本待确认"></a>
### Actual Feedback Submission (`FEEDBACK-CAND-002`; requirement version pending confirmation)

Submit distinguishable synthetic feedback in an explicitly authorized test environment and observe the actual result. On success, the receipt corresponds to this run's feedback; any notice that diagnostics are incomplete must be visible. On failure, the draft remains recoverable and feedback is displayed. Submission may upload the description, screenshots, logs, and session diagnostics. Check authorization and scope separately for external submission, diagnostic collection, accounts, and cost. A button click, simulated receipt, or historical feedback ID is not a substitute for the real result in this run.

<a id="操作记录与截图标注-feedback-record-cand-001-需求版本待确认"></a>
<a id="操作记录与截图标注feedback-record-cand-001需求版本待确认"></a>
### Activity Records and Screenshot Annotations (`FEEDBACK-RECORD-CAND-001`; requirement version pending confirmation)

In an isolated task where the capability is available and capture is explicitly authorized, start, pause, and resume a record to create activity steps. Screenshots created in the record should be associated with their corresponding steps; the user can open annotation and return to the record. After ending, the review page can show the record and description and allow the user to choose a next action. “Record activity” here means recording steps, screenshots, and similar data; it does not assume continuous video recording. Verify system screenshot permission, recorded content, and data scope. Historical user confirmation of step pagination, annotations, descriptions, and entry points is in the [Build Basis](./build.md); target-version applicability, complete window screenshots, and operable state remain unverified.

<a id="检查与提交操作记录-feedback-record-cand-002-需求版本待确认"></a>
<a id="检查与提交操作记录feedback-record-cand-002需求版本待确认"></a>
### Review and Submit an Activity Record (`FEEDBACK-RECORD-CAND-002`; requirement version pending confirmation)

For a real record with independently verifiable activity and screenshots, the review page shows steps and images corresponding to the input; changes and cancellation produce distinguishable outcomes. Judge actual submission success only from the service receipt and the result actually retained. Activity records and screenshots must not contain real private content or full credentials. Verify permissions and data scope separately for creating records, capturing screenshots, collecting diagnostics, using the clipboard, and external submission. Failure retry and cross-platform permission differences are separate focused scenarios.

<a id="提交步骤说明-feedback-step-note-cand-001-需求版本待确认"></a>
<a id="提交步骤说明feedback-step-note-cand-001需求版本待确认"></a>
### Submit a Step Description (`FEEDBACK-STEP-NOTE-CAND-001`; requirement version pending confirmation)

Historical user screenshot requirements say a successfully submitted description is bound to the step active at submission, an explanation icon appears at the right of that step row, and hovering shows the submitted text. Enter submits, and the input placeholder identifies the shortcut. Use a distinguishable isolated step identity, actual submitted content, and independent receipt or record as references. A draft, button click, or hint does not substitute for a submission result. This is separate from final feedback submission; verify recording capability, actual submission side effects, and external-sharing authorization. Target-build applicability, requirement version, and complete window image remain unverified.

<a id="数据与独立参照"></a>
## Data and Independent References

The normal path needs an isolated product instance, distinguishable synthetic description, and authorized synthetic screen content. Manual attachments must use traceable original files under `examples`; verify source and digest against actual content type and obtain user confirmation for import/native selection. Independently record this run's description, step identities, and attachment digests. Do not use the page's own counts, model assertions, or prepopulated results as the sole reference.

Opening the form, automatic screenshots, activity recording, screenshot annotation, and submission are separate actions. Opening the form may trigger an automatic screenshot; starting a record may capture screenshots and page activity; submission may initiate external upload with diagnostics. Without explicit confirmation of side effects, data scope, and authorization, retain the gap; do not expand “page is accessible” into permission to record, capture, or upload.

<a id="专项与缺口"></a>
## Focused Scenarios and Gaps

Target-build entry-point reachability, identity/feature-flag conditions, requirement version, applicability and adoption state, complete real window screenshots, and service receipts remain unverified. Image selection/preview, error recovery, partial diagnostics, recording permission, retry after failure, screenshot annotation, external submission, and native Windows/macOS behavior are separate focused scenarios. Do not generalize simulated data, component tests, or old-build records into a pass for this target. Confirm actual permissions and product semantics from the relevant page or historical source as needed; do not change business code or existing historical freezes.
