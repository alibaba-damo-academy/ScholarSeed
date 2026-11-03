import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createInstance } from 'i18next'

const menuSource = readFileSync(new URL('./RowMenu.tsx', import.meta.url), 'utf8')
const listSource = readFileSync(new URL('./LiteratureList.tsx', import.meta.url), 'utf8')
const detailSource = readFileSync(new URL('./LiteratureDetail.tsx', import.meta.url), 'utf8')
const notesSource = readFileSync(new URL('./Notes.tsx', import.meta.url), 'utf8')

const engine = createInstance()
await engine.init({
  fallbackLng: false,
  lng: 'zh',
  resources: {
    en: { literature: JSON.parse(readFileSync(new URL('../../../../localization/locales/en/literature.json', import.meta.url), 'utf8')) },
    zh: { literature: JSON.parse(readFileSync(new URL('../../../../localization/locales/zh/literature.json', import.meta.url), 'utf8')) }
  }
})

test('the row menu is the design system context menu wrapped around the row itself', () => {
  // 消费域只能从 components/ui barrel 取菜单能力, 定位/开合/键盘导航都由它负责。
  assert.match(menuSource, /} from '\.\.\/\.\.\/components\/ui'/)
  assert.match(menuSource, /<ContextMenuTrigger asChild>\{children\}<\/ContextMenuTrigger>/)
  // 行是列表网格的直接子元素: 触发器必须合并到行的 div 上, 不能插入包裹节点。
  assert.match(listSource, /<LiteratureRowMenu actions=\{menu\} item=\{item\} projectId=\{projectId\}>/)
  assert.doesNotMatch(menuSource, /onContextMenu=/)
  assert.doesNotMatch(menuSource, /createPortal/)
})

test('menu entries keep the required order and separators', () => {
  const sequence = [...menuSource.matchAll(/<ContextMenuSeparator \/>|literature\('([a-zA-Z.]+)'\)/g)]
    .map((match) => match[1] ?? '|')
  assert.deepEqual(sequence, [
    'list.rowMenu.viewPdf',
    'list.rowMenu.copyTitle',
    'list.rowMenu.viewInfo',
    '|',
    'list.rowMenu.addNote',
    'list.rowMenu.addAttachment',
    '|',
    'batch.removeProject',
    'batch.deleteTitle'
  ])
})

test('icons come from the shared icon set instead of hand drawn svg', () => {
  assert.match(menuSource, /import \{ Copy, Eye, Info, Paperclip, PenLine, Trash \} from 'lucide-react'/)
  assert.doesNotMatch(menuSource, /<svg|<path\s/)
})

test('view pdf is unavailable exactly when the row has no usable primary attachment', () => {
  // 与行双击同一条判定: 文件已丢失的主附件也算没有, 否则只会换来一句错误提示。
  assert.match(menuSource, /isAttachmentAvailable\(item\.primary_attachment\)/)
  assert.match(menuSource, /disabled=\{primaryAttachment === null\}/)
  assert.match(menuSource, /if \(primaryAttachment\) actions\.viewPdf\(primaryAttachment\.id\)/)
  assert.match(listSource, /viewPdf: \(attachmentId\) =>\s*act\.openLiteratureAttachment\(item\.id, attachmentId\)/)
})

test('copy title is a clipboard action owned by the list, not by the menu', () => {
  // 菜单只摆动作, 不碰剪贴板: 复制的实现与它的成功/失败提示都留在列表里。
  assert.match(menuSource, /onSelect=\{actions\.copyTitle\}/)
  assert.doesNotMatch(menuSource, /clipboard/i)
  // 标题为空的行没有可复制的东西, 与「没有主附件就不能查看 PDF」同一种处理: 置灰。
  assert.match(menuSource, /disabled=\{item\.title\.trim\(\) === ''\}/)
  // 走共享剪贴板能力 (主进程优先), 不用只认聚焦态的 navigator.clipboard。
  assert.match(listSource, /import \{ writeClipboard \} from '\.\.\/\.\.\/components\/primitive\/clipboard'/)
  assert.match(listSource, /await writeClipboard\(title\)/)
  assert.match(listSource, /copyTitle: \(\) => void copyItemTitle\(item\)/)
  // 成与败都要有用户可见反馈, 不能静默。
  assert.match(listSource, /literature\('list\.rowMenu\.titleCopied'\)/)
  assert.match(listSource, /literature\('list\.rowMenu\.copyTitleFailed'\)/)
})

