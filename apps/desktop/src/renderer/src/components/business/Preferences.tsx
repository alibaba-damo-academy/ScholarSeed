import React from 'react'
import { useTranslation } from 'react-i18next'

import { LOCALES } from '../../../../localization/catalog'
import { Globe, Palette, Save } from 'lucide-react'

import { type Lang, type Theme } from '../../model'
import { Icon } from '../../icons'
import { useApp } from '../../store'
import { IconFont } from '../primitive'
import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch
} from '../ui'

// Preferences.tsx — 语言 / 外观两个高频偏好的**唯一**控件实现。
//
// PRD「偏好设置」⑧ 要求「头像菜单」与「设置页」始终显示同一选中状态。只要两处各写
// 一份下拉，选项文案与取值就会各自漂移，出现菜单是深色、设置页是浅色的第二个答案。
// 因此控件只此一份，由两个表面各自决定外层排版（菜单里带分隔线，设置页里带标题）。
//
// 切换只写 store：落盘由 store 的唯一偏好提交链承担，外观生效由 App 上已挂的
// `useThemeEffect(state.theme)` 承担，这里不重复接线。

const ROWS_CLASS_NAME = 'grid gap-[10px]'
const ROW_CLASS_NAME = 'flex items-center justify-between gap-[12px]'
const LABEL_CLASS_NAME = 'flex flex-none items-center gap-[8px] text-[12px] text-[var(--text-2)]'
const PREFERENCE_ICON_SIZE = 15
const LANGUAGE_VALUE_CLASS_NAME = 'ml-auto flex-none text-[var(--vds-text-tertiary)]'
const LANGUAGE_COMPACT_VALUE_CLASS_NAME = 'flex-none text-[var(--vds-text-primary)]'
const LANGUAGE_COMPACT_CHEVRON_CLASS_NAME = 'ml-[2px] flex-none text-[var(--vds-text-primary)]'
const LANGUAGE_POPOVER_CLASS_NAME = 'z-[calc(var(--vds-z-popover)+1)] gap-0'
const LANGUAGE_POPOVER_STYLE = { transform: 'translate(226px, -42px)' } as const
const LANGUAGE_OPTION_CLASS_NAME = 'flex h-9 w-full items-center justify-start gap-2 rounded-[8px] border-0 bg-transparent p-2 text-left text-[14px] font-[var(--vds-fw-normal)] leading-5 text-[var(--vds-text-primary)] shadow-none hover:bg-[var(--vds-surface-hover)] hover:text-[var(--vds-text-primary)]'
const LANGUAGE_OPTION_ACTIVE_CLASS_NAME = 'bg-[var(--vds-surface-hover)] text-[var(--vds-text-primary)]'
const LANGUAGE_OPTION_MARK_CLASS_NAME = 'w-5 flex-none text-center text-[14px] text-[var(--vds-text-secondary)]'
const LANGUAGE_COMPACT_POPOVER_CLASS_NAME = 'no-drag z-[calc(var(--vds-z-popover)+1)] min-w-[128px] gap-[2px] rounded-[14px] border-0 bg-white p-[6px] shadow-[0_14px_40px_rgba(0,0,0,0.14)]'
const LANGUAGE_COMPACT_OPTION_CLASS_NAME = 'flex !h-[32px] min-h-[32px] w-full items-center justify-start gap-[10px] rounded-[8px] border-0 bg-transparent !px-[10px] !py-0 text-left text-[14px] font-[var(--vds-fw-medium)] leading-5 text-[var(--vds-text-primary)] shadow-none hover:bg-[var(--vds-surface-hover)] focus-visible:shadow-none'
const LANGUAGE_COMPACT_OPTION_ACTIVE_CLASS_NAME = 'bg-[var(--vds-other-overlay-1)]'
const LANGUAGE_COMPACT_OPTION_MARK_CLASS_NAME = 'w-[18px] shrink-0 text-center text-[13px] font-[var(--vds-fw-medium)] leading-5 text-[var(--vds-text-secondary)]'
const LANGUAGE_COMPACT_POPOVER_STYLE = { transform: 'translateX(-12px)' } as const

