import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { LiteratureSummary } from '../../contracts/literature'
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  Input
} from '../../components/ui'
import { LiteratureApiError, importIdentifier } from './api'
import type { ImportDestination } from './catalog'
import { identifierImportFailureKey, type IdentifierImportFailureKey } from './error'
import { claimSubmission } from './submission'

/** 没有落点概念的调用方（首页）交出的空落点：服务端把空值当全库根。 */
const LIBRARY_ROOT: ImportDestination = { projectId: '', collectionId: '' }

export interface IdentifierImportProps {
  onClose: () => void
  onImported: (item: LiteratureSummary) => void
  /**
   * 落点在提交那一刻才取：侧边栏「+」带过来的 override 是一次性的，打开对话框时就读
   * 会读到上一次的落点。不传即导入全库根。
   */
  resolveDestination?: () => ImportDestination
}

/**
 * 「从 ArXiv ID / DOI 导入」的单行输入框。
 *
 * 输入、提交锁与失败文案全部由这里自己持有，只把「导入了哪一条」交回调用方 —— 文献页
 * 与首页因此挂同一份实现，不必像 PDF 导入那样每页各复制一遍状态机。
 */
export function IdentifierImport({
  onClose,
  onImported,
  resolveDestination
}: IdentifierImportProps): React.JSX.Element {
  const { t } = useTranslation('literature')
  const { t: ui } = useTranslation('ui')
  const [identifier, setIdentifier] = useState('')
  const [failure, setFailure] = useState<IdentifierImportFailureKey | null>(null)
  const [saving, setSaving] = useState(false)
  const submitting = useRef(false)

  const submit = async (): Promise<void> => {
    const value = identifier.trim()
    // 受理返回前对话框还开着，这里必须自己闭锁：连点会各起一次导入，而文献库是追加
    // 语义（proposal 91），两次点击就是两条重复题录。
    if (!value || !claimSubmission(submitting)) return
    setSaving(true)
    setFailure(null)
    try {
      const item = await importIdentifier(value, resolveDestination?.() ?? LIBRARY_ROOT)
      submitting.current = false
      setSaving(false)
      setIdentifier('')
      onClose()
      onImported(item)
    } catch (reason) {
      submitting.current = false
      setSaving(false)
      setFailure(
        identifierImportFailureKey(reason instanceof LiteratureApiError ? reason.failure.code : null)
      )
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      {/* 与同目录的创建/移动弹窗一致：渲染在文献面板内会被祖先 stacking context 困住，遮罩盖不住活动栏与分栏拖拽条。 */}
      <DialogPortal>
        <DialogContent data-testid="identifier-import">
          <DialogHeader>
            <DialogTitle>{t('identifierImport.title')}</DialogTitle>
            <DialogDescription>{t('identifierImport.description')}</DialogDescription>
          </DialogHeader>
          {failure ? <Alert tone="error" title={t(failure)} /> : null}
          <Input
            autoFocus
            data-testid="identifier-import-input"
            disabled={saving}
            label={t('identifierImport.label')}
            onChange={(event) => {
              setIdentifier(event.target.value)
              setFailure(null)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
              void submit()
            }}
            placeholder={t('identifierImport.placeholder')}
            value={identifier}
          />
          <DialogFooter>
            <Button disabled={saving} onClick={onClose} variant="outline">
              {ui('cancel')}
            </Button>
            <Button
              data-testid="identifier-import-submit"
              disabled={!identifier.trim()}
              loading={saving}
              onClick={() => void submit()}
            >
              {t('identifierImport.submit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
