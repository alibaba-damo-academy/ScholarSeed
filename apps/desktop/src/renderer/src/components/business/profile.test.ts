import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createInstance } from 'i18next'

import { modelDisabledReason, modelDisplayLabels, modelProviderLabel, providerPresetText } from './profile.ts'

const resources = Object.fromEntries(['zh', 'en'].map((language) => [language, {
  account: JSON.parse(readFileSync(new URL(`../../../../localization/locales/${language}/account.json`, import.meta.url), 'utf8')),
  subscription: JSON.parse(readFileSync(new URL(`../../../../localization/locales/${language}/subscription.json`, import.meta.url), 'utf8'))
}]))

test('model disabled reason follows explicit provenance and language without changing catalogue state', async () => {
  const localization = createInstance()
  await localization.init({ lng: 'zh', fallbackLng: false, resources, interpolation: { escapeValue: false } })
  const reasons = [
    { disabled: true, disabled_reason_code: 'gateway_credential_required', disabled_reason: '登录后可使用内置模型' },
    { disabled: true, disabled_reason_code: 'subscription_connection_required', disabled_reason: '请在模型服务中连接 ChatGPT' }
  ]
  const original = structuredClone(reasons)
  for (const reason of reasons) assert.equal(modelDisabledReason(reason, localization.getFixedT(null, 'account')), reason.disabled_reason)
  await localization.changeLanguage('en')
  const t = localization.getFixedT(null, 'account')
  assert.equal(modelDisabledReason(reasons[0], t), 'Sign in to use built-in models')
  assert.equal(modelDisabledReason(reasons[1], t), 'Connect ChatGPT in Model services')
  assert.deepEqual(reasons, original)
  for (const reason of reasons) assert.equal(modelDisabledReason({ disabled_reason: reason.disabled_reason }, t), reason.disabled_reason)
  const raw = '原始供应商提示 <name> & {{name}}'
  for (const code of ['upstream_reason', '__proto__', 'constructor']) {
    assert.equal(modelDisabledReason({ disabled_reason_code: code, disabled_reason: raw }, t), raw)
    assert.equal(modelDisabledReason({ disabled_reason_code: code }, t), code)
  }
  assert.equal(modelDisabledReason({}, t), undefined)
  const menu = readFileSync(new URL('./ModelMenu.tsx', import.meta.url), 'utf8')
  assert.match(menu, /title=\{model\.disabled \? modelDisabledReason\(model, account\) : undefined\}/)
  assert.match(menu, /modelDisabledReason\(blocked\[0\], account\)/)
  // 显示状态归服务端持久化: renderer 不得再持有一份私有隐藏标记。留着它的话, 任何一次目录
  // 重取都会整体覆盖 catalog.models, 把用户关掉的模型放回对话框。
  const panel = readFileSync(new URL('./AccountPanel.tsx', import.meta.url), 'utf8')
  for (const source of [menu, panel]) assert.doesNotMatch(source, /user_disabled/)
})

