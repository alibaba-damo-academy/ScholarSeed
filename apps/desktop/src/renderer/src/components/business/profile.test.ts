import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { createInstance } from 'i18next'

import {
  editModelApiKeyDraft,
  initialModelApiKeyDraft,
  modelApiKeyNeedsReplacement,
  modelApiKeyShowsSavedMask,
  modelDisabledReason,
  modelDisabledTag,
  modelDisplayLabels,
  modelProviderLabel,
  SAVED_API_KEY_MASK,
  probeFailureDetail,
  providerPresetText,
  PROBE_REASON_KEYS,
  PROBE_SUGGESTION_KEYS,
  PROBE_TITLE_KEYS,
} from './profile.ts'
import type { ProbeFailureKind } from './profile.ts'

const resources = Object.fromEntries(
  ['zh', 'en'].map((language) => [
    language,
    {
      account: JSON.parse(
        readFileSync(
          new URL(`../../../../localization/locales/${language}/account.json`, import.meta.url),
          'utf8'
        )
      ),
      subscription: JSON.parse(
        readFileSync(
          new URL(
            `../../../../localization/locales/${language}/subscription.json`,
            import.meta.url
          ),
          'utf8'
        )
      ),
    },
  ])
)

test('floating composer uses a ten-row height budget without changing conversation limits', () => {
  const source = ts.createSourceFile(
    'Composer.tsx',
    readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const heights = new Map<string, number>()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      const initializer = declaration.initializer
      if (ts.isNumericLiteral(initializer))
        heights.set(declaration.name.text, Number(initializer.text))
      else if (ts.isIdentifier(initializer) && heights.has(initializer.text)) {
        heights.set(declaration.name.text, heights.get(initializer.text)!)
      }
    }
  }
  assert.equal(heights.get('COMPOSER_MAX_HEIGHT_PX'), 132)
  assert.equal(heights.get('INLINE_COMPOSER_MAX_ROWS'), 10)
})

test('saved model API keys stay opaque while the draft supports explicit replacement', () => {
  const saved = initialModelApiKeyDraft(true)
  assert.equal(saved.value, '')
  assert.equal(modelApiKeyShowsSavedMask(saved), true)
  assert.equal(modelApiKeyNeedsReplacement(saved), false)
  assert.equal(SAVED_API_KEY_MASK.length > 0, true)

  const cleared = editModelApiKeyDraft(saved, '')
  assert.equal(modelApiKeyShowsSavedMask(cleared), false)
  assert.equal(modelApiKeyNeedsReplacement(cleared), true)

  const replaced = editModelApiKeyDraft(cleared, 'new-private-key')
  assert.equal(replaced.value, 'new-private-key')
  assert.equal(modelApiKeyNeedsReplacement(replaced), false)
  assert.equal(modelApiKeyNeedsReplacement(editModelApiKeyDraft(replaced, '  ')), true)
  assert.equal(modelApiKeyShowsSavedMask(initialModelApiKeyDraft(true)), true)
  assert.equal(modelApiKeyNeedsReplacement(initialModelApiKeyDraft(false)), false)
})

