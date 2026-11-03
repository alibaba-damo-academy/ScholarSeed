import { Copy } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { writeClipboard } from '../primitive/clipboard'
import { CopyButton, Tooltip } from '../ui'

export function FeedbackReceipt({ ticket }: { ticket: string }): React.JSX.Element {
  const { t } = useTranslation('components')
  const receipt = t('feedback.ticketLine', { ticket })

  return (
    <span className="flex items-center gap-[var(--vds-space-1)]">
      <span className="min-w-0 cursor-text select-text break-all" data-testid="feedback-ticket">{receipt}</span>
      <Tooltip content={t('feedback.copyTicket')} portalled>
        <CopyButton
          type="button"
          value={receipt}
          writeText={writeClipboard}
          iconOnly
          icon={<Copy />}
          size="sm"
          variant="ghost"
          idleLabel={t('feedback.copyTicket')}
          copiedLabel={t('feedback.copied')}
          data-testid="feedback-copy"
        />
      </Tooltip>
    </span>
  )
}
