import React from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { FileFormatIcon } from '../primitive'

export function setFileDragPreview(
  transfer: DataTransfer,
  name: string,
  kind: 'file' | 'dir',
  iconName = name
): void {
  const host = document.createElement('div')
  host.className = 'pointer-events-none fixed top-0 right-full w-max'
  host.setAttribute('aria-hidden', 'true')
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => {
      root.render(
        <div className="flex w-max max-w-xs items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-primary)] shadow-[var(--vds-shadow-2-center)]">
          <FileFormatIcon name={iconName} kind={kind} />
          <span className="min-w-0 truncate">{name}</span>
        </div>
      )
    })
    const bubble = host.firstElementChild
    if (bubble) transfer.setDragImage(bubble, 0, 0)
  } finally {
    requestAnimationFrame(() => {
      root.unmount()
      host.remove()
    })
  }
}
