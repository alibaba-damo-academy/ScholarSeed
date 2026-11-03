import React from 'react'
import { useTranslation } from 'react-i18next'

import scholarseedLogoMark from '../../assets/logo.svg'
import { accountDisplayText } from '../../account'
import { Icon } from '../../icons'
import type { QuickStartPreset } from '../../quickstart'
import { QUICK_START_PRESETS } from '../../quickstart'
import { focusComposer } from '../../reference'
import { PROJECT_POPOVER_CONTENT_CLASS, ProjectMenu } from '../../shell/ProjectMenu'
import { selectedProject, useApp } from '../../store'
import { useAccountIdentity } from '../../components/business/AccountMenu'
import { Composer } from '../../components/business/Composer'
import { Button, Popover, PopoverContent, PopoverTrigger } from '../../components/ui'
import { RESEARCH_IDEA_TASK_TYPE } from '../../api'

// Home.tsx — the 首页 surface (PRD 2.1.2): brand hero, the wide composer, the
// project picker (modification 2), and the 快捷开始 cards. It renders whenever no
// session is selected; the first sent turn creates the real session and the
// conversation view takes over.

const PRESET_KEYS = { review: { titleKey: 'home.reviewTitle', hintKey: 'home.reviewHint' }, idea: { titleKey: 'home.ideaTitle', hintKey: 'home.ideaHint' }, reproduce: { titleKey: 'home.reproduceTitle', hintKey: 'home.reproduceHint' } } as const
const HOME_GUTTER_CLASS = 'px-[var(--conversation-inline-gutter)]'
const QUICKSTART_CARD_CLASS = [
  'flex min-h-[108px] w-full min-w-0 flex-col gap-[9px] rounded-[var(--card-radius)]',
  'border border-[var(--border-soft)] bg-[var(--bg-2)] px-[var(--vds-space-4)] py-[15px] text-left shadow-none',
  'transition-[background,box-shadow,border-color] duration-150 ease-in-out hover:bg-[var(--bg-2)] hover:shadow-[var(--shadow-card)]'
].join(' ')

/** Returns a time-of-day greeting: 早上好 / 下午好 / 晚上好. */
function timeGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'home.morning' as const
  if (h < 18) return 'home.afternoon' as const
  return 'home.evening' as const
}

/** display_name 可能是“花名(工号)”；问候只显示括号前的用户可见部分。 */
function greetingName(raw: string): string {
  const paren = raw.indexOf('(')
  return paren > 0 ? raw.slice(0, paren) : raw
}

function BrandMark(): React.JSX.Element {
  return (
    <span className="block size-[74px] flex-none" aria-hidden>
      <img
        className="block size-full rounded-[15px] object-cover shadow-[var(--shadow-card)]"
        src={scholarseedLogoMark}
        alt=""
      />
    </span>
  )
}

/** Seeds the composer with a preset; the researcher still sends it themselves. */
function QuickStartCard({ preset }: { preset: QuickStartPreset }): React.JSX.Element {
  const { t } = useTranslation('shell')
  const { set } = useApp()
  const messages = Object.prototype.hasOwnProperty.call(PRESET_KEYS, preset.id) ? PRESET_KEYS[preset.id as keyof typeof PRESET_KEYS] : null
  return (
    <Button
      unstyled
      data-testid={`quickstart-${preset.id}`}
      className={QUICKSTART_CARD_CLASS}
      onClick={() => {
        set({
          composerText: preset.prompt,
          composerTaskType: preset.id === 'idea' ? RESEARCH_IDEA_TASK_TYPE : ''
        })
        focusComposer({ selectionStart: 0, selectionEnd: 0 })
      }}
    >
      <span className="flex w-full min-w-0 items-center gap-[var(--vds-space-2)] overflow-hidden text-[var(--text)] [&_svg]:w-[15px] [&_svg]:min-w-[15px] [&_svg]:basis-[15px]">
        <Icon name={preset.icon} size={15} />
        <span className="block min-w-0 flex-1 basis-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-semibold">
          {messages ? t(messages.titleKey) : preset.title}
        </span>
      </span>
      <span className="[display:-webkit-box] overflow-hidden text-[11.5px] leading-[1.55] text-[var(--text-3)] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
        {messages ? t(messages.hintKey) : preset.hint}
      </span>
    </Button>
  )
}

