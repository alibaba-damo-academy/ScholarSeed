import React from 'react'
import { useTranslation } from 'react-i18next'

import type { FeatureModule } from '../../contracts/features'
import { Pending } from '../../shell/Pending'
import { useApp } from '../../store'

/**
 * 每个 viewer 单独成 chunk，按 kind 真正被打开时才加载。
 *
 * 这些组件各自拖着很重的依赖树（Monaco、pdfjs + pdf-lib、milkdown/prosemirror/
 * codemirror），静态导入会把它们全部钉进首屏 —— 而冷启动时用户还没有打开任何文档。
 * lazy 在模块作用域创建一次；放进 render 会让每次渲染都产出新组件类型而丢掉状态。
 * 加载边界由组合根统一施加（见 `app/composition.tsx`）。
 */
const MarkdownDocument = React.lazy(() => import('./MarkdownDocument')
  .then((module) => ({ default: module.MarkdownDocument })))
const MonacoDocument = React.lazy(() => import('./MonacoDocument')
  .then((module) => ({ default: module.MonacoDocument })))
const PdfDocument = React.lazy(() => import('./PdfDocument')
  .then((module) => ({ default: module.PdfDocument })))
const OfficeDocument = React.lazy(() => import('./OfficeDocument')
  .then((module) => ({ default: module.OfficeDocument })))
const ImageDocument = React.lazy(() => import('./ImageDocument')
  .then((module) => ({ default: module.ImageDocument })))
const TableViewer = React.lazy(() => import('./viewers/TableViewer')
  .then((module) => ({ default: module.TableViewer })))
const VersionDiff = React.lazy(() => import('./VersionDiff')
  .then((module) => ({ default: module.VersionDiff })))

export { VersionHistory } from './VersionHistory'

/**
 * Workbench Feature 贡献声明（开发 4 拥有）。
 *
 * 这里是原先 `Workbench.tsx` 里 `switch (viewerForPath(path))` 的替代品：
 * 每种 viewer 注册一次，Shell 按 kind 查表。架构文档 §4.3 要求的
 * "不按扩展名在 Shell 写分支"由此成立 —— 扩展名 → kind 的映射在后端
 * `/api/workbench/open`，kind → 组件的映射在这张表。
 *
 * 注意各 viewer 仍需要 `project`：它们内部要拼接 `/api/resource/raw` 的
 * 查询参数。project 从 store 取而不从 props 传，避免每个 render 回调
 * 都要透传一层。
 */
export function workbenchFeature(): FeatureModule {
  return {
    id: 'workbench',
    viewerPlugins: [
      {
        kind: 'version_diff',
        render: ({ tabId }) => tabId
          ? <VersionDiff tabId={tabId} />
          : <UnavailableViewer kind="version_diff" />
      },
      {
        kind: 'markdown',
        toolbar: 'viewer',
        render: ({ path, documentSessionId, tabId, viewKind, toolbarActions }) =>
          documentSessionId && tabId && viewKind
            ? (
                <MarkdownDocumentHost
                  sessionId={documentSessionId}
                  tabId={tabId}
                  toolbarActions={toolbarActions}
                  viewKind={viewKind}
                />
              )
            : <UnavailableViewer kind="markdown" path={path} />
      },
      {
        kind: 'pdf',
        toolbar: 'viewer',
        render: ({ active, path, documentSessionId, documentPanels, tabId }) => documentSessionId && tabId
          ? <PdfDocumentHost active={active} documentPanels={documentPanels} sessionId={documentSessionId} tabId={tabId} />
          : <UnavailableViewer kind="pdf" path={path} />
      },
      { kind: 'table', render: ({ path }) => <TableViewerHost path={path} /> },
      {
        kind: 'code',
        toolbar: 'viewer',
        render: ({ path, documentSessionId, tabId, viewKind, toolbarActions }) =>
          documentSessionId && tabId && viewKind
            ? <MonacoDocumentHost sessionId={documentSessionId} tabId={tabId} viewKind={viewKind} toolbarActions={toolbarActions} />
            : <UnavailableViewer kind="code" path={path} />
      },
      { kind: 'image', render: ({ documentSessionId, tabId }) => documentSessionId && tabId
        ? <ImageDocument sessionId={documentSessionId} tabId={tabId} />
        : <UnavailableViewer kind="image" /> },
      {
        kind: 'office',
        render: ({ documentSessionId, tabId, viewKind }) => documentSessionId && tabId && viewKind
          ? <OfficeDocument kind="office" sessionId={documentSessionId} tabId={tabId} viewKind={viewKind} />
          : <UnavailableViewer kind="office" />
      },
      {
        kind: 'spreadsheet',
        render: ({ documentSessionId, tabId, viewKind }) => documentSessionId && tabId && viewKind
          ? <OfficeDocument kind="spreadsheet" sessionId={documentSessionId} tabId={tabId} viewKind={viewKind} />
          : <UnavailableViewer kind="spreadsheet" />
      },
      {
        kind: 'unsupported',
        render: ({ path, contentKind }) => (
          <UnavailableViewer kind="unsupported" path={path} contentKind={contentKind} />
        )
      }
    ]
  }
}

