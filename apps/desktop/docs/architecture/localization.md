<a id="国际化开发接入规范"></a>
# Localization Integration Guidelines

## Scope / Non-goals

This document is a consumer guide for the [i18n architecture](i18n.md); it does not choose a separate technology stack. Infrastructure and subsequent feature remediation are delivered separately. Verify implementation and gate coverage against the Owner source, actual checks, and [verification guidelines](../quality/testing.md) below. Work records summarize only the current acceptance result and evidence location; raw evidence stays in the ignored local task directory. Historical plans or prior checkmarks do not prove that the current API, bilingual pages, or native Electron flows have been accepted.

## Source of truth

`src/localization/` owns language registration, resources, the core, and generated types; `src/persistence.ts` is the sole write queue for preferences; `scripts/ci/localization/` owns resource, call-parameter, and source checks; `i18n:*` scripts in `package.json` are the entry points.

## Current / Required / Gap / Advisory

- **current**: JSON → generated types → native i18next calls; the root Provider is integrated into the existing startup path, while historical page copy has not yet been migrated.
- **required**: When adding, changing, or integrating features, localize new/changed copy and directly related historical copy in the UI unit touched in both English and Chinese. Do not migrate an entire page just because one file changed; do not overwrite other contributors' changes. Do not expand the authorized scope for read-only tasks or when the user prohibits page changes.
- **gap**: The AST gate checks explicit syntax positions and tracks same-file variables, aliases, properties, and limited const mappings; cross-module data flow, external dynamic sources, and third-party resources still require owner review. Unmigrated pages are debt, not evidence of complete bilingual support.
- **advisory**: Message names should express user actions/states; put context needed by translators in same-domain descriptions. Do not merge semantically different sentences just to reduce the number of keys.

## Ownership / Dependency

React business code uses `react-i18next` directly; plain TypeScript receives an i18next translator or fixed-namespace function and does not read a store; main uses its own `mainLocalization()`. UI primitives consume messages through the standard provider or explicit props and do not import app/store. Pages do not create their own instance, language cache, or detector.

<a id="最短接入流程"></a>
### Minimal Integration Flow

1. Add complete sentences under the owning namespace in `src/localization/locales/zh/*.json` and `en/*.json`. The resource aggregation module is generated from the JSON inventory and statically imports resources into the package. When adding a language, also update `LOCALES`; checks reject mismatches between registration and resources.
2. Consume messages with `useTranslation(namespace)` or `Trans`; remove the old branch/dictionary from the unit migrated in this change. Do not concatenate fragments to imitate word order.
3. Run `npm run i18n:generate` to generate types and runtime resource imports. Do not edit `types.d.ts` or `resources.ts` by hand.
4. Run `pnpm ops ci check i18n --base <明确的Git-ref>`, `pnpm ops ci check types desktop`, domain checks, and applicable real-product verification.
5. Review tooltips, placeholders, aria-labels, errors, toasts, status notices, and formatting; check translation meaning and long-copy layout.

<a id="react-与普通-ts"></a>
### React and Plain TypeScript

```tsx
const { t } = useTranslation('foundation')
t('preferences.failed')
```

```ts
// main must use only the main instance; do not import the renderer singleton.
const text = mainLocalization().t('preferences.failed')
// Plain TypeScript functions explicitly receive the return value of getFixedT(null, namespace).
```

The existing foundation message is actually used for preference-sync failure; it is not demo data. Create message resources for business keys used in other examples before using them; do not copy an example verbatim if its key does not exist.

<a id="插值复数与富文本"></a>
### Interpolation, Plurals, and Rich Text

JSON example: `"welcome": "你好 {{name}}"` / `"welcome": "Hello {{name}}"`; call `t('welcome', { name })`. Do not concatenate `name` in advance. Resource literals generate types; an additional call check covers cases where the library allows options to be omitted, and missing parameters must fail.

Plural example: Chinese uses `files_other`; English uses `files_one` / `files_other`; each string includes `{{count}}`, and the logical key is called as `t('files', { count })`. Add the branches required by `Intl.PluralRules` for other languages; Chinese and English raw suffixes need not correspond one-to-one.

Use controlled `components` and `values` in `Trans` for rich text: put registered tags such as `<strong>...</strong>` in the message, and provide components in code. Do not use `dangerouslySetInnerHTML` or arbitrary translated HTML. Do not treat user HTML as a trusted message. React escapes React text; handle main/plain HTML output according to its target channel instead of copying renderer escaping settings.

