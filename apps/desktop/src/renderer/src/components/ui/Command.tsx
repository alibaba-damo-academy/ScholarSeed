import { useTranslation } from 'react-i18next'
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent,
  ReactElement,
  ReactNode
} from 'react'
import {
  Children,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'

import { commandClassName, commandStyleClassName } from './classes'
import { Dialog, DialogContent, DialogTitle, type DialogProps } from './Dialog'
import { cx } from './utils'

interface CommandContextValue {
  activeValue: string | undefined
  disabled: boolean
  emptyId: string
  listId: string
  query: string
  registerItem: (value: string, node: HTMLButtonElement | null, visible: boolean) => void
  selectValue: (value: string, focus?: boolean) => void
  selectedValue: string | undefined
  setQuery: (value: string) => void
  visibleCount: number
  visibleValues: string[]
}

const CommandContext = createContext<CommandContextValue | null>(null)

function useCommandContext(component: string): CommandContextValue {
  const context = useContext(CommandContext)
  if (!context) throw new Error(`${component} must be used inside Command`)
  return context
}

export interface CommandProps extends Omit<HTMLAttributes<HTMLDivElement>, 'defaultValue' | 'onChange'> {
  children: ReactNode
  defaultSearchValue?: string
  defaultValue?: string
  disabled?: boolean
  onSearchValueChange?: (value: string) => void
  onValueChange?: (value: string) => void
  searchValue?: string
  value?: string
}

export interface CommandInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  onValueChange?: (value: string) => void
  value?: string
}

export interface CommandListProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onKeyDown'> {
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
}

export interface CommandGroupProps extends HTMLAttributes<HTMLDivElement> {
  heading?: ReactNode
}

export interface CommandItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect' | 'value'> {
  keywords?: string[]
  onSelect?: (value: string) => void
  value?: string
}

export type CommandEmptyProps = HTMLAttributes<HTMLDivElement>
export type CommandSeparatorProps = HTMLAttributes<HTMLDivElement>
export interface CommandDialogProps extends Omit<DialogProps, 'children' | 'open'> {
  children: ReactNode
  defaultOpen?: boolean
  open?: boolean
}
export type CommandShortcutProps = HTMLAttributes<HTMLSpanElement>

const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'End', 'Home'])
const COMMAND_DIALOG_CLASS_NAME = 'vds-command-dialog w-[min(640px,calc(100vw-48px))] gap-0 overflow-hidden [padding:0]'
const COMMAND_DIALOG_TITLE_CLASS_NAME =
  'vds-command-dialog__title absolute [width:1px] [height:1px] [margin:-1px] overflow-hidden [clip:rect(0_0_0_0)]'
const COMMAND_DIALOG_COMMAND_CLASS_NAME = 'vds-command-dialog__command w-full'
const COMMAND_SHORTCUT_CLASS_NAME =
  'vds-command__shortcut [margin-left:auto] text-[length:var(--vds-font-body-lv1)] [letter-spacing:0] text-[var(--vds-text-tertiary)]'
const COMMAND_INPUT_WRAPPER_CLASS_NAME =
  'vds-command__input-wrapper flex min-w-0 items-center [padding:0_var(--vds-space-3)] [border-bottom:var(--vds-border-width-1)_solid_var(--vds-border-default)]'
const COMMAND_INPUT_ICON_CLASS_NAME =
  'vds-command__input-icon [flex:0_0_auto] [margin-right:var(--vds-space-2)] text-[20px] leading-none text-[var(--vds-text-tertiary)]'
const COMMAND_INPUT_CLASS_NAME =
  'vds-command__input w-full [height:44px] min-w-0 [padding:0] [border:0] [border-radius:0] bg-transparent [font:inherit] text-[var(--vds-text-primary)] outline-none focus-visible:shadow-none disabled:cursor-not-allowed disabled:bg-[var(--vds-surface-muted)] [&::-webkit-search-cancel-button]:hidden'