/**
 * The home project picker records draft assignment only. Runtime workspace
 * activation happens when the first turn opens its real session.
 */
function ProjectPicker(): React.JSX.Element {
  const { t } = useTranslation('shell')
  const { state, set } = useApp()

  // PRD 2.1.8 ①: 未选时显示「选择项目」, 已选才显示项目名 (不用完整路径)。
  const selectedName = selectedProject(state)?.name || null

  return (
    <Popover open={state.homeProjectMenuOpen} onOpenChange={(open) => set({ homeProjectMenuOpen: open })}>
      <div className="mt-[10px]">
        <PopoverTrigger asChild>
          <Button
            unstyled
            data-testid="home-project-picker"
            className="inline-flex min-h-[30px] items-center gap-[7px] rounded-[9px] border border-[var(--border-soft)] bg-[var(--bg-2)] px-[11px] text-xs text-[var(--text-2)] transition-[background,color] duration-150 hover:bg-[var(--bg-3)] hover:text-[var(--text)] focus-visible:bg-[var(--bg-3)] focus-visible:text-[var(--text)]"
          >
            <Icon name="folder" size={14} />
            <span className="max-w-60 overflow-hidden text-ellipsis whitespace-nowrap">{selectedName || t('home.selectProject')}</span>
            <Icon name="chevron-down" size={12} />
          </Button>
        </PopoverTrigger>
        <PopoverContent className={PROJECT_POPOVER_CONTENT_CLASS}>
          <ProjectMenu onClose={() => set({ homeProjectMenuOpen: false })} />
        </PopoverContent>
      </div>
    </Popover>
  )
}

export function Home(): React.JSX.Element {
  const { t } = useTranslation('shell')
  const { t: accountText } = useTranslation('account')
  const { state } = useApp()
  // 身份取自账号 chrome 的同一个 hook (AccountMenu 是它的单一所有者)。自己再存一份
  // 就会在登录/登出后停在旧值上 —— 问候语会一直喊错人。
  const { user, profile } = useAccountIdentity(state.backendReady)

  const name = greetingName(accountDisplayText(user, profile, accountText))
  const greeting = t('home.greeting', { greeting: t(timeGreeting()), name })

  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto py-[clamp(24px,6vh,64px)] [&_.conversation-content]:bg-transparent [&_.vds-reading-column]:w-full"
      data-testid="home-surface"
    >
      <div className="my-auto flex w-[min(920px,calc(100%_-_48px))] flex-col [&>div]:bg-transparent">
        <header className={`flex items-center gap-[22px] pb-[26px] ${HOME_GUTTER_CLASS}`}>
          <BrandMark />
          <div className="min-w-0">
            <h2 className="mt-[var(--vds-space-0)] mb-[var(--vds-space-0)] font-[var(--serif-display)] text-[clamp(22px,2.8vw,28px)] leading-[1.2] font-bold tracking-[0.01em] text-[var(--text)]">
              {greeting}
            </h2>
            <h2 className="mt-[2px] mb-[var(--vds-space-0)] font-[var(--serif-display)] text-[clamp(22px,2.8vw,28px)] leading-[1.2] font-bold tracking-[0.01em] text-[var(--text)]">
              {t('home.question')}
            </h2>
            <p className="mt-[9px] mb-[var(--vds-space-0)] text-sm leading-normal text-[var(--text-3)]">{t('home.subtitle')}</p>
          </div>
        </header>

        <Composer home homeExtras={<ProjectPicker />} />

        <div className={`mt-[34px] mb-[18px] flex items-center gap-[var(--vds-space-3)] text-[10.5px] text-[var(--text-3)] ${HOME_GUTTER_CLASS}`}>
          <span className="h-px flex-1 bg-[var(--border-soft)]" aria-hidden />
          <span>{t('home.quickStart')}</span>
          <span className="h-px flex-1 bg-[var(--border-soft)]" aria-hidden />
        </div>

        <div className={`grid grid-cols-3 gap-[14px] ${HOME_GUTTER_CLASS}`}>
          {QUICK_START_PRESETS.map((preset) => (
            <QuickStartCard key={preset.id} preset={preset} />
          ))}
        </div>
      </div>
    </div>
  )
}
