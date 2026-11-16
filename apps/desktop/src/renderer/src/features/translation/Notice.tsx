import { useTranslation } from 'react-i18next'
import { useToast } from '../../components/ui'

type Notice = 'recovered' | 'rate_limited'

function Message({ kind }: { kind: Notice }): React.JSX.Element {
  const { t } = useTranslation('components')
  return (
    <>{kind === 'recovered' ? t('translation.recovered') : t('translation.errors.rate_limited')}</>
  )
}

export function useTranslationNotice(): (kind: Notice) => void {
  const { toast } = useToast()
  return (kind) => {
    toast({
      title: <Message kind={kind} />,
      tone: kind === 'recovered' ? 'info' : 'warning',
      dedupeKey: `translation-${kind}`,
    })
  }
}
