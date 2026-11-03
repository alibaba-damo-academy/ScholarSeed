import React from 'react'
import { useTranslation } from 'react-i18next'

import { LOCALES } from '../../../../localization/catalog'
import { Globe, Palette, Save } from 'lucide-react'

import { type Lang, type Theme } from '../../model'
import { Icon } from '../../icons'
import { useApp } from '../../store'
import { IconFont } from '../primitive'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPortal,
  AlertDialogTitle,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
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
const LANGUAGE_COMPACT_CHEVRON_CLASS_NAME =
  'ml-[var(--vds-space-half)] flex-none text-[var(--vds-text-primary)]'
const LANGUAGE_POPOVER_CLASS_NAME = 'z-[var(--vds-z-preferences-language-menu)] gap-0'
const LANGUAGE_OPTION_CLASS_NAME =
  'flex h-[var(--vds-control-height-md)] w-full items-center justify-start gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border-0 bg-transparent p-[var(--vds-space-2)] text-left text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] leading-5 text-[var(--vds-text-primary)] shadow-none hover:bg-[var(--vds-surface-hover)] hover:text-[var(--vds-text-primary)]'
const LANGUAGE_OPTION_ACTIVE_CLASS_NAME =
  'bg-[var(--vds-surface-hover)] text-[var(--vds-text-primary)]'
const LANGUAGE_OPTION_MARK_CLASS_NAME =
  'w-5 flex-none text-center text-[14px] text-[var(--vds-text-secondary)]'
const LANGUAGE_COMPACT_POPOVER_CLASS_NAME =
  'no-drag z-[var(--vds-z-preferences-language-menu)] min-w-[var(--vds-language-menu-min-width)] gap-[var(--vds-space-half)] rounded-[var(--vds-language-menu-radius)] border-0 bg-white p-[calc(var(--vds-space-3)/2)] shadow-[var(--vds-language-menu-shadow)]'
const LANGUAGE_COMPACT_OPTION_CLASS_NAME =
  'flex !h-[var(--vds-control-height-md)] min-h-[var(--vds-control-height-md)] w-full items-center justify-start gap-[calc(var(--vds-space-5)/2)] rounded-[var(--vds-radius-4)] border-0 bg-transparent !px-[calc(var(--vds-space-5)/2)] !py-0 text-left text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-control-label-line-height)] text-[var(--vds-text-primary)] shadow-none hover:bg-[var(--vds-surface-hover)] focus-visible:shadow-none'
const LANGUAGE_COMPACT_OPTION_ACTIVE_CLASS_NAME = 'bg-[var(--vds-other-overlay-1)]'
const LANGUAGE_COMPACT_OPTION_MARK_CLASS_NAME =
  'w-[var(--vds-icon-9)] shrink-0 text-center text-[length:var(--vds-language-menu-mark-font-size)] font-[var(--vds-fw-medium)] leading-[var(--vds-control-label-line-height)] text-[var(--vds-text-secondary)]'
const LANGUAGE_COMPACT_POPOVER_STYLE = { transform: 'translateX(-12px)' } as const

export function LanguageSwitchDialog(): React.JSX.Element {
  const { state, act } = useApp()
  const { t } = useTranslation('workbench')
  const pending = state.languageSwitch
  const failure = pending?.failure
  return (
    <AlertDialog
      open={Boolean(pending)}
      onOpenChange={(open) => {
        if (!open && !pending?.saving) act.cancelLanguageSwitch()
      }}
    >
      <AlertDialogPortal>
        <AlertDialogContent data-testid="language-switch-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('languageSwitch.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {failure
                ? t(
                    failure === 'save'
                      ? 'languageSwitch.saveFailed'
                      : 'languageSwitch.preferencesFailed'
                  )
                : t('languageSwitch.description', {
                    count: pending?.dirtyCount ?? 0,
                    language: pending ? LOCALES[pending.target].label : '',
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending?.saving}>
              {t('languageSwitch.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={pending?.saving}
              onClick={(event) => {
                event.preventDefault()
                void act.confirmLanguageSwitch()
              }}
            >
              {pending?.saving ? t('languageSwitch.saving') : t('languageSwitch.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialogPortal>
    </AlertDialog>
  )
}

export function LanguagePopoverControl({
  className,
  iconSize = PREFERENCE_ICON_SIZE,
  showChevron = false,
  showIcon = true,
  showLabel = true,
  variant = 'menu',
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
          {showLabel && <span className="min-w-0 truncate">{t('preferences.language')}</span>}
          <span
            className={
              variant === 'compact' ? LANGUAGE_COMPACT_VALUE_CLASS_NAME : LANGUAGE_VALUE_CLASS_NAME
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
        className={
          variant === 'compact' ? LANGUAGE_COMPACT_POPOVER_CLASS_NAME : LANGUAGE_POPOVER_CLASS_NAME
        }
        side={variant === 'compact' ? 'auto' : 'right'}
        style={variant === 'compact' ? LANGUAGE_COMPACT_POPOVER_STYLE : undefined}
      >
        <Button
          type="button"
          aria-pressed={state.lang === 'zh'}
          className={
            variant === 'compact'
              ? `${LANGUAGE_COMPACT_OPTION_CLASS_NAME} ${state.lang === 'zh' ? LANGUAGE_COMPACT_OPTION_ACTIVE_CLASS_NAME : ''}`
              : `${LANGUAGE_OPTION_CLASS_NAME} ${state.lang === 'zh' ? LANGUAGE_OPTION_ACTIVE_CLASS_NAME : ''}`
          }
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
          className={
            variant === 'compact'
              ? `${LANGUAGE_COMPACT_OPTION_CLASS_NAME} ${state.lang === 'en' ? LANGUAGE_COMPACT_OPTION_ACTIVE_CLASS_NAME : ''}`
              : `${LANGUAGE_OPTION_CLASS_NAME} ${state.lang === 'en' ? LANGUAGE_OPTION_ACTIVE_CLASS_NAME : ''}`
          }
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

export function PreferenceControls({
  showAppearance = true,
}: { showAppearance?: boolean } = {}): React.JSX.Element {
  const { state, act } = useApp()
  const { t } = useTranslation('components')
  return (
    <div className={ROWS_CLASS_NAME}>
      <div className={ROW_CLASS_NAME}>
        <span className={LABEL_CLASS_NAME}>
          <Globe size={PREFERENCE_ICON_SIZE} strokeWidth={1.75} />
          {t('preferences.language')}
        </span>
        <Select value={state.lang} onValueChange={(value) => act.setLang(value as Lang)}>
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
          <Select value={state.theme} onValueChange={(value) => act.setTheme(value as Theme)}>
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
