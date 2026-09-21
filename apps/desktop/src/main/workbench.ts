// workbench.ts — MVP 0.2 工作台产品流程验收 harness（`--workbench-check`）。
//
// 为什么需要它：`--shoot` 只证明「界面长这样」，契约测试只证明「HTTP 通」。
// 两者都无法回答「用户在真实界面上点了按钮，磁盘上究竟有没有发生变化」——
// 而 PRD 对资料库的核心要求恰恰是「书深里的操作与本地真实文件保持一致」。
//
// 因此本 harness 在**真实渲染进程**里点**真实 DOM 元素**，走**真实 IPC/HTTP**，
// 每一步之后再回读后端 `/api/resource/tree` 与 `/api/literature/items` 核对结果，
// 把「点击 → 落盘」这条链路整体钉死。
//
// 它不 mock 任何东西：没有假 provider、没有直调内部函数、不预置 state。
// 唯一的「非用户行为」是用 `element.click()` 代替鼠标物理点击，
// 这与 shoot.ts 既有的 clickSelector 同源，事件仍走 React 真实处理器。

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, join, resolve, sep } from 'path'

import { BrowserWindow, clipboard } from 'electron'

import { IMPORT_PICKER_TARGET, supportsImportPickerTarget } from '../picker'
import { typeInputValue } from './drive'

type LogSink = (line: string) => void

/** 单步操作后等界面/后端稳定的时间。 */
const SETTLE_MS = 700

/** 等某个选择器出现的轮询上限。 */
const WAIT_TIMEOUT_MS = 8_000
const FILE_VERSION_INPUT_TIMEOUT_MS = 30_000
const OFFICE_REVEAL_TIMEOUT_MS = 30_000
const OFFICE_FONT_PERMISSION_STATUS = '正在申请系统字体权限…'
const WAIT_POLL_MS = 100

/** 新建文档/文件夹时填入的名称，带前缀便于事后识别与清理。 */
const NEW_FOLDER_NAME = 'UI验收目录'
const NEW_DOC_NAME = 'UI验收笔记'
const SPLIT_DOC_NAME = 'UI验收分栏笔记'
const RENAMED_FOLDER_NAME = 'UI验收目录-已改名'
const OFFICE_FIXTURE_NAME = 'UI验收Office.docx'
const OFFICE_FIXTURE_ENV = 'SCHOLARSEED_WORKBENCH_OFFICE_FIXTURE'
const OFFICE_SEARCH_QUERY_ENV = 'SCHOLARSEED_WORKBENCH_OFFICE_SEARCH_QUERY'
const SEARCH_ONLY_ENV = 'SCHOLARSEED_WORKBENCH_SEARCH_ONLY'
const ENABLED_ENV_VALUE = '1'
const FILE_VERSION_MAX_SIZE_MB = 2048
const KILOBYTES_PER_MEGABYTE = 1024
const FILE_VERSION_MAX_SIZE_KB = FILE_VERSION_MAX_SIZE_MB * KILOBYTES_PER_MEGABYTE
const DOCUMENT_TAB_SELECTOR = '[role="tab"][data-testid^="document-tab-"]'
const MARKDOWN_SEARCH_NAME = 'perovskite.md'
const MARKDOWN_SEARCH_QUERY = '失效机理初探'
const EXPECTED_RECENT_FILE_ROWS = 5
const RECENT_FILE_FIXTURE_NAMES = [
  '最近打开验收-1.md',
  '最近打开验收-2.md',
  '最近打开验收-3.md'
] as const
const LITERATURE_FIXTURE_NAME = 'perovskite-fixture.bib'
const LITERATURE_PDF_NAME = 'perovskite-attachment.pdf'
const LITERATURE_MARKDOWN_NAME = 'perovskite-supplement.md'
const LITERATURE_MARKDOWN_CONTENT = '# Supplement\n\nHumidity protocol and observations.\n'
const LITERATURE_IMPORT_OPERATION = 'ui-acceptance-literature-import'
const LITERATURE_FIXTURE = [
  '@article{acc1,',
  '  title={Perovskite degradation under humidity},',
  '  author={Zhang, Wei},',
  '  journal={Nature Energy},',
  '  year={2024},',
  '  doi={10.1/abc}',
  '}',
  '@article{acc2,',
  '  title={Perovskite encapsulation review},',
  '  author={Li, Ming},',
  '  journal={Joule},',
  '  year={2022},',
  '  doi={10.1/def}',
  '}'
].join('\n')

/** 固件项目：工作区根只是容器、本身不是项目（proposal 47 §4），所以验收得自己建一个。 */
const FIXTURE_PROJECT_NAME = 'UI验收固件'

/** harness 产物的共同标记。清理只动名字里带它、且位于工作区根之下的目录。 */
const RESIDUE_MARK = 'UI验收'

/** 项目面板验收用的名称（proposal 47 阶段一/二）。 */
const NEW_PROJECT_NAME = 'UI验收项目'

/** MANAGED 布局的内置双库目录名，与后端 `content.domain.model` 的常量一致。 */
const RESOURCES_DIR = 'resources'
const LITERATURE_DIR = 'literature'

/** AI 产物目录名，与后端 `AGENT_OUTPUT_DIR` 一致。 */
const AGENT_OUTPUT_DIR = 'ai_extracts'
const RESTORE_FILE_NAME = '恢复同步验收.md'
const RESTORE_INITIAL_CONTENT = '# 恢复同步验收\n\n初始版本。\n'
const RESTORE_LATEST_CONTENT = '# 恢复同步验收\n\n当前版本。\n'
const LINKED_INITIAL_CONTENT = '外部原文'
const LINKED_UPDATED_CONTENT = '外部程序保存后的实时内容'

// Markdown 划词发 AI 现在发生在 Milkdown 所见即所得编辑视图（`edit`），
// 不再是旧的纯渐染只读预览：workbench 重构后 `markdown-render` 已不存在，
// 选区能力改由 `MarkdownVisualEditor` 的 `data-testid="markdown-visual-editor"`
// 承载，且必须先通过 Markdown 自有的 `markdown-open-editor`
// 切到可视化编辑视图，才能进入这个可选区的编辑器。
const MARKDOWN_RENDER_TEST_ID = 'markdown-visual-editor'
const MARKDOWN_EDIT_TEST_ID = 'markdown-open-editor'


const MARKDOWN_CODE_COPY_TEXT = 'console.log("clipboard");'

/** 写入 Markdown 的正文，含标题/粗体/表格/代码块，用于验证渲染与落盘。 */
const MARKDOWN_BODY = [
  '# UI 驱动验收',
  '',
  '这一段由**真实 UI 点击**写入，用于核对磁盘内容。',
  '',
  '| 项 | 值 |',
  '|----|----|',
  '| 通道 | 真实渲染进程 |',
  '',
  '```text',
  MARKDOWN_CODE_COPY_TEXT,
  '```'
].join('\n')

/** BOTH_CHANGED 验收中两侧故意不同的尾部内容。 */
const CONFLICT_MEMORY_SUFFIX = '编辑器内存另存版本。'
const CONFLICT_DISK_SUFFIX = '外部程序磁盘版本。'

/** 树里是否存在某个名字的节点。
 *
 * 断言按**名字**而不是整条相对路径: MANAGED 项目的资料树路径带 `resources/` 前缀,
 * 而 LEGACY 项目没有 —— 拿整条路径比会在换项目布局时假红。
 */
function hasNode(paths: string[], name: string): boolean {
  return paths.some((item) => item === name || item.endsWith(`/${name}`))
}

/** 找出树里某个名字对应的完整相对路径（供后续接口调用）。 */
function findNode(paths: string[], name: string): string {
  return paths.find((item) => item === name || item.endsWith(`/${name}`)) ?? ''
}

interface StepResult {
  name: string
  ok: boolean
  detail: string
}

type StepRecorder = (name: string, ok: boolean, detail?: string) => void

const settle = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/** 点一个选择器；元素不存在返回 false，不抛异常。 */
async function click(win: BrowserWindow, selector: string): Promise<boolean> {
  return Boolean(
    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!(el instanceof HTMLElement)) return false
        el.click()
        return true
      })()
    `)
  )
}

/** 点击当前全局搜索里同时包含指定文件名和证据片段的资料结果。 */
async function clickResourceSearchHit(
  win: BrowserWindow,
  name: string,
  query: string
): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(`
    (() => {
      const row = Array.from(document.querySelectorAll('[data-testid^="search-hit-resource-"]'))
        .find((candidate) =>
          candidate instanceof HTMLElement
          && (candidate.textContent || '').includes(${JSON.stringify(name)})
          && (candidate.textContent || '').includes(${JSON.stringify(query)})
        )
      if (!(row instanceof HTMLElement)) return false
      row.click()
      return true
    })()
  `))
}
/** 同一轮事件循环连续点击两次，用于验证保存入口会合并重复提交。 */
async function clickTwice(win: BrowserWindow, selector: string): Promise<boolean> {
  return Boolean(
    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!(el instanceof HTMLElement)) return false
        el.click()
        el.click()
        return true
      })()
    `)
  )
}

/** 按文档路径选中可见视图中的正文，并触发 Viewer 的真实选区捕获事件。 */
async function selectDocumentText(
  win: BrowserWindow,
  path: string,
  testId: string
): Promise<boolean> {
  return Boolean(
    await win.webContents.executeJavaScript(`
      (() => {
        const slots = Array.from(document.querySelectorAll('.vds-document-view-slot'))
        const elements = slots.flatMap((candidate) => {
          if (!(candidate instanceof HTMLElement) || candidate.hidden) return []
          const title = candidate.querySelector('.vds-document-toolbar > span:first-child')
          if (title?.getAttribute('title') !== ${JSON.stringify(path)}) return []
          return Array.from(candidate.querySelectorAll('[data-testid]'))
            .filter((element) => element.getAttribute('data-testid') === ${JSON.stringify(testId)})
        })
        const element = elements.find((candidate) => candidate instanceof HTMLElement)
        if (!(element instanceof HTMLElement)) return false
        const range = document.createRange()
        range.selectNodeContents(element)
        const selection = window.getSelection()
        if (!selection) return false
        selection.removeAllRanges()
        selection.addRange(range)
        const selected = selection.toString().trim().length > 0
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        return selected
      })()
    `)
  )
}

async function waitForDocumentText(
  win: BrowserWindow,
  path: string,
  testId: string
): Promise<boolean> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await selectDocumentText(win, path, testId)) return true
    await settle(WAIT_POLL_MS)
  }
  return false
}

async function describeDocumentViews(win: BrowserWindow): Promise<string> {
  return String(
    await win.webContents.executeJavaScript(`
      JSON.stringify(Array.from(document.querySelectorAll('.vds-document-view-slot')).map((slot) => ({
        hidden: slot instanceof HTMLElement ? slot.hidden : null,
        path: slot.querySelector('.vds-document-toolbar > span:first-child')?.getAttribute('title') ?? '',
        markdown: slot.querySelector('[data-testid="markdown-visual-editor"]')?.textContent?.length ?? -1,
        monaco: Boolean(slot.querySelector('[data-testid="monaco-editor"]'))
      })))
    `)
  )
}

/** 用真实 contextmenu 事件打开 Tab 菜单。 */
async function openContextMenu(win: BrowserWindow, selector: string): Promise<boolean> {
  return Boolean(
    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.bottom
        }))
        return true
      })()
    `)
  )
}

/** 用可见标题精确打开某个 Tab 的菜单，避免分栏内同时存在多个 active Tab 时点错。 */
async function openTabContextMenu(win: BrowserWindow, title: string): Promise<boolean> {
  return Boolean(
    await win.webContents.executeJavaScript(`
      (() => {
        const el = Array.from(document.querySelectorAll(${JSON.stringify(DOCUMENT_TAB_SELECTOR)}))
          .find((tab) => tab.querySelector('span')?.textContent === ${JSON.stringify(title)})
        if (!(el instanceof HTMLElement)) return false
        const rect = el.getBoundingClientRect()
        el.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.bottom
        }))
        return true
      })()
    `)
  )
}

interface DocumentTabSnapshot {
  count: number
  ids: string[]
}

/** 顶部页签上的「未保存」红点数量；measure 层是 aria-hidden 副本，必须排除。 */
async function tabDirtyMarkers(win: BrowserWindow, title: string): Promise<number> {
  return Number(await win.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('.vds-navigation-tabs [role="tab"]'))
      .filter((tab) => !tab.closest('[aria-hidden="true"]')
        && tab.querySelector('span')?.textContent === ${JSON.stringify(title)}
        && tab.querySelector('[data-slot="navigation-tab-dirty"]'))
      .length
  `))
}

async function documentTabSnapshot(win: BrowserWindow, title: string): Promise<DocumentTabSnapshot> {
  return await win.webContents.executeJavaScript(`
    (() => {
      const tabs = Array.from(document.querySelectorAll(${JSON.stringify(DOCUMENT_TAB_SELECTOR)}))
        .filter((tab) => tab.querySelector('span')?.textContent === ${JSON.stringify(title)})
      return {
        count: tabs.length,
        ids: tabs.map((tab) => tab.getAttribute('data-testid') || '')
      }
    })()
  `) as DocumentTabSnapshot
}

async function closeDocumentTab(win: BrowserWindow, title: string): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(`
    (() => {
      const tab = Array.from(document.querySelectorAll(${JSON.stringify(DOCUMENT_TAB_SELECTOR)}))
        .find((candidate) => candidate.querySelector('span')?.textContent === ${JSON.stringify(title)})
      const close = tab?.querySelector('button[aria-label^="关闭 "]')
      if (!(close instanceof HTMLElement)) return false
      close.click()
      return true
    })()
  `))
}

async function beginTabDrag(win: BrowserWindow, title: string, targetLeafIndex: number): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(`
    (() => {
      const source = Array.from(document.querySelectorAll(${JSON.stringify(DOCUMENT_TAB_SELECTOR)}))
        .find((tab) => tab.textContent?.includes(${JSON.stringify(title)}))
      const target = document.querySelectorAll('.vds-dock-leaf')[${targetLeafIndex}]
      if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) return false
      const data = new DataTransfer()
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
      const rect = target.getBoundingClientRect()
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        dataTransfer: data
      }))
      return true
    })()
  `))
}

async function finishTabDrag(win: BrowserWindow, title: string): Promise<void> {
  await win.webContents.executeJavaScript(`
    (() => {
      const source = Array.from(document.querySelectorAll(${JSON.stringify(DOCUMENT_TAB_SELECTOR)}))
        .find((tab) => tab.textContent?.includes(${JSON.stringify(title)}))
      if (source instanceof HTMLElement) source.dispatchEvent(new DragEvent('dragend', { bubbles: true }))
    })()
  `)
}

/** 通过真实 DragEvent 把资料树节点放到目标目录，并读取有效落点的高亮状态。 */
async function dragResourceNode(
  win: BrowserWindow,
  sourcePath: string,
  targetPath: string
): Promise<{ dispatched: boolean; validTarget: boolean }> {
  return await win.webContents.executeJavaScript(`
    new Promise((resolve) => {
      const source = document.querySelector(${JSON.stringify(`[data-testid="tree-${sourcePath}"]`)})
      const target = document.querySelector(${JSON.stringify(`[data-testid="tree-${targetPath}"]`)})
      if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) {
        resolve({ dispatched: false, validTarget: false })
        return
      }
      const data = new DataTransfer()
      source.dispatchEvent(new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer: data
      }))
      setTimeout(() => {
        target.dispatchEvent(new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: data
        }))
        setTimeout(() => {
          const validTarget = target.classList.contains('outline')
          target.dispatchEvent(new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: data
          }))
          source.dispatchEvent(new DragEvent('dragend', {
            bubbles: true,
            dataTransfer: data
          }))
          resolve({ dispatched: true, validTarget })
        }, 50)
      }, 50)
    })
  `) as { dispatched: boolean; validTarget: boolean }
}

/** 在所见即所得编辑器末尾创建空段并输入一个真实按键字符。 */
async function typeMarkdownSlash(win: BrowserWindow): Promise<boolean> {
  const focused = Boolean(await win.webContents.executeJavaScript(`
    (() => {
      const root = document.querySelector('[data-testid="markdown-visual-editor"] .ProseMirror')
      if (!(root instanceof HTMLElement)) return false
      root.focus()
      const range = document.createRange()
      range.selectNodeContents(root)
      range.collapse(false)
      const selection = window.getSelection()
      if (!selection) return false
      selection.removeAllRanges()
      selection.addRange(range)
      return true
    })()
  `))
  if (!focused) return false
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '/' })
  win.webContents.sendInputEvent({ type: 'char', keyCode: '/' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '/' })
  return true
}

/** 通过浏览器原生 DragEvent 把指定文件 Tab 移入目标 leaf 中央。 */
async function dragTabToLeaf(
  win: BrowserWindow,
  title: string,
  targetLeafIndex: number
): Promise<boolean> {
  return Boolean(
    await win.webContents.executeJavaScript(`
      (() => {
        const tabs = Array.from(document.querySelectorAll(${JSON.stringify(DOCUMENT_TAB_SELECTOR)}))
        const source = tabs.find((tab) => tab.textContent?.includes(${JSON.stringify(title)}))
        const leaves = Array.from(document.querySelectorAll('.vds-dock-leaf'))
        const target = leaves[${targetLeafIndex}]
        if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement) || !source.draggable) return false
        const data = new DataTransfer()
        source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
        const rect = target.getBoundingClientRect()
        const init = {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          dataTransfer: data
        }
        target.dispatchEvent(new DragEvent('dragover', init))
        target.dispatchEvent(new DragEvent('drop', init))
        source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }))
        return true
      })()
    `)
  )
}

/** 在同一标签条内把 source 悬停到 target 前/后，返回插入指示是否出现。 */
async function beginTabReorder(
  win: BrowserWindow,
  sourceTitle: string,
  targetTitle: string,
  insertion: 'before' | 'after'
): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(`
    (async () => {
      const tabs = Array.from(document.querySelectorAll(${JSON.stringify(DOCUMENT_TAB_SELECTOR)}))
      const source = tabs.find((tab) => tab.querySelector('span')?.textContent === ${JSON.stringify(sourceTitle)})
      const target = tabs.find((tab) => tab.querySelector('span')?.textContent === ${JSON.stringify(targetTitle)}
        && tab.parentElement === source?.parentElement)
      if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) return false
      const data = new DataTransfer()
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }))
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const rect = target.getBoundingClientRect()
      target.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientX: ${insertion === 'before' ? 'rect.left + 1' : 'rect.right - 1'},
        clientY: rect.top + rect.height / 2,
        dataTransfer: data
      }))
      window.__scholarseedTabReorder = { source, target, data, insertion: ${JSON.stringify(insertion)} }
      return true
    })()
  `))
}