test('the destructive entry follows the scope: remove in a project, delete in the overview', () => {
  assert.match(menuSource, /destructive onSelect=\{actions\.remove\}/)
  assert.match(menuSource, /projectId\s*\?\s*literature\('batch\.removeProject'\)\s*:\s*literature\('batch\.deleteTitle'\)/)
  assert.match(listSource, /remove: \(\) => setRemoveTarget\(item\)/)
  // 单条与批量共用同一套语义与失败提示, 不各写一份后端调用。
  assert.match(listSource, /if \(!\(await removeLiteratures\(selected\)\)\) return/)
  assert.match(listSource, /const removed = await removeLiteratures\(\[target\.id\]\)/)
  assert.match(listSource, /bulkLiteratures\(\[\.\.\.ids\], 'unlink_project', \{/)
  assert.match(listSource, /deleteLiteratures\(\[\.\.\.ids\]\)/)
  // 破坏性动作先确认, 文案点名这一条文献。
  assert.match(listSource, /data-testid="literature-row-remove-confirm"/)
  assert.match(listSource, /literature\('list\.rowMenu\.removeDescription', \{/)
  assert.match(listSource, /literature\('list\.rowMenu\.deleteDescription', \{/)
})

test('note and attachment intents land on their own tab and fire once', () => {
  assert.match(detailSource, /intent\.action === 'note' \? DETAIL_TAB\.notes : DETAIL_TAB\.attachments/)
  // 附件页的隐藏 input 只在该 tab 挂上后才存在, 早一步 click 会打在空 ref 上。
  assert.match(detailSource, /if \(detailTab !== DETAIL_TAB\.attachments \|\| !attachmentInput\.current\) return/)
  assert.match(detailSource, /attachmentInput\.current\.click\(\)/)
  assert.match(detailSource, /startNew=\{\s*pendingIntent\?\.action === 'note' \? pendingIntent\.nonce : 0\s*\}/)
  // 笔记按 nonce 触发: 依赖里放 requestNew 会把用户正在写的那篇反复重开。
  assert.match(notesSource, /startRequest\.current\.requestNew\(\)/)
  assert.match(notesSource, /\}, \[startNew\]\)/)
  assert.match(listSource, /addNote: \(\) => openDetail\(item, 'note'\)/)
  assert.match(listSource, /addAttachment: \(\) => openDetail\(item, 'attachment'\)/)
  // 意图消费后回收, 否则重开面板会再触发一次; 回收函数要稳定身份, 否则详情侧
  // 消费 effect 的 deps 每轮渲染都变。
  assert.match(
    listSource,
    /const clearDetailIntent = useCallback\(\(\) => setDetailIntent\(null\), \[\]\)/
  )
  assert.match(listSource, /onIntentConsumed=\{clearDetailIntent\}/)
})

test('row menu labels are localized in both languages', () => {
  const zh = engine.getFixedT('zh', 'literature')
  const en = engine.getFixedT('en', 'literature')
  assert.equal(zh('list.rowMenu.viewPdf'), '查看 PDF')
  assert.equal(zh('list.rowMenu.copyTitle'), '复制标题')
  assert.equal(zh('list.rowMenu.viewInfo'), '查看基本信息')
  assert.equal(zh('list.rowMenu.addNote'), '添加笔记')
  assert.equal(zh('list.rowMenu.addAttachment'), '添加附件')
  assert.equal(en('list.rowMenu.viewPdf'), 'View PDF')
  assert.equal(en('list.rowMenu.copyTitle'), 'Copy title')
  assert.equal(en('list.rowMenu.viewInfo'), 'View basic information')
  assert.equal(en('list.rowMenu.addNote'), 'Add note')
  assert.equal(en('list.rowMenu.addAttachment'), 'Add attachment')
  assert.equal(
    zh('list.rowMenu.deleteDescription', { title: 'A' }),
    '确定要删除“A”吗？此操作无法撤销。'
  )
  assert.equal(
    en('list.rowMenu.removeDescription', { title: 'A' }),
    'Remove “A” from this project? It will remain in the literature overview.'
  )
})