`Trans` does not subscribe to language changes by itself. Ordinary render trees are driven by the calling component's `useTranslation`. When storing a ReactNode in long-lived state such as a toast or notification queue, store an element whose owning display component consumes `useTranslation`, and render the message or `Trans` inside that component. Do not cache `t()` results or assume a cached `<Trans>` updates itself. Notification action buttons must also consume language in the display component. Existing `ToastExampleMessage`, `ToastExampleAction`, and preference failure/retry display components use this pattern; it is not an additional translation engine.


<a id="持久化引用的展示来源与身份"></a>
### Display Provenance and Identity of Persisted References

Assistant reference display provenance must not be inferred by matching “Untitled conversation” or stripping the “Text selection” suffix, or same-named user content could be modified by mistake. Under the required reference type and anchor conditions, `features/assistant/text.ts` renders explicit `label_fallback` or `selection_source_label`; an empty string is an explicit provenance value, not absence. Unknown markers fall back to the original label/title and do not automatically translate user titles.

See the [provenance section of the i18n architecture](i18n.md#label-provenance-and-frozen-business-identity) for the full contract on provenance, admission identity, persistence, and model context; do not maintain a second Serve mechanism description in this integration guide. When changing display or restoration flows, check Desktop's `provenance.test.ts` and the Serve contracts listed in that section, and add evidence for real selection, sending, language switching, preview, and cold recovery as applicable to the current scope. Historical screenshots or contract tests do not replace real acceptance.

<a id="错误状态与业务格式"></a>
### Error States and Business Formatting

Persisted or redrawable state stores a stable error code/message ID plus parameters and is translated at display time; do not permanently store the current Chinese copy in the business database or session. Preserve raw upstream errors in diagnostic details and localize the application's own explanation. Do not translate protocol states, paths, code, logs, user messages, or AI-generated content.

`createFormatters(language)` provides `.number(value, options)`, `.date(value, options)`, and `.relative(value, unit, options)`. Pass the original business currency and precision for amounts, and preserve the original timeZone for dates; an English UI does not imply USD or a different time zone. Do not change search tokenization or file-sorting semantics.

<a id="可执行接入示例"></a>
### Executable Integration Example

The `example` namespace below exists only in virtual resources for the document contract test and is not included in the product package. The test extracts code from this document and checks it using actual i18next/react-i18next types, the resource generator, and parameter checker. To use this pattern in the project, first create English and Chinese JSON for the actual business namespace, then adjust relative imports for the module location. The relative paths below assume `src/localization/`.

```json i18n-example-zh
{"welcome":"你好 {{name}}","files_other":"{{count}} 个文件","failure":"无法打开 {{name}}。","rich":"阅读 <strong>{{name}}</strong>"}
```

```json i18n-example-en
{"welcome":"Hello {{name}}","files_one":"{{count}} file","files_other":"{{count}} files","failure":"Could not open {{name}}.","rich":"Read <strong>{{name}}</strong>"}
```

```tsx i18n-example
import { useTranslation, Trans } from 'react-i18next'
import type { TFunction } from 'i18next'
import { mainLocalization } from '../main/localization'
import { createFormatters } from './format'

const errors = { unavailable: 'failure' } as const
type Failure = { code: keyof typeof errors; name: string }

// Plain TypeScript receives a translator; state retains the error code and parameters, and translation happens at display time.
export function describeFailure(t: TFunction<'example'>, failure: Failure) {
  return t(errors[failure.code], { name: failure.name })
}

export function Example({ name, count }: { name: string; count: number }) {
  const { t } = useTranslation('example')
  return <>
    <p>{t('welcome', { name })}</p>
    <p>{t('files', { count })}</p>
    <p>{describeFailure(t, { code: 'unavailable', name })}</p>
    <Trans ns="example" i18nKey="rich" values={{ name }} components={{ strong: <strong /> }} />
  </>
}

// Call after main initialization; do not import the renderer singleton here.
export function nativeFailure() {
  return mainLocalization().t('foundation:preferences.failed')
}

export function formatted(language: 'zh' | 'en', amount: number, timestamp: number) {
  const format = createFormatters(language)
  return {
    amount: format.number(amount, { style: 'currency', currency: 'CNY', minimumFractionDigits: 2 }),
    date: format.date(timestamp, { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }),
    relative: format.relative(-1, 'day', { numeric: 'auto' })
  }
}
```

<a id="增量检查与债务收紧"></a>
### Incremental Checks and Debt Tightening

`npm run i18n:check -- --base <ref>` uses an explicit commit/ref; `I18N_BASE_REF` can also be set. If none is specified locally, use the immutable baseCommit recorded in the debt inventory and print the resolved value; a missing/invalid ref must fail. CI uses the MR diff base, before SHA, or default-branch merge-base; do not hard-code a branch name.

Scan the staged snapshot and working-tree content separately, including untracked source; an unstaged fix cannot mask hard-coded copy in the staged snapshot. When Desktop has staged changes, also reconstruct the complete staged tree in a temporary directory and independently run resource integrity, generated-drift, call-parameter, and TypeScript checks against it; unstaged resource or type fixes cannot be borrowed. The temporary tree reuses installed dependencies only, does not run staged package scripts, is automatically cleaned after checks, and does not modify the real index. Added/changed copy receives a historical exemption only if it appears both in the comparison-baseline nodes and the reviewed debt inventory. Identity consists of owner, syntax kind, and text; duplicate counts are preserved, with no credit by line number or total file count. Comments, logs, and protocol declarations do not fail when outside visible syntax positions; tests/fixtures are explicit input examples and are not scanned as product copy. New files have no debt.

Visible sinks include JSX text, common display attributes, Tooltip `content`, feedback calls, and explicit display fields. Same-file references are resolved by scope, preserving variable-shadowing semantics. Text containing only a URL/email is not translated; templates made only of dynamic values and punctuation are not treated as complete copy, but hard-coded fallbacks/conditional branches within them are still checked. Generic objects' error/message fields may carry protocol values, so indirect variable sources for these fields are not traced; actual display locations remain checked. Owners supplement cross-file data flow and other business semantics through review.

The debt inventory is initially derived from the real baseline AST and is not updated by default checks. After reviewing a migration commit, run `node scripts/ci/localization.mjs --tighten --base <已迁移commit>` to remove disappeared nodes only, without increasing counts. Review the diff; do not add records manually or expand exclusions. Legacy `I18N` consumers may only decrease.

When reviewed debt files already exist in the comparison baseline, neither the current nor staged debt files may increase node identities or counts; changing their baseCommit cannot relax this constraint. The source of an inventory must still be manually verified when first created; tooling does not replace review of changes to the gate itself.

Fallback with `??` / `||` between complete message keys is not dynamic concatenation; string addition and template construction are still rejected. Map finite business states explicitly and with types to complete message keys. Key catalogs use fields such as `titleKey` / `descriptionKey` to distinguish message references from final display text. Owning constants hold canonical protocol errors, diagnostic content, and saved projections; actual display locations still require localization, and extracting constants does not replace UI translation.

The checker is not an automatic translator: Codex reads these rules and applies remediation in later authorized development tasks, while the gate detects omissions. It does not start background edits, scheduled monitoring, automatic commits, or remote translation. People verify the units touched in the current change and string sources that machines cannot identify.

<a id="正反例"></a>
## Good and Bad Examples

```text
Good example: Change the import-failure flow → migrate that state's title, body, retry tooltip, and English/Chinese parameters together.
Bad example: Add hard-coded English and claim it is localized because “there is no Chinese.”
Good example: Keep an untouched legacy page listed as historical debt; new features must use the standard integration.
Bad example: Remove one old violation and add a new one, then pass because the total file count did not increase.
```

## Enforced by

`pnpm ops ci test integration --scope tooling --suite i18n` verifies resource/AST/parameter contracts; `pnpm ops ci check i18n` runs real resource, generated-drift, and incremental-source checks. This test remains in the explicit Desktop `pretest` and `.gitlab-ci.yml` sets. `pnpm ops ci check types desktop` checks call keys and options types. Business semantics outside AST coverage require review; a passing gate does not prove correct translation or real-product acceptance.

## Update triggers

When changing APIs, namespace registration, type generation, checked syntax positions/exceptions, or baseline rules, update this document and contract tests together; change i18n.md first for architectural decisions. Maintain development rules in the actual AGENTS.md.

## Stop condition

After locating the actual owner, resources, and consumption entry point, proceed with authorized feature development; include resources, checks, and applicable real verification in the same change. The foundational Goal does not wait for every historical page to migrate; a feature cannot be declared complete with new violations, parameter errors, or required verification missing.