const COMMAND_LIST_CLASS_NAME = [
  'vds-command__list flex max-h-[var(--vds-command-list-max-height)] flex-col gap-[var(--vds-command-list-gap)] overflow-auto [background:var(--vds-bg-white-default)] [padding:var(--vds-command-list-padding)]',
  "data-[empty=true]:min-h-[68px] data-[empty=true]:justify-center data-[empty=true]:[&_.vds-command__group]:hidden data-[empty=true]:[&_.vds-command__separator]:hidden",
  'data-[searching=true]:[&_.vds-command__separator]:hidden [&_.vds-command__group:not(:has(.vds-command__item:not([hidden])))]:hidden'
].join(' ')
const COMMAND_GROUP_CLASS_NAME = 'vds-command__group flex flex-col gap-[var(--vds-command-group-gap)]'
const COMMAND_GROUP_HEADING_CLASS_NAME =
  'vds-command__group-heading [padding:var(--vds-command-heading-padding)] text-[length:var(--vds-font-body-lv1)] [font-weight:var(--vds-fw-medium)] text-[var(--vds-text-tertiary)]'
const COMMAND_ITEM_CLASS_NAME =
  'vds-command__item flex w-full items-center gap-[var(--vds-space-2)] [min-height:var(--vds-command-item-height)] [padding:var(--vds-command-item-padding)] [border:0] [border-radius:var(--vds-radius-3)] bg-transparent [font:inherit] text-left text-[var(--vds-text-primary)] cursor-pointer hover:[background:var(--vds-surface-hover)] focus-visible:outline-none focus-visible:[box-shadow:var(--vds-focus-ring)] disabled:cursor-not-allowed disabled:text-[var(--vds-text-disabled)] [&[hidden]]:hidden [&_svg]:[flex:0_0_auto] [&_svg]:[width:16px] [&_svg]:[height:16px] [&_svg]:text-[var(--vds-text-tertiary)] [&_.iconfont]:[flex:0_0_auto] [&_.iconfont]:[width:16px] [&_.iconfont]:[height:16px] [&_.iconfont]:text-[var(--vds-text-tertiary)]'
const COMMAND_ITEM_SELECTED_CLASS_NAME = 'vds-command__item--selected [background:var(--vds-surface-hover)]'
const COMMAND_EMPTY_CLASS_NAME =
  'vds-command__empty [padding:var(--vds-command-empty-padding)] text-center text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-tertiary)]'
const COMMAND_SEPARATOR_CLASS_NAME =
  'vds-command__separator [height:var(--vds-divider-size)] [margin:var(--vds-command-separator-margin)] [background:var(--vds-divider-color)]'

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function matchesQuery(label: string, keywords: string[] | undefined, query: string): boolean {
  const normalizedQuery = normalizeSearch(query)
  if (!normalizedQuery) return true
  const haystack = [label, ...(keywords ?? [])].join(' ').toLocaleLowerCase()
  return haystack.includes(normalizedQuery)
}

function commandItemValue(children: ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(commandItemValue).filter(Boolean).join(' ')
  if (isValidElement(children)) return commandItemValue((children as ReactElement<{ children?: ReactNode }>).props.children)
  const textValues = Children.toArray(children).map(commandItemValue).filter(Boolean)
  if (textValues.length > 0) return textValues.join(' ')
  return ''
}

function commandNodeMatchesQuery(children: ReactNode, query: string): boolean {
  return Children.toArray(children).some((child) => {
    if (!isValidElement(child)) return false

    if (child.type === CommandItem) {
      const props = child.props as CommandItemProps
      const label = commandItemValue(props.children) || props.value || ''
      return !props.disabled && matchesQuery(label, props.keywords, query)
    }

    return commandNodeMatchesQuery((child as ReactElement<{ children?: ReactNode }>).props.children, query)
  })
}