/** 完成 beginTabReorder 建立的真实拖放序列。 */
async function finishTabReorder(win: BrowserWindow): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(`
    (() => {
      const current = window.__scholarseedTabReorder
      if (!current) return false
      const { source, target, data, insertion } = current
      const rect = target.getBoundingClientRect()
      target.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: insertion === 'before' ? rect.left + 1 : rect.right - 1,
        clientY: rect.top + rect.height / 2,
        dataTransfer: data
      }))
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: data }))
      delete window.__scholarseedTabReorder
      return true
    })()
  `))
}

/** 等选择器出现。超时返回 false，由调用方记为失败而不是静默继续。 */
async function waitFor(
  win: BrowserWindow,
  selector: string,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = await win.webContents.executeJavaScript(
      `Boolean(document.querySelector(${JSON.stringify(selector)}))`
    )
    if (found === true) return true
    await settle(WAIT_POLL_MS)
  }
  return false
}

async function waitForMissing(
  win: BrowserWindow,
  selector: string,
  timeoutMs = WAIT_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const missing = await win.webContents.executeJavaScript(
      `!document.querySelector(${JSON.stringify(selector)})`
    )
    if (missing === true) return true
    await settle(WAIT_POLL_MS)
  }
  return false
}

async function waitForText(win: BrowserWindow, expected: string): Promise<boolean> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const found = await win.webContents.executeJavaScript(
      `document.body?.innerText.includes(${JSON.stringify(expected)}) === true`
    )
    if (found === true) return true
    await settle(WAIT_POLL_MS)
  }
  return false
}

/**
 * 往受 React 控制的输入框填值。
 *
 * 直接改 `.value` 不会触发 React 的 onChange（它监听的是原生 input 事件且
 * 依赖 value setter 拦截），所以要走原型链上的 setter 再派发事件 ——
 * 与 shoot.ts 里 typeIntoComposer 的做法一致。
 */
async function fill(win: BrowserWindow, selector: string, value: string): Promise<boolean> {
  return Boolean(
    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false
        const proto = el instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()
    `)
  )
}

/** 在输入框上按回车（就地命名靠 Enter 提交）。 */
async function pressEnter(win: BrowserWindow, selector: string): Promise<boolean> {
  return Boolean(
    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!(el instanceof HTMLElement)) return false
        el.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', bubbles: true, cancelable: true
        }))
        return true
      })()
    `)
  )
}

/** 读取页面上某个选择器的可见文本，用于断言提示与状态。 */
async function textOf(win: BrowserWindow, selector: string): Promise<string> {
  return String(
    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        return el instanceof HTMLElement ? el.innerText : ''
      })()
    `)
  )
}

async function clickVersionRestore(win: BrowserWindow, sequence: number): Promise<boolean> {
  return Boolean(await win.webContents.executeJavaScript(`
    (() => {
      const row = Array.from(document.querySelectorAll('.vds-version-row')).find(
        (candidate) => candidate.querySelector('strong')?.textContent?.trim() === ${JSON.stringify(`v${sequence}`)}
      )
      const action = Array.from(row?.querySelectorAll('button') ?? []).find(
        (candidate) => candidate.textContent?.trim() === '恢复'
      )
      if (!(action instanceof HTMLButtonElement) || action.disabled) return false
      action.click()
      return true
    })()
  `))
}

async function restoredEditorState(
  win: BrowserWindow,
  expectedSequence: number
): Promise<{ text: string; newest: string; rows: number }> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  let state = { text: '', newest: '', rows: 0 }
  while (Date.now() < deadline) {
    state = await win.webContents.executeJavaScript(`
      (() => {
        const visible = Array.from(document.querySelectorAll('.vds-document-view-slot')).find(
          (candidate) => candidate instanceof HTMLElement && !candidate.hidden
        )
        const rows = Array.from(document.querySelectorAll('.vds-version-row'))
        return {
          text: visible?.querySelector('[data-testid="monaco-editor"] .view-lines')?.textContent
            ?? visible?.querySelector('[data-testid="markdown-visual-editor"]')?.textContent
            ?? '',
          newest: rows[0]?.querySelector('strong')?.textContent?.trim() ?? '',
          rows: rows.length
        }
      })()
    `) as { text: string; newest: string; rows: number }
    if (state.newest === `v${expectedSequence}`) return state
    await settle(WAIT_POLL_MS)
  }
  return state
}

async function commitFileVersionInput(
  win: BrowserWindow,
  selector: string,
  value: number
): Promise<boolean> {
  if (!await waitForFileVersionInput(win, selector)) return false
  const focused = await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector(${JSON.stringify(selector)})
      if (!(input instanceof HTMLInputElement)) return false
      input.focus()
      input.select()
      return document.activeElement === input
    })()
  `)
  if (!focused) return false
  await win.webContents.insertText(String(value))
  await settle(WAIT_POLL_MS)
  return Boolean(
    await win.webContents.executeJavaScript(`
      (() => {
        const input = document.querySelector(${JSON.stringify(selector)})
        if (!(input instanceof HTMLInputElement)) return false
        input.blur()
        return true
      })()
    `)
  )
}

async function waitForFileVersionInput(
  win: BrowserWindow,
  selector: string
): Promise<boolean> {
  const deadline = Date.now() + FILE_VERSION_INPUT_TIMEOUT_MS
  let editable = false
  while (Date.now() < deadline) {
    editable = Boolean(await win.webContents.executeJavaScript(`
      (() => {
        const input = document.querySelector(${JSON.stringify(selector)})
        return input instanceof HTMLInputElement && !input.disabled
      })()
    `))
    if (editable) break
    await settle(WAIT_POLL_MS)
  }
  return editable
}

async function fileVersionFormState(win: BrowserWindow): Promise<string> {
  return String(await win.webContents.executeJavaScript(`
    (() => JSON.stringify({
      limit: document.querySelector('[data-testid="file-version-limit"]')?.value ?? null,
      maxFileSize: document.querySelector('[data-testid="file-version-max-size"]')?.value ?? null,
      active: document.activeElement?.getAttribute?.('data-testid') ?? null,
      notice: document.querySelector('.vds-toaster [role="status"]')?.textContent ?? '',
      error: document.querySelector('.vds-toaster [role="alert"]')?.textContent ?? ''
    }))()
  `))
}

async function beginFileVersionRequestCapture(win: BrowserWindow): Promise<void> {
  await win.webContents.executeJavaScript(`
    (() => {
      const scope = globalThis
      scope.__scholarseedWorkbenchOriginalFetch ??= scope.fetch.bind(scope)
      scope.__scholarseedWorkbenchFileVersionRequests = []
      scope.fetch = (...args) => {
        const [input, init] = args
        const url = typeof input === 'string' ? input : input.url
        const method = init?.method ?? (typeof input === 'string' ? 'GET' : input.method)
        const path = new URL(url, location.href).pathname
        if (path.includes('/api/serve/settings/file-versions')) {
          scope.__scholarseedWorkbenchFileVersionRequests.push(method.toUpperCase() + ' ' + path)
        }
        return scope.__scholarseedWorkbenchOriginalFetch(...args)
      }
    })()
  `)
}

async function finishFileVersionRequestCapture(win: BrowserWindow): Promise<string[]> {
  return await win.webContents.executeJavaScript(`
    (() => {
      const scope = globalThis
      const requests = [...(scope.__scholarseedWorkbenchFileVersionRequests ?? [])]
      if (scope.__scholarseedWorkbenchOriginalFetch) {
        scope.fetch = scope.__scholarseedWorkbenchOriginalFetch
      }
      delete scope.__scholarseedWorkbenchOriginalFetch
      delete scope.__scholarseedWorkbenchFileVersionRequests
      return requests
    })()
  `) as string[]
}

async function waitForFileVersionSettings(
  win: BrowserWindow,
  expectedLimit: number,
  expectedMaxFileSizeKb: number
): Promise<{
  max_versions_per_file?: number
  max_file_size_kb?: number
  include_patterns?: string[]
  ignore_patterns?: string[]
} | null> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  let settings: {
    max_versions_per_file?: number
    max_file_size_kb?: number
    include_patterns?: string[]
    ignore_patterns?: string[]
  } | null = null
  while (Date.now() < deadline) {
    settings = (await apiJson(win, '/api/serve/settings/file-versions')) as {
      max_versions_per_file?: number
      max_file_size_kb?: number
      include_patterns?: string[]
      ignore_patterns?: string[]
    } | null
    if (
      settings?.max_versions_per_file === expectedLimit
      && settings?.max_file_size_kb === expectedMaxFileSizeKb
    ) return settings
    await settle(WAIT_POLL_MS)
  }
  return settings
}

/** 选中页面上某个元素的全部文本（用于验证划词类功能）。 */
async function selectTextOf(win: BrowserWindow, selector: string): Promise<boolean> {
  return Boolean(
    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!(el instanceof HTMLElement)) return false
        const range = document.createRange()
        range.selectNodeContents(el)
        const sel = window.getSelection()
        if (!sel) return false
        sel.removeAllRanges()
        sel.addRange(range)
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        return sel.toString().trim().length > 0
      })()
    `)
  )
}

/** 读取输入框/文本区当前值。 */
async function valueOf(win: BrowserWindow, selector: string): Promise<string> {
  return String(
    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        return (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
          ? el.value : ''
      })()
    `)
  )
}

/**
 * 回读后端接口作为「磁盘真相」。
 *
 * 走 renderer 的 fetch 而不是主进程：这样用的就是产品自己的 apiBase 与
 * 凭据上下文，避免主进程另拼一套地址导致「测的不是产品那条链路」。
 */
async function apiJson(win: BrowserWindow, path: string): Promise<unknown> {
  return win.webContents.executeJavaScript(`
    fetch((window.scholarseed?.getApiBase?.() ?? '') + ${JSON.stringify(path)}, {
      credentials: 'include'
    }).then((r) => r.json()).catch(() => null)
  `)
}

/** 同 apiJson，但发 POST（走 renderer 的 fetch，用产品自己的地址与凭据）。 */
async function apiPost(win: BrowserWindow, path: string, body: unknown): Promise<unknown> {
  return win.webContents.executeJavaScript(`
    fetch((window.scholarseed?.getApiBase?.() ?? '') + ${JSON.stringify(path)}, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: ${JSON.stringify(JSON.stringify(body))}
    }).then((r) => r.json()).catch(() => null)
  `)
}

/** 上传真实附件，仍走 renderer 的产品 API 与凭据上下文。 */
async function apiPostFile(
  win: BrowserWindow,
  path: string,
  name: string,
  content: string,
  mediaType: string
): Promise<unknown> {
  return win.webContents.executeJavaScript(`
    (() => {
      const body = new FormData()
      body.append(
        'file',
        new File([${JSON.stringify(content)}], ${JSON.stringify(name)}, {
          type: ${JSON.stringify(mediaType)}
        })
      )
      return fetch((window.scholarseed?.getApiBase?.() ?? '') + ${JSON.stringify(path)}, {
        method: 'POST',
        credentials: 'include',
        body
      }).then((r) => r.json()).catch(() => null)
    })()
  `)
}

async function apiPostVersion(
  win: BrowserWindow,
  path: string,
  body: unknown
): Promise<unknown> {
  return win.webContents.executeJavaScript(`
    fetch((window.scholarseed?.getApiBase?.() ?? '') + ${JSON.stringify(path)}, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID()
      },
      body: ${JSON.stringify(JSON.stringify(body))}
    }).then((r) => r.json()).catch(() => null)
  `)
}

/** 同 apiJson，但发 DELETE。 */
async function apiDelete(win: BrowserWindow, path: string): Promise<unknown> {
  return win.webContents.executeJavaScript(`
    fetch((window.scholarseed?.getApiBase?.() ?? '') + ${JSON.stringify(path)}, {
      method: 'DELETE',
      credentials: 'include'
    }).then((r) => r.json()).catch(() => null)
  `)
}

/** 把资料树摊平成相对路径集合，便于断言某个路径是否真实存在。 */
function flatten(nodes: unknown): string[] {
  const out: string[] = []
  const walk = (items: unknown): void => {
    if (!Array.isArray(items)) return
    for (const item of items) {
      const node = item as { path?: unknown; children?: unknown }
      if (typeof node.path === 'string') out.push(node.path)
      walk(node.children)
    }
  }
  walk(nodes)
  return out
}

/** 本次验收所用项目的 id。
 *
 * 工作区根只是**项目容器**、本身不是项目（proposal 47 §4），所以回读接口不带
 * `project` 就没有「当前项目」可解析 —— 会拿到空树而不是报错，断言就成了假红。
 */
let fixtureProjectId = ''
let literatureFixtureItemId = ''

/** 给回读 URL 补上当前项目。 */
function withProject(path: string): string {
  if (!fixtureProjectId) return path
  return `${path}${path.includes('?') ? '&' : '?'}project=${encodeURIComponent(fixtureProjectId)}`
}

/** 本轮创建的项目登记 id 与磁盘目录，跑完原路移除。
 *
 * 不清理会让下一轮假红而不是发现真问题：固件与验收项目都按**名字**在项目列表里
 * `find`，工作区里堆着上一轮的同名项目时命中的是旧那个 —— 里面的 `UI验收目录-已改名`
 * 和已经移进 `笔记/` 的文档都还在，于是「重命名旧名消失」「移动弹窗打开」当场就红。
 */
const residueProjects: string[] = []
const residueDirectories: string[] = []

async function treePaths(win: BrowserWindow): Promise<string[]> {
  const payload = (await apiJson(win, withProject('/api/resource/tree'))) as {
    nodes?: unknown
  } | null
  return flatten(payload?.nodes)
}

/** 在 select 上选中指定 value（受控 select 同样需要走 setter + change）。 */
async function selectOption(
  win: BrowserWindow,
  selector: string,
  value: string
): Promise<boolean> {
  return Boolean(
    await win.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!(el instanceof HTMLSelectElement)) return false
        Object.getOwnPropertyDescriptor(
          window.HTMLSelectElement.prototype, 'value'
        )?.set?.call(el, ${JSON.stringify(value)})
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return true
      })()
    `)
  )
}

/**
 * 读剪贴板内容（验证「复制路径」真的写进了剪贴板）。
 *
 * 用 Electron 主进程的 `clipboard` 而不是渲染层的 `navigator.clipboard.readText()`：
 * 后者在无头/未聚焦的窗口里会因「Document is not focused」静默拒绝，
 * 读到空串会被误判为产品 bug。主进程读的是同一块系统剪贴板，不受聚焦限制。
 */
async function clipboardText(): Promise<string> {
  return clipboard.readText()
}

/** Populate and verify the empty-query recent list exclusively through real resource-tree clicks. */
async function verifyRecentFileSearch(
  win: BrowserWindow,
  record: StepRecorder
): Promise<boolean> {
  await click(win, '[data-testid="activity-resource"]')
  await waitFor(win, '[data-testid="resource-tree-root"]')
  const recentFixturePaths = [
    `${RESOURCES_DIR}/${RESTORE_FILE_NAME}`,
    `${RESOURCES_DIR}/实验数据.csv`,
    ...RECENT_FILE_FIXTURE_NAMES.map((name) => `${RESOURCES_DIR}/${name}`)
  ]
  let recentFixtureOpened = 0
  for (const path of recentFixturePaths) {
    const selector = `[data-testid="tree-${path}"]`
    const opened = await waitFor(win, selector) && await click(win, selector)
    await settle(SETTLE_MS)
    const selected = opened && Boolean(await win.webContents.executeJavaScript(`
      document.querySelector(${JSON.stringify(selector)})?.classList.contains('is-selected')
    `))
    if (selected) recentFixtureOpened += 1
  }
  record(
    '通过真实资料树打开 5 个验收文件',
    recentFixtureOpened === EXPECTED_RECENT_FILE_ROWS,
    `${recentFixtureOpened}/${EXPECTED_RECENT_FILE_ROWS}`
  )
  await settle(SETTLE_MS)

  await click(win, '[data-testid="topbar-search"]')
  const searchPanel = await waitFor(win, '[data-testid="global-search"]')
  record('全局搜索面板可打开', searchPanel)
  let queryPanelReady = searchPanel
  if (!searchPanel) return false

  const recentRows = await win.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('[data-testid="search-recent-file"]')).map((row) => ({
      path: row.getAttribute('data-path') || '',
      projectId: row.getAttribute('data-project-id') || '',
      text: row.textContent?.trim() || ''
    }))
  `) as { path: string; projectId: string; text: string }[]
  const completeRecentRows = recentRows.filter(
    (row) => row.path && row.projectId && row.text
  )
  record(
    '全局搜索空查询展示 5 个最近打开文件',
    recentRows.length === EXPECTED_RECENT_FILE_ROWS
      && completeRecentRows.length === EXPECTED_RECENT_FILE_ROWS,
    recentRows.map((row) => row.path).join(', ') || '未展示最近文件'
  )
  const snapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
  mkdirSync(snapshotDir, { recursive: true })
  writeFileSync(
    join(snapshotDir, 'global-search-recent.png'),
    (await win.webContents.capturePage()).toPNG()
  )

  const firstRecent = recentRows[0]
  if (firstRecent) {
    const recentClicked = await click(win, '[data-testid="search-recent-file"]')
    const panelClosed = recentClicked
      && await waitForMissing(win, '[data-testid="global-search"]')
    const selectedRecent = panelClosed && Boolean(await win.webContents.executeJavaScript(`
      document.querySelector(${JSON.stringify(`[data-testid="tree-${firstRecent.path}"]`)})
        ?.classList.contains('is-selected')
    `))
    record(
      '最近文件可从全局搜索直接打开',
      selectedRecent,
      selectedRecent ? firstRecent.path : `未打开 ${firstRecent.path}`
    )
    queryPanelReady = await click(win, '[data-testid="topbar-search"]')
      && await waitFor(win, '[data-testid="global-search"]')
  }
  return queryPanelReady
}

