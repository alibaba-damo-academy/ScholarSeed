import React from 'react'
import { useTranslation } from 'react-i18next'

/**
 * 统一「待实现」占位（MVP 0.2）。
 *
 * 档位 C 的功能一律使用本组件，便于全局检索尚未落地的点，也保证
 * 多人开发时占位文案与视觉一致。feature 标明归属模块，让开发者
 * 一眼看出该由谁补齐。
 */
export function Pending({
  feature,
  owner,
  detail,
  inline = false
}: {
  /** 功能名，例如「DOCX 编辑」。 */
  feature: string
  /** 归属模块，例如「审阅与版本」。 */
  owner?: string
  /** 补充说明：为什么留空，补齐时要注意什么。 */
  detail?: string
  /**
   * 行内模式：嵌在已可用视图旁边提示「这一小块待实现」，
   * 而不是占整个面。例如 PDF 已能预览，仅高亮批注未做。
   */
  inline?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  if (inline) {
    return (
      <div
        data-testid="pending-placeholder"
        data-feature={feature}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          fontSize: 11.5,
          color: 'var(--text-4)',
          borderTop: '1px dashed var(--border)',
          background: 'var(--bg-2)'
        }}
      >
        <span style={{ fontWeight: 600 }}>{t('pending.title', { feature })}</span>
        {owner && <span>{t('pending.owner', { owner })}</span>}
        {detail && <span>{detail}</span>}
      </div>
    )
  }

  return (
    <div
      data-testid="pending-placeholder"
      data-feature={feature}
      style={{
        display: 'grid',
        placeItems: 'center',
        height: '100%',
        padding: 32
      }}
    >
      <div
        style={{
          maxWidth: 420,
          textAlign: 'center',
          border: '1px dashed var(--border)',
          borderRadius: 'var(--radius-lg)',
          padding: '28px 24px',
          background: 'var(--bg-2)'
        }}
      >
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>
          {t('pending.title', { feature })}
        </div>
        {owner && (
          <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--text-4)' }}>
            {t('pending.owner', { owner })}
          </div>
        )}
        <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.7, color: 'var(--text-2)' }}>
          {detail ?? t('pending.detail')}
        </div>
      </div>
    </div>
  )
}
