import React from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Hammer, Plug } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import type { FeatureModule } from '../../contracts/features'
import { Skills } from '../../components/business/Skills'
import { Button, Page, PageBody, Tabs, TabsList, TabsTrigger } from '../../components/ui'
import { useApp } from '../../store'
import { Connectors } from './Connectors'

const NAVIGATION_TRIGGER_CLASS =
  '!h-[var(--vds-control-height-md)] !gap-[var(--vds-navigation-button-gap)] !pl-[var(--vds-space-2)] !pr-[var(--vds-space-3)] !py-[calc(var(--vds-space-1)+var(--vds-space-half))] !rounded-[var(--vds-radius-4)] !text-[length:var(--vds-font-body-lv2)] !font-[var(--vds-fw-regular)] !leading-[var(--vds-lh-body-lv2)] data-[state=active]:!font-[var(--vds-fw-medium)] data-[state=active]:!bg-[var(--vds-other-overlay-2)] data-[state=active]:!shadow-none'

function SkillCenter(): React.JSX.Element {
  const { t } = useTranslation('skills')
  const { t: components } = useTranslation('components')
  const { state, act } = useApp()
  const returnProject = state.projects.find(
    (project) => project.id === state.workbenchReturnProjectId
  )
  const [section, setSection] = React.useState('skills')
  const [navigationHost, setNavigationHost] = React.useState<Element | null>(null)
  React.useEffect(() => {
    setNavigationHost(document.querySelector('[data-home-header-navigation]'))
  }, [])
  const navigation = (
    <Tabs value={section} onValueChange={(value) => setSection(String(value))}>
      <TabsList
        aria-label={t('connectors.navigation')}
        className="!h-[var(--vds-control-height-md)] !justify-start !gap-[var(--vds-space-2)] !bg-transparent !p-0 [&>span]:hidden"
      >
        <TabsTrigger value="skills" className={NAVIGATION_TRIGGER_CLASS}>
          <Hammer aria-hidden="true" className="size-[var(--vds-icon-8)]" />
          {t('connectors.skills')}
        </TabsTrigger>
        <TabsTrigger value="connectors" className={NAVIGATION_TRIGGER_CLASS}>
          <Plug aria-hidden="true" className="size-[var(--vds-icon-8)]" />
          {t('connectors.title')}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
  return (
    <Page
      padding="none"
      className={`h-full overflow-hidden py-[var(--vds-space-4)] ${section === 'skills' ? '[--vds-skills-page-inset:var(--vds-space-6)]' : 'px-[var(--vds-space-6)]'}`}
      data-testid="skill-center"
    >
      {navigationHost ? createPortal(navigation, navigationHost) : navigation}
      {returnProject && (
        <Button
          variant="ghost"
          className={`mb-[var(--vds-space-3)] w-fit ${section === 'skills' ? 'mx-[var(--vds-space-6)]' : ''}`}
          data-testid="skills-return-conversation"
          icon={<ArrowLeft aria-hidden="true" />}
          onClick={() => {
            act.selectProject(returnProject.id)
            act.openWorkbenchView('resource', { preserveProject: true })
          }}
        >
          {components('composer.returnSkillConversation')}
        </Button>
      )}
      <PageBody className="min-h-0 flex-1 grid-rows-[minmax(0,1fr)]">
        {section === 'skills' ? <Skills /> : <Connectors />}
      </PageBody>
    </Page>
  )
}

export function skillsFeature(): FeatureModule {
  return {
    id: 'skills',
    activityItems: [
      {
        key: 'skills',
        label: (i18n) => i18n.getFixedT(null, 'layout')('extensions'),
        icon: 'sparkle',
        order: 40,
      },
    ],
    panels: [
      {
        key: 'skills',
        title: (i18n) => i18n.getFixedT(null, 'layout')('skills'),
        slot: 'page',
        render: () => <SkillCenter />,
      },
    ],
  }
}