test('model disabled reason follows explicit provenance and language without changing catalogue state', async () => {
  const localization = createInstance()
  await localization.init({
    lng: 'zh',
    fallbackLng: false,
    resources,
    interpolation: { escapeValue: false },
  })
  const reasons = [
    {
      disabled: true,
      disabled_reason_code: 'gateway_credential_required',
      disabled_reason: '登录后可使用内置模型',
    },
    {
      disabled: true,
      disabled_reason_code: 'subscription_connection_required',
      disabled_reason: '请在模型服务中连接 ChatGPT',
    },
    {
      disabled: true,
      disabled_reason_code: 'oauth_storage_unavailable',
      disabled_reason: '本地凭据暂不可访问，请恢复存储访问后重试',
    },
  ]
  const original = structuredClone(reasons)
  for (const reason of reasons)
    assert.equal(
      modelDisabledReason(reason, localization.getFixedT(null, 'account')),
      reason.disabled_reason
    )
  // 置灰行短 tag: 只有登记码给 tag, 其余(含无码)不给。
  assert.equal(modelDisabledTag(reasons[0], localization.getFixedT(null, 'account')), '登录可用')
  assert.equal(modelDisabledTag(reasons[1], localization.getFixedT(null, 'account')), undefined)
  assert.equal(modelDisabledTag({}, localization.getFixedT(null, 'account')), undefined)
  await localization.changeLanguage('en')
  const t = localization.getFixedT(null, 'account')
  assert.equal(modelDisabledReason(reasons[0], t), 'Sign in to use built-in models')
  assert.equal(modelDisabledReason(reasons[1], t), 'Connect ChatGPT in Model services')
  assert.equal(
    modelDisabledReason(reasons[2], t),
    'Local credentials are unavailable. Restore storage access and retry.'
  )
  assert.equal(modelDisabledTag(reasons[0], t), 'Sign in to use')
  assert.deepEqual(reasons, original)
  for (const reason of reasons)
    assert.equal(
      modelDisabledReason({ disabled_reason: reason.disabled_reason }, t),
      reason.disabled_reason
    )
  const raw = '原始供应商提示 <name> & {{name}}'
  for (const code of ['upstream_reason', '__proto__', 'constructor']) {
    assert.equal(modelDisabledReason({ disabled_reason_code: code, disabled_reason: raw }, t), raw)
    assert.equal(modelDisabledReason({ disabled_reason_code: code }, t), code)
  }
  assert.equal(modelDisabledReason({}, t), undefined)
  const menu = readFileSync(new URL('./ModelMenu.tsx', import.meta.url), 'utf8')
  assert.match(
    menu,
    /title=\{model\.disabled \? modelDisabledReason\(model, account\) : undefined\}/
  )
  assert.match(menu, /modelDisabledReason\(blocked\[0\], account\)/)
  // 置灰行名字后挂灰色短 tag; 底部「切换后…」footnote 已按设计移除。
  assert.match(menu, /tag=\{modelDisabledTag\(model, account\)\}/)
  assert.doesNotMatch(menu, /models\.effect/)
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
  const controlsContract =
    /<span\s+className=\{inline && !inlineEditorLayout.multiline \? 'hidden' : 'flex-1'\}\s*\/>\s*\{surface === 'assistant' && <ModelMenu\s+compact\s+iconOnly=\{inline\}\s*\/>\}\s*\{surface !== 'assistant' && <ModelMenu\s*\/>\}/
  const controls = composer.match(controlsContract)?.[0]
  assert.ok(controls)
  assert.equal(composer.match(/<ModelMenu\b/g)?.length, 2)
  const overlapping = controls.replace("surface !== 'assistant'", "surface === 'assistant'")
  assert.notEqual(overlapping, controls)
  assert.doesNotMatch(overlapping, controlsContract)
  assert.match(effort, /export function useEffort/)
  assert.doesNotMatch(effort, /<Slider/)
  assert.match(menu, /useEffort\(\)/)
  assert.doesNotMatch(menu, /reasoning-reset/)
  assert.match(menu, /const menuOpen = independent \? localOpen : state\.modelMenuOpen/)
  assert.match(menu, /data-testid=\{`\$\{testIdPrefix\}-selector-toggle`\}/)
  // 新交互: 单弹窗顶部直接展示全模型列表(最大高度 300px, 超出滚动), 思考强度行在
  // 右侧展开二级菜单; 无可选档位或未选择模型时强度行禁用并回显占位符; 底部为模型管理。
  assert.match(menu, /data-testid="model-effort-row"/)
  assert.match(menu, /data-testid="model-selector-menu"/)
  assert.match(menu, /data-testid="model-menu-manage"/)
  assert.match(menu, /max-h-\[var\(--vds-model-menu-list-max-height\)\] min-h-0 overflow-y-auto/)
  assert.doesNotMatch(menu, /--vds-model-controls-width/)
  assert.match(menu, /<EllipsisText/)
  assert.match(menu, /wrapperClassName="flex-1"/)
  // 分组: 订阅组与 API/个人模型组共用组标题层级; 行内不再挂右侧提供商副标签挤占模型名宽度。
  assert.match(menu, /const MODEL_GROUP_HEADER_CLASS =/)
  assert.match(menu, /apiModelGroups\.map\(\(group\)/)
  assert.doesNotMatch(menu, /wrapperClassName="max-w-\[40%\] shrink-0"/)
  // 弹窗整体抬到 modal 层, 菜单内溢出 tooltip 内容层必须再抬一级否则被弹窗盖住。
  assert.match(
    menu,
    /const MODEL_MENU_TOOLTIP_CONTENT_CLASS = '!z-\[var\(--vds-z-modal-nested-flyout\)\]'/
  )
  assert.match(menu, /tooltipContentClassName=\{MODEL_MENU_TOOLTIP_CONTENT_CLASS\}/)
  assert.match(menu, /effort\.selectable \? effort\.label : '-'/)
  // 未选择模型(登出后仅剩置灰行): 主按钮回显占位符、强度行禁用。
  assert.match(menu, /const hasCurrentModel = modelAvailable && Boolean\(selectedModel\)/)
  assert.match(menu, /hasCurrentModel \? effort\.label : '-'/)
  assert.match(menu, /hasCurrentModel && effort\.selectable \? effort\.label : '-'/)
  assert.doesNotMatch(menu, /effort\.hasModel/)
  // Target d5f013f4f uses white-surface hover and brand selection for model rows.
  assert.match(menu, /bg-\[var\(--vds-brand-light-bg-default\)\]/)
  const parsed = ts.createSourceFile(
    'ModelMenu.tsx',
    menu,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const rows = parsed.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === 'MODEL_ROW_CLASS')
  assert.equal(rows.length, 1)
  assert.ok(rows[0].initializer)
  const js = ts.transpileModule(`const rowClass = ${rows[0].initializer.getText(parsed)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  const rowClass = new Function(js + '\nreturn rowClass;')() as (
    selected: boolean,
    disabled: boolean
  ) => string
  for (const selected of [true, false]) {
    for (const disabled of [true, false]) {
      const classes = new Set(rowClass(selected, disabled).split(/\s+/))
      assert.equal(classes.has('bg-[var(--vds-brand-light-bg-default)]'), selected)
      assert.equal(classes.has('hover:bg-[var(--vds-bg-white-hover-transparent)]'), !selected)
      assert.equal(classes.has('cursor-not-allowed'), disabled)
      assert.equal(classes.has('opacity-[var(--vds-model-menu-disabled-opacity)]'), disabled)
      assert.equal(classes.has('cursor-pointer'), !disabled)
    }
  }
  assert.match(menu, /<Check className="text-\[var\(--vds-brand-bg-default\)\]"/)
  // 模型管理入口不带左侧 icon; 不再有「更多模型」二级入口。
  assert.doesNotMatch(menu, /model-list-toggle/)
  assert.doesNotMatch(menu, /models\.moreModels/)
  assert.doesNotMatch(menu, /Icon name="settings"/)
  // 模型管理行与强度行复用同一个设计系统箭头。
  const manageRow = menu.slice(menu.indexOf('data-testid="model-menu-manage"'))
  assert.match(manageRow.slice(0, manageRow.indexOf('</Button>')), /<DropdownMenuArrow\s*\/>/)
  // 强度/管理行上方用设计系统分割线(h-px 分隔色), 不是贴上行的上边框。
  assert.match(
    menu,
    /h-\[var\(--vds-border-width-1\)\] shrink-0 bg-\[var\(--vds-divider-default\)\]/
  )
  assert.doesNotMatch(menu, /border-t border-\[var\(--border-soft\)\]/)
  assert.match(menu, /min-w-0 flex-\[0_1_auto\]/)
  assert.doesNotMatch(menu, /compact \? 'max-w-\[160px\]' : 'max-w-\[180px\]'/)
  assert.doesNotMatch(menu, /max-w-\[120px\]|max-w-\[220px\]/)
  assert.match(menu, /className=\{`\$\{MODEL_CHIP_CLASS\} w-full overflow-hidden/)
  assert.match(
    menu,
    /className="[^"]*flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left[^"]*"/
  )
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
  await localization.init({
    lng: 'zh',
    fallbackLng: false,
    resources,
    interpolation: { escapeValue: false },
  })
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
  await localization.init({
    lng: 'zh',
    fallbackLng: false,
    resources,
    initAsync: false,
    interpolation: { escapeValue: false },
  })
  const preset = {
    id: 'dashscope',
    label: '阿里云百炼',
    base_url: 'https://example.test/v1',
    wire_api: 'chat_completions' as const,
    note: '',
    credential_hint: '原提示',
  }
  const original = structuredClone(preset)
  assert.equal(
    providerPresetText(preset, localization.getFixedT('zh', 'account')).label,
    '阿里云百炼'
  )
  await localization.changeLanguage('en')
  assert.equal(
    providerPresetText(preset, localization.getFixedT(null, 'account')).label,
    'Alibaba Cloud Model Studio'
  )
  assert.equal(
    providerPresetText(preset, localization.getFixedT(null, 'account')).credentialHint,
    'Create an API key in the Model Studio console'
  )
  assert.deepEqual(preset, original)
  const unknown = {
    ...preset,
    id: 'custom-provider',
    label: '用户标签 中英',
    note: 'Upstream note 原文',
    credential_hint: 'Custom hint 原文',
  }
  assert.deepEqual(providerPresetText(unknown, localization.getFixedT(null, 'account')), {
    label: unknown.label,
    note: unknown.note,
    credentialHint: unknown.credential_hint,
  })
  assert.deepEqual(providerPresetText(undefined, localization.getFixedT(null, 'account')), {
    label: '',
    note: '',
    credentialHint: '',
  })
})

test('catalog and frozen answer labels translate only explicit preset provenance', async () => {
  const localization = createInstance()
  await localization.init({
    lng: 'zh',
    fallbackLng: false,
    resources,
    initAsync: false,
    interpolation: { escapeValue: false },
  })
  const model = {
    key: 'personal-a:literal',
    label: '阿里云百炼 · User · model / & <中英>',
    provider_label: '阿里云百炼',
    model_label: 'User · model / & <中英>',
    provider_preset_id: 'dashscope',
  }
  const pending = { sessionId: 'session-a', model: { ...model } }
  const original = structuredClone(pending)
  assert.deepEqual(modelDisplayLabels(model, localization.getFixedT(null, 'account')), {
    label: model.model_label,
    providerLabel: '阿里云百炼',
  })
  await localization.changeLanguage('en')
  const t = localization.getFixedT(null, 'account')
  assert.deepEqual(modelDisplayLabels(model, t), {
    label: model.model_label,
    providerLabel: 'Alibaba Cloud Model Studio',
  })
  assert.equal(modelDisplayLabels(pending.model, t).label, model.model_label)
  assert.deepEqual(pending, original)
  assert.equal(
    modelProviderLabel(model.provider_preset_id, model.provider_label, t),
    'Alibaba Cloud Model Studio'
  )
  assert.equal(
    modelDisplayLabels({ ...model, provider_preset_id: undefined }, t).label,
    model.label
  )
  assert.equal(
    modelDisplayLabels({ ...model, provider_preset_id: 'unregistered' }, t).label,
    model.label
  )
  assert.equal(modelDisplayLabels({ ...model, model_label: undefined }, t).label, model.label)
  assert.equal(
    modelDisplayLabels({ ...model, model_label: undefined }, t).providerLabel,
    model.provider_label
  )
  const custom = { key: 'user-model', label: 'qwen 用户自定义', provider_label: '私有厂商' }
  assert.deepEqual(modelDisplayLabels(custom, t), {
    label: custom.label,
    providerLabel: custom.provider_label,
  })
  assert.equal(modelProviderLabel(undefined, '阿里云百炼', t), '阿里云百炼')
  assert.equal(modelProviderLabel('unregistered', 'Private vendor 中英', t), 'Private vendor 中英')
})

test('built-in provenance and token plan editions follow language without rewriting identities', async () => {
  const localization = createInstance()
  await localization.init({
    lng: 'zh',
    fallbackLng: false,
    resources,
    interpolation: { escapeValue: false },
  })
  const model = {
    key: 'builtin',
    source: 'builtin' as const,
    label: 'Qwen · 用户名称',
    model_label: 'Qwen · 用户名称',
  }
  const original = structuredClone(model)
  assert.deepEqual(modelDisplayLabels(model, localization.getFixedT(null, 'account')), {
    label: model.model_label,
    providerLabel: '内置模型',
  })
  await localization.changeLanguage('en')
  const t = localization.getFixedT(null, 'account')
  assert.deepEqual(modelDisplayLabels(model, t), {
    label: model.model_label,
    providerLabel: 'Built-in model',
  })
  assert.equal(
    modelProviderLabel('dashscope-token-plan', '原始名称', t),
    'Alibaba Cloud Model Studio Token Plan (Personal)'
  )
  assert.equal(
    modelProviderLabel('dashscope-token-plan-team', '原始名称', t),
    'Alibaba Cloud Model Studio Token Plan (Team)'
  )
  assert.deepEqual(model, original)
})

test('probe failure detail classifies backend error codes and transport failures', () => {
  // 后端拒绝 (PersonalApiProbeResult 形态, 带 message): 按 error_class 分类, 不透传原文
  const reject = (error_class?: string) => ({
    ok: false as const,
    message: 'raw upstream text',
    models: [],
    latency_ms: 1,
    error_class,
  })
  assert.equal(probeFailureDetail(reject('http_status_401')).kind, 'auth')
  assert.equal(probeFailureDetail(reject('http_status_403')).kind, 'auth')
  assert.equal(probeFailureDetail(reject('http_status_404')).kind, 'notFound')
  const status = probeFailureDetail(reject('http_status_429'))
  assert.equal(status.kind, 'status')
  assert.equal(status.params?.status, 429)
  assert.equal(probeFailureDetail(reject('base_url_required')).kind, 'baseUrl')
  assert.equal(probeFailureDetail(reject('unsupported_wire_api')).kind, 'protocol')
  // 非 HTTP 状态的 error_class 是 httpx 网络层异常名
  assert.equal(probeFailureDetail(reject('ConnectError')).kind, 'network')
  assert.equal(probeFailureDetail(reject('ReadTimeout')).kind, 'network')
  // 无 error_class 且模型列表为空: 端点可达但没返回模型 (ok=bool(models))
  assert.equal(probeFailureDetail(reject(undefined)).kind, 'noModels')
  // 传输层失败 (PersonalApiFailure 形态, 带 code)
  assert.equal(
    probeFailureDetail({ ok: false, error: '', code: 'network_failure' }).kind,
    'network'
  )
  assert.equal(
    probeFailureDetail({ ok: false, error: '', code: 'http_failure', status: 401 }).kind,
    'auth'
  )
  assert.equal(
    probeFailureDetail({ ok: false, error: '', code: 'http_failure', status: 500 }).kind,
    'status'
  )
  assert.equal(
    probeFailureDetail({ ok: false, error: '', code: 'authentication_required' }).kind,
    'generic'
  )
  // 保存校验失败的结构化 detail: 指名失败模型并带上游原文, 不再归到通用 422
  const rejected = probeFailureDetail({
    ok: false,
    error: '{"code":"InternalError.Algo"}',
    code: 'http_failure',
    status: 422,
    detail: {
      code: 'connection_validation_failed',
      model: 'MiniMax-M2.5',
      wire_api: 'responses',
      error_class: 'http_status_500',
      upstream: '{"code":"InternalError.Algo"}',
    },
  })
  assert.equal(rejected.kind, 'modelRejected')
  assert.equal(rejected.params?.model, 'MiniMax-M2.5')
  assert.equal(rejected.params?.upstream, '{"code":"InternalError.Algo"}')
  // 无已选模型 (保存时只读目录就失败): 按 error_class 复用既有分类, 而不是一律 422 通用
  assert.equal(
    probeFailureDetail({
      ok: false,
      error: '',
      code: 'http_failure',
      status: 422,
      detail: { code: 'connection_validation_failed', model: '', error_class: 'http_status_401' },
    }).kind,
    'auth'
  )
  // 有已选模型但上游是鉴权失败 (401): 仍归 auth, 不能误报成「换模型」把用户带偏
  assert.equal(
    probeFailureDetail({
      ok: false,
      error: '',
      code: 'http_failure',
      status: 422,
      detail: {
        code: 'connection_validation_failed',
        model: 'MiniMax-M2.5',
        error_class: 'http_status_401',
        upstream: 'invalid api key',
      },
    }).kind,
    'auth'
  )
  // 每个分类都必须有原因与建议文案 key, 否则弹窗渲染空字符串
  const kinds: ProbeFailureKind[] = [
    'missingKey',
    'auth',
    'notFound',
    'status',
    'network',
    'protocol',
    'baseUrl',
    'noModels',
    'modelRejected',
    'generic',
  ]
  for (const kind of kinds) {
    assert.ok(PROBE_REASON_KEYS[kind], `missing reason key for ${kind}`)
    assert.ok(PROBE_SUGGESTION_KEYS[kind], `missing suggestion key for ${kind}`)
  }
  // 测试与保存/刷新两种动作各有标题 key
  assert.ok(PROBE_TITLE_KEYS.test, 'missing test title key')
  assert.ok(PROBE_TITLE_KEYS.connection, 'missing connection title key')
})
