import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, FileUp, FolderUp, Link, type LucideIcon } from 'lucide-react'

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ScrollArea,
  Spinner
} from '../../components/ui'
import { useApp } from '../../store'
import { hasDraggedFiles, resolveDraggedFilePaths } from '../../drag'
import {
  IMPORT_PICKER_TARGET,
  supportsImportPickerTarget,
  type ImportPickerTarget
} from '../../../../picker'
import type { ResourceImportDecisionAction } from './api'
import type { ImportMode } from './state'

/**
 * 两种导入方式的文案，直接取自 PRD「资料导入」与原型弹窗。
 *
 * 复制会落项目内副本；关联把用户明确选择的文件或目录登记成
 * 虚拟挂载点，不扩大授权到文件所在的整个目录。
 */
interface ImportChoice {
  mode: ImportMode
  titleKey: 'localImport.copyTitle' | 'localImport.linkTitle'
  detail: 'localImport.copyDetail' | 'localImport.linkDetail'
  icon: LucideIcon
  dropEffect: 'copy' | 'link'
  dropAction: 'localImport.copyDrop' | 'localImport.linkDrop'
}

const IMPORT_CHOICES: readonly ImportChoice[] = [
  {
    mode: 'copy',
    titleKey: 'localImport.copyTitle',
    detail: 'localImport.copyDetail',
    icon: Copy,
    dropEffect: 'copy',
    dropAction: 'localImport.copyDrop'
  },
  {
    mode: 'link',
    titleKey: 'localImport.linkTitle',
    detail: 'localImport.linkDetail',
    icon: Link,
    dropEffect: 'link',
    dropAction: 'localImport.linkDrop'
  }
]

const IMPORT_CARD_CLASS_NAME = [
  'h-full w-full min-w-0 flex-col justify-start overflow-hidden',
  'rounded-[var(--vds-radius-8)] p-[var(--vds-space-6)] text-center !whitespace-normal !gap-[var(--vds-space-5)]'
].join(' ')
const IMPORT_ICON_CLASS_NAME =
  'grid size-10 place-items-center rounded-[var(--vds-radius-4)] border border-[var(--vds-fill-6)] bg-[var(--vds-bg-white-default)] text-[var(--vds-brand-text-primary)]'
type ImportBusyAction = ImportMode | ResourceImportDecisionAction

/**
 * 导入本地资料弹窗（PRD「资料导入」：复制 / 关联 二选一）。
 *
 * 来源可用系统选择器多选（Electron 主进程 `pickImport`），也可从操作系统
 * 拖入后由 preload 解析真实路径。复制与关联均由 `/api/resource/import-jobs`
 * 持久受理并投影到任务中心；重名决策继续由资料导入 API 能力承载。
 */
