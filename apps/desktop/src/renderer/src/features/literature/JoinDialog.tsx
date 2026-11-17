import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  Radio,
  RadioGroup,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui'
import type { JoinScope } from './join'
import type { JoinDestination } from './hierarchy'

export const NO_COLLECTION_KEY = 'none'

export interface JoinScopeOption extends JoinDestination {
  key: string
  label: string
}

/**
 * 批量加入文献库: 元信息一定入, 「元信息和全文」只在真的已经有下载完成的全文时才出现。
 *
 * `heldCount` 缺省表示这批结果根本没有可复用的全文来源 (不是精确检索卡片, 或查询失败),
 * 此时整个加入方式选择都不渲染, 行为就是仅元信息 —— 不给用户一个点下去会落空的选项。
 */
export function JoinScopeDialog({
  open,
  busy,
  count,
  heldCount,
  options,
  loadFailed,
  loading,
  onClose,
  onConfirm,
}: {
  open: boolean
  busy: boolean
  count: number
  heldCount?: number
  options: JoinScopeOption[]
  loadFailed?: boolean
  loading?: boolean
  onClose: () => void
  onConfirm: (scope: JoinScope, destination?: JoinScopeOption) => void
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const [scope, setScope] = useState<JoinScope>('metadata')
  const [collectionKey, setCollectionKey] = useState(NO_COLLECTION_KEY)
  useEffect(() => {
    if (open) {
      setScope('metadata')
      setCollectionKey(NO_COLLECTION_KEY)
    }
  }, [open])
  const held = heldCount ?? 0
  const chooseScope = held > 0
  const close = (): void => {
    if (!busy) onClose()
  }
  const confirm = (): void => {
    if (busy || loading || loadFailed) return
    const destination = options.find((option) => option.key === collectionKey)
    if (collectionKey !== NO_COLLECTION_KEY && !destination) return
    // 没有全文来源时不给选择, 也就不能带着上一次残留的 scope 提交。
    onConfirm(chooseScope ? scope : 'metadata', destination)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close()
      }}
    >
      <DialogPortal>
        <DialogContent
          aria-label={t('joinScope.title')}
          onClick={(event) => event.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>{t('joinScope.title')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-[var(--vds-space-4)]">
            <span className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]">
              {t('joinScope.selected', { count })}
            </span>
            {chooseScope ? (
              <RadioGroup
                aria-label={t('joinScope.method')}
                value={scope}
                disabled={busy}
                onValueChange={(value) => setScope(value as JoinScope)}
              >
                <Radio value="metadata">{t('joinScope.metadataOnly')}</Radio>
                <Radio value="fulltext" align="first-line">
                  <span className="flex flex-col gap-[var(--vds-space-1)]">
                    <span>{t('joinScope.withFulltext')}</span>
                    <span className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                      {t('joinScope.held', { count: held })}
                    </span>
                  </span>
                </Radio>
              </RadioGroup>
            ) : null}
            <Select
              label={t('joinScope.collection')}
              value={collectionKey}
              disabled={busy || loading || loadFailed}
              onValueChange={setCollectionKey}
            >
              <SelectTrigger aria-label={t('joinScope.collection')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_COLLECTION_KEY}>{t('joinScope.noCollection')}</SelectItem>
                {options.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {loadFailed ? (
              <p role="alert" className="text-[var(--vds-error-text-primary)]">
                {t('joinScope.loadFailed')}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={close}>
              {t('joinScope.cancel')}
            </Button>
            <Button loading={busy} disabled={busy || loading || loadFailed} onClick={confirm}>
              {t('joinScope.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