/**
 * viewer 宿主：把 store 里的当前项目补给具体 viewer。
 *
 * 单独一层薄壳而不让每个 viewer 自己 useApp：viewer 是可被其它宿主
 * （比如将来的分屏、预览弹窗）复用的纯展示组件，让它自己读全局 store
 * 会把它绑死在当前 Shell 上。
 */
function useProject(): string | null {
  return useApp().state.homeSelectedProjectId
}

function MarkdownDocumentHost(props: {
  sessionId: string
  tabId: string
  toolbarActions?: React.ReactNode
  viewKind: 'preview' | 'edit'
}): React.JSX.Element {
  const formatOnSave = useApp().state.formatOnSave
  return <MarkdownDocument {...props} formatOnSave={formatOnSave} />
}

function MonacoDocumentHost(props: {
  sessionId: string
  tabId: string
  toolbarActions?: React.ReactNode
  viewKind: 'preview' | 'edit'
}): React.JSX.Element {
  const formatOnSave = useApp().state.formatOnSave
  return <MonacoDocument {...props} formatOnSave={formatOnSave} />
}

function TableViewerHost({ path }: { path: string }): React.JSX.Element {
  return <TableViewer path={path} project={useProject()} />
}

function PdfDocumentHost({
  active,
  documentPanels,
  sessionId,
  tabId
}: {
  active: boolean
  documentPanels?: React.ComponentProps<typeof PdfDocument>['documentPanels']
  sessionId: string
  tabId: string
}): React.JSX.Element {
  const { act } = useApp()
  return (
    <PdfDocument
      active={active}
      documentPanels={documentPanels}
      onResourceImported={async () => {
        await act.reloadResourceTree()
      }}
      sessionId={sessionId}
      tabId={tabId}
    />
  )
}

const VIEWER_MESSAGE_KEYS = {
  markdown: 'viewer.markdown',
  pdf: 'viewer.pdf',
  code: 'viewer.code',
  image: 'viewer.image',
  office: 'viewer.office',
  spreadsheet: 'viewer.spreadsheet',
  version_diff: 'viewer.versionDiff',
  unsupported: 'viewer.unsupported'
} as const

function UnavailableViewer({ kind, path = '', contentKind }: {
  kind: keyof typeof VIEWER_MESSAGE_KEYS
  path?: string
  contentKind?: string
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const detail = kind === 'unsupported'
    ? contentKind === 'oversized'
      ? t('viewer.oversized', { path })
      : contentKind === 'binary'
        ? t('viewer.binary', { path })
        : t('viewer.noPreview', { path })
    : path
      ? t('viewer.openPath', { path })
      : t('viewer.open')
  return <Pending feature={t(VIEWER_MESSAGE_KEYS[kind])} owner={t('unavailable.workspace')} detail={detail} />
}