export function LanguagePopoverControl({
  className,
  iconSize = PREFERENCE_ICON_SIZE,
  showChevron = false,
  showIcon = true,
  showLabel = true,
  variant = 'menu'
}: {
  className: string
  iconSize?: number
  showChevron?: boolean
  showIcon?: boolean
  showLabel?: boolean
  variant?: 'compact' | 'menu'
}): React.JSX.Element {
  const { state, act } = useApp()
  const [open, setOpen] = React.useState(false)
  const { t } = useTranslation('components')
  const currentLabel = LOCALES[state.lang].label

  const selectLanguage = (value: Lang): void => {
    act.setLang(value)
    setOpen(false)
  }
  const handleLanguagePointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    value: Lang
  ): void => {
    event.preventDefault()
    event.stopPropagation()
    selectLanguage(value)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          aria-pressed={open}
          className={className}
          data-testid="account-menu-language"
          size="content"
          variant="ghost"
        >
          {showIcon && <Globe size={iconSize} strokeWidth={1.75} />}
          {showLabel && <span>{t('preferences.language')}</span>}
          <span
            className={
              variant === 'compact'
                ? LANGUAGE_COMPACT_VALUE_CLASS_NAME
                : LANGUAGE_VALUE_CLASS_NAME
            }
          >
            {currentLabel}
          </span>
          {showChevron && (
            <span className={LANGUAGE_COMPACT_CHEVRON_CLASS_NAME}>
              <Icon name="chevron-down" size={12} sw={1.8} />
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={variant === 'compact' ? LANGUAGE_COMPACT_POPOVER_CLASS_NAME : LANGUAGE_POPOVER_CLASS_NAME}
        style={variant === 'compact' ? LANGUAGE_COMPACT_POPOVER_STYLE : LANGUAGE_POPOVER_STYLE}
      >
        <Button
          type="button"
          aria-pressed={state.lang === 'zh'}
          className={variant === 'compact'
            ? `${LANGUAGE_COMPACT_OPTION_CLASS_NAME} ${state.lang === 'zh' ? LANGUAGE_COMPACT_OPTION_ACTIVE_CLASS_NAME : ''}`
            : `${LANGUAGE_OPTION_CLASS_NAME} ${state.lang === 'zh' ? LANGUAGE_OPTION_ACTIVE_CLASS_NAME : ''}`}
          size="content"
          variant="ghost"
          onPointerDown={(event) => handleLanguagePointerDown(event, 'zh')}
        >
          <IconFont
            className={
              variant === 'compact'
                ? LANGUAGE_COMPACT_OPTION_MARK_CLASS_NAME
                : LANGUAGE_OPTION_MARK_CLASS_NAME
            }
            type="icon-zhongwen"
          />
          {LOCALES.zh.label}
        </Button>
        <Button
          type="button"
          aria-pressed={state.lang === 'en'}
          className={variant === 'compact'
            ? `${LANGUAGE_COMPACT_OPTION_CLASS_NAME} ${state.lang === 'en' ? LANGUAGE_COMPACT_OPTION_ACTIVE_CLASS_NAME : ''}`
            : `${LANGUAGE_OPTION_CLASS_NAME} ${state.lang === 'en' ? LANGUAGE_OPTION_ACTIVE_CLASS_NAME : ''}`}
          size="content"
          variant="ghost"
          onPointerDown={(event) => handleLanguagePointerDown(event, 'en')}
        >
          <IconFont
            className={
              variant === 'compact'
                ? LANGUAGE_COMPACT_OPTION_MARK_CLASS_NAME
                : LANGUAGE_OPTION_MARK_CLASS_NAME
            }
            type="icon-yingwen"
          />
          {LOCALES.en.label}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

export function PreferenceControls({ showAppearance = true }: { showAppearance?: boolean } = {}): React.JSX.Element {
  const { state, act } = useApp()
  const { t } = useTranslation('components')
  return (
    <div className={ROWS_CLASS_NAME}>
      <div className={ROW_CLASS_NAME}>
        <span className={LABEL_CLASS_NAME}>
          <Globe size={PREFERENCE_ICON_SIZE} strokeWidth={1.75} />
          {t('preferences.language')}
        </span>
        <Select
          value={state.lang}
          onValueChange={(value) => act.setLang(value as Lang)}
        >
          <SelectTrigger aria-label={t('preferences.language')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zh">中文</SelectItem>
            <SelectItem value="en">English</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {showAppearance && (
        <div className={ROW_CLASS_NAME}>
          <span className={LABEL_CLASS_NAME}>
            <Palette size={PREFERENCE_ICON_SIZE} strokeWidth={1.75} />
            {t('preferences.appearance')}
          </span>
          <Select
            value={state.theme}
            onValueChange={(value) => act.setTheme(value as Theme)}
          >
            <SelectTrigger aria-label={t('preferences.appearance')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">{t('preferences.light')}</SelectItem>
              <SelectItem value="dark">{t('preferences.dark')}</SelectItem>
              <SelectItem value="system">{t('preferences.system')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <div className={ROW_CLASS_NAME}>
        <span className={LABEL_CLASS_NAME}>
          <Save size={PREFERENCE_ICON_SIZE} strokeWidth={1.75} />
          {t('preferences.autoSave')}
        </span>
        <Switch
          checked={state.autoSave}
          data-testid="preferences-auto-save"
          label={t('preferences.autoSave')}
          onCheckedChange={act.setAutoSave}
        />
      </div>
    </div>
  )
}