test('composer has one combined model control at the right of the spacer', () => {
  const composer = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')
  const effort = readFileSync(new URL('./Effort.tsx', import.meta.url), 'utf8')
  const menu = readFileSync(new URL('./ModelMenu.tsx', import.meta.url), 'utf8')
  assert.match(composer, /home \? '[^']*flex-nowrap[^']*' : 'flex-nowrap'/)
  assert.doesNotMatch(composer, /home \? '[^']*flex-wrap[^n][^']*' : 'flex-wrap'/)
  assert.doesNotMatch(composer, /<Effort/)
  assert.match(composer, /<span className="flex-1" \/>[\s\S]*<ModelMenu/)
  assert.match(effort, /export function useEffort/)
  assert.doesNotMatch(effort, /<Slider/)
  assert.match(menu, /useEffort\(\)/)
  assert.doesNotMatch(menu, /reasoning-reset/)
  assert.match(menu, /setSubmenu\(null\)\s+set\(\{ modelMenuOpen: false \}\)\s+if \(model.key === selectedModelKey\)/)
  // 新交互: 单弹窗顶部直接展示全模型列表(最大高度 300px, 超出滚动), 思考强度行在
  // 右侧展开二级菜单; 无可选档位或未选择模型时强度行禁用并回显占位符; 底部为模型管理。
  assert.match(menu, /data-testid="model-effort-row"/)
  assert.match(menu, /data-testid="model-selector-menu"/)
  assert.match(menu, /data-testid="model-menu-manage"/)
  assert.match(menu, /max-h-\[300px\] min-h-0 overflow-y-auto/)
  // 弹窗固定 200px 宽; 模型名/副标签溢出省略, hover 由 EllipsisText 的 tooltip 显示全文。
  assert.match(menu, /w-\[var\(--vds-model-menu-width\)\]/)
  // 思考强度二级弹窗同宽 200px, 不再使用旧的 240px 控件宽 token。
  assert.doesNotMatch(menu, /--vds-model-controls-width/)
  assert.match(menu, /<EllipsisText/)
  assert.match(menu, /wrapperClassName="flex-1"/)
  // 弹窗整体抬到 modal 层, 菜单内溢出 tooltip 内容层必须再抬一级否则被弹窗盖住。
  assert.match(menu, /const MODEL_MENU_TOOLTIP_CONTENT_CLASS = '!z-\[calc\(var\(--vds-z-modal\)\+2\)\]'/)
  assert.match(menu, /tooltipContentClassName=\{MODEL_MENU_TOOLTIP_CONTENT_CLASS\}/)
  assert.match(menu, /effort\.selectable \? effort\.label : '-'/)
  // 未选择模型(登出后仅剩置灰行): 主按钮回显占位符、强度行禁用。
  assert.match(menu, /const hasCurrentModel = modelAvailable && Boolean\(selectedModel\)/)
  assert.match(menu, /hasCurrentModel \? effort\.label : '-'/)
  assert.match(menu, /disabled=\{!hasCurrentModel \|\| !effort\.selectable \|\| effort\.pending \|\| Boolean\(pending\)\}/)
  assert.match(menu, /hasCurrentModel && effort\.selectable \? effort\.label : '-'/)
  assert.doesNotMatch(menu, /effort\.hasModel/)
  // 模型行 hover/选中态与对号对齐项目切换菜单: 品牌浅底 + lucide Check。
  assert.match(menu, /bg-\[var\(--vds-brand-light-bg-default\)\]/)
  assert.match(menu, /hover:bg-\[var\(--vds-bg-gray-hover-transparent\)\]/)
  assert.match(menu, /<Check className="text-\[var\(--vds-brand-bg-default\)\]"/)
  // 模型管理入口不带左侧 icon; 不再有「更多模型」二级入口。
  assert.doesNotMatch(menu, /model-list-toggle/)
  assert.doesNotMatch(menu, /models\.moreModels/)
  assert.doesNotMatch(menu, /Icon name="settings"/)
  // 模型管理行右侧带小箭头(与强度行一致的 chevron-right)。
  assert.match(menu, /data-testid="model-menu-manage"[\s\S]{0,500}chevron-right/)
  // 强度/管理行上方用设计系统分割线(h-px 分隔色), 不是贴上行的上边框。
  assert.match(menu, /h-px shrink-0 bg-\[var\(--vds-divider-default\)\]/)
  assert.doesNotMatch(menu, /border-t border-\[var\(--border-soft\)\]/)
  assert.match(menu, /min-w-0 flex-\[0_1_auto\]/)
  assert.doesNotMatch(menu, /compact \? 'max-w-\[160px\]' : 'max-w-\[180px\]'/)
  assert.doesNotMatch(menu, /max-w-\[120px\]|max-w-\[220px\]/)
  assert.match(menu, /className=\{`\$\{MODEL_CHIP_CLASS\} w-full overflow-hidden/)
  assert.match(menu, /className="[^"]*flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left[^"]*"/)
})

test('conversation context picker keeps a stable request and popover identity', () => {
  const composer = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')
  assert.match(composer, /const atContextSourceId = atContextSource\?\.id/)
  assert.match(
    composer,
    /act\.openAiContextPicker\(atContextSourceId, atTerm\)[\s\S]*\[atActive, atContextSourceId, atTerm\]/
  )
  assert.match(composer, /`act` intentionally excluded from deps/)
  assert.doesNotMatch(composer, /\[act, atActive, atContextSourceId, atTerm\]/)
  assert.doesNotMatch(composer, /\[act, atActive, atContextSource, atTerm\]/)
  assert.doesNotMatch(
    composer,
    /<PopoverContent\s+key=\{`\$\{skillPanelOpen\}-\$\{state\.aiPanel\.contextPickerOpen\}`\}/
  )
})

test('subscription status messages preserve custom connection names in both languages', async () => {
  const localization = createInstance()
  await localization.init({ lng: 'zh', fallbackLng: false, resources, interpolation: { escapeValue: false } })
  const name = '用户 · ChatGPT <研究> & {{name}}'
  for (const language of ['zh', 'en']) {
    await localization.changeLanguage(language)
    const t = localization.getFixedT(null, 'subscription')
    for (const state of ['connected', 'reauth', 'disconnected'] as const) {
      assert.equal(t('connectionStatus', { name, status: t(state) }), `${name} · ${t(state)}`)
    }
  }
})

test('preset presentation follows language without changing connection inputs or unknown metadata', async () => {
  const localization = createInstance()
  await localization.init({ lng: 'zh', fallbackLng: false, resources, initAsync: false, interpolation: { escapeValue: false } })
  const preset = { id: 'dashscope', label: '阿里云百炼', base_url: 'https://example.test/v1', wire_api: 'chat_completions' as const, note: '', credential_hint: '原提示' }
  const original = structuredClone(preset)
  assert.equal(providerPresetText(preset, localization.getFixedT('zh', 'account')).label, '阿里云百炼')
  await localization.changeLanguage('en')
  assert.equal(providerPresetText(preset, localization.getFixedT(null, 'account')).label, 'Alibaba Cloud Model Studio')
  assert.equal(providerPresetText(preset, localization.getFixedT(null, 'account')).credentialHint, 'Create an API key in the Model Studio console')
  assert.deepEqual(preset, original)
  const unknown = { ...preset, id: 'custom-provider', label: '用户标签 中英', note: 'Upstream note 原文', credential_hint: 'Custom hint 原文' }
  assert.deepEqual(providerPresetText(unknown, localization.getFixedT(null, 'account')), {
    label: unknown.label, note: unknown.note, credentialHint: unknown.credential_hint
  })
  assert.deepEqual(providerPresetText(undefined, localization.getFixedT(null, 'account')), { label: '', note: '', credentialHint: '' })
})


test('catalog and frozen answer labels translate only explicit preset provenance', async () => {
  const localization = createInstance()
  await localization.init({ lng: 'zh', fallbackLng: false, resources, initAsync: false, interpolation: { escapeValue: false } })
  const model = { key: 'personal-a:literal', label: '阿里云百炼 · User · model / & <中英>', provider_label: '阿里云百炼', model_label: 'User · model / & <中英>', provider_preset_id: 'dashscope' }
  const pending = { sessionId: 'session-a', model: { ...model } }
  const original = structuredClone(pending)
  assert.deepEqual(modelDisplayLabels(model, localization.getFixedT(null, 'account')), { label: model.model_label, providerLabel: '阿里云百炼' })
  await localization.changeLanguage('en')
  const t = localization.getFixedT(null, 'account')
  assert.deepEqual(modelDisplayLabels(model, t), { label: model.model_label, providerLabel: 'Alibaba Cloud Model Studio' })
  assert.equal(modelDisplayLabels(pending.model, t).label, model.model_label)
  assert.deepEqual(pending, original)
  assert.equal(modelProviderLabel(model.provider_preset_id, model.provider_label, t), 'Alibaba Cloud Model Studio')
  assert.equal(modelDisplayLabels({ ...model, provider_preset_id: undefined }, t).label, model.label)
  assert.equal(modelDisplayLabels({ ...model, provider_preset_id: 'unregistered' }, t).label, model.label)
  assert.equal(modelDisplayLabels({ ...model, model_label: undefined }, t).label, model.label)
  assert.equal(modelDisplayLabels({ ...model, model_label: undefined }, t).providerLabel, model.provider_label)
  const custom = { key: 'user-model', label: 'qwen 用户自定义', provider_label: '私有厂商' }
  assert.deepEqual(modelDisplayLabels(custom, t), { label: custom.label, providerLabel: custom.provider_label })
  assert.equal(modelProviderLabel(undefined, '阿里云百炼', t), '阿里云百炼')
  assert.equal(modelProviderLabel('unregistered', 'Private vendor 中英', t), 'Private vendor 中英')
})


test('built-in provenance and token plan editions follow language without rewriting identities', async () => {
  const localization = createInstance()
  await localization.init({ lng: 'zh', fallbackLng: false, resources, interpolation: { escapeValue: false } })
  const model = { key: 'builtin', source: 'builtin' as const, label: 'Qwen · 用户名称', model_label: 'Qwen · 用户名称' }
  const original = structuredClone(model)
  assert.deepEqual(modelDisplayLabels(model, localization.getFixedT(null, 'account')), { label: model.model_label, providerLabel: '内置模型' })
  await localization.changeLanguage('en')
  const t = localization.getFixedT(null, 'account')
  assert.deepEqual(modelDisplayLabels(model, t), { label: model.model_label, providerLabel: 'Built-in model' })
  assert.equal(modelProviderLabel('dashscope-token-plan', '原始名称', t), 'Alibaba Cloud Model Studio Token Plan (Personal)')
  assert.equal(modelProviderLabel('dashscope-token-plan-team', '原始名称', t), 'Alibaba Cloud Model Studio Token Plan (Team)')
  assert.deepEqual(model, original)
})