export function ImportDialog(): React.JSX.Element {
  const { t } = useTranslation('resources')
  const { t: uiText } = useTranslation('ui')
  const { state, set, act } = useApp()
  const [busy, setBusy] = useState<ImportBusyAction | null>(null)
  const [dropMode, setDropMode] = useState<ImportMode | null>(null)
  const dragDepthRef = useRef<Record<ImportMode, number>>({ copy: 0, link: 0 })
  const dialog = state.resource.importDialog

  const close = (): void => {
    if (busy === null) set({ resource: { ...state.resource, importDialog: null } })
  }

  const importSources = async (mode: ImportMode, sources: string[]): Promise<void> => {
    if (busy !== null || sources.length === 0) return
    setBusy(mode)
    try {
      await act.importResourceFiles(mode, sources)
    } finally {
      setBusy(null)
    }
  }

  const pickAndImport = async (
    mode: ImportMode,
    target: ImportPickerTarget
  ): Promise<void> => {
    if (busy !== null) return
    const pick = window.scholarseed?.pickImport
    if (!pick) {
      act.noticeResource('error', { key: 'localImport.pickerUnavailable' })
      return
    }
    const picked = await pick(target)
    await importSources(mode, picked)
  }

  const clearDropMode = (mode: ImportMode): void => {
    dragDepthRef.current[mode] = 0
    setDropMode((current) => current === mode ? null : current)
  }

  const dropFiles = (mode: ImportMode, event: React.DragEvent<HTMLButtonElement>): void => {
    if (!hasDraggedFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    clearDropMode(mode)
    if (busy !== null) return

    const resolved = resolveDraggedFilePaths(
      event.dataTransfer.files,
      window.scholarseed?.pathForFile
    )
    if (resolved.unresolvedCount > 0 || resolved.paths.length === 0) {
      act.noticeResource('error', { key: 'localImport.dropPathError' })
      return
    }
    void importSources(mode, resolved.paths)
  }

  const resolveConflict = async (action: ResourceImportDecisionAction): Promise<void> => {
    if (busy !== null) return
    setBusy(action)
    try {
      await act.resolveResourceImport(action)
    } finally {
      setBusy(null)
    }
  }

  if (!dialog) return <></>
  const resolving = dialog.phase === 'resolve'
  const canReplace = resolving && dialog.conflicts.every((item) => item.canReplaceWithVersion)
  const activeChoice = IMPORT_CHOICES.find((choice) => choice.mode === dropMode)
  const usesUnifiedPicker = supportsImportPickerTarget(
    window.scholarseed?.platform,
    IMPORT_PICKER_TARGET.RESOURCE
  )

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open) close()
    }}>
      <DialogContent
        aria-label={resolving ? t('localImport.resolveLabel') : t('localImport.title')}
        data-testid="resource-import-dialog"
        onDragOver={(event) => {
          if (!resolving && hasDraggedFiles(event.dataTransfer)) event.preventDefault()
        }}
        onDrop={(event) => {
          if (!resolving && hasDraggedFiles(event.dataTransfer)) event.preventDefault()
        }}
      >
        {resolving ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('localImport.conflictTitle')}</DialogTitle>
              <DialogDescription>
                {t('localImport.conflictDescription')}
              </DialogDescription>
            </DialogHeader>
            <Alert className="mt-4" tone="warning">
              <AlertTitle>{t('localImport.conflicts', { count: dialog.conflicts.length })}</AlertTitle>
              <AlertDescription truncate={false}>
                {t('localImport.replaceHint')}
              </AlertDescription>
            </Alert>
            <ScrollArea
              className="mt-4 max-h-[260px] rounded-[10px] border border-[var(--vds-border-default)]"
              viewportClassName="max-h-[260px]"
            >
              <ul className="divide-y divide-[var(--vds-border-default)]" data-testid="resource-import-conflicts">
                {dialog.conflicts.map((conflict) => (
                  <li className="px-4 py-3" key={conflict.sourceIndex}>
                    <div className="text-[13px] font-[var(--vds-fw-semibold)] text-[var(--vds-text-primary)]">
                      {conflict.sourceName}
                    </div>
                    <div className="mt-1 break-all text-[11.5px] text-[var(--vds-text-secondary)]">
                      {t('localImport.renameTo', { name: conflict.suggestedName })}
                    </div>
                    {!conflict.canReplaceWithVersion && (
                      <div className="mt-1 text-[11px] text-[var(--vds-status-warning-text)]">
                        {t('localImport.cannotReplace')}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </ScrollArea>
            <DialogFooter className="mt-5">
              <Button disabled={busy !== null} variant="outline" onClick={close}>{uiText('cancel')}</Button>
              <Button
                data-testid="resource-import-rename"
                disabled={busy !== null}
                loading={busy === 'rename'}
                variant="secondary"
                onClick={() => void resolveConflict('rename')}
              >
                {t('localImport.renameImport')}
              </Button>
              <Button
                data-testid="resource-import-replace"
                disabled={busy !== null || !canReplace}
                loading={busy === 'replace'}
                variant="danger"
                onClick={() => void resolveConflict('replace')}
              >
                {t('localImport.replaceImport')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('localImport.title')}</DialogTitle>
              <DialogDescription className="sr-only">
                {t('localImport.description')}
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-1 gap-[var(--vds-space-5)] sm:grid-cols-2">
              {IMPORT_CHOICES.map((choice) => {
                const dropActive = dropMode === choice.mode
                const ChoiceIcon = choice.icon
                const choiceButton = (
                  <Button
                    aria-busy={busy === choice.mode}
                    aria-label={t('localImport.choiceLabel', { title: t(choice.titleKey), action: dropActive ? t(choice.dropAction) : t('localImport.pick') })}
                    className={IMPORT_CARD_CLASS_NAME}
                    data-drop-active={dropActive ? 'true' : 'false'}
                    data-import-mode={choice.mode}
                    data-testid={`import-${choice.mode}`}
                    disabled={busy !== null}
                    size="content"
                    variant="dropzone"
                    onClick={usesUnifiedPicker
                      ? () => void pickAndImport(choice.mode, IMPORT_PICKER_TARGET.RESOURCE)
                      : undefined}
                    onDragEnd={() => clearDropMode(choice.mode)}
                    onDragEnter={(event) => {
                      if (!hasDraggedFiles(event.dataTransfer) || busy !== null) return
                      event.preventDefault()
                      dragDepthRef.current[choice.mode] += 1
                      setDropMode(choice.mode)
                    }}
                    onDragLeave={(event) => {
                      event.preventDefault()
                      dragDepthRef.current[choice.mode] = Math.max(
                        0,
                        dragDepthRef.current[choice.mode] - 1
                      )
                      if (dragDepthRef.current[choice.mode] === 0) clearDropMode(choice.mode)
                    }}
                    onDragOver={(event) => {
                      if (!hasDraggedFiles(event.dataTransfer)) return
                      event.preventDefault()
                      if (busy !== null) {
                        event.dataTransfer.dropEffect = 'none'
                        return
                      }
                      event.dataTransfer.dropEffect = choice.dropEffect
                      setDropMode(choice.mode)
                    }}
                    onDrop={(event) => dropFiles(choice.mode, event)}
                  >
                    <span className={IMPORT_ICON_CLASS_NAME}>
                      {busy === choice.mode
                        ? <Spinner size="sm" />
                        : <ChoiceIcon className="size-4" strokeWidth={1.8} />}
                    </span>
                    <span className="w-full min-w-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">{t(choice.titleKey)}</span>
                    <span className="w-full min-w-0 max-w-[360px] break-words text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-tertiary)]">{t(choice.detail)}</span>
                  </Button>
                )
                if (usesUnifiedPicker) {
                  return <React.Fragment key={choice.mode}>{choiceButton}</React.Fragment>
                }
                return (
                  <DropdownMenu key={choice.mode}>
                    <DropdownMenuTrigger asChild>
                      {choiceButton}
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="center"
                      className="!z-[calc(var(--vds-z-modal)+1)]"
                    >
                      <DropdownMenuItem
                        data-testid={`import-${choice.mode}-file`}
                        onSelect={() => void pickAndImport(choice.mode, IMPORT_PICKER_TARGET.FILE)}
                      >
                        <FileUp />
                        {t('localImport.pickFile')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        data-testid={`import-${choice.mode}-directory`}
                        onSelect={() => void pickAndImport(choice.mode, IMPORT_PICKER_TARGET.DIRECTORY)}
                      >
                        <FolderUp />
                        {t('localImport.pickDirectory')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )
              })}
            </div>
            {activeChoice ? (
              <p
                aria-live="polite"
                className="mb-0 text-center text-[length:var(--vds-font-subhead)] leading-[var(--vds-lh-subhead)] text-[var(--vds-brand-text-placeholder)]"
                data-testid="resource-import-drop-hint"
              >
                {t(activeChoice.dropAction)}
              </p>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
