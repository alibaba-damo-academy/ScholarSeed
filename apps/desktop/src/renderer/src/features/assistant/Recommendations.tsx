import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Textarea,
} from '../../components/ui'
import { nextStepMessage, type NextStepsContent } from './suggestions'

export function Suggestions({
  payload,
  available,
  busy,
  failed,
  draft,
  onDraft,
  onSend,
}: {
  payload: NextStepsContent
  available: boolean
  busy: boolean
  failed: boolean
  draft: string
  onDraft: (value: string) => void
  onSend: (message: string) => void | Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  return (
    <Card data-testid="next-steps-card" aria-busy={busy}>
      <CardHeader>
        <CardTitle>{payload.title}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-[var(--vds-space-3)]">
        {payload.options.map((option) => (
          <Button
            key={option.label}
            variant="secondary"
            size="content"
            className="w-full min-w-0 flex-col items-start !whitespace-normal text-left"
            disabled={!available || busy}
            onClick={() => void onSend(nextStepMessage(option))}
          >
            <span className="w-full break-words">{option.label}</span>
            <span className="w-full break-words">{option.description}</span>
          </Button>
        ))}
        <Textarea
          label={payload.free_text_label}
          value={draft}
          rows={2}
          disabled={!available || busy}
          onChange={(event) => onDraft(event.target.value)}
        />
        {failed && (
          <Alert tone="error">
            <AlertDescription>{t('retry.continueUnconfirmed')}</AlertDescription>
          </Alert>
        )}
        <div className="flex justify-end">
          <Button
            loading={busy}
            disabled={!available || !draft.trim()}
            onClick={() => void onSend(draft)}
          >
            {payload.submit_label}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