export const Command = forwardRef<HTMLDivElement, CommandProps>(
  (
    {
      children,
      className,
      defaultSearchValue,
      defaultValue,
      disabled = false,
      onSearchValueChange,
      onValueChange,
      searchValue,
      value,
      ...props
    },
    ref
  ) => {
    const generatedId = useId()
    const itemRefs = useRef(new Map<string, HTMLButtonElement>())
    const visibleValuesRef = useRef<string[]>([])
    const [visibleValues, setVisibleValues] = useState<string[]>([])
    const [uncontrolledSearchValue, setUncontrolledSearchValue] = useState(defaultSearchValue ?? '')
    const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue)
    const currentQuery = searchValue ?? uncontrolledSearchValue
    const currentValue = value ?? uncontrolledValue
    const activeValue = currentValue && visibleValues.includes(currentValue) ? currentValue : visibleValues[0]

    const context = useMemo<CommandContextValue>(
      () => ({
        activeValue,
        disabled,
        emptyId: `${generatedId}-empty`,
        listId: `${generatedId}-list`,
        query: currentQuery,
        registerItem: (itemValue, node, visible) => {
          if (node) itemRefs.current.set(itemValue, node)
          else itemRefs.current.delete(itemValue)

          const nextVisibleValues = visible
            ? Array.from(new Set([...visibleValuesRef.current, itemValue]))
            : visibleValuesRef.current.filter((visibleValue) => visibleValue !== itemValue)

          if (nextVisibleValues.join('\u0000') !== visibleValuesRef.current.join('\u0000')) {
            visibleValuesRef.current = nextVisibleValues
            setVisibleValues(nextVisibleValues)
          }
        },
        selectValue: (nextValue, focus = false) => {
          if (disabled || !visibleValuesRef.current.includes(nextValue)) return
          if (value === undefined) setUncontrolledValue(nextValue)
          onValueChange?.(nextValue)
          if (focus) itemRefs.current.get(nextValue)?.focus()
        },
        selectedValue: currentValue,
        setQuery: (nextValue) => {
          if (disabled) return
          if (searchValue === undefined) setUncontrolledSearchValue(nextValue)
          onSearchValueChange?.(nextValue)
        },
        visibleCount: visibleValues.length,
        visibleValues
      }),
      [
        activeValue,
        currentQuery,
        currentValue,
        disabled,
        generatedId,
        onSearchValueChange,
        onValueChange,
        searchValue,
        value,
        visibleValues
      ]
    )

    return (
      <CommandContext.Provider value={context}>
        <div
          aria-disabled={disabled || undefined}
          className={cx(commandClassName({ className, disabled }), commandStyleClassName())}
          ref={ref}
          {...props}
        >
          {children}
        </div>
      </CommandContext.Provider>
    )
  }
)

Command.displayName = 'Command'

export function CommandDialog({ children, defaultOpen = false, onOpenChange, open, ...props }: CommandDialogProps): JSX.Element {
  const { t } = useTranslation('ui')
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const currentOpen = open ?? uncontrolledOpen

  return (
    <Dialog
      open={currentOpen}
      onOpenChange={(nextOpen) => {
        if (open === undefined) setUncontrolledOpen(nextOpen)
        onOpenChange?.(nextOpen)
      }}
      {...props}
    >
      <DialogContent className={COMMAND_DIALOG_CLASS_NAME} hideCloseButton>
        <DialogTitle className={COMMAND_DIALOG_TITLE_CLASS_NAME}>{t('command.title')}</DialogTitle>
        <Command className={COMMAND_DIALOG_COMMAND_CLASS_NAME}>{children}</Command>
      </DialogContent>
    </Dialog>
  )
}

export const CommandShortcut = forwardRef<HTMLSpanElement, CommandShortcutProps>(
  ({ className, ...props }, ref) => (
    <span className={cx(COMMAND_SHORTCUT_CLASS_NAME, className)} ref={ref} {...props} />
  )
)

CommandShortcut.displayName = 'CommandShortcut'

export const CommandInput = forwardRef<HTMLInputElement, CommandInputProps>(
  ({ className, disabled, onValueChange, placeholder, value, ...props }, ref) => {
    const { t } = useTranslation('ui')
    const context = useCommandContext('CommandInput')
    const currentValue = value ?? context.query

    return (
      <div className={COMMAND_INPUT_WRAPPER_CLASS_NAME}>
        <span aria-hidden="true" className={COMMAND_INPUT_ICON_CLASS_NAME}>⌕</span>
        <input
          aria-controls={context.listId}
          aria-describedby={context.visibleCount === 0 ? context.emptyId : undefined}
          aria-disabled={context.disabled || disabled || undefined}
          className={cx(COMMAND_INPUT_CLASS_NAME, className)}
          disabled={context.disabled || disabled}
          placeholder={placeholder ?? t('search')}
          ref={ref}
          type="search"
          value={currentValue}
          onChange={(event) => {
            const nextValue = event.currentTarget.value
            if (value === undefined) context.setQuery(nextValue)
            onValueChange?.(nextValue)
          }}
          {...props}
        />
      </div>
    )
  }
)

CommandInput.displayName = 'CommandInput'