/**
 * 清掉本轮自己造出来的项目与目录。
 *
 * 顺序是先摘登记再删目录：`forget` 只动登记表、不碰磁盘，反过来先删目录会在库里
 * 留下一堆指向不存在位置的幽灵项目。
 *
 * 这个函数会 `rm -rf`，所以围栏设两道：目标必须严格落在工作区根**之下**，且目录名
 * 必须带 harness 标记。取不到工作区根就整段跳过 —— 宁可留下残留，也不拿猜出来的
 * 路径去删用户的资料。清理结果只写日志，不计入断言：这是 harness 自己的卫生，
 * 不是产品验收项。
 */
async function cleanupResidue(win: BrowserWindow, log: LogSink): Promise<void> {
  for (const projectId of residueProjects) {
    const forgotten = (await apiDelete(
      win,
      `/api/content/projects/${encodeURIComponent(projectId)}`
    )) as { removed?: boolean; detail?: string } | null
    if (!forgotten?.removed) {
      log(`[workbench] cleanup: 项目登记未摘除 ${projectId} — ${JSON.stringify(forgotten ?? {})}\n`)
    }
  }
  // 端点回的是 { root: 生效值, configured: 用户显式设置值 }，围栏要的是生效值。
  const workspace = (await apiJson(win, '/api/serve/workspace-root')) as { root?: string } | null
  const fence = workspace?.root ? resolve(workspace.root) : ''
  if (!fence) {
    log('[workbench] cleanup: 取不到工作区根，跳过目录清理\n')
    return
  }
  let removed = 0
  for (const directory of residueDirectories) {
    const target = resolve(directory)
    const inside = target !== fence && target.startsWith(`${fence}${sep}`)
    if (!inside || !basename(target).includes(RESIDUE_MARK)) {
      log(`[workbench] cleanup: 拒绝删除 ${target}（不在工作区根下，或不是验收产物）\n`)
      continue
    }
    try {
      rmSync(target, { recursive: true, force: true })
      removed += 1
    } catch (error) {
      log(`[workbench] cleanup: 删除失败 ${target} — ${String(error)}\n`)
    }
  }
  log(
    `[workbench] cleanup: 摘除 ${residueProjects.length} 个项目登记，删除 ${removed}/${residueDirectories.length} 处目录\n`
  )
}

/**
 * 跑完整的工作台产品流程验收。
 *
 * 每一步都是「真实点击 → 回读后端 → 断言」。任一步失败不中断后继步骤，
 * 以便一次跑完拿到完整的失败清单（而不是修一个跑一次）。
 */
