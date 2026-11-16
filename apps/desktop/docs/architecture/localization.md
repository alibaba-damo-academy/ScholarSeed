# 国际化开发接入规范

## Scope / Non-goals

本文件是[i18n 总体设计](i18n.md)的消费指南，不另选技术栈。基础设施与后续功能整改分开交付。实现与门禁覆盖按下述 Owner 源码、实际检查及[验证规范](../quality/testing.md)核验；工作记录只概述本次验收结论与证据位置，原始证据留在已忽略的本地任务目录。历史计划或既往勾选状态不证明当前 API、页面双语或 Electron 原生流程已验收。

## Source of truth

`src/localization/` 持有语言登记、资源、核心与生成类型；`src/persistence.ts` 是偏好唯一写入队列；`scripts/ci/localization/` 持有资源、调用参数和源码检查；`package.json` 的 `i18n:*` 是执行入口。

## Current / Required / Gap / Advisory

- **current**：JSON → 生成类型 → i18next 原生调用；根 Provider 接入现有启动路径，历史页面文案尚未迁移。
- **required**：后续新增、修改、联调功能时，新增/修改文案和本次触及 UI 单元的直接相关历史文案须同步中英整改。不得仅因改一个文件就迁移整页；不得覆盖其他同学修改。只读任务或用户禁止页面修改时不扩大授权。
- **gap**：AST 门禁检查明确语法位置，追踪同文件变量、别名、属性与有限 const 映射；跨模块数据流、外部动态来源和第三方资源仍需 owner 审查。未迁移页面属于债务，不是已完整支持双语。
- **advisory**：消息名表达用户动作/状态，译者需要的上下文放同域说明；不可为了少写 key 合并语义不同的句子。

## Ownership / Dependency

React 业务直接用 `react-i18next`；纯 TS 接收 i18next 的 translator 或固定 namespace 函数，不读 store；main 使用自身 `mainLocalization()`。UI 原子通过标准 provider 或显式 props 消费消息，不导入 app/store。页面不自行创建实例、语言缓存或 detector。

### 最短接入流程

1. 在所属 namespace 的 `src/localization/locales/zh/*.json` 与 `en/*.json` 增加完整句子。资源聚合模块由 JSON 库存生成，静态导入随包资源；新增语言须同时更新 `LOCALES`，检查会拒绝登记与资源不一致。
2. 用 `useTranslation(namespace)` 或 `Trans` 消费；删除本次已迁移单元的旧分支/字典。不能拼接词段模拟语序。
3. `npm run i18n:generate` 生成类型和运行时资源导入，禁止手改 `types.d.ts` 或 `resources.ts`。
4. `pnpm ops ci check i18n --base <明确的Git-ref>`、`pnpm ops ci check types desktop`、领域检查及适用的真实产品验证。
5. 审查 tooltip、placeholder、aria-label、错误、toast、状态提示与格式化；审查翻译语义和长文案布局。

### React 与普通 TS

```tsx
const { t } = useTranslation('foundation')
t('preferences.failed')
```

```ts
// main 只能使用 main 实例；不要从 renderer 引入单例。
const text = mainLocalization().t('preferences.failed')
// 普通 TS 函数显式接收 getFixedT(null, namespace) 的返回值。
```

现有 foundation 消息实际用于偏好同步失败，不是演示数据。其它示例中的业务 key 必须先创建消息资源，不能把示例直接复制为不存在的 key。

### 插值、复数与富文本

JSON 示例：`"welcome": "你好 {{name}}"` / `"welcome": "Hello {{name}}"`，调用 `t('welcome', { name })`。不要预先拼接 name。资源字面量生成类型；额外调用检查补足库允许省略 options 的情况，缺参数必须报错。

复数示例：中文 `files_other`，英文 `files_one` / `files_other`，文本分别包含 `{{count}}`，调用逻辑 key `t('files', { count })`。其它语言按 `Intl.PluralRules` 需要的分支补齐，不强求中英原始后缀一一对应。

富文本用 `Trans` 的受控 `components` 与 `values`：消息中放 `<strong>...</strong>` 等登记标签，组件由代码提供；禁止 `dangerouslySetInnerHTML` 或任意翻译 HTML。不要把用户 HTML 作为可信消息。React 文本由 React 转义；main/普通 HTML 输出按目标通道处理，不能照搬 renderer 的 escaping 设置。

`Trans` 本身不订阅语言变化。普通渲染树由调用组件的 `useTranslation` 驱动；将 ReactNode 存进 toast、通知队列等长期状态时，应存放由所属展示组件消费 `useTranslation` 的元素，并在该组件内渲染消息或 `Trans`。不要缓存 `t()` 结果，也不要假设缓存的 `<Trans>` 会自行更新。通知操作按钮同样需要在显示组件内消费语言。现有 `ToastExampleMessage`、`ToastExampleAction` 和偏好失败/重试展示组件采用这一方式；这不是额外的翻译引擎。


### 持久化引用的展示来源与身份

助手引用不能通过匹配“未命名对话”或截去“划词”后缀猜测展示来源，否则会误改
同名用户内容。`features/assistant/text.ts` 在符合引用类型与 anchor 的条件下，
使用显式 `label_fallback` 或 `selection_source_label` 渲染；空字符串也是明确的
来源值，不等于缺失。未知标记回到原始 label/title，不自动翻译用户标题。

