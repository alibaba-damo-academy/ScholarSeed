import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('Assistant selection references use an Assistant-owned composition of public primitives', () => {
  const panel = readFileSync(new URL('./AiPanel.tsx', import.meta.url), 'utf8')
  const quote = readFileSync(new URL('./Quote.tsx', import.meta.url), 'utf8')
  const stream = readFileSync(
    new URL('../../components/business/Stream.tsx', import.meta.url),
    'utf8'
  )
  const failure = readFileSync(
    new URL('../../components/business/Failure.tsx', import.meta.url),
    'utf8'
  )
  const workbenchCss = readFileSync(new URL('../../shell/workbench.css', import.meta.url), 'utf8')

  assert.match(panel, /<AssistantContextQuote/)
  assert.match(panel, /<HoverCardTrigger asChild>\{tag\}<\/HoverCardTrigger>/)
  assert.match(panel, /<HoverCardContent[^>]*>[\s\S]*<AssistantContextQuote/)
  assert.match(panel, /tabIndex=\{ref\.anchor \? 0 : undefined\}/)
  assert.match(
    panel,
    /act\.openResourceFile\(\s*ref\.source_id,\s*state\.homeSelectedProjectId \?\? undefined\s*\)/
  )
  assert.match(
    panel,
    /act\.openLiteratureAttachment\(\s*ref\.source_id,\s*ref\.anchor\?\.document_id \?\? undefined\s*\)/
  )
  assert.doesNotMatch(panel, /已引用 \{otherRefs\.length\} 项/)
  assert.match(panel, /data-testid="ai-context-ref"/)
  assert.match(panel, /EllipsisVertical/)
  assert.match(panel, /Pencil/)
  assert.match(panel, /Trash/)
  assert.doesNotMatch(panel, /<Command\s+searchValue=\{sessionQuery\}/)
  assert.match(
    panel,
    /<\/CommandItem>\s*\)\}\s*\{sessionRenameId !== node\.id && \(\s*<Popover[\s\S]*<PopoverTrigger asChild>[\s\S]*<IconButton[\s\S]*data-testid=\{`ai-session-actions-\$\{node\.id\}`\}[\s\S]*variant="ghostIcon"/
  )
  assert.match(
    panel,
    /<PopoverContent[\s\S]*data-testid=\{`ai-session-action-menu-\$\{node\.id\}`\}/
  )
  assert.doesNotMatch(panel, /DropdownMenu/)
  // 气泡稳定展示：面板打开就预热目录，点开时第一帧就是最终高度。
  assert.match(panel, /const fetchSessions = useCallback\(\s*async \(query: string\)/)
  assert.match(
    panel,
    /if \(!ai\.open \|\| ai\.sessionMenuOpen\) return\s*\n\s*void fetchSessions\(''\)/
  )
  // 列表相位互斥：加载占位只在「无行且未拿到结果」时出现，绝不与旧行同时渲染。
  assert.match(panel, /\{sessionNodes\.length === 0 && listPending && \(/)
  assert.match(panel, /\{sessionNodes\.length === 0 && sessionListState === 'ready' && \(/)
  assert.doesNotMatch(panel, /\{sessionListState === 'loading' && \(/)
  // 历史对话 = 点击弹出气泡（右对齐历史按钮），不再是整块「历史会话 tab」。
  assert.match(
    panel,
    /<PopoverContent\s+align="end"\s+aria-label=\{t\('panel\.history'\)\}[\s\S]*?data-testid="ai-session-flyout"\s+side="bottom"/
  )
  assert.doesNotMatch(panel, /is-history/)
  assert.doesNotMatch(panel, /sessionTotal/)
  // 浮层内不放「新会话」入口：新建仍由面板头部那颗按钮负责。
  assert.doesNotMatch(panel, /vds-ai-session-new/)
  assert.match(panel, /data-testid="ai-session-search"/)
  // 行标题走 EllipsisText：只有真被截断才浮 tooltip；列表可滚动，tooltip 必须 portal 才不被裁切。
  assert.match(panel, /<EllipsisText[\s\S]*?tooltipPortalled[\s\S]*?<\/EllipsisText>/)
  assert.doesNotMatch(panel, /<Tooltip content=\{displayName\}/)
  // 格式化归 assistant 自己的 text.ts 所有（可单测），不在面板组件里养本地 helper。
  assert.match(
    panel,
    /sessionTimeLabel\(\s*row\?\.last_agent_reply_at \?\? undefined,\s*sessionTimeFormat\s*\)/
  )
  assert.match(
    panel,
    /import \{ referenceBaseLabel, referenceLabel, sessionTimeLabel \} from '\.\/text'/
  )
  assert.doesNotMatch(panel, /function sessionUpdatedLabel/)
  assert.match(panel, /\{updatedLabel \? \(/)
  // 浮层视觉值全部取设计 token，页面不写死透明度等数值；水平方向不再固定宽度，
  // 而是与输入框同宽同左（宽度随会话区域自适应、区域过宽时同输入框被内容列宽封顶），
  // 经 PopoverContent 的 inline style 覆盖定位层的 left/width。
  assert.match(panel, /opacity:var\(--vds-opacity-full\)/)
  assert.doesNotMatch(panel, /w-\[var\(--vds-popover-width-md\)\]/)
  // 浮层边界必须由输入框内容列测量而来（而非面板），以保证与输入框对齐。
  assert.match(panel, /inputBoxRef=\{composerInputBoxRef\}/)
  assert.match(panel, /const box = composerInputBoxRef\.current/)
  assert.match(panel, /width: sessionFlyoutBounds\.width/)
  // Popover 基类带 320px max-width 钳制，浮层必须解除它才能让 inline width 生效。
  assert.match(panel, /!max-w-none/)
  assert.doesNotMatch(panel, /SESSION_[A-Z_]*CLASS_NAME[\s\S]{0,400}?\d+px/)
  // 历史浮层整族手写 CSS 已迁到 Tailwind + token：不允许再回到 workbench.css。
  assert.doesNotMatch(
    workbenchCss,
    /\.vds-ai-session-(?:popover|list|row|main|title|time|more|actions|action-item|error|menu|new)/
  )
  assert.doesNotMatch(panel, /className="vds-selection-action-source"/)
  assert.match(quote, /from '\.\.\/\.\.\/components\/ui'/)
  assert.match(quote, /<blockquote/)
  assert.match(quote, /<ScrollArea/)
  assert.match(quote, /data-testid="assistant-selection-open-source"/)
  assert.match(stream, /data-testid="sent-context-references"/)
  assert.match(stream, /data-testid="sent-selection-reference"/)
  assert.match(stream, /act\.openResourceFile\(reference\.sourceId, project\.id\)/)
  assert.doesNotMatch(stream, />\{r\.status\}</)
  assert.match(stream, /<Failure[\s\S]*onContinue=\{onContinue\}/)
  assert.match(failure, /data-testid="turn-continue"[\s\S]*variant="outline"/)
  assert.match(stream, /<div role="status" aria-live="polite" className="sr-only">/)
  const activity = stream.slice(
    stream.indexOf('data-testid="turn-activity"'),
    stream.indexOf('<CollapsibleTrigger', stream.indexOf('data-testid="turn-activity"'))
  )
  assert.doesNotMatch(activity, /aria-live=/)
  const continueAction = failure.slice(
    failure.indexOf('data-testid="turn-continue"'),
    failure.indexOf('</Button>', failure.indexOf('data-testid="turn-continue"'))
  )
  assert.match(continueAction, /size="sm"/)
})
