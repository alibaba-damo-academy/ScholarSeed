<a id="问题反馈与操作记录候选构建依据"></a>
# Candidate Build Basis for Feedback and Activity Records

<a id="建设状态"></a>
## Construction Status

Asset revision `feedback/3`. `FEEDBACK-CAND-001/002`, `FEEDBACK-RECORD-CAND-001/002`, and `FEEDBACK-STEP-NOTE-CAND-001` are candidate references; none has been frozen or included in the evaluation denominator. User confirmation of historical feedback/activity-record interactions, current source, and old tests are traceable clues only. The product requirement version, target-build applicability, and adoption state for this target remain unconfirmed. This work did not operate the product, capture the screen, or submit external feedback, and does not indicate a product pass.

<a id="步骤说明依据"></a>
## Basis for Step Descriptions

The user screenshot requirement for step submission says that a successfully submitted description is bound to the step active at submission, has a visible explanation entry point, and can be viewed. Enter submits and the shortcut is indicated. Confirm complete semantics for failure, input methods, and line breaks; do not treat source behavior as an adopted criterion. A real distinguishable step, content, and independent result are required; verify external-sharing authorization.

<a id="合成附件输入-feedback2"></a>
<a id="合成附件输入feedback2"></a>
## Synthetic Attachment Inputs: feedback/2

The [evaluation manifest](../../../../../examples/projects/evaluation/project.json) `image` (`icon.png`, 1024×1024, 92265 bytes, SHA-256 `0830e69b8b3f1203bbefee47649f4de25bd78a4ea9e6ad82591c837e8241d2a2`) and [image-secondary manifest](../../../../../examples/projects/image-secondary/project.json) `secondary-image` (`secondary.png`, 256×160, 1180 bytes, SHA-256 `2f98c21d4db76db99f98fe77623de32046572a13f4ad0e849dc82d106c23ac39`) may be used separately. Both are synthetic original PNGs and distinguishable manual attachment inputs; verify identity against each manifest and isolated copy. Do not describe them as product screenshots or as prepopulated feedback state. Current [Feedback.tsx](../../../src/renderer/src/components/business/Feedback.tsx) accepts PNG and has single-image and total-size limits; both images are below the limits listed in current source. This is only a format clue; it does not prove that the target package shares the source or that upload succeeds.

File selection requires user confirmation. Opening the feedback form may trigger an automatic screenshot. Verify the instance, data scope, and authorization separately for feedback drafts, screenshot capture, diagnostic content, and external submission. Preparing inputs alone does not operate the product or upload anything. Requirement version, target-build applicability, and complete window images remain unverified. This revision does not change adoption state, criteria, or historical freezes.

<a id="历史依据与边界"></a>
## Historical Basis and Boundaries

- Historical feedback image preview and account-menu feedback records cover image preview, preservation of the draft and attachments after closing, and the problem-feedback entry point. Historical real macOS validation and simulated results remain distinct; neither generalizes to the current package, a complete upload, or Windows.
- Activity-record interaction and subsequent user annotations record requirements for pause, screenshot annotation, steps, descriptions, and review/submission, and explicitly state that component-level simulated upload is not real upload. Historical final-feedback review-dialog notes cover review and retention after failure. The latest entry-point text is “记录操作” (“Record activity”); the old title “录制” (“Record”) does not prove continuous video capture.
- Service-error feedback records historical isolated macOS service-error feedback and partial diagnostic boundaries; its old receipt is not evidence of this run's input or a pass.
- Bounded search of existing freeze manifests and the historical catalog at `sourceCommit` `539af079455cc821b976760728fc13dfedbb8b66` did not recover a historical stable ID that can be confirmed as corresponding to this page's feedback/activity-record items. This negative result does not prove that no historical requirement exists. Candidate IDs are therefore used without replacing historical entries. If a unique synonymous ID is later found, confirm the mapping first; do not rewrite the original freeze.

<a id="当前源码与副作用"></a>
## Current Source and Side Effects

