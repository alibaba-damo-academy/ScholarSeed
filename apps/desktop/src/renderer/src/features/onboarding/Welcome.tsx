import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Box, MessageSquare, FileText } from 'lucide-react'
import type { Project } from '../../api'
import { ProjectForm } from '../../components/business/ProjectForm'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../components/ui'

/** One welcome-to-project flow, sharing the normal project form and creation API. */
export function Welcome({
  onComplete,
  onSkip,
}: {
  onComplete: (project: Project) => Promise<void>
  onSkip: () => void
}): React.JSX.Element {
  const { t } = useTranslation('onboarding')
  const [creating, setCreating] = useState(false)
  if (creating)
    return (
      <ProjectForm
        target={{ mode: 'create' }}
        heading={t('home.createTitle')}
        introduction={t('home.createDescription')}
        onClose={onSkip}
        onCancel={() => {
          setCreating(false)
        }}
        onDone={async (_message, project) => {
          if (!project) throw new Error('onboarding_project_missing')
          await onComplete(project)
        }}
        footerLeading={(formBusy) => (
          <Button variant="ghost" disabled={formBusy} onClick={onSkip}>
            {t('home.skipGuide')}
          </Button>
        )}
      />
    )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onSkip()
      }}
    >
      <DialogContent
        hideCloseButton
        data-ob="guide-home"
        aria-label={t('home.title')}
        className="!z-[var(--vds-z-modal)] !w-[var(--vds-onboarding-welcome-width)] !max-w-none max-h-[var(--vds-onboarding-card-height)] overflow-y-auto !rounded-[var(--vds-radius-8)] !p-[var(--vds-space-6)]"
        overlayClassName="!z-[var(--vds-z-overlay)]"
      >
        <DialogHeader>
          <DialogTitle>{t('home.title')}</DialogTitle>
          <DialogDescription>{t('home.introduction')}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-[var(--vds-space-3)]">
          {(
            [
              { titleKey: 'home.projectTitle', bodyKey: 'home.projectBody', Icon: Box },
              { titleKey: 'home.taskTitle', bodyKey: 'home.taskBody', Icon: MessageSquare },
              { titleKey: 'home.outputTitle', bodyKey: 'home.outputBody', Icon: FileText },
            ] as const
          ).map(({ titleKey, bodyKey, Icon }) => (
            <div
              key={titleKey}
              className="flex items-start gap-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] bg-[var(--vds-surface-muted)] p-[var(--vds-space-3)]"
            >
              <span
                aria-hidden
                className="grid size-[var(--vds-space-8)] shrink-0 place-items-center rounded-[var(--vds-radius-4)] bg-[var(--vds-brand-light-bg-default)] text-[var(--vds-brand-text-primary)]"
              >
                <Icon className="size-[var(--vds-icon-8)]" />
              </span>
              <div className="grid gap-[var(--vds-space-1)]">
                <strong>{t(titleKey)}</strong>
                <p className="m-0 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)]">
                  {t(bodyKey)}
                </p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-[var(--vds-space-2)] flex flex-wrap items-center justify-between gap-[var(--vds-space-3)]">
          <Button variant="ghost" onClick={onSkip}>
            {t('home.skipGuide')}
          </Button>
          <Button data-ob="guide-start-project" onClick={() => setCreating(true)}>
            {t('home.createTitle')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