来源、准入身份、持久化与模型上下文的完整契约见
[i18n 总体设计的来源章节](i18n.md#label-provenance-and-frozen-business-identity)，
不在接入指南维护第二份 Serve 机制说明。改变展示或恢复链路时核对
Desktop 的 `provenance.test.ts` 与该章节列出的 Serve 契约，并按本次范围补充
真实选择、发送、切语言、预览及冷恢复证据；历史截图或契约测试不替代真实验收。

### 错误状态与业务格式

持久或可重绘状态存稳定错误码/消息 ID + 参数，在展示时翻译；不把当时的中文永久存进业务数据库或会话。原始上游错误保留在诊断详情，应用自己的说明本地化。协议状态、路径、代码、日志、用户消息与 AI 已生成内容不翻译。

`createFormatters(language)` 提供 `.number(value, options)`、`.date(value, options)`、`.relative(value, unit, options)`。金额传原业务 currency 和精度，日期保留原 timeZone；英文 UI 不等于美元或另一个时区。不要改变检索分词和文件排序语义。

### 可执行接入示例

以下 `example` namespace 只在文档契约测试的虚拟资源中存在，不加入产品包。测试从本文提取代码，使用实际 i18next/react-i18next 类型、资源生成器及参数检查器校验。项目中采用此模式时，先为实际业务 namespace 创建中英文 JSON，再按模块位置调整相对导入。下面的相对路径以 `src/localization/` 为例。

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

// 普通 TS 接收 translator；状态保留错误码和参数，在展示时调用。
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

// main 初始化后调用；这里不能导入 renderer 单例。
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

### 增量检查与债务收紧

`npm run i18n:check -- --base <ref>` 使用明确 commit/ref；也可设 `I18N_BASE_REF`。本地未指定时使用债务清单记录的不可变 baseCommit，并打印解析结果；缺失/非法 ref 必须失败。CI 使用 MR diff base、before SHA 或默认分支 merge-base，不硬编码分支名。

分别扫描暂存区快照与工作区内容，并包含未跟踪源码；未暂存的修正不能掩盖暂存区里的硬编码。存在 Desktop 暂存改动时，还会在临时目录中还原完整暂存树，对该树独立执行资源完整性、生成漂移、调用参数和 TypeScript 检查，不能借用未暂存的资源或类型修复。临时树只复用已安装依赖，不执行暂存版本的 package scripts，检查后自动清理，不修改真实 index。新增/修改文案必须同时属于比较基线节点和受审债务清单才获历史豁免；身份由 owner、语法种类、文本组成，保留重复数量，不按行号或文件总数抵扣。注释、日志、协议声明不在可见语法位置时不报错；测试/fixture 是明确的输入示例，不扫描为产品文案。新文件无债务。

可见 sink 包括 JSX 文本、常见展示属性、Tooltip 的 `content`、反馈调用及显式展示字段；同文件引用按作用域解析，保留变量遮蔽语义。只包含 URL/email 的文字不翻译；纯动态值与标点组成的模板不被当作完整文案，但其中的硬编码 fallback/条件分支仍检查。通用对象的 error/message 字段可能承载协议值，因此不追踪这些字段的间接变量来源，真实展示位置仍受检查。跨文件数据流和其它业务语义由 owner 审查补充。

债务清单首次来自真实基线 AST，不由默认检查更新。迁移提交审查后可运行 `node scripts/ci/localization.mjs --tighten --base <已迁移commit>`，只移除消失节点，不增加数量。必须审查 diff，不得手加记录或扩大排除范围。旧 `I18N` 消费者只能减少。

比较基线中已有受审债务文件时，当前及暂存区债务文件均不得增加节点身份或数量，修改其 baseCommit 不能放宽这一约束。首次建立清单仍需人工核实来源，工具不能替代对门禁自身改动的审查。

完整消息键之间的 `??` / `||` 回退不属于动态拼接；字符串加法和模板构造仍拒绝。有限业务状态通过类型化显式映射到完整消息键，键目录使用 `titleKey` / `descriptionKey` 等字段区分消息引用和最终显示文本。协议错误、诊断内容与已保存投影的规范文本由所属常量持有；真正显示位置仍必须本地化，不以提取常量替代界面翻译。

检查不是自动翻译器：Codex 在后续已授权开发任务中读取规则并同步整改，门禁负责发现遗漏；不启动后台修改、定时监控、自动提交或远程翻译。人负责核实本次触及单元及机器不能识别的字符串来源。

## 正反例

```text
正例：改导入失败流程 → 同步迁移该状态的标题、正文、重试 tooltip 和中英参数。
反例：新增英文硬编码，以“没有中文”声称已国际化。
正例：未改动旧页面仍列为历史债务；新功能必须标准接入。
反例：删一个旧违规再加一个新违规，用文件总数没增加过关。
```

## Enforced by

`pnpm ops ci test integration --scope tooling --suite i18n` 验证资源/AST/参数契约；`pnpm ops ci check i18n` 执行真实资源、生成漂移与增量源码检查；该测试仍属于 Desktop `pretest` 及 `.gitlab-ci.yml` 的显式集合。`pnpm ops ci check types desktop` 检查调用 key 和 options 类型。AST 不覆盖的业务语义必须审查，门禁通过不等于翻译正确或真实产品已验收。

## Update triggers

改 API、namespace 登记、类型生成、检查语法位置/例外或基线规则时同步本文与契约测试；总体决策改动先改 i18n.md。开发规则在实际 AGENTS.md 中维护。

## Stop condition

找到实际 owner、资源与消费入口后开展已授权功能开发；同一变更补资源、检查和适用真实验证。基础 Goal 不等待所有历史页面迁移；新增违规、参数错误或必需验证缺失不能宣称该功能完成。