export const CommandList = forwardRef<HTMLDivElement, CommandListProps>(
  ({ children, className, onKeyDown, ...props }, ref) => {
    const context = useCommandContext('CommandList')

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
      onKeyDown?.(event)
      if (event.defaultPrevented || context.disabled || !NAVIGATION_KEYS.has(event.key)) return

      const registeredValues = context.visibleValues
      if (registeredValues.length === 0) return

      event.preventDefault()
      const currentIndex = Math.max(registeredValues.indexOf(context.activeValue ?? ''), 0)
      const nextIndex =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? registeredValues.length - 1
            : event.key === 'ArrowDown'
              ? (currentIndex + 1) % registeredValues.length
              : (currentIndex - 1 + registeredValues.length) % registeredValues.length
      context.selectValue(registeredValues[nextIndex], true)
    }

    return (
      <div
        className={cx(COMMAND_LIST_CLASS_NAME, className)}
        data-empty={context.visibleCount === 0 ? 'true' : undefined}
        data-searching={context.query.trim() ? 'true' : undefined}
        id={context.listId}
        ref={ref}
        role="listbox"
        onKeyDown={handleKeyDown}
        {...props}
      >
        {children}
      </div>
    )
  }
)

CommandList.displayName = 'CommandList'

export const CommandGroup = forwardRef<HTMLDivElement, CommandGroupProps>(
  ({ children, className, heading, hidden, ...props }, ref) => {
    const context = useCommandContext('CommandGroup')
    const groupHidden = hidden || context.visibleCount === 0 || !commandNodeMatchesQuery(children, context.query)

    return (
      <div className={cx(COMMAND_GROUP_CLASS_NAME, groupHidden && 'hidden', className)} hidden={groupHidden} ref={ref} role="group" {...props}>
        {heading ? <div className={COMMAND_GROUP_HEADING_CLASS_NAME}>{heading}</div> : null}
        {children}
      </div>
    )
  }
)

CommandGroup.displayName = 'CommandGroup'

export const CommandItem = forwardRef<HTMLButtonElement, CommandItemProps>(
  ({ children, className, disabled, keywords, onClick, onSelect, type = 'button', value, ...props }, ref) => {
    const context = useCommandContext('CommandItem')
    const generatedValue = useId()
    const textValue = commandItemValue(children)
    const itemValue = (value ?? textValue) || generatedValue
    const label = textValue || itemValue
    const visible = matchesQuery(label, keywords, context.query)
    const isDisabled = context.disabled || disabled
    const selected = context.activeValue === itemValue

    return (
      <button
        aria-disabled={isDisabled || undefined}
        aria-selected={selected}
        className={cx(COMMAND_ITEM_CLASS_NAME, selected && COMMAND_ITEM_SELECTED_CLASS_NAME, className)}
        disabled={isDisabled}
        hidden={!visible}
        ref={(node) => {
          context.registerItem(itemValue, node, visible && !isDisabled)
          if (typeof ref === 'function') ref(node)
          else if (ref && 'current' in ref) {
            ;(ref as { current: HTMLButtonElement | null }).current = node
          }
        }}
        role="option"
        tabIndex={selected ? 0 : -1}
        type={type}
        value={itemValue}
        onClick={(event) => {
          onClick?.(event)
          if (event.defaultPrevented || isDisabled) return
          context.selectValue(itemValue)
          onSelect?.(itemValue)
        }}
        {...props}
      >
        {children}
      </button>
    )
  }
)

CommandItem.displayName = 'CommandItem'

export const CommandEmpty = forwardRef<HTMLDivElement, CommandEmptyProps>(
  ({ children = 'No results found.', className, ...props }, ref) => {
    const context = useCommandContext('CommandEmpty')
    if (context.visibleCount > 0) return null

    return (
      <div className={cx(COMMAND_EMPTY_CLASS_NAME, className)} id={context.emptyId} ref={ref} role="status" {...props}>
        {children}
      </div>
    )
  }
)

CommandEmpty.displayName = 'CommandEmpty'

export const CommandSeparator = forwardRef<HTMLDivElement, CommandSeparatorProps>(
  ({ className, hidden, ...props }, ref) => {
    const context = useCommandContext('CommandSeparator')
    const separatorHidden = hidden || context.visibleCount === 0 || Boolean(context.query.trim())

    return (
      <div
        aria-hidden="true"
        className={cx(COMMAND_SEPARATOR_CLASS_NAME, separatorHidden && 'hidden', className)}
        hidden={separatorHidden}
        ref={ref}
        role="separator"
        {...props}
      />
    )
  }
)

CommandSeparator.displayName = 'CommandSeparator'