Source baseline `acce09fa42ddf234d84b02dde34b2ab4be570215`. Recheck whether the files below differ from this commit when maintaining this page. Source does not prove common origin with the target installed package or satisfy user requirements.

- **Entry points/conditions:** [ActivityRail.tsx](../../../src/renderer/src/shell/ActivityRail.tsx) mounts the feedback form. [Recorder.tsx](../../../src/renderer/src/features/feedback-recorder/Recorder.tsx) selects entry points/shortcuts based on recording capability, authentication, and current phase. [Feedback.tsx](../../../src/renderer/src/components/business/Feedback.tsx) also contains an error-recovery entry point. Do not treat identity branches in historical designs as fixed expectations without verifying the target build.
- **Natural display and state:** `Feedback.tsx` manages the description, log/session diagnostic selection, automatic or manual images, and preview; on success it enters a receipt state, while failure returns to editing. `Recorder.tsx` manages recording, pausing, and review phases. [Capture.tsx](../../../src/renderer/src/features/feedback-recorder/Capture.tsx) and [Review.tsx](../../../src/renderer/src/features/feedback-recorder/Review.tsx) display activity and review. Description, attachment count, phase, and receipt change according to this run's input and result; do not freeze values from a screenshot.
- **Actual side effects:** `openFeedback` in [store.tsx](../../../src/renderer/src/store.tsx) attempts to capture the current window before showing the form. The start path in `Recorder.tsx` creates a record and attempts an image capture; the record collects page activity, and stop enters review. `submitFeedback` in [api.ts](../../../src/renderer/src/api.ts) sends the description, optional images, and diagnostics to the Desktop bridge. [submission.ts](../../../src/main/submission.ts) owns actual submission; recording submission also includes the record report and diagnostics. Therefore, check authorization and data scope separately for navigation, automatic image capture, recording, screenshot annotation, and external submission; these are not uniformly read-only.
- **Source digests for this review:** `Feedback.tsx` `d1a5e884365e10309e4de2076d68d28b93fc1e50c1f647eca46fd5a1722821ca`; `Recorder.tsx` `ac6e124ad451759e8a972f7f73e2787d605ed61230656fa772b2bce9367ae927`; `Capture.tsx` `938c3e9e4d700ee03ab04305d47872e2aca0b8a3ba74f7da6fb883312d130d29`; `Review.tsx` `795ef8234d5591e4293ddcba06d9b5332dc5059dc82be0bb86af70732e974535`; `ActivityRail.tsx` `b139dc7c17bbcb9677a507bbb03a1faa8df751b2d963451d72170e48fd9546c3`; `store.tsx` `ed81d7a9f13dd0f510ff4b079c267251ac6681341234a8d40615534f69b39342`; `api.ts` `6eaddf9622cd43ab5adebcc9511a4ecce763e1ca7877f5237f60f6cd13fbb2af`; `submission.ts` `0e4c4cc1703da0217a9ffa394690d74cabc579e938471adaf0590c4fd7808b77`.

<a id="数据截图与执行交接"></a>
## Data, Screenshots, and Execution Handoff

Target clue: macOS arm64 installed build `0.3.2 / 202611121823 / preview`, historical ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`. This run did not verify the current instance or common origin with the target package; recheck the exact artifact, instance, and capability before later execution. `examples` is only an authorized synthetic attachment source; it does not prepopulate feedback, screenshot records, or server receipts. Select specific files before execution and verify identity, type, digest, and isolated copy. Manual import requires user confirmation.

This workspace has no verified reusable complete-window screenshot of the feedback form, activity record, and real submission receipt for this target package. Do not present component fixtures, simulated receipts, old images, or real user data as current product screenshots. Real screenshots and receipts, external-submission and diagnostic permissions, account conditions, target requirement version, and applicability remain gaps. Only after the user explicitly scopes the operation and the necessary permissions are ready should an execution Skill separately freeze any of the four evaluation areas. Candidate creation alone does not add it to smoke coverage or constitute a pass.