export async function runWorkbenchCheck(win: BrowserWindow, log: LogSink): Promise<number> {
  const steps: StepResult[] = []
  const record = (name: string, ok: boolean, detail = ''): void => {
    steps.push({ name, ok, detail })
    log(`[workbench] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}\n`)
  }

  // ---- 固件：先有项目才有资料库 ----
  //
  // 工作区根只是**项目容器**，本身不再登记成项目（proposal 47 §4），所以这里必须先
  // 通过真实界面建一个项目并选中它，否则后面每一步都在一棵不存在的树上跑。
  // 资料与文献直接写进该项目的内置双库：这是"用户在访达里已经有资料"的等价起点。
  // 先确认外壳真的起来了: 后面每一步都点 DOM, 外壳没起来时所有失败都会指向错误的原因。
  let shellReady = await waitFor(win, '[data-testid="activity-projects"]')
  let fixtureCreatedBeforePanel = false
  if (!shellReady) {
    let opened = false
    if (await waitFor(win, '[data-testid="workbench-blank"]')) {
      opened = await click(win, '[data-testid="workbench-blank-create"]')
    } else if (await waitFor(win, '[data-testid="home-overview"]')) {
      opened = await click(
        win,
        '[data-testid="home-project-create-top"], [data-testid="home-project-empty"]'
      )
    } else if (await waitFor(win, '[data-testid="home-surface"]')) {
      const pickerOpened = await click(win, '[data-testid="home-project-picker"]')
      const createReady =
        pickerOpened && (await waitFor(win, '[data-testid="project-menu-create"]'))
      opened = createReady && (await click(win, '[data-testid="project-menu-create"]'))
    }
    if (opened && (await waitFor(win, '[data-testid="project-new-modal"]'))) {
      await fill(win, '#project-name-control', FIXTURE_PROJECT_NAME)
      await click(win, '[data-testid="project-create"]')
      await settle(SETTLE_MS)
      fixtureCreatedBeforePanel = true
      if (await waitFor(win, `[data-testid="home-project-${FIXTURE_PROJECT_NAME}"]`)) {
        await click(win, `[data-testid="home-project-${FIXTURE_PROJECT_NAME}"]`)
      }
      shellReady = await waitFor(win, '[data-testid="activity-resource"]')
    }
  }
  record(
    '工作台外壳就绪（活动栏可见）',
    shellReady,
    shellReady
      ? ''
      : String(
          await win.webContents.executeJavaScript(
            `document.body ? document.body.innerText.slice(0, 200) : 'no body'`
          )
        )
  )
  let projectsReady = fixtureCreatedBeforePanel
  if (!fixtureCreatedBeforePanel) {
    await click(win, '[data-testid="activity-projects"]')
    await settle(SETTLE_MS)
    projectsReady = await waitFor(win, '[data-testid="project-create-name"]')
  }
  record('项目创建入口可用于新建项目', projectsReady)
  if (!projectsReady) {
    log('[workbench] 项目面板未渲染，无法建立固件项目，提前结束\n')
    log('[workbench] result passed=0 failed=1\n')
    return 1
  }
  if (!fixtureCreatedBeforePanel) {
    await fill(win, '[data-testid="project-create-name"]', FIXTURE_PROJECT_NAME)
    await click(win, '[data-testid="project-create-submit"]')
    await settle(SETTLE_MS)
  }
  const fixtureListing = (await apiJson(win, '/api/content/projects')) as
    | { projects: { id: string; name: string; root: string; layout: string }[] }
    | null
  const fixture = fixtureListing?.projects.find((item) => item.name === FIXTURE_PROJECT_NAME)
  record(
    '固件项目已建立（只填名字, 内置双库）',
    Boolean(fixture && fixture.layout === 'managed'),
    fixture ? `${fixture.name} @ ${fixture.root}` : '列表里没有'
  )
  if (fixture) {
    fixtureProjectId = fixture.id
    residueProjects.push(fixture.id)
    residueDirectories.push(fixture.root)
    mkdirSync(join(fixture.root, RESOURCES_DIR, '笔记'), { recursive: true })
    mkdirSync(join(fixture.root, LITERATURE_DIR), { recursive: true })
    writeFileSync(
      join(fixture.root, RESOURCES_DIR, '笔记', 'perovskite.md'),
      '# Perovskite 稳定性\n湿度下 perovskite 器件的失效机理初探。\n',
      'utf-8'
    )
    writeFileSync(
      join(fixture.root, RESOURCES_DIR, '实验数据.csv'),
      'run,rh,pce\n1,45,0.19\n',
      'utf-8'
    )
    writeFileSync(
      join(fixture.root, RESOURCES_DIR, RESTORE_FILE_NAME),
      RESTORE_INITIAL_CONTENT,
      'utf-8'
    )
    for (const [index, name] of RECENT_FILE_FIXTURE_NAMES.entries()) {
      writeFileSync(
        join(fixture.root, RESOURCES_DIR, name),
        `# 最近打开验收 ${index + 1}\n`,
        'utf-8'
      )
    }
    const officeFixture = process.env[OFFICE_FIXTURE_ENV]
    if (officeFixture && existsSync(officeFixture)) {
      copyFileSync(officeFixture, join(fixture.root, RESOURCES_DIR, OFFICE_FIXTURE_NAME))
    }
    const bibliography = join(fixture.root, LITERATURE_DIR, LITERATURE_FIXTURE_NAME)
    const literaturePdf = join(fixture.root, LITERATURE_DIR, LITERATURE_PDF_NAME)
    writeFileSync(bibliography, LITERATURE_FIXTURE, 'utf-8')
    copyFileSync(
      join(dirname(dirname(__dirname)), 'e2e', 'fixtures', 'preview_pdf_1MB.pdf'),
      literaturePdf
    )
    const literatureImport = (await apiPost(win, '/api/literature/import', {
      project: fixture.id,
      source: 'local',
      sources: [bibliography, literaturePdf],
      operation_id: LITERATURE_IMPORT_OPERATION
    })) as { item_ids?: string[] } | null
    literatureFixtureItemId = literatureImport?.item_ids?.[0] ?? ''
    if (literatureFixtureItemId) {
      await apiPostFile(
        win,
        `/api/v1/literatures/${encodeURIComponent(literatureFixtureItemId)}/attachments?primary=false`,
        LITERATURE_MARKDOWN_NAME,
        LITERATURE_MARKDOWN_CONTENT,
        'text/markdown'
      )
    }
    // 选中项目走真实入口: 顶栏项目切换器（与首页项目卡片同一套选中语义）。
    //
    // 新建后要等全局项目表刷新: 管理面板只刷新自己那一份列表, 顶栏/首页读的是
    // 会话元数据那一轮拉回来的 state.projects。这里派发产品自己的刷新事件
    // (等价用户点一次重试), 再轮询等选项出现 —— 不 sleep 一个魔法秒数。
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent('scholarseed:refresh-session-list'))`
    )
    let selected = false
    for (let attempt = 0; attempt < 12 && !selected; attempt += 1) {
      await settle(500)
      await click(win, '[data-testid="topbar-project"]')
      if (await waitFor(win, `[data-testid="project-menu-option-${FIXTURE_PROJECT_NAME}"]`)) {
        selected = await click(win, `[data-testid="project-menu-option-${FIXTURE_PROJECT_NAME}"]`)
      }
    }
    await settle(SETTLE_MS)
    record('顶栏项目切换器可选中新建的项目', selected)
  }

  // 落到资料库视图（选中项目后已在此，但显式点一次，等价于用户点活动栏）。
  await click(win, '[data-testid="activity-resource"]')
  await settle(SETTLE_MS)
  const ready = await waitFor(win, '[data-testid="resource-panel"]')
  record('资料库面板渲染', ready)
  if (!ready) {
    log('[workbench] 资料库面板未渲染，后续步骤无意义，提前结束\n')
    log(`[workbench] result passed=0 failed=1\n`)
    await cleanupResidue(win, log)
    return 1
  }

  const before = await treePaths(win)
  record('读到真实资料树', before.length > 0, `顶层+子层共 ${before.length} 个节点`)

  if (process.env[SEARCH_ONLY_ENV] === ENABLED_ENV_VALUE) {
    const officeSearchQuery = process.env[OFFICE_SEARCH_QUERY_ENV]?.trim() ?? ''
    const searchPanel = await verifyRecentFileSearch(win, record)
    if (searchPanel) {
      await fill(win, '[data-testid="global-search-input"]', MARKDOWN_SEARCH_QUERY)
      await settle(1_500)
      const markdownHit = await clickResourceSearchHit(
        win,
        MARKDOWN_SEARCH_NAME,
        MARKDOWN_SEARCH_QUERY
      )
      record('全局搜索可从 Markdown 正文命中资料', markdownHit)
      const editorReady = markdownHit && await waitFor(win, '[data-testid="monaco-editor"]')
      await settle(SETTLE_MS)
      await clipboard.writeText('')
      if (editorReady) win.webContents.copy()
      await settle(SETTLE_MS)
      const selectedMarkdown = await clipboardText()
      record(
        'Markdown 正文命中点击后定位并选中对应源码',
        editorReady && selectedMarkdown === MARKDOWN_SEARCH_QUERY,
        selectedMarkdown
      )
      const snapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
      mkdirSync(snapshotDir, { recursive: true })
      writeFileSync(
        join(snapshotDir, 'resource-markdown-reveal.png'),
        (await win.webContents.capturePage()).toPNG()
      )
    }
    if (officeSearchQuery) {
      await click(win, '[data-testid="topbar-search"]')
      const officeSearchPanel = await waitFor(win, '[data-testid="global-search"]')
      record('DOCX 定位前可重新打开全局搜索', officeSearchPanel)
      await fill(win, '[data-testid="global-search-input"]', officeSearchQuery)
      await settle(1_500)
      const officeHit = officeSearchPanel && await clickResourceSearchHit(
        win,
        OFFICE_FIXTURE_NAME,
        officeSearchQuery
      )
      record(
        '全局搜索可从 DOCX 正文命中资料',
        Boolean(officeHit),
        officeHit ? OFFICE_FIXTURE_NAME : `未命中 ${officeSearchQuery}`
      )
      const officeReady = officeHit && await waitFor(
        win,
        `iframe[data-testid="office-editor"][title="${OFFICE_FIXTURE_NAME}"][data-document-ready="true"]`,
        OFFICE_REVEAL_TIMEOUT_MS
      )
      const selectionReady = officeReady && await waitFor(
        win,
        '[data-testid="selection-action-host"]'
      )
      record(
        'DOCX 正文命中点击后由 Writer 定位并选中',
        Boolean(officeReady && selectionReady)
      )
      const snapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
      mkdirSync(snapshotDir, { recursive: true })
      writeFileSync(
        join(snapshotDir, 'resource-docx-reveal.png'),
        (await win.webContents.capturePage()).toPNG()
      )
    } else if (!officeSearchQuery) {
      record('全局搜索可从 DOCX 正文命中资料', false, '未提供 DOCX 搜索词')
    }
    const failed = steps.filter((step) => !step.ok).length
    log(`[workbench] result passed=${steps.length - failed} failed=${failed}\n`)
    await cleanupResidue(win, log)
    return failed ? 1 : 0
  }

  // ---- 访达改动 → 界面自动刷新 (proposal 47 阶段三验收: 数秒内反映) ----
  //
  // 必须写进**当前显示的那个项目**的资料库根: 界面上的树是当前项目的投影,
  // 往别的项目里丢文件当然不会出现 —— 那是断言写错了, 不是产品没刷新。
  const currentProject = (await apiJson(win, withProject('/api/content/project'))) as
    | { root?: string; layout?: string }
    | null
  const currentRoot = String(currentProject?.root ?? '')
  if (currentRoot) {
    const resourcesRoot =
      currentProject?.layout === 'managed' ? join(currentRoot, RESOURCES_DIR) : currentRoot
    const externalName = `访达新建-${Date.now()}.md`
    writeFileSync(join(resourcesRoot, externalName), '外部写入', 'utf-8')
    let reflected = false
    for (let attempt = 0; attempt < 16 && !reflected; attempt += 1) {
      await settle(500)
      const rows = (await win.webContents.executeJavaScript(`
        Array.from(document.querySelectorAll('.vds-tree-name')).map((el) => el.textContent || '')
      `)) as string[]
      reflected = rows.some((name) => name.includes(externalName))
    }
    record(
      '在访达里新建的文件数秒内自动出现在界面上 (无需手动刷新)',
      reflected,
      `${externalName} @ ${resourcesRoot}`
    )

    const restorePath = `${RESOURCES_DIR}/${RESTORE_FILE_NAME}`
    const restoreAbsolutePath = join(resourcesRoot, RESTORE_FILE_NAME)
    let restoreFileId = ''
    let restoreInitialRevision = ''
    let restoreHeadVersionId = ''
    let restoreAdmissionAttempted = false
    for (let attempt = 0; attempt < 16 && !restoreFileId; attempt += 1) {
      const capability = (await apiJson(
        win,
        withProject(`/api/resource/capability?path=${encodeURIComponent(restorePath)}`)
      )) as { file_id?: string; disk_revision?: string; version_id?: string } | null
      restoreFileId = String(capability?.file_id ?? '')
      restoreInitialRevision = String(capability?.disk_revision ?? '')
      restoreHeadVersionId = String(capability?.version_id ?? '')
      if (!restoreFileId && restoreInitialRevision && !restoreAdmissionAttempted) {
        restoreAdmissionAttempted = true
        await apiPostVersion(
          win,
          withProject('/api/serve/resources/version-admission'),
          { path: restorePath, expected_disk_revision: restoreInitialRevision }
        )
      }
      if (!restoreFileId) await settle(500)
    }
    writeFileSync(restoreAbsolutePath, RESTORE_LATEST_CONTENT, 'utf-8')
    let restoreLatestRevision = restoreInitialRevision
    let restoreLatestVersionId = restoreHeadVersionId
    let restorePendingRevision: number | null = null
    for (let attempt = 0; attempt < 16 && restoreLatestRevision === restoreInitialRevision; attempt += 1) {
      const capability = (await apiJson(
        win,
        withProject(`/api/resource/capability?path=${encodeURIComponent(restorePath)}`)
      )) as { disk_revision?: string; version_id?: string; pending?: { revision?: number } } | null
      restoreLatestRevision = String(capability?.disk_revision ?? '')
      restoreLatestVersionId = String(capability?.version_id ?? restoreHeadVersionId)
      restorePendingRevision = capability?.pending?.revision ?? null
      if (!restoreLatestRevision || restoreLatestRevision === restoreInitialRevision) await settle(250)
    }
    const restoreV2 = restoreFileId && restoreLatestRevision
      ? await apiPostVersion(
          win,
          withProject(`/api/resource/files/${encodeURIComponent(restoreFileId)}/versions`),
          {
            path: restorePath,
            origin: 'user',
            expected_disk_revision: restoreLatestRevision,
            expected_version_id: restoreLatestVersionId,
            expected_pending_revision: restorePendingRevision
          }
        )
      : null
    const restoreCapability = await apiJson(
      win,
      withProject(`/api/resource/capability?path=${encodeURIComponent(restorePath)}`)
    )
    await waitFor(win, `[data-testid="tree-${restorePath}"]`)
    const restoreTreeReady = await waitFor(win, `[data-testid="tree-${restorePath}"]`)
    const restoreTreeOpened = restoreTreeReady
      && await click(win, `[data-testid="tree-${restorePath}"]`)
    const restoreHistoryReady = restoreTreeOpened
      && await waitFor(win, '[data-testid="document-version-history"]')
    const restoreOpened = Boolean(restoreV2) && restoreHistoryReady
    const restoreHistoryOpened = restoreOpened
      && await click(win, '[data-testid="document-version-history"]')
      && await waitFor(win, '.vds-version-history')
      && await waitFor(win, '.vds-version-row')
    record(
      '恢复验收可从真实文件打开版本历史侧栏',
      Boolean(restoreHistoryOpened),
      JSON.stringify({
        restoreFileId,
        restoreInitialRevision,
        restoreLatestRevision,
        restoreV2,
        restoreCapability,
        restoreTreeReady,
        restoreTreeOpened,
        restoreHistoryReady,
        tabs: await documentTabSnapshot(win, RESTORE_FILE_NAME),
        views: await describeDocumentViews(win)
      })
    )
    if (restoreHistoryOpened) {
      const historySnapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
      mkdirSync(historySnapshotDir, { recursive: true })
      writeFileSync(
        join(historySnapshotDir, 'version-history-management.png'),
        (await win.webContents.capturePage()).toPNG()
      )
      const beforeRestoreTab = await documentTabSnapshot(win, RESTORE_FILE_NAME)
      const restoredInitial = await clickVersionRestore(win, 1)
      const initialState = restoredInitial
        ? await restoredEditorState(win, 3)
        : { text: '', newest: '', rows: 0 }
      const afterInitialTab = await documentTabSnapshot(win, RESTORE_FILE_NAME)
      record(
        '单文件恢复立即同步已打开编辑器与版本历史',
        restoredInitial
          && initialState.text.includes('初始版本')
          && !initialState.text.includes('当前版本')
          && initialState.rows === 3
          && beforeRestoreTab.ids[0] === afterInitialTab.ids[0],
        JSON.stringify(initialState)
      )
      const restoredLatest = await clickVersionRestore(win, 2)
      const latestState = restoredLatest
        ? await restoredEditorState(win, 4)
        : { text: '', newest: '', rows: 0 }
      record(
        '连续恢复仍保留原标签并读取最新磁盘内容',
        restoredLatest && latestState.text.includes('当前版本') && latestState.rows === 4,
        JSON.stringify(latestState)
      )
      const restoreSnapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
      mkdirSync(restoreSnapshotDir, { recursive: true })
      writeFileSync(
        join(restoreSnapshotDir, 'resource-version-restored.png'),
        (await win.webContents.capturePage()).toPNG()
      )
      await click(win, '.vds-sheet__close')
      await win.webContents.executeJavaScript(`
        document.querySelector('.vds-document-tab.is-active button[aria-label^="关闭 "]')?.click()
      `)
      await settle(SETTLE_MS)
    }
  }

  // ---- 新建文件夹：点真按钮 → 就地输入 → 回车 → 回读后端确认落盘 ----
  await click(win, '[data-testid="resource-new-folder"]')
  const folderInput = await waitFor(win, '[data-testid="resource-name-input"]')
  record('新建文件夹弹出就地输入框', folderInput)
  if (folderInput) {
    await fill(win, '[data-testid="resource-name-input"]', NEW_FOLDER_NAME)
    await pressEnter(win, '[data-testid="resource-name-input"]')
    await settle(SETTLE_MS)
    const paths = await treePaths(win)
    record(
      '新建文件夹真实落盘',
      hasNode(paths, NEW_FOLDER_NAME),
      hasNode(paths, NEW_FOLDER_NAME) ? NEW_FOLDER_NAME : `树里没有，现有 ${paths.length} 个节点`
    )
    const notice = await textOf(win, '[data-testid="resource-notice"]')
    record('落盘后给出成功提示', notice.includes('已创建'), notice || '无提示')
  }

  // ---- 新建 Markdown 文档：落盘后只选中，用户点击才打开 ----
  await click(win, '[data-testid="resource-new-doc"]')
  const docInput = await waitFor(win, '[data-testid="resource-name-input"]')
  record('新建文档弹出就地输入框', docInput)
  let docPath = ''
  let versionFileId = ''
  let initialVersionCount = 0
  if (docInput) {
    await fill(win, '[data-testid="resource-name-input"]', NEW_DOC_NAME)
    await pressEnter(win, '[data-testid="resource-name-input"]')
    await settle(SETTLE_MS)
    const paths = await treePaths(win)
    docPath = findNode(paths, `${NEW_DOC_NAME}${'.md'}`)
    record('新建文档真实落盘（自动补 .md）', docPath.endsWith('.md'), docPath || '未找到')
    const markdownTitle = `${NEW_DOC_NAME}.md`
    const initial = docPath
      ? (await apiJson(
          win,
          withProject(`/api/resource/read?path=${encodeURIComponent(docPath)}`)
        )) as { content?: string } | null
      : null
    record(
      '新建 Markdown 首行使用最终主文件名作为一级标题',
      initial?.content?.startsWith(`# ${NEW_DOC_NAME}\n`) === true,
      initial?.content ?? '未读到正文'
    )
    const automaticallyOpened = (await documentTabSnapshot(win, markdownTitle)).count > 0
    record('新建后不自动打开 Markdown', !automaticallyOpened)
    for (let attempt = 0; attempt < 16 && !versionFileId; attempt += 1) {
      const capability = (await apiJson(
        win,
        withProject(`/api/resource/capability?path=${encodeURIComponent(docPath)}`)
      )) as { file_id?: string } | null
      versionFileId = String(capability?.file_id ?? '')
      if (!versionFileId) await settle(500)
    }
    if (versionFileId) {
      const initialHistory = (await apiJson(
        win,
        withProject(`/api/resource/files/${encodeURIComponent(versionFileId)}/versions`)
      )) as { versions?: unknown[] } | null
      initialVersionCount = initialHistory?.versions?.length ?? 0
    }
    record('新文件被后台扫描纳管并创建 v1', Boolean(versionFileId && initialVersionCount === 1))
    const selected = docPath
      ? Boolean(await win.webContents.executeJavaScript(`
          document.querySelector(${JSON.stringify(`[data-testid="tree-${docPath}"]`)})
            ?.classList.contains('is-selected')
        `))
      : false
    record('新建后资料树定位并选中文档', selected, docPath || '未找到新文档')
    if (selected) {
      const snapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
      mkdirSync(snapshotDir, { recursive: true })
      writeFileSync(
        join(snapshotDir, 'resource-created-selected.png'),
        (await win.webContents.capturePage()).toPNG()
      )
    }
    const clicked = docPath
      ? await click(win, `[data-testid="tree-${docPath}"]`)
      : false
    const opened = clicked && await waitFor(win, '[data-testid="markdown-visual-editor"]')
    record(
      '用户点击新文档后打开 Markdown 编辑模式',
      Boolean(opened),
      opened
        ? docPath
        : `clicked=${clicked} views=${await describeDocumentViews(win)}`
    )
  }

  // ---- 同一 Tab 切源码模式 → Monaco 输入 → 保存 → 回读磁盘 ----
  if (docPath) {
    const markdownTitle = `${NEW_DOC_NAME}.md`
    const beforeSource = await documentTabSnapshot(win, markdownTitle)
    const sourceAction = await click(win, '[data-testid="markdown-open-source"]')
    const source = await waitFor(win, '[data-testid="monaco-editor"]')
    const afterSource = await documentTabSnapshot(win, markdownTitle)
    record(
      'Markdown 在同一文件 Tab 内切换源码模式',
      Boolean(sourceAction && source && beforeSource.count === 1 && afterSource.count === 1
        && beforeSource.ids[0] === afterSource.ids[0]),
      `before=${JSON.stringify(beforeSource)} after=${JSON.stringify(afterSource)}`
    )
    if (source) {
      const fileId = versionFileId

      const typed = await typeInputValue(win, '[data-testid="monaco-editor"]', MARKDOWN_BODY)
      await settle(SETTLE_MS)
      const dirtyMarkers = typed ? await tabDirtyMarkers(win, markdownTitle) : 0
      if (dirtyMarkers === 1) {
        const snapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
        mkdirSync(snapshotDir, { recursive: true })
        writeFileSync(
          join(snapshotDir, 'tab-dirty-marker.png'),
          (await win.webContents.capturePage()).toPNG()
        )
      }
      const saved = typed && await clickTwice(win, '[data-testid="markdown-save"]')
      await settle(SETTLE_MS)
      const clearedMarkers = await tabDirtyMarkers(win, markdownTitle)
      record(
        '顶部页签未保存时标红点、保存后清除',
        dirtyMarkers === 1 && saved && clearedMarkers === 0,
        `未保存红点 ${dirtyMarkers} → ${clearedMarkers}`
      )
      const saveState = await win.webContents.executeJavaScript(`
        document.querySelector('[data-save-state]')?.getAttribute('data-save-state') || ''
      `)
      record(
        'Monaco 连续保存合并为一次提交且不产生自身冲突',
        saved && saveState !== 'conflict',
        String(saveState)
      )

      const read = (await apiJson(
        win,
        withProject(`/api/resource/read?path=${encodeURIComponent(docPath)}`)
      )) as { content?: unknown } | null
      const onDisk = typeof read?.content === 'string' ? read.content : ''
      record(
        '编辑内容真实写入磁盘',
        onDisk.includes('真实 UI 点击') && onDisk.includes('| 通道 |'),
        onDisk ? `磁盘内容 ${onDisk.length} 字符` : '磁盘读不到内容'
      )

      if (fileId) {
        const afterOrdinarySave = (await apiJson(
          win,
          withProject(`/api/resource/files/${encodeURIComponent(fileId)}/versions`)
        )) as { versions?: { origin?: string; sequence?: number }[] } | null
        record(
          '用户主动保存直接创建一个文件版本',
          afterOrdinarySave?.versions?.length === initialVersionCount + 1
            && afterOrdinarySave.versions[0]?.origin === 'user',
          `版本数 ${initialVersionCount} → ${afterOrdinarySave?.versions?.length ?? 0}`
        )
        if (fixture) {
          writeFileSync(join(fixture.root, docPath), `${MARKDOWN_BODY}\n\n外部编辑器确认版本。\n`, 'utf-8')
        }
        const driftVisible = await waitFor(
          win,
          '[data-testid="markdown-save"][data-external-change="true"]'
        )
        const externalVersionActions = await win.webContents.executeJavaScript(`(() => {
          const saveState = document.querySelector('[data-save-state]')
          const save = document.querySelector('[data-testid="markdown-save"]')
          const histories = [...document.querySelectorAll('[data-testid="document-version-history"]')]
          const editorSwitch = document.querySelector('[data-testid="markdown-open-editor"]')
          return {
            historyCount: histories.length,
            historyFollowsEditorSwitch: Boolean(
              editorSwitch && histories[0]
              && editorSwitch.compareDocumentPosition(histories[0]) & Node.DOCUMENT_POSITION_FOLLOWING
            ),
            saveState: saveState?.getAttribute('data-save-state') || '',
            saveDisabled: save?.matches(':disabled') ?? true,
            saveLabel: save?.getAttribute('aria-label') || '',
            saveHasDirtyDot: Boolean(document.querySelector('[data-testid="markdown-save-dirty"]'))
          }
        })()`)
        record(
          '外部修改收敛到唯一历史入口与带红点的保存操作',
          Boolean(
            driftVisible
            && externalVersionActions.historyCount === 1
            && externalVersionActions.historyFollowsEditorSwitch
            && externalVersionActions.saveState !== 'dirty'
            && externalVersionActions.saveDisabled === false
            && externalVersionActions.saveLabel === '保存'
            && externalVersionActions.saveHasDirtyDot
          ),
          JSON.stringify(externalVersionActions)
        )
        if (driftVisible) {
          const snapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
          mkdirSync(snapshotDir, { recursive: true })
          writeFileSync(
            join(snapshotDir, 'external-version-actions.png'),
            (await win.webContents.capturePage()).toPNG()
          )
        }
        const sealed = driftVisible && await click(win, '[data-testid="markdown-save"]')
        const sealSettled = sealed && await waitForMissing(
          win,
          '[data-testid="markdown-save"][data-external-change="true"]'
        )
        const afterExplicitSave = (await apiJson(
          win,
          withProject(`/api/resource/files/${encodeURIComponent(fileId)}/versions`)
        )) as { versions?: { origin?: string; sequence?: number }[] } | null
        record(
          '外部修改通过保存操作追加版本',
          Boolean(
            sealSettled &&
            afterExplicitSave?.versions?.length === initialVersionCount + 2 &&
            afterExplicitSave?.versions?.[0]?.origin === 'external_confirmed'
          ),
          JSON.stringify(afterExplicitSave?.versions?.[0] ?? {})
        )
        const historyOpened = await click(win, '[data-testid="document-version-history"]')
        const historyVisible = historyOpened && await waitFor(win, '.vds-version-history')
        record('版本历史侧栏可从文件工具栏打开', Boolean(historyVisible))
        if (historyVisible) {
          await waitFor(win, '.vds-version-row')
          const historyText = await textOf(win, '.vds-version-history')
          record(
            '版本历史显示紧凑筛选与版本来源',
            historyText.includes('外部修改')
              && historyText.includes('全部来源')
              && historyText.includes('最新优先')
              && !historyText.includes('历史 Agent 交付'),
            historyText.slice(0, 160)
          )
          await click(win, '.vds-sheet__close')
        }

        if (fixture) {
          const intendedMemoryContent = `${MARKDOWN_BODY}\n\n${CONFLICT_MEMORY_SUFFIX}\n`
          const diskContent = `${MARKDOWN_BODY}\n\n${CONFLICT_DISK_SUFFIX}\n`
          const memoryChanged = await typeInputValue(
            win,
            '[data-testid="monaco-editor"]',
            intendedMemoryContent
          )
          writeFileSync(join(fixture.root, docPath), diskContent, 'utf-8')
          const conflictVisible = memoryChanged && await waitFor(
            win,
            '[data-testid="document-save-conflict"]'
          )
          const copied = conflictVisible && await click(
            win,
            '[data-testid="document-conflict-copy"]'
          )
          let copiedPath = ''
          let copiedFileId = ''
          for (let attempt = 0; attempt < 16 && !copiedFileId; attempt += 1) {
            await settle(500)
            const paths = await treePaths(win)
            copiedPath = paths.find((path) => (
              path !== docPath
              && path.endsWith('.md')
              && basename(path).startsWith(NEW_DOC_NAME)
            )) ?? ''
            if (copiedPath) {
              const capability = (await apiJson(
                win,
                withProject(`/api/resource/capability?path=${encodeURIComponent(copiedPath)}`)
              )) as { file_id?: string } | null
              copiedFileId = String(capability?.file_id ?? '')
            }
          }
          const originalAfterConflict = (await apiJson(
            win,
            withProject(`/api/resource/read?path=${encodeURIComponent(docPath)}`)
          )) as { content?: unknown } | null
          const copyAfterConflict = copiedPath
            ? (await apiJson(
                win,
                withProject(`/api/resource/read?path=${encodeURIComponent(copiedPath)}`)
              )) as { content?: unknown } | null
            : null
          const copiedHistory = copiedFileId
            ? (await apiJson(
                win,
                withProject(`/api/resource/files/${encodeURIComponent(copiedFileId)}/versions`)
              )) as { versions?: { sequence?: number }[] } | null
            : null
          record(
            '内存与磁盘同时修改时另存为受管文件并保留双方完整内容',
            Boolean(
              copied
              && copiedPath
              && originalAfterConflict?.content === diskContent
              && typeof copyAfterConflict?.content === 'string'
              && copyAfterConflict.content.includes(CONFLICT_MEMORY_SUFFIX)
              && !copyAfterConflict.content.includes(CONFLICT_DISK_SUFFIX)
              && copiedHistory?.versions?.length === 1
              && copiedHistory.versions[0]?.sequence === 1
            ),
            JSON.stringify({
              copied,
              copiedPath,
              original: originalAfterConflict?.content,
              copy: copyAfterConflict?.content,
              history: copiedHistory?.versions
            })
          )
        }
      }
    }

    // ---- 同一 Tab 切编辑模式：共享内容并产出可直接编辑的结构化 DOM ----
    const editorAction = await click(win, '[data-testid="markdown-open-editor"]')
    const rendered = await waitFor(win, '[data-testid="markdown-visual-editor"] .ProseMirror')
    const afterEditor = await documentTabSnapshot(win, markdownTitle)
    record(
      'Markdown 源码与编辑模式不增加文件 Tab',
      Boolean(editorAction && rendered && afterEditor.count === 1 && afterEditor.ids[0] === beforeSource.ids[0]),
      JSON.stringify(afterEditor)
    )
    if (rendered) {
      const shape = await win.webContents.executeJavaScript(`
        (() => {
          const root = document.querySelector('[data-testid="markdown-visual-editor"] .ProseMirror')
          if (!root) return null
          return {
            h1: root.querySelectorAll('h1').length,
            strong: root.querySelectorAll('strong').length,
            table: root.querySelectorAll('table').length,
            th: root.querySelectorAll('th').length
          }
        })()
      `)
      const s = shape as { h1: number; strong: number; table: number; th: number } | null
      record(
        '所见即所得编辑器产出真实 DOM（标题/粗体/表格）',
        Boolean(s && s.h1 === 2 && s.strong === 1 && s.table >= 1 && s.th === 2),
        s ? `h1=${s.h1} strong=${s.strong} table=${s.table} th=${s.th}` : '取不到结构'
      )

      const snapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
      mkdirSync(snapshotDir, { recursive: true })
      writeFileSync(
        join(snapshotDir, 'markdown-editor.png'),
        (await win.webContents.capturePage()).toPNG()
      )

      const clipboardBeforeCodeCopy = await clipboardText()
      await clipboard.writeText('')
      const codeCopyClicked = await click(win, '.milkdown-code-block .copy-button')
      await settle(SETTLE_MS)
      const copiedCode = await clipboardText()
      record(
        'Markdown 代码块复制写入真实系统剪贴板',
        codeCopyClicked && copiedCode === MARKDOWN_CODE_COPY_TEXT,
        copiedCode
      )
      await clipboard.writeText(clipboardBeforeCodeCopy)
      if (codeCopyClicked) {
        writeFileSync(
          join(snapshotDir, 'markdown-code-copy.png'),
          (await win.webContents.capturePage()).toPNG()
        )
      }

      const slashTyped = await typeMarkdownSlash(win)
      const slashMenu = slashTyped && await waitFor(win, '.milkdown-slash-menu[data-show="true"]')
      const slashText = slashMenu ? await textOf(win, '.milkdown-slash-menu[data-show="true"]') : ''
      record(
        '输入 / 可唤起完整 Markdown 基础命令菜单',
        slashMenu && slashText.includes('一级标题 H1') && slashText.includes('公式') && slashText.includes('代码块'),
        slashMenu ? slashText.slice(0, 160) : '斜杠菜单未出现'
      )
      if (slashMenu) {
        writeFileSync(
          join(snapshotDir, 'markdown-slash-menu.png'),
          (await win.webContents.capturePage()).toPNG()
        )
      }
    }

    // ---- 动态分栏：右键 Tab → 菜单不透明 → 拆分并移动 ----
    const activeTab = '.vds-navigation-tabs [role="tab"][aria-selected="true"]'
    const contextOpened = await openContextMenu(win, activeTab)
    const tabMenu = contextOpened && await waitFor(win, '[data-testid="document-tab-menu"]')
    record('Tab 右键菜单可打开', Boolean(tabMenu))
    if (tabMenu) {
      const background = await win.webContents.executeJavaScript(`
        getComputedStyle(document.querySelector('[data-testid="document-tab-menu"]')).backgroundColor
      `)
      record(
        'Tab 右键菜单有不透明底色',
        typeof background === 'string' && background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent',
        String(background)
      )
      await click(win, '[data-testid="tab-split-right"]')
      await settle(SETTLE_MS)
      const leaves = await win.webContents.executeJavaScript(
        `document.querySelectorAll('.vds-dock-leaf').length`
      )
      record('同一 Markdown 会话向右拆分出第二个投影视图', Number(leaves) === 2, `leaf=${leaves}`)
    }

    // ---- 活动 leaf：点左栏后新建文件必须只进左栏 ----
    const focusedLeft = await win.webContents.executeJavaScript(`
      (() => {
        const leaf = document.querySelectorAll('.vds-dock-leaf')[0]
        if (!(leaf instanceof HTMLElement)) return false
        leaf.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
        return true
      })()
    `)
    await click(win, '[data-testid="resource-new-doc"]')
    const splitInput = await waitFor(win, '[data-testid="resource-name-input"]')
    if (splitInput) {
      await fill(win, '[data-testid="resource-name-input"]', SPLIT_DOC_NAME)
      await pressEnter(win, '[data-testid="resource-name-input"]')
      await settle(SETTLE_MS)
    }
    const splitDocPath = findNode(await treePaths(win), `${SPLIT_DOC_NAME}.md`)
    const splitOpened = splitDocPath
      ? await click(win, `[data-testid="tree-${splitDocPath}"]`)
      : false
    if (splitOpened) await waitFor(win, `[data-testid^="document-tab-"]`)
    const openedInLeft = await win.webContents.executeJavaScript(`
      (() => {
        const left = document.querySelectorAll('.vds-dock-leaf')[0]
        return Boolean(left && left.textContent?.includes(${JSON.stringify(SPLIT_DOC_NAME)}))
      })()
    `)
    record(
      '新文件打开到最近聚焦的分栏',
      Boolean(focusedLeft && splitInput && splitOpened && openedInLeft)
    )

    // ---- 拖放：把新文件 Tab 从左 leaf 拖到右 leaf 中央 ----
    const dragged = await dragTabToLeaf(win, SPLIT_DOC_NAME, 1)
    await settle(SETTLE_MS)
    const movedToRight = await win.webContents.executeJavaScript(`
      (() => {
        const right = document.querySelectorAll('.vds-dock-leaf')[1]
        return Boolean(right && right.textContent?.includes(${JSON.stringify(SPLIT_DOC_NAME)}))
      })()
    `)
    record('上方文件 Tab 可拖放到另一个分栏', Boolean(dragged && movedToRight))

    // ---- 同栏排序：拖到目标标签前，先检查插入指示，再检查 DOM 顺序 ----
    const reorderTargetTitle = `${NEW_DOC_NAME}.md`
    const reorderStarted = movedToRight
      && await beginTabReorder(win, `${SPLIT_DOC_NAME}.md`, reorderTargetTitle, 'before')
    await settle(WAIT_POLL_MS)
    const insertionVisible = reorderStarted && await win.webContents.executeJavaScript(`
      (() => {
        const target = Array.from(document.querySelectorAll(${JSON.stringify(DOCUMENT_TAB_SELECTOR)}))
          .find((tab) => tab.querySelector('span')?.textContent === ${JSON.stringify(reorderTargetTitle)}
            && tab.getAttribute('data-drop-insertion') === 'before')
        if (!(target instanceof HTMLElement)) return false
        const marker = getComputedStyle(target, '::before')
        return marker.content !== 'none' && Number.parseFloat(marker.width) > 0
      })()
    `)
    record('同栏标签拖拽显示插入位置指示', Boolean(insertionVisible))
    if (insertionVisible) {
      const snapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
      mkdirSync(snapshotDir, { recursive: true })
      writeFileSync(join(snapshotDir, 'document-tab-reorder.png'), (await win.webContents.capturePage()).toPNG())
    }
    const reorderFinished = reorderStarted && await finishTabReorder(win)
    await settle(SETTLE_MS)
    const reordered = reorderFinished && await win.webContents.executeJavaScript(`
      (() => {
        const tabs = Array.from(document.querySelectorAll(${JSON.stringify(DOCUMENT_TAB_SELECTOR)}))
        const source = tabs.find((tab) => tab.querySelector('span')?.textContent === ${JSON.stringify(`${SPLIT_DOC_NAME}.md`)})
        const target = tabs.find((tab) => tab.querySelector('span')?.textContent === ${JSON.stringify(reorderTargetTitle)}
          && tab.parentElement === source?.parentElement)
        if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement) || !source.parentElement) return false
        const titles = Array.from(source.parentElement.querySelectorAll(${JSON.stringify(`${DOCUMENT_TAB_SELECTOR} span`)})).map((node) => node.textContent)
        return titles.indexOf(${JSON.stringify(`${SPLIT_DOC_NAME}.md`)})
          < titles.indexOf(${JSON.stringify(reorderTargetTitle)})
      })()
    `)
    record('上方文件 Tab 可拖到同栏另一标签前完成排序', Boolean(reordered))

    // ---- 标签右键菜单：新增动作可见，复制动作回读真实系统剪贴板 ----
    const tabContextOpened = await openTabContextMenu(win, `${SPLIT_DOC_NAME}.md`)
    const tabContextReady = tabContextOpened && await waitFor(win, '[data-testid="document-tab-menu"]')
    const tabActionsVisible = tabContextReady && await win.webContents.executeJavaScript(`
      ['tab-add-to-conversation', 'tab-copy-name', 'tab-copy-absolute-path', 'tab-reveal-in-finder']
        .every((id) => Boolean(document.querySelector('[data-testid="' + id + '"]')))
    `)
    record('文件 Tab 右键菜单包含加入对话、复制和访达动作', Boolean(tabActionsVisible))
    const layoutActions = tabContextReady && await win.webContents.executeJavaScript(`
      Array.from(document.querySelectorAll('[data-testid="document-tab-menu"] [data-testid^="tab-split-"], [data-testid="document-tab-menu"] [data-testid^="tab-move-"]'))
        .map((item) => item.getAttribute('data-testid'))
    `) as string[] | false
    record(
      '右栏菜单先列拆分、再列唯一相邻移动目标',
      Array.isArray(layoutActions)
        && JSON.stringify(layoutActions) === JSON.stringify(['tab-split-down', 'tab-move-left']),
      JSON.stringify(layoutActions)
    )
    if (tabContextReady) {
      await clipboard.writeText('')
      await click(win, '[data-testid="tab-copy-name"]')
      await settle(SETTLE_MS)
      const copiedName = await clipboardText()
      record('文件 Tab 可复制文件名', copiedName === `${SPLIT_DOC_NAME}.md`, copiedName)
    }
    const pathContextOpened = await openTabContextMenu(win, `${SPLIT_DOC_NAME}.md`)
    const pathContextReady = pathContextOpened && await waitFor(win, '[data-testid="document-tab-menu"]')
    if (pathContextReady) {
      await clipboard.writeText('')
      await click(win, '[data-testid="tab-copy-absolute-path"]')
      await settle(SETTLE_MS)
      const copiedPath = await clipboardText()
      record(
        '文件 Tab 可复制绝对路径',
        copiedPath.startsWith('/') && copiedPath.endsWith(`${SPLIT_DOC_NAME}.md`),
        copiedPath
      )
    }
    const conversationContextOpened = await openTabContextMenu(win, `${SPLIT_DOC_NAME}.md`)
    const conversationContextReady = conversationContextOpened
      && await waitFor(win, '[data-testid="document-tab-menu"]')
    const conversationAdded = conversationContextReady
      && await click(win, '[data-testid="tab-add-to-conversation"]')
    const aiPanelOpened = conversationAdded && await waitFor(win, '[data-testid="ai-panel"]')
    const contextAttached = aiPanelOpened && await win.webContents.executeJavaScript(`
      Array.from(document.querySelectorAll('.vds-ai-chip'))
        .some((chip) => chip.textContent?.includes(${JSON.stringify(`${SPLIT_DOC_NAME}.md`)}))
    `)
    record('文件 Tab 可加入当前对话', Boolean(contextAttached))

    const finderContextOpened = await openTabContextMenu(win, `${SPLIT_DOC_NAME}.md`)
    const finderContextReady = finderContextOpened && await waitFor(win, '[data-testid="document-tab-menu"]')
    const finderInvoked = finderContextReady && await click(win, '[data-testid="tab-reveal-in-finder"]')
    await settle(SETTLE_MS)
    const revealNotice = await textOf(win, '[data-testid="resource-notice"]')
    record(
      '文件 Tab 可调用访达定位',
      Boolean(finderInvoked) && !revealNotice.includes('无法在访达中打开'),
      revealNotice
    )

    // ---- 三栏 T 形：完整左栏必须明确列出右上、右下两个真实目标 ----
    const splitContextOpened = await openTabContextMenu(win, `${SPLIT_DOC_NAME}.md`)
    const splitContextReady = splitContextOpened && await waitFor(win, '[data-testid="document-tab-menu"]')
    const splitDown = splitContextReady && await click(win, '[data-testid="tab-split-down"]')
    await settle(SETTLE_MS)
    const threeLeaves = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.vds-dock-leaf').length`
    )
    const leftContextOpened = splitDown && Number(threeLeaves) === 3
      && await openTabContextMenu(win, markdownTitle)
    const leftContextReady = leftContextOpened && await waitFor(win, '[data-testid="document-tab-menu"]')
    const tLayoutActions = leftContextReady && await win.webContents.executeJavaScript(`
      Array.from(document.querySelectorAll('[data-testid="document-tab-menu"] [data-testid^="tab-split-"], [data-testid="document-tab-menu"] [data-testid^="tab-move-"]'))
        .map((item) => item.getAttribute('data-testid'))
    `) as string[] | false
    record(
      'T 形左栏菜单先列拆分，再明确列出右上和右下',
      Array.isArray(tLayoutActions)
        && JSON.stringify(tLayoutActions) === JSON.stringify([
          'tab-split-down',
          'tab-move-right-top',
          'tab-move-right-bottom'
        ]),
      JSON.stringify(tLayoutActions)
    )
    if (leftContextReady) {
      const snapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
      mkdirSync(snapshotDir, { recursive: true })
      writeFileSync(join(snapshotDir, 'document-tab-t-menu.png'), (await win.webContents.capturePage()).toPNG())
    }
    if (leftContextReady) await click(win, '.vds-menu-veil')
    const collapsedThreePane = await win.webContents.executeJavaScript(`
      (() => {
        const leaves = Array.from(document.querySelectorAll('.vds-dock-leaf'))
        const bottomRight = leaves.at(-1)
        const close = bottomRight?.querySelector(${JSON.stringify(`${DOCUMENT_TAB_SELECTOR} button[aria-label]`)})
        if (!(close instanceof HTMLElement)) return false
        close.click()
        return true
      })()
    `)
    await settle(SETTLE_MS)
    record(
      'T 形菜单验收后可关闭新增投影并恢复双栏',
      Boolean(collapsedThreePane)
        && Number(await win.webContents.executeJavaScript(`document.querySelectorAll('.vds-dock-leaf').length`)) === 2
    )
  }

  // ---- Office：真实 DOCX 覆盖层级、纵向拆分和 iframe/Qt resize 协议 ----
  const officeFixture = process.env[OFFICE_FIXTURE_ENV]
  const officePath = findNode(await treePaths(win), OFFICE_FIXTURE_NAME)
  if (officeFixture && officePath) {
    await click(win, `[data-testid="tree-${officePath}"]`)
    const officeFrame = await waitFor(win, 'iframe[data-testid="office-editor"]')
    const shellModeSwitcher = await win.webContents.executeJavaScript(`
      Boolean(document.querySelector('[data-testid="document-preview"], [data-testid="document-edit"]'))
    `)
    record('真实 Office 文档不显示工作台模式切换', officeFrame && !shellModeSwitcher)
    const officeStatus = officeFrame && await win.webContents.executeJavaScript(`
      (() => Array.from(document.querySelectorAll('iframe[data-testid="office-editor"]')).map((frame) => ({
        slot: frame.dataset.runtimeSlot,
        runtimeReady: frame.dataset.runtimeReady,
        documentReady: frame.dataset.documentReady,
        visibility: getComputedStyle(frame).visibility,
        status: frame.contentDocument?.querySelector('#status')?.textContent || ''
      })))()
    `) as { documentReady: string; visibility: string; status: string }[] | false
    const officeEnteredRuntime = Boolean(officeStatus && officeStatus.some((item) => (
      item.documentReady === 'true'
      || (item.visibility === 'visible' && item.status === OFFICE_FONT_PERMISSION_STATUS)
    )))
    record(
      '真实 Office 文件进入运行时（无授权环境停在原生字体授权）',
      officeEnteredRuntime,
      `${officePath} ${JSON.stringify(officeStatus)}`
    )
    if (officeEnteredRuntime) {
      const officeBoundary = await win.webContents.executeJavaScript(`
        (() => {
          const frame = Array.from(document.querySelectorAll('iframe[data-testid="office-editor"]'))
            .find((node) => node instanceof HTMLElement && getComputedStyle(node).visibility === 'visible')
          const anchor = Array.from(document.querySelectorAll('.vds-office-anchor'))
            .find((node) => node instanceof HTMLElement && node.offsetParent !== null)
          const pane = anchor?.closest('.vds-workbench-pane')
          if (!(frame instanceof HTMLElement) || !(anchor instanceof HTMLElement) || !(pane instanceof HTMLElement)) return null
          const frameRect = frame.getBoundingClientRect()
          const anchorRect = anchor.getBoundingClientRect()
          const paneRect = pane.getBoundingClientRect()
          const contained = (outer, inner) => inner.left >= outer.left - 1 && inner.top >= outer.top - 1
            && inner.right <= outer.right + 1 && inner.bottom <= outer.bottom + 1
          return {
            frame: { left: frameRect.left, top: frameRect.top, right: frameRect.right, bottom: frameRect.bottom },
            anchor: { left: anchorRect.left, top: anchorRect.top, right: anchorRect.right, bottom: anchorRect.bottom },
            pane: { left: paneRect.left, top: paneRect.top, right: paneRect.right, bottom: paneRect.bottom },
            inAnchor: contained(anchorRect, frameRect),
            inPane: contained(paneRect, frameRect)
          }
        })()
      `) as { inAnchor: boolean; inPane: boolean } | null
      record(
        'Office iframe 只占所属工作栏内容区域',
        Boolean(officeBoundary?.inAnchor && officeBoundary.inPane),
        JSON.stringify(officeBoundary)
      )

      const chromeTopmost = await win.webContents.executeJavaScript(`
        (() => ['.vds-activity-rail', '.vds-module-panel', '.vds-document-tabs'].every((selector) => {
          const element = document.querySelector(selector)
          if (!(element instanceof HTMLElement)) return false
          const rect = element.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.left + Math.min(rect.width / 2, 12), rect.top + Math.min(rect.height / 2, 12))
          return hit === element || Boolean(hit?.closest(selector) === element)
        }))()
      `)
      record('Office 打开时活动栏、左侧栏和 Tab 栏保持在 iframe 上方', Boolean(chromeTopmost))

      const officeTreeMenuPath = findNode(await treePaths(win), NEW_FOLDER_NAME)
      const treeMenuOpened = Boolean(officeTreeMenuPath)
        && await click(win, `[data-testid="tree-more-${officeTreeMenuPath}"]`)
      const treeMenuVisible = treeMenuOpened && await waitFor(win, '[data-testid="resource-node-menu"]')
      const treeMenuTopmost = treeMenuVisible && await win.webContents.executeJavaScript(`
        (() => {
          const menu = document.querySelector('[data-testid="resource-node-menu"]')
          if (!(menu instanceof HTMLElement)) return false
          const rect = menu.getBoundingClientRect()
          return document.elementFromPoint(rect.left + 12, rect.top + 12)?.closest('[data-testid="resource-node-menu"]') === menu
        })()
      `)
      record('Office 打开时资料树菜单显示在 iframe 上方', Boolean(treeMenuTopmost))
      if (treeMenuVisible) await click(win, '.vds-menu-veil')

      await click(win, '[data-testid="resource-import"]')
      const modalVisible = await waitFor(win, '[data-testid="resource-import-dialog"] .vds-modal')
      const modalOverlay = modalVisible && await win.webContents.executeJavaScript(`
        (() => {
          const modal = document.querySelector('[data-testid="resource-import-dialog"] .vds-modal')
          if (!(modal instanceof HTMLElement)) return false
          const rect = modal.getBoundingClientRect()
          return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('.vds-modal') === modal
        })()
      `)
      record('Office 上方的弹窗不被 iframe 遮挡', Boolean(modalOverlay))
      if (modalVisible) await click(win, '[data-testid="resource-import-dialog"] .vds-modal-close')

      const contextOpened = await openTabContextMenu(win, OFFICE_FIXTURE_NAME)
      const menuVisible = contextOpened && await waitFor(win, '[data-testid="document-tab-menu"]')
      const overlay = menuVisible && await win.webContents.executeJavaScript(`
        (() => {
          const menu = document.querySelector('[data-testid="document-tab-menu"]')
          if (!(menu instanceof HTMLElement)) return false
          const rect = menu.getBoundingClientRect()
          return document.elementFromPoint(rect.left + 12, rect.top + 12)?.closest('[data-testid="document-tab-menu"]') === menu
        })()
      `)
      record('Office 上方的 Tab 菜单不被 iframe 遮挡', Boolean(overlay))
      const officeLayoutActions = menuVisible && await win.webContents.executeJavaScript(`
        Array.from(document.querySelectorAll(
          '[data-testid="document-tab-menu"] [data-testid^="tab-split-"], [data-testid="document-tab-menu"] [data-testid^="tab-move-"]'
        )).map((node) => node.getAttribute('data-testid'))
      `) as string[] | false
      record(
        'Office Tab 菜单不提供拆分或移动操作',
        Array.isArray(officeLayoutActions) && officeLayoutActions.length === 0,
        JSON.stringify(officeLayoutActions)
      )
      if (menuVisible) await click(win, '.vds-menu-veil')
      await settle(SETTLE_MS)
      const geometry = await win.webContents.executeJavaScript(`
        (() => {
          const anchors = Array.from(document.querySelectorAll('.vds-office-anchor'))
            .filter((node) => node instanceof HTMLElement && node.offsetParent !== null)
          const frames = Array.from(document.querySelectorAll('iframe[data-testid="office-editor"]'))
            .filter((node) => node instanceof HTMLElement && getComputedStyle(node).visibility === 'visible')
          const sizes = anchors.map((anchor) => {
            const rect = anchor.getBoundingClientRect()
            const frame = frames.find((candidate) => {
              const box = candidate.getBoundingClientRect()
              return Math.abs(box.left - rect.left) <= 1 && Math.abs(box.top - rect.top) <= 1
            })
            const box = frame?.getBoundingClientRect()
            return { height: rect.height, match: Boolean(box && Math.abs(box.height - rect.height) <= 1) }
          })
          return { anchors: anchors.length, frames: frames.length, sizes }
        })()
      `) as { anchors: number; frames: number; sizes: { height: number; match: boolean }[] }
      record(
        'Office 始终只占用一个工作栏和一个 Runtime iframe',
        geometry.anchors === 1 && geometry.frames === 1
          && geometry.sizes.every((size) => size.height >= 160 && size.match),
        JSON.stringify(geometry)
      )
      const snapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
      mkdirSync(snapshotDir, { recursive: true })
      writeFileSync(join(snapshotDir, 'office-single-runtime.png'), (await win.webContents.capturePage()).toPNG())

      const dragStarted = await beginTabDrag(win, SPLIT_DOC_NAME, 0)
      const dragPreview = dragStarted && await waitFor(win, '.vds-dock-drop-preview')
      const dragLayer = dragPreview ? await win.webContents.executeJavaScript(`
        (() => {
          const preview = document.querySelector('.vds-dock-drop-preview')
          const runtime = document.querySelector('.vds-office-runtime-layer')
          if (!(preview instanceof HTMLElement) || !(runtime instanceof HTMLElement)) return null
          const rect = preview.getBoundingClientRect()
          return {
            visible: rect.width > 0 && rect.height > 0,
            previewZ: Number(getComputedStyle(preview).zIndex),
            runtimeZ: Number(getComputedStyle(runtime).zIndex)
          }
        })()
      `) as { visible: boolean; previewZ: number; runtimeZ: number } | null : null
      record(
        'Office 打开时拖拽预览显示在 iframe 上方',
        Boolean(dragLayer?.visible && dragLayer.previewZ > dragLayer.runtimeZ),
        JSON.stringify(dragLayer)
      )
      await finishTabDrag(win, SPLIT_DOC_NAME)

      const markdownTitle = `${NEW_DOC_NAME}.md`
      const markdownProjectionCount = (await documentTabSnapshot(win, markdownTitle)).count
      if (markdownProjectionCount > 1) {
        await closeDocumentTab(win, markdownTitle)
        await settle(SETTLE_MS)
      }
      const closeRequested = await closeDocumentTab(win, markdownTitle)
      const closeDialogVisible = closeRequested && await waitFor(win, '[data-testid="document-close-dialog"]')
      const closeDialog = closeDialogVisible ? await win.webContents.executeJavaScript(`
        (() => {
          const dialog = document.querySelector('[data-testid="document-close-dialog"]')
          if (!(dialog instanceof HTMLElement)) return null
          const rect = dialog.getBoundingClientRect()
          const color = getComputedStyle(dialog).backgroundColor
          const channels = color.match(/[\\d.]+/g)?.map(Number) || []
          const alpha = channels.length >= 4 ? channels[3] : 1
          return {
            alpha,
            color,
            topmost: document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('[data-testid="document-close-dialog"]') === dialog,
            actions: ['document-close-save', 'document-close-discard', 'document-close-cancel']
              .every((testId) => Boolean(dialog.querySelector('[data-testid="' + testId + '"]')))
          }
        })()
      `) as { alpha: number; color: string; topmost: boolean; actions: boolean } | null : null
      record(
        '关闭未保存确认框为不透明设计系统面板且位于 Office 上方',
        Boolean(closeDialog?.alpha === 1 && closeDialog.topmost && closeDialog.actions),
        JSON.stringify(closeDialog)
      )
      writeFileSync(join(snapshotDir, 'office-all-overlays.png'), (await win.webContents.capturePage()).toPNG())
      if (closeDialogVisible) {
        await click(win, '[data-testid="document-close-save"]')
        await settle(SETTLE_MS)
        const savedAndClosed = (await documentTabSnapshot(win, markdownTitle)).count === 0
        record('关闭确认框的保存并关闭动作提交 dirty 文档并关闭 Tab', savedAndClosed)
      }
    }
  }

  // ---- 重命名：右键菜单 → 重命名 → 回读确认旧名消失新名出现 ----
  // testid 用的是节点的完整相对路径 (`tree-more-resources/UI验收目录`), 不是名字 ——
  // MANAGED 项目的路径带 `resources/` 前缀, 拿名字拼选择器会点不到。
  const folderPath = findNode(await treePaths(win), NEW_FOLDER_NAME)
  const menuOpened = await click(win, `[data-testid="tree-more-${folderPath}"]`)
  const menuVisible = menuOpened && (await waitFor(win, '[data-testid="resource-node-menu"]'))
  record('树行「更多操作」打开右键菜单', Boolean(menuVisible))
  if (menuVisible) {
    const items = await textOf(win, '[data-testid="resource-node-menu"]')
    record(
      '菜单含六项资料管理动作',
      ['重命名', '移动到', '创建副本', '在访达中打开', '复制路径', '删除'].every((k) =>
        items.includes(k)
      ),
      items.replace(/\n/g, ' / ')
    )
    await click(win, '[data-testid="menu-rename"]')
    const renameInput = await waitFor(win, '[data-testid="resource-name-input"]')
    if (renameInput) {
      await fill(win, '[data-testid="resource-name-input"]', RENAMED_FOLDER_NAME)
      await pressEnter(win, '[data-testid="resource-name-input"]')
      await settle(SETTLE_MS)
      const paths = await treePaths(win)
      record(
        '重命名真实生效（旧名消失/新名出现）',
        hasNode(paths, RENAMED_FOLDER_NAME) && !hasNode(paths, NEW_FOLDER_NAME),
        `新名在=${hasNode(paths, RENAMED_FOLDER_NAME)} 旧名在=${hasNode(paths, NEW_FOLDER_NAME)}`
      )
      if (docPath.startsWith(`${folderPath}/`)) {
        const renamedFolderPath = findNode(paths, RENAMED_FOLDER_NAME)
        docPath = `${renamedFolderPath}${docPath.slice(folderPath.length)}`
      }
    } else {
      record('重命名真实生效（旧名消失/新名出现）', false, '重命名输入框未出现')
    }
  }

  // ---- 资料搜索：输入关键词 → 断言命中来源被标注 ----
  await fill(win, '[data-testid="resource-search"]', 'UI验收')
  await settle(1_200)
  const hitCount = await win.webContents.executeJavaScript(
    `document.querySelectorAll('[data-testid^="hit-"]').length`
  )
  record('资料搜索返回真实命中', Number(hitCount) > 0, `命中 ${hitCount} 条`)
  await fill(win, '[data-testid="resource-search"]', '')
  await settle(SETTLE_MS)

  // ---- 创建副本（PRD「复制文件或文件夹」）：断言原件保留 + 避让副本出现 ----
  const copyMenu =
    (await click(
      win,
      `[data-testid="tree-more-${findNode(await treePaths(win), RENAMED_FOLDER_NAME)}"]`
    )) &&
    (await waitFor(win, '[data-testid="resource-node-menu"]'))
  if (copyMenu) {
    await click(win, '[data-testid="menu-copy"]')
    await settle(SETTLE_MS)
    const paths = await treePaths(win)
    const copies = paths.filter((p) => (p.split('/').pop() ?? '').startsWith(RENAMED_FOLDER_NAME))
    record(
      '创建副本真实落盘且原件保留',
      copies.length >= 2 && hasNode(paths, RENAMED_FOLDER_NAME),
      `同名系列 ${copies.length} 个: ${copies.join(', ')}`
    )
  } else {
    record('创建副本真实落盘且原件保留', false, '右键菜单未打开')
  }
  
  // ---- 复制路径（PRD「复制路径」）：断言真实绝对路径进了剪贴板 ----
  const pathMenu =
    (await click(
      win,
      `[data-testid="tree-more-${findNode(await treePaths(win), RENAMED_FOLDER_NAME)}"]`
    )) &&
    (await waitFor(win, '[data-testid="resource-node-menu"]'))
  if (pathMenu) {
    // 先清剪贴板，避免拿到上一次残留值当成本次结果。
    await clipboard.writeText('')
    await click(win, '[data-testid="menu-copy-path"]')
    await settle(SETTLE_MS)
    const clip = await clipboardText()
    const notice = await textOf(win, '[data-testid="resource-notice"]')
    record(
      '复制路径写入真实绝对路径',
      clip.includes(RENAMED_FOLDER_NAME) && clip.startsWith('/'),
      clip ? clip : `剪贴板为空（面板提示：${notice || '无'}）`
    )
  } else {
    record('复制路径写入真实绝对路径', false, '右键菜单未打开')
  }
  
  // ---- 拖拽移动资料：把新建的 md 放进真实子目录，再经菜单移到上一级 ----
  if (docPath) {
    const docRowSelector = `[data-testid="tree-${docPath}"]`
    if (!await waitFor(win, docRowSelector, SETTLE_MS)) {
      const parentPath = docPath.slice(0, docPath.lastIndexOf('/'))
      await click(win, `[data-testid="tree-${parentPath}"]`)
      await waitFor(win, docRowSelector)
    }
    const moveTarget = findNode(await treePaths(win), '笔记')
    const drag = await dragResourceNode(win, docPath, moveTarget)
    await settle(SETTLE_MS)
    let paths = await treePaths(win)
    const moved = `${moveTarget}/${docPath.split('/').pop()}`
    record(
      '拖拽移动走真实 DOM/HTTP/磁盘链路（源消失/目标出现）',
      drag.dispatched && drag.validTarget && paths.includes(moved) && !paths.includes(docPath),
      `${JSON.stringify(drag)} 目标在=${paths.includes(moved)} 源在=${paths.includes(docPath)}`
    )
    docPath = paths.includes(moved) ? moved : docPath

    const movedMenu =
      (await click(win, `[data-testid="tree-more-${docPath}"]`))
      && (await waitFor(win, '[data-testid="resource-node-menu"]'))
    if (movedMenu) {
      const upEnabled = await win.webContents.executeJavaScript(`
        !document.querySelector('[data-testid="menu-move-up"]')?.hasAttribute('disabled')
      `)
      await click(win, '[data-testid="menu-move-up"]')
      await settle(SETTLE_MS)
      paths = await treePaths(win)
      const movedUp = `${moveTarget.slice(0, moveTarget.lastIndexOf('/'))}/${docPath.split('/').pop()}`
      record(
        '右键“移到上一级目录”真实生效',
        Boolean(upEnabled) && paths.includes(movedUp) && !paths.includes(docPath),
        `目标在=${paths.includes(movedUp)} 源在=${paths.includes(docPath)}`
      )
      docPath = paths.includes(movedUp) ? movedUp : docPath
    } else {
      record('右键“移到上一级目录”真实生效', false, '右键菜单未打开')
    }
  }
  
  // ---- 导入弹窗（PRD「资料导入」）：复制/关联均由整卡触发 ----
  //
  // 只验弹窗形态与双模式入口，导入本身留给发版前人工点一次。这条边界是实测出来的：
  // 系统原生选择器在无头环境无法应答（点下去永久挂住），而想「只固定选择结果、其后
  // 链路保持真实」就必须替换 `window.scholarseed.pickImport` —— preload 的 contextBridge
  // 把该对象定义成不可配置，渲染层劫持不了它。那是**安全属性**（渲染进程不能改写通往
  // 主进程的桥），不该为了测试削弱。
  //
  // 因此导入落盘的证据在别处：`contract_workbench_domains`（copy 产生副本且原件保留、
  // link 不产生第二份副本）与 `contract_content_authorization`（关联根登记/挂载/撤销）。
  await click(win, '[data-testid="resource-import"]')
  const importDialog = await waitFor(win, '[data-testid="resource-import-dialog"]')
  record('导入弹窗可打开', importDialog)
  if (importDialog) {
    const shape = await win.webContents.executeJavaScript(`
      (() => {
        const root = document.querySelector('[data-testid="resource-import-dialog"]')
        if (!root) return null
        return {
          copy: root.querySelector('[data-testid="import-copy"]')?.tagName === 'BUTTON',
          link: root.querySelector('[data-testid="import-link"]')?.tagName === 'BUTTON',
          copyTargetMenu: root.querySelector('[data-testid="import-copy"]')?.getAttribute('aria-haspopup') === 'menu',
          linkTargetMenu: root.querySelector('[data-testid="import-link"]')?.getAttribute('aria-haspopup') === 'menu',
          legacyPickerActions: Boolean(root.querySelector(
            '[data-testid="import-copy-file"], [data-testid="import-copy-dir"], [data-testid="import-link-file"], [data-testid="import-link-dir"]'
          ))
        }
      })()
    `)
    const s = shape as Record<string, boolean> | null
    record(
      '导入弹窗按平台提供 macOS 整卡直达或 Windows/Linux 文件类型菜单',
      Boolean(
        s &&
        s.copy &&
        s.link &&
        !s.legacyPickerActions &&
        (supportsImportPickerTarget(process.platform, IMPORT_PICKER_TARGET.RESOURCE)
          ? !s.copyTargetMenu && !s.linkTargetMenu
          : s.copyTargetMenu && s.linkTargetMenu)
      ),
      s ? JSON.stringify(s) : '取不到结构'
    )

    // 合成文件只用于验证两个真实卡片都接住 dragenter 并切换各自高亮；不触发 drop，
    // 因为 webUtils 只会为操作系统真实拖入的 File 返回路径，合成 File 没有本地身份。
    for (const target of [
      { label: '复制', selector: '[data-testid="import-copy"]' },
      { label: '关联', selector: '[data-testid="import-link"]' }
    ]) {
      const accepted = await win.webContents.executeJavaScript(`
        (() => {
          const card = document.querySelector(${JSON.stringify(target.selector)})
          if (!card) return false
          const transfer = new DataTransfer()
          transfer.items.add(new File(['drag-check'], '外部资料.md', { type: 'text/markdown' }))
          return !card.dispatchEvent(new DragEvent('dragenter', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer
          }))
        })()
      `)
      await settle(SETTLE_MS)
      const active = await waitFor(
        win,
        `${target.selector}[data-drop-active="true"]`
      )
      record(
        `拖入${target.label}卡片会激活对应区域`,
        Boolean(accepted && active)
      )
      await win.webContents.executeJavaScript(`
        (() => {
          const card = document.querySelector(${JSON.stringify(target.selector)})
          if (!card) return
          card.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }))
        })()
      `)
      await settle(SETTLE_MS)
    }
    // 关掉弹窗，不触发原生选择器。
    await click(win, '[data-testid="resource-import-dialog"] .vds-modal-close')
    await settle(SETTLE_MS)
  }
  
  // ---- 删除确认：断言 PRD 要求的两条提示文案，然后取消（不真删）----
  const delMenu =
    (await click(
      win,
      `[data-testid="tree-more-${findNode(await treePaths(win), RENAMED_FOLDER_NAME)}"]`
    )) &&
    (await waitFor(win, '[data-testid="resource-node-menu"]'))
  if (delMenu) {
    await click(win, '[data-testid="menu-delete"]')
    const dialog = await waitFor(win, '[data-testid="resource-delete-confirm"]')
    record('删除弹出确认框', dialog)
    if (dialog) {
      const copy = await textOf(win, '[data-testid="resource-delete-confirm"]')
      record(
        '删除文案含「同步影响本地文件」与「废纸篓可恢复」',
        copy.includes('同步影响') && copy.includes('废纸篓'),
        copy.replace(/\n/g, ' ')
      )
      await click(win, '[data-testid="resource-delete-cancel"]')
      await settle(SETTLE_MS)
    }
  }

  // ---- 文献库：切视图 → 断言真实条目与筛选维度 ----
  await click(win, '[data-testid="activity-literature"]')
  await settle(SETTLE_MS)
  const litReady = await waitFor(win, '[data-testid="literature-overview"]')
  record('文献库列表渲染', litReady)
  if (litReady) {
    const lit = (await apiJson(win, withProject('/api/literature/items'))) as
      | { items?: unknown[]; total?: number }
      | null
    const total = typeof lit?.total === 'number' ? lit.total : 0
    record('文献库读到真实条目', total > 0, `共 ${total} 条`)

    const rows = await win.webContents.executeJavaScript(
      `document.querySelectorAll('.lit-row').length`
    )
    record('列表渲染出条目行', Number(rows) > 0, `${rows} 行`)

    // 排序：点年份表头，断言首行年份随之变化（升→降）。
    const yearAt = async (): Promise<string> =>
      String(
        await win.webContents.executeJavaScript(`
          (() => {
            const row = document.querySelector('.lit-row')
            const cell = row?.querySelector('.vds-lit-cell.is-year')
            return cell instanceof HTMLElement ? cell.innerText.trim() : ''
          })()
        `)
      )
    const beforeSort = await yearAt()
    await click(win, '[data-testid="literature-sort-year"]')
    await settle(SETTLE_MS)
    const asc = await yearAt()
    // 再点同一列是**回到默认「最近添加」**, 不是切降序 (store.toggleLiteratureSort
    // 明确这样设计: 用户需要一个回默认视图的出口)。此前这一步断言「升→降」,
    // 产品里根本没有那个行为, 所以它一直是红的。
    await click(win, '[data-testid="literature-sort-year"]')
    await settle(SETTLE_MS)
    const restored = await yearAt()
    const sorted = await win.webContents.executeJavaScript(`
      Boolean(document.querySelector('[data-testid="literature-sort-year"].is-sorted'))
    `)
    record(
      '按年份排序生效, 再点回到默认排序',
      asc !== '' && sorted !== true && restored === beforeSort,
      `默认首行=${beforeSort} 年份升序首行=${asc} 回默认首行=${restored} 仍高亮=${String(sorted)}`
    )

    const retainedLiteratureSearch = 'Perovskite'
    const searchPrepared = await fill(
      win,
      'input[aria-label="搜索文献"]',
      retainedLiteratureSearch
    )
    await settle(SETTLE_MS)

    const markdownRowExpanded = Boolean(await win.webContents.executeJavaScript(`
      (() => {
        const row = Array.from(document.querySelectorAll('.lit-row'))
          .find((candidate) => (candidate.textContent || '').includes('Perovskite degradation under humidity'))
        const expand = row?.querySelector('[aria-label="展开附件"]')
        if (!(expand instanceof HTMLElement)) return false
        expand.click()
        return true
      })()
    `))
    await settle(SETTLE_MS)
    const markdownAttachmentOpened = markdownRowExpanded
      && Boolean(await win.webContents.executeJavaScript(`
      (() => {
        const attachment = Array.from(
          document.querySelectorAll('[data-testid^="literature-attachment-"]')
        ).find((candidate) => (candidate.textContent || '').includes(${JSON.stringify(LITERATURE_MARKDOWN_NAME)}))
        if (!(attachment instanceof HTMLElement)) return false
        attachment.click()
        return true
      })()
    `))
    await settle(SETTLE_MS)
    const markdownOpenRequested = markdownAttachmentOpened
      && Boolean(await win.webContents.executeJavaScript(`
        (() => {
          const button = Array.from(document.querySelectorAll('.lit-detail-body button'))
            .find((candidate) => (candidate.textContent || '').includes('打开附件'))
          if (!(button instanceof HTMLElement)) return false
          button.click()
          return true
        })()
      `))
    await settle(SETTLE_MS)
    const markdownViewer = markdownOpenRequested
      && await waitFor(win, '[data-testid="markdown-filename-title"]')
    if (markdownViewer) {
      const snapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
      mkdirSync(snapshotDir, { recursive: true })
      writeFileSync(
        join(snapshotDir, 'literature-markdown-preview.png'),
        (await win.webContents.capturePage()).toPNG()
      )
    }
    record(
      '文献 Markdown 附件复用资料库 Markdown 预览器',
      markdownViewer,
      markdownViewer
        ? LITERATURE_MARKDOWN_NAME
        : JSON.stringify({
            literatureFixtureItemId,
            markdownRowExpanded,
            markdownAttachmentOpened,
            markdownOpenRequested
          })
    )
    const literatureClosed = markdownViewer
      && await closeDocumentTab(win, LITERATURE_MARKDOWN_NAME)
    await settle(SETTLE_MS)
    const literatureListRestored = literatureClosed
      && await waitFor(win, '[data-testid="literature-overview"]')
    const closeState = literatureListRestored
      ? await win.webContents.executeJavaScript(`
          (() => ({
            search: document.querySelector('input[aria-label="搜索文献"]')?.value ?? '',
            resourceViewerVisible: Boolean(document.querySelector('[data-testid="markdown-filename-title"]'))
          }))()
        `) as { search: string; resourceViewerVisible: boolean }
      : null
    if (literatureListRestored) {
      const snapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
      mkdirSync(snapshotDir, { recursive: true })
      writeFileSync(
        join(snapshotDir, 'literature-close-restores-list.png'),
        (await win.webContents.capturePage()).toPNG()
      )
    }
    record(
      '关闭唯一文献文件返回文献列表并保留搜索状态',
      searchPrepared
        && literatureListRestored
        && closeState?.search === retainedLiteratureSearch
        && closeState.resourceViewerVisible === false,
      JSON.stringify(closeState)
    )
    await fill(win, 'input[aria-label="搜索文献"]', '')
    await settle(SETTLE_MS)

    // 批量：勾一条 → 断言批量操作条出现
    const firstCheck = await win.webContents.executeJavaScript(`
      (() => {
        const box = document.querySelector('[data-testid^="literature-check-"]')
        if (!(box instanceof HTMLElement)) return false
        box.click()
        return true
      })()
    `)
    await settle(SETTLE_MS)
    const batchBar = await waitFor(win, '[data-testid="literature-batch"]')
    record('勾选后出现批量操作条', Boolean(firstCheck) && batchBar)

    const pdfRowOpened = Boolean(await win.webContents.executeJavaScript(`
      (() => {
        const row = Array.from(document.querySelectorAll('.lit-row'))
          .find((candidate) => (candidate.textContent || '').includes(${JSON.stringify(LITERATURE_PDF_NAME.replace('.pdf', ''))}))
        if (!(row instanceof HTMLElement)) return false
        row.click()
        const expand = row.querySelector('[aria-label="展开附件"]')
        if (expand instanceof HTMLElement) expand.click()
        return true
      })()
    `))
    await settle(SETTLE_MS)
    const attachmentOpened = pdfRowOpened && Boolean(await win.webContents.executeJavaScript(`
      (() => {
        const row = document.querySelector('[data-testid^="literature-attachment-"]')
        if (!(row instanceof HTMLElement)) return false
        row.click()
        return true
      })()
    `))
    await settle(SETTLE_MS)
    const literatureMenuOpened = attachmentOpened
      && await openTabContextMenu(win, LITERATURE_PDF_NAME)
    const literatureMenuReady = literatureMenuOpened
      && await waitFor(win, '[data-testid="document-tab-menu"]')
    const literatureFileActionsEnabled = literatureMenuReady
      && await win.webContents.executeJavaScript(`
        ['tab-add-to-conversation', 'tab-copy-absolute-path', 'tab-reveal-in-finder']
          .every((id) => {
            const action = document.querySelector('[data-testid="' + id + '"]')
            return action instanceof HTMLElement
              && !action.hasAttribute('data-disabled')
              && action.getAttribute('aria-disabled') !== 'true'
          })
    `)
    record('文献附件 Tab 的文件路径动作均可用', Boolean(literatureFileActionsEnabled))
    if (literatureFileActionsEnabled) {
      await clipboard.writeText('')
      await click(win, '[data-testid="tab-copy-absolute-path"]')
      await settle(SETTLE_MS)
      const copiedPath = await clipboardText()
      record('文献附件 Tab 可复制绝对路径', copiedPath === literaturePdf, copiedPath)

      const conversationMenuOpened = await openTabContextMenu(win, LITERATURE_PDF_NAME)
      const conversationMenuReady = conversationMenuOpened
        && await waitFor(win, '[data-testid="document-tab-menu"]')
      const conversationAdded = conversationMenuReady
        && await click(win, '[data-testid="tab-add-to-conversation"]')
      const aiPanelOpened = conversationAdded && await waitFor(win, '[data-testid="ai-panel"]')
      const contextAttached = aiPanelOpened && await win.webContents.executeJavaScript(`
        Array.from(document.querySelectorAll('[data-testid="ai-context-ref"]'))
          .some((chip) => chip.textContent?.includes(${JSON.stringify(LITERATURE_PDF_NAME)}))
      `)
      record('文献附件以文件路径加入当前对话', Boolean(contextAttached))
      if (contextAttached) {
        const snapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
        mkdirSync(snapshotDir, { recursive: true })
        writeFileSync(
          join(snapshotDir, 'literature-attachment-added-to-conversation.png'),
          (await win.webContents.capturePage()).toPNG()
        )
      }
    }
    const copyAction = attachmentOpened && await waitFor(win, '[data-testid="literature-copy-to-project"]')
    if (copyAction) await click(win, '[data-testid="literature-copy-to-project"]')
    const copyChoice = copyAction && await waitFor(win, '[data-testid="literature-copy-records"]')
    record('附件详情明确提供存入资料库及批注复制选择', copyAction && copyChoice)
    if (copyAction && copyChoice) {
      const snapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
      mkdirSync(snapshotDir, { recursive: true })
      writeFileSync(
        join(snapshotDir, 'literature-attachment-copy.png'),
        (await win.webContents.capturePage()).toPNG()
      )
    }
  }

  // ---- AI 面板：⌘J 等价的按钮 → 断言真实 Composer 被挂载 ----
  await click(win, '[data-testid="activity-resource"]')
  await settle(SETTLE_MS)
  await click(win, '[data-testid="topbar-ai"]')
  await settle(SETTLE_MS)
  const panel = await waitFor(win, '[data-testid="ai-panel"]')
  record('AI 面板可唤起', panel)
  if (panel) {
    const composer = await win.webContents.executeJavaScript(
      `Boolean(window.__scholarseedSubmitMessage) &&
       Boolean(document.querySelector('[data-testid="composer-input"]'))`
    )
    record(
      'AI 面板内挂载的是 0.1 真实 Composer（提交入口已注册）',
      composer === true,
      composer === true ? '__scholarseedSubmitMessage + composer-input 均在' : '真实输入框缺失'
    )

    const draftScopeEnabled = await win.webContents.executeJavaScript(
      `document.querySelector('[data-testid="ai-search-scope"]')?.disabled === false`
    )
    await click(win, '[data-testid="ai-search-scope"]')
    await click(win, '[data-testid="ai-scope-academic"]')
    await settle(SETTLE_MS)
    const academicSelected = await textOf(win, '[data-testid="ai-search-scope"]')
    await click(win, '[data-testid="ai-search-scope"]')
    await click(win, '[data-testid="ai-scope-web"]')
    await settle(SETTLE_MS)
    const webSelected = await textOf(win, '[data-testid="ai-search-scope"]')
    record(
      '新建默认会话可切换检索源',
      draftScopeEnabled === true && academicSelected.includes('学术') && webSelected.includes('全网'),
      `enabled=${draftScopeEnabled} 学术=${academicSelected} 全网=${webSelected}`
    )

    // ---- 上下文附加（PRD「资料上下文」）：开一份资料后加为上下文 ----
    // 先确保目标文件真的开在中区（前面的移动步骤会重建标签），
    // 否则 attachActiveFileToAi 会因「当前活动标签不是文件」而拒绝 ——
    // 那是正确的产品行为，不应被当成缺陷。
    if (docPath) {
      // 移动后文件在子目录里，而目录默认折叠 —— 得先展开父目录才能点到它。
      // 这与用户真实操作一致（先展开目录再点文件）。
      const slash = docPath.lastIndexOf('/')
      if (slash > 0) {
        await click(win, `[data-testid="tree-${docPath.slice(0, slash)}"]`)
        await settle(SETTLE_MS)
      }
      await click(win, `[data-testid="tree-${docPath}"]`)
      const opened = await waitFor(win, '[data-testid="markdown-visual-editor"]')
      record('移动后可从树上重新打开该资料', opened, docPath)
      await settle(SETTLE_MS)
      // 最新 Composer 把资料引用统一收进「+ → 引用资料库」选择器，
      // 不再保留旧 AI 面板顶部的当前文件快捷按钮。
      await click(win, '[data-testid="composer-plus"]')
      await click(win, '[data-testid="composer-add-context"]')
      await waitFor(win, '[data-testid="ai-context-picker"]')
      const contextOption = `[data-testid="ai-context-option-file-${docPath}"]`
      await waitFor(win, contextOption)
      await click(win, contextOption)
      await settle(SETTLE_MS)
      const chips = await win.webContents.executeJavaScript(
        `document.querySelectorAll('.vds-ai-chip').length`
      )
      const notice = await textOf(win, '[data-testid="resource-notice"]')
      record(
        '当前资料可加为 AI 上下文',
        Number(chips) > 0,
        Number(chips) > 0 ? `上下文 chip ${chips} 个` : `chip 0 个（面板提示：${notice || '无'}）`
      )
    }

    // ---- 暂存引用（PRD「暂存引用」）：划词 → 存入引用 → 一起发给 AI ----
    // 划词发 AI 依赖 Milkdown 所见即所得编辑器的选区能力，
    // 只在 Markdown 自有的可视化编辑视图中存在。
    if (docPath) {
      const editOpened = await click(win, `[data-testid="${MARKDOWN_EDIT_TEST_ID}"]`)
      const picked = editOpened
        && await waitForDocumentText(win, docPath, MARKDOWN_RENDER_TEST_ID)
      const action = picked && await waitFor(win, '[data-testid="document-stash-clip"]')
      if (action) await click(win, '[data-testid="document-stash-clip"]')
      await settle(SETTLE_MS)
      const clips = await waitFor(win, '[data-testid="ai-clips"]')
      const viewEvidence = picked ? '' : await describeDocumentViews(win)
      record(
        '划词可存入暂存引用队列',
        editOpened && picked && action && clips,
        `编辑视图打开=${editOpened} 选中=${picked} 动作出现=${action} 队列出现=${clips}${viewEvidence ? ` 视图=${viewEvidence}` : ''}`
      )
      if (picked) {
        const askAction = await waitFor(win, '[data-testid="document-ask-ai"]')
        if (askAction) await click(win, '[data-testid="document-ask-ai"]')
        await settle(SETTLE_MS)
        const draft = await valueOf(win, '[data-testid="composer-input"]')
        record(
          '划词问 AI 带选区与出处进入输入框',
          askAction && draft.includes('就以下内容提问') && draft.includes(docPath),
          draft ? `输入框 ${draft.length} 字符` : '输入框为空'
        )
      }
    }

    // ---- 存入资料库（PRD「对话存入资料库」）：选中文本 → 存为 Markdown ----
    if (docPath) {
      const picked = await selectDocumentText(win, docPath, MARKDOWN_RENDER_TEST_ID)
      await click(win, '[data-testid="ai-save-to-library"]')
      await settle(2_000)
      const paths = await treePaths(win)
      const note = paths.find((p) => p.includes(`${AGENT_OUTPUT_DIR}/`))
      let hasSource = false
      if (note) {
        const read = (await apiJson(
          win,
          withProject(`/api/resource/read?path=${encodeURIComponent(note)}`)
        )) as { content?: unknown } | null
        const body = typeof read?.content === 'string' ? read.content : ''
        hasSource = body.includes('## 来源') && body.includes('对话：')
      }
      const notice = await textOf(win, '[data-testid="resource-notice"]')
      record(
        '存入资料库生成 Markdown 且保留对话来源',
        Boolean(note) && hasSource,
        note
          ? `${note}（含来源段=${hasSource}）`
          : `未生成 ${AGENT_OUTPUT_DIR}/ 下的文件（选中=${picked}，面板提示：${notice || '无'}）`
      )
    }
  }

  // ---- 全局搜索（PRD「全局搜索」）：真实打开文件 + 真实键入 ----
  const queryPanelReady = await verifyRecentFileSearch(win, record)
  if (queryPanelReady) {
    // 搜一个同时存在于资料（.bib 文件名/正文）与文献（条目标题）的词。
    await fill(win, '[data-testid="global-search-input"]', 'perovskite')
    await settle(1_500)
    const domains = await win.webContents.executeJavaScript(`
      (() => {
        const rows = Array.from(
          document.querySelectorAll('[data-testid^="search-hit-"]')
        ).map((el) => el.getAttribute('data-testid') || '')
        return {
          resource: rows.filter((t) => t.startsWith('search-hit-resource-')).length,
          literature: rows.filter((t) => t.startsWith('search-hit-literature-')).length
        }
      })()
    `)
    const d = domains as { resource: number; literature: number } | null
    record(
      '全局搜索返回跨域真实命中（资料 + 文献）',
      Boolean(d && d.resource > 0 && d.literature > 0),
      d ? `资料 ${d.resource} 条 / 文献 ${d.literature} 条` : '取不到命中'
    )
    const officeSearchQuery = process.env[OFFICE_SEARCH_QUERY_ENV]?.trim()
    if (officeSearchQuery) {
      await fill(win, '[data-testid="global-search-input"]', officeSearchQuery)
      await settle(1_500)
      const officeHit = await win.webContents.executeJavaScript(`
        Array.from(document.querySelectorAll('[data-testid^="search-hit-resource-"]')).some(
          (row) =>
            (row.textContent || '').includes(${JSON.stringify(OFFICE_FIXTURE_NAME)}) &&
            (row.textContent || '').includes(${JSON.stringify(officeSearchQuery)})
        )
      `)
      record(
        '全局搜索可从 DOCX 正文命中资料',
        Boolean(officeHit),
        officeHit ? OFFICE_FIXTURE_NAME : `未命中 ${officeSearchQuery}`
      )
    }
    await click(win, '[data-testid="global-search"] .vds-modal-backdrop')
    await waitForMissing(win, '[data-testid="global-search"]')
  }

  // ---- 项目创建与关联入口（proposal 47）：走当前可达的顶栏 / 资料库入口 ----
  await click(win, '[data-testid="topbar-project"]')
  const createEntry = await waitFor(win, '[data-testid="project-menu-create"]')
  const projectDialog = createEntry
    && await click(win, '[data-testid="project-menu-create"]')
    && await waitFor(win, '[data-testid="project-new-modal"]')
  record('顶栏项目菜单可打开新建项目弹窗', Boolean(projectDialog))
  if (projectDialog) {
    await fill(win, '#project-name-control', NEW_PROJECT_NAME)
    await click(win, '[data-testid="project-create"]')
    await settle(SETTLE_MS)
  }
  const listing = (await apiJson(win, '/api/content/projects')) as
    | { projects: { id: string; name: string; root: string; layout: string }[] }
    | null
  const created = listing?.projects.find((item) => item.name === NEW_PROJECT_NAME)
  record(
    '新建项目只填名字即落库（布局为内置双库）',
    Boolean(created && created.layout === 'managed'),
    created ? `${created.name} @ ${created.root}` : '列表里没有'
  )
  if (created) {
    residueProjects.push(created.id)
    residueDirectories.push(created.root)
    const directory = created.root.split('/').filter(Boolean).pop() ?? ''
    record(
      '目录名按 <日期>-<shortid>-<slug> 生成',
      /^\d{8}-[0-9a-z]{8}-/.test(directory),
      directory
    )
    const tree = (await apiJson(
      win,
      `/api/resource/tree?project=${encodeURIComponent(created.id)}`
    )) as { nodes?: { path: string }[] } | null
    record(
      '新项目的资料树以 resources/ 为基准（单一相对基）',
      Array.isArray(tree?.nodes),
      JSON.stringify(tree?.nodes ?? []).slice(0, 120)
    )

    await click(win, '[data-testid="activity-resource"]')
    await settle(SETTLE_MS)
    const importOpened = await click(win, '[data-testid="resource-import"]')
    const linkChoice = importOpened && await waitFor(win, '[data-testid="import-link"]')
    record('资料库导入弹窗提供关联原文件入口', Boolean(linkChoice))
    if (linkChoice) await click(win, '[data-testid="resource-import-dialog"] .vds-modal-close')

      // ---- 关联根的安全取消关联：UI 只能撤销挂载，不能删除外部原文件 ----
      const linkedRoot = join(dirname(created.root), `UI验收关联-${Date.now()}`)
      const insideLinked = join(linkedRoot, '关联文件.md')
      const secondLinked = join(linkedRoot, '关联文件2.md')
      mkdirSync(linkedRoot, { recursive: true })
      residueDirectories.push(linkedRoot)
      writeFileSync(insideLinked, LINKED_INITIAL_CONTENT, 'utf-8')
      writeFileSync(secondLinked, '外部原文2', 'utf-8')
      const authorized = (await apiPost(win, '/api/content/roots', {
        project: created.id,
        source: linkedRoot,
        mount: '外部资料'
      })) as { root_id?: string; mount_path?: string; detail?: string } | null
      record(
        '授权项目外目录成为项目内挂载点',
        Boolean(authorized?.root_id && authorized.mount_path),
        JSON.stringify(authorized ?? {})
      )
      const mountPath = String(authorized?.mount_path ?? '')
      if (mountPath) {
        const linkedTree = (await apiJson(
          win,
          `/api/resource/tree?project=${encodeURIComponent(created.id)}`
        )) as { nodes?: { path: string; origin?: string; children?: { path: string }[] }[] } | null
        const mountNode = linkedTree?.nodes?.find((node) => node.path === mountPath)
        record(
          '关联目录出现在资料树里并标为 link',
          Boolean(mountNode && mountNode.origin === 'link'),
          JSON.stringify(mountNode ?? {}).slice(0, 160)
        )
        // 后端 origin 绿着、渲染层断掉时，用户看到的就是「关联目录和普通目录一模一样」
        // （AssetOrigin 契约要求 UI 能区分），所以这条必须落到真实 DOM 上。
        //
        // 资料树画的是**当前选中项目**，而授权对象是上面新建的那个 —— 不先切过去，
        // 断言看的就是另一个项目的树。切换走产品自己的顶栏切换器。
        await win.webContents.executeJavaScript(
          `window.dispatchEvent(new CustomEvent('scholarseed:refresh-session-list'))`
        )
        const linkedOption = `[data-testid="project-menu-option-${NEW_PROJECT_NAME}"]`
        let switched = false
        for (let attempt = 0; attempt < 12 && !switched; attempt += 1) {
          await settle(500)
          await click(win, '[data-testid="topbar-project"]')
          if (await waitFor(win, linkedOption)) switched = await click(win, linkedOption)
        }
        await settle(SETTLE_MS)
        await click(win, '[data-testid="activity-resource"]')
        const iconSelector = `[data-testid="tree-icon-${mountPath}"]`
        const iconShape = (await waitFor(win, iconSelector))
          ? await win.webContents.executeJavaScript(`
            (() => {
              const icon = document.querySelector(${JSON.stringify(iconSelector)})
              if (!icon) return null
              const row = icon.closest('.vds-tree-row')
              return {
                icon: icon.getAttribute('data-icon'),
                linked: Boolean(row && row.classList.contains('is-linked'))
              }
            })()
          `)
          : null
        const linkedRow = iconShape as { icon?: string; linked?: boolean } | null
        record(
          '关联目录在资料树上用 link 图标且整行标为关联',
          linkedRow?.icon === 'link' && linkedRow.linked === true,
          `切到该项目=${String(switched)} ${JSON.stringify(linkedRow ?? {})}`
        )
        await click(win, `[data-testid="tree-${mountPath}"]`)
        const linkedFilePath = `${mountPath}/关联文件.md`
        const linkedFileVisible = await waitFor(win, `[data-testid="tree-${linkedFilePath}"]`)
        const linkedPreviewOpened = linkedFileVisible
          && await click(win, `[data-testid="tree-${linkedFilePath}"]`)
        const initialLinkedPreview = linkedPreviewOpened
          && await waitForText(win, LINKED_INITIAL_CONTENT)
        writeFileSync(insideLinked, LINKED_UPDATED_CONTENT, 'utf-8')
        const updatedLinkedPreview = initialLinkedPreview
          && await waitForText(win, LINKED_UPDATED_CONTENT)
        record(
          '关联原文件保存后实时刷新已打开的标签页预览',
          Boolean(linkedPreviewOpened && initialLinkedPreview && updatedLinkedPreview),
          await describeDocumentViews(win)
        )
        if (updatedLinkedPreview) {
          const snapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
          mkdirSync(snapshotDir, { recursive: true })
          writeFileSync(
            join(snapshotDir, 'linked-file-live-preview.png'),
            (await win.webContents.capturePage()).toPNG()
          )
        }
        const token = (await apiPost(win, '/api/content/trash-token', {
          project: created.id,
          path: linkedFilePath
        })) as { token?: string; detail?: string } | null
        record(
          '关联根内任意文件都不能签发物理删除令牌',
          !token?.token
            && token?.detail === 'cannot_trash_linked'
            && readFileSync(insideLinked, 'utf-8') === LINKED_UPDATED_CONTENT,
          `${JSON.stringify(token)} 原文件存在=${String(existsSync(insideLinked))}`
        )
        const unlinkMenu =
          (await click(win, `[data-testid="tree-more-${mountPath}"]`))
          && (await waitFor(win, '[data-testid="resource-node-menu"]'))
        const unlinkMenuText = unlinkMenu
          ? await textOf(win, '[data-testid="resource-node-menu"]')
          : ''
        if (unlinkMenu) await click(win, '[data-testid="menu-unlink"]')
        const unlinkDialog = await waitFor(win, '[data-testid="resource-unlink-confirm"]')
        const unlinkCopy = unlinkDialog
          ? await textOf(win, '[data-testid="resource-unlink-confirm"]')
          : ''
        record(
          '关联根菜单只提供取消关联，确认框明确原文件保留',
          unlinkMenuText.includes('取消关联')
            && !unlinkMenuText.includes('删除')
            && unlinkCopy.includes('原文件会完整保留'),
          `${unlinkMenuText.replace(/\n/g, ' / ')} | ${unlinkCopy.replace(/\n/g, ' / ')}`
        )
        if (unlinkDialog) await click(win, '[data-testid="resource-unlink-go"]')
        await settle(SETTLE_MS)
        const rootsAfterUnlink = (await apiJson(
          win,
          `/api/content/roots?project=${encodeURIComponent(created.id)}`
        )) as { roots?: { root_id?: string }[] } | null
        record(
          'UI 取消关联撤销挂载且两个外部原文件逐字保留',
          !rootsAfterUnlink?.roots?.some((root) => root.root_id === authorized?.root_id)
            && readFileSync(insideLinked, 'utf-8') === '外部原文'
            && readFileSync(secondLinked, 'utf-8') === '外部原文2',
          JSON.stringify(rootsAfterUnlink ?? {})
        )
      }

      // 单文件关联走同一个公共授权端点，但授权边界必须停在文件本身，树上也必须
      // 是 file 叶子。原生选择器在无头环境无法应答，因此这里从选择器之后的真实
      // HTTP 链路开始验证；上面的弹窗形态断言负责钉住用户入口。
      const linkedFile = join(dirname(created.root), `UI验收关联单文件-${Date.now()}.md`)
      writeFileSync(linkedFile, '单文件原文', 'utf-8')
      residueDirectories.push(linkedFile)
      const authorizedFile = (await apiPost(win, '/api/content/roots', {
        project: created.id,
        source: linkedFile,
        mount: basename(linkedFile)
      })) as {
        root_id?: string
        mount_path?: string
        kind?: string
        detail?: string
      } | null
      record(
        '关联单文件通过公共授权端点登记为 file 挂载',
        Boolean(
          authorizedFile?.root_id &&
          authorizedFile.mount_path &&
          authorizedFile.kind === 'file'
        ),
        JSON.stringify(authorizedFile ?? {})
      )
      const fileMountPath = String(authorizedFile?.mount_path ?? '')
      if (fileMountPath) {
        const linkedFileTree = (await apiJson(
          win,
          `/api/resource/tree?project=${encodeURIComponent(created.id)}`
        )) as {
          nodes?: { path: string; kind?: string; origin?: string; children?: unknown[] }[]
        } | null
        const fileNode = linkedFileTree?.nodes?.find((node) => node.path === fileMountPath)
        record(
          '关联单文件作为 LINK 叶子出现在真实资料树',
          Boolean(
            fileNode &&
            fileNode.kind === 'file' &&
            fileNode.origin === 'link' &&
            !('children' in fileNode)
          ),
          JSON.stringify(fileNode ?? {})
        )
        const written = (await apiPost(win, '/api/resource/write', {
          project: created.id,
          path: fileMountPath,
          content: '书深修改单文件'
        })) as { saved?: boolean; detail?: string } | null
        record(
          '通过挂载路径写入只修改关联的原文件',
          Boolean(written?.saved) && readFileSync(linkedFile, 'utf-8') === '书深修改单文件',
          JSON.stringify(written ?? {})
        )
        await click(win, '[data-testid="resource-refresh"]')
        await settle(SETTLE_MS)
        const unlinkFileMenu =
          (await click(win, `[data-testid="tree-more-${fileMountPath}"]`))
          && (await waitFor(win, '[data-testid="resource-node-menu"]'))
        if (unlinkFileMenu) await click(win, '[data-testid="menu-unlink"]')
        const unlinkFileDialog = await waitFor(win, '[data-testid="resource-unlink-confirm"]')
        if (unlinkFileDialog) await click(win, '[data-testid="resource-unlink-go"]')
        await settle(SETTLE_MS)
        const rootsAfterFileUnlink = (await apiJson(
          win,
          `/api/content/roots?project=${encodeURIComponent(created.id)}`
        )) as { roots?: { root_id?: string }[] } | null
        record(
          '关联单文件也只经 UI 取消关联且原文件保留',
          Boolean(unlinkFileMenu && unlinkFileDialog)
            && !rootsAfterFileUnlink?.roots?.some(
              (root) => root.root_id === authorizedFile?.root_id
            )
            && readFileSync(linkedFile, 'utf-8') === '书深修改单文件',
          JSON.stringify(rootsAfterFileUnlink ?? {})
        )
      }

  }

  const accountOpened = await click(win, '[data-testid="activity-account"]')
  const settingsOpened = accountOpened && await click(win, '[data-testid="account-menu-settings"]')
  const settingsVisible = settingsOpened && await waitFor(win, '[data-testid="account-settings-shell"]')
  const filesOpened = settingsVisible && await click(win, '[data-testid="account-settings-nav-files"]')
  const filesVisible = filesOpened && await waitFor(win, '[data-testid="account-settings-files"]')
  record('资料库文件设置页可从真实应用一级入口打开', Boolean(filesVisible))
  if (filesVisible) {
    await waitFor(win, '[data-testid="file-version-limit"]')
    const pageText = await textOf(win, '[data-testid="account-settings-files"]')
    record(
      '一级设置展示自动保存、保存时自动格式化、版本数量与最大文件大小',
      pageText.includes('文件自动保存')
        && pageText.includes('保存时自动格式化')
        && pageText.includes('版本数量')
        && pageText.includes('最大文件大小')
        && !pageText.includes('高级配置')
        && !pageText.includes('保存设置')
        && !pageText.includes('按文件类型保存')
    )
    const defaultSettings = (await apiJson(
      win,
      '/api/serve/settings/file-versions'
    )) as {
      max_versions_per_file?: number
      max_file_size_kb?: number
      include_patterns?: string[]
      common_patterns?: string[]
    } | null
    record(
      '新用户默认保留 50 个版本、最大 50 MB（API 51200 KB）且纳入全部常见类型',
      defaultSettings?.max_versions_per_file === 50
        && defaultSettings?.max_file_size_kb === 50 * 1024
        && JSON.stringify(defaultSettings.include_patterns)
          === JSON.stringify(defaultSettings.common_patterns),
      JSON.stringify(defaultSettings ?? {})
    )
    await waitForFileVersionInput(win, '[data-testid="file-version-limit"]')
    const formatOnSaveDefault = await win.webContents.executeJavaScript(`
      document.querySelector('[data-testid="file-version-format-on-save"]')
        ?.getAttribute('aria-checked') || ''
    `)
    record('保存时自动格式化默认关闭', formatOnSaveDefault === 'false', String(formatOnSaveDefault))
    await settle(SETTLE_MS)
    await beginFileVersionRequestCapture(win)
    const defaultForm = await fileVersionFormState(win)
    record(
      '设置页以 MB 展示默认版本数与文件大小',
      JSON.parse(defaultForm).limit === '50'
        && JSON.parse(defaultForm).maxFileSize === '50'
        && (await textOf(win, '[data-testid="file-version-size-row"]')).includes('MB'),
      defaultForm
    )
    const settingsSnapshotDir = resolve(process.cwd(), '..', '..', 'tmp', 'test_snapshot', 'desktop')
    mkdirSync(settingsSnapshotDir, { recursive: true })
    writeFileSync(
      join(settingsSnapshotDir, 'file-version-settings-default.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    const sizeCommitted = await commitFileVersionInput(
      win,
      '[data-testid="file-version-max-size"]',
      FILE_VERSION_MAX_SIZE_MB
    )
    const sizeDialog = sizeCommitted && await waitFor(win, '[role="alertdialog"]', 300)
    const savedToast = sizeCommitted
      && await waitFor(win, '.vds-toaster [role="status"][data-tone="success"]')
    const savedToastText = savedToast
      ? await textOf(win, '.vds-toaster [role="status"][data-tone="success"]')
      : ''
    record(
      '设置保存成功使用全局 Toast 提示',
      savedToastText === '文件版本设置已保存'
        || savedToastText === 'File version settings saved',
      savedToastText
    )
    await settle(WAIT_POLL_MS * 5)
    const savedToastLayout = await win.webContents.executeJavaScript(`
      (() => {
        const toast = document.querySelector('.vds-toaster [role="status"][data-tone="success"]')
        if (!(toast instanceof HTMLElement)) return null
        const rect = toast.getBoundingClientRect()
        const style = getComputedStyle(toast)
        const toaster = toast.closest('.vds-toaster')
        const toasterStyle = toaster instanceof HTMLElement ? getComputedStyle(toaster) : null
        const rootStyle = getComputedStyle(document.documentElement)
        return {
          display: style.display,
          height: rect.height,
          left: rect.left,
          modalZIndex: rootStyle.getPropertyValue('--vds-z-modal').trim(),
          opacity: style.opacity,
          top: rect.top,
          toasterZIndex: toasterStyle?.zIndex ?? '',
          visibility: style.visibility,
          width: rect.width,
          zIndex: style.zIndex
        }
      })()
    `) as {
      display: string
      height: number
      left: number
      modalZIndex: string
      opacity: string
      top: number
      toasterZIndex: string
      visibility: string
      width: number
      zIndex: string
    } | null
    record(
      '保存成功 Toast 在当前窗口可见区域完成布局',
      Boolean(
        savedToastLayout
          && savedToastLayout.display !== 'none'
          && savedToastLayout.visibility === 'visible'
          && Number(savedToastLayout.opacity) > 0
          && savedToastLayout.width > 0
          && savedToastLayout.height > 0
          && savedToastLayout.left >= 0
          && savedToastLayout.top >= 0
          && Number(savedToastLayout.toasterZIndex) > Number(savedToastLayout.modalZIndex)
      ),
      JSON.stringify(savedToastLayout)
    )
    writeFileSync(
      join(settingsSnapshotDir, 'file-version-settings.png'),
      (await win.webContents.capturePage()).toPNG()
    )
    if (savedToastLayout) {
      writeFileSync(
        join(settingsSnapshotDir, 'file-version-settings-toast.png'),
        (await win.webContents.capturePage({
          height: Math.ceil(savedToastLayout.height),
          width: Math.ceil(savedToastLayout.width),
          x: Math.floor(savedToastLayout.left),
          y: Math.floor(savedToastLayout.top)
        })).toPNG()
      )
    }
    const resizedSettings = await waitForFileVersionSettings(win, 50, FILE_VERSION_MAX_SIZE_KB)
    const sizeRequests = await finishFileVersionRequestCapture(win)
    const sizeMutationRequests = sizeRequests.filter((request) => request.startsWith('POST '))
    record(
      '最大文件大小完成编辑后直接保存且不显示确认或统计',
      Boolean(!sizeDialog && resizedSettings?.max_file_size_kb === FILE_VERSION_MAX_SIZE_KB),
      `${JSON.stringify(resizedSettings ?? {})} form=${await fileVersionFormState(win)}`
    )
    record(
      '设置保存只发送一次配置请求且不请求影响预览',
      sizeMutationRequests.length === 1
        && sizeMutationRequests[0] === 'POST /api/serve/settings/file-versions',
      JSON.stringify(sizeRequests)
    )
    const increased = await commitFileVersionInput(win, '[data-testid="file-version-limit"]', 120)
    const increasedSettings = await waitForFileVersionSettings(
      win,
      120,
      FILE_VERSION_MAX_SIZE_KB
    )
    const increaseDialog = await waitFor(win, '[role="alertdialog"]', 300)
    record(
      '调高版本上限完成编辑后自动保存且不触发清理确认',
      Boolean(increased && increasedSettings?.max_versions_per_file === 120 && !increaseDialog),
      `${JSON.stringify(increasedSettings ?? {})} form=${await fileVersionFormState(win)}`
    )
    const decreased = await commitFileVersionInput(win, '[data-testid="file-version-limit"]', 20)
    const retentionDialog = decreased && await waitFor(win, '[role="alertdialog"]', 300)
    record(
      '调低版本上限完成编辑后直接保存且不显示确认或统计',
      Boolean(!retentionDialog),
      retentionDialog ? await textOf(win, '[role="alertdialog"]') : ''
    )
    const decreasedSettings = await waitForFileVersionSettings(
      win,
      20,
      FILE_VERSION_MAX_SIZE_KB
    )
    record(
      '自动保存只更新调低后的版本上限配置',
      decreasedSettings?.max_versions_per_file === 20,
      `${JSON.stringify(decreasedSettings ?? {})} form=${await fileVersionFormState(win)}`
    )
  }

  const passed = steps.filter((s) => s.ok).length
  const failed = steps.length - passed
  log(`[workbench] result passed=${passed} failed=${failed}\n`)
  if (failed > 0) {
    log(`[workbench] failures: ${steps.filter((s) => !s.ok).map((s) => s.name).join(' | ')}\n`)
  }
  // 清理要走真实 serve 接口，必须赶在主进程退出之前。
  await cleanupResidue(win, log)
  return failed > 0 ? 1 : 0
}
