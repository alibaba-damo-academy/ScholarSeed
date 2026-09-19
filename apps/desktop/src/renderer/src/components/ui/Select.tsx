import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import {
  Children,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'

import { IconFont } from '../primitive'
import {
  fieldClassName,
  fieldLabelClassName,
  fieldMessageClassName,
  selectChevronClassName,
  selectClassName,
  selectCompatClassName,
  selectContentClassName,
  selectGroupClassName,
  selectItemBaseClassName,
  selectItemIndicatorClassName,
  selectItemLabelClassName,
  selectItemSelectedClassName,
  selectLabelClassName,
  selectScrollButtonClassName,
  selectSeparatorClassName,
  selectShellClassName,
  selectStyleClassName,
  selectTriggerIconClassName,
  selectTriggerValueClassName,
  type ControlSize
} from './classes'
import { cx } from './utils'
import { useFocusScope, visibleContent } from './focus'
import type { LocalizationMetadata } from './metadata'

export type SelectSize = ControlSize

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'>, LocalizationMetadata {
  error?: string
  label?: string
  onValueChange?: (value: string) => void
  size?: SelectSize
  value?: string
}

interface SelectContextValue {
  contentId: string
  size: SelectSize
  contentRef: React.RefObject<HTMLDivElement>
  disabled: boolean
  labels: Record<string, ReactNode>
  open: boolean
  registerLabel: (value: string, label: ReactNode) => void
  selectedLabel?: ReactNode
  triggerRect: SelectTriggerRect | null
  value?: string
  setOpen: (open: boolean) => void
  setTriggerRect: (rect: SelectTriggerRect | null) => void
  setValue: (value: string) => void
}

const SelectContext = createContext<SelectContextValue | null>(null)
type SelectTriggerRect = Pick<DOMRect, 'bottom' | 'left' | 'top' | 'width'>
const SELECT_OPTION_SELECTOR = '[role="option"]:not([aria-disabled="true"])'
const SELECT_CONTENT_OFFSET = 4
const SELECT_VIEWPORT_PADDING = 8

function collectSelectLabels(children: ReactNode): Record<string, ReactNode> {
  const labels: Record<string, ReactNode> = {}
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return
    const props = child.props as { children?: ReactNode; value?: unknown }
    if (typeof props.value === 'string' && props.children !== undefined) labels[props.value] = props.children
    if (props.children !== undefined) Object.assign(labels, collectSelectLabels(props.children))
  })
  return labels
}

function isNativeSelectChildren(children: ReactNode): boolean {
  const childList = Children.toArray(children)
  if (childList.length === 0) return true
  return childList.every((child) => isValidElement(child) && (child.type === 'option' || child.type === 'optgroup'))
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ children, className, defaultValue, error, id, label, onChange, onValueChange, size = 'md', value, ...props }, ref) => {
    const generatedId = useId()
    const labelSource = import.meta.env.DEV ? props['data-i18n-label'] : undefined
    const errorSource = import.meta.env.DEV ? props['data-i18n-error'] : undefined
    const selectId = id ?? generatedId
    const messageId = error ? `${selectId}-message` : undefined
    const rootRef = useRef<HTMLDivElement>(null)
    const contentRef = useRef<HTMLDivElement>(null)
    const [uncontrolledValue, setUncontrolledValue] = useState<string | undefined>(
      typeof defaultValue === 'string' ? defaultValue : undefined
    )
    const [labels, setLabels] = useState<Record<string, ReactNode>>({})
    const [open, setOpen] = useState(false)
    const [triggerRect, setTriggerRect] = useState<SelectTriggerRect | null>(null)
    const currentValue = value ?? uncontrolledValue
    const staticLabels = useMemo(() => collectSelectLabels(children), [children])

    useEffect(() => {
      if (!open) return undefined

      const closeOnOutsidePointer = (event: PointerEvent) => {
        const target = event.target as Node
        if (!rootRef.current?.contains(target) && !contentRef.current?.contains(target)) setOpen(false)
      }

      document.addEventListener('pointerdown', closeOnOutsidePointer, true)
      return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true)
    }, [open])

    const context = useMemo<SelectContextValue>(
      () => ({
        contentId: `${selectId}-options`,
        contentRef,
        size,
        disabled: props.disabled === true,
        labels,
        open,
        registerLabel: (itemValue, itemLabel) => {
          setLabels((currentLabels) => (
            currentLabels[itemValue] === itemLabel ? currentLabels : { ...currentLabels, [itemValue]: itemLabel }
          ))
        },
        selectedLabel: currentValue ? labels[currentValue] ?? staticLabels[currentValue] : undefined,
        triggerRect,
        setOpen,
        setTriggerRect,
        setValue: (nextValue) => {
          if (props.disabled) return
          if (value === undefined) setUncontrolledValue(nextValue)
          onValueChange?.(nextValue)
          setOpen(false)
        },
        value: currentValue
      }),
      [currentValue, labels, onValueChange, open, props.disabled, selectId, size, staticLabels, triggerRect, value]
    )

    if (!isNativeSelectChildren(children)) {
      return (
        <SelectContext.Provider value={context}>
          <div
            aria-disabled={props.disabled || undefined}
            className={fieldClassName({})}
            data-value={currentValue}
            ref={rootRef}
          >
            {label ? <span className={fieldLabelClassName({})} {...(labelSource ? { 'data-i18n-text': labelSource } : {})}>{label}</span> : null}
            <div className={selectCompatClassName}>{children}</div>
            {error ? (
              <span className={fieldMessageClassName({})} id={messageId} {...(errorSource ? { 'data-i18n-text': errorSource } : {})}>
                {error}
              </span>
            ) : null}
          </div>
        </SelectContext.Provider>
      )
    }

    return (
      <label className={fieldClassName({})} htmlFor={selectId}>
        {label ? <span className={fieldLabelClassName({})} {...(labelSource ? { 'data-i18n-text': labelSource } : {})}>{label}</span> : null}
        <span className={selectShellClassName}>
          <select
            aria-describedby={messageId}
            aria-invalid={error ? true : undefined}
            className={cx(selectClassName({ className, invalid: Boolean(error), size }), selectStyleClassName({ invalid: Boolean(error), size }), 'peer')}
            id={selectId}
            ref={ref}
            value={value}
            defaultValue={defaultValue}
            onChange={(event) => {
              onChange?.(event)
              onValueChange?.(event.currentTarget.value)
            }}
            {...props}
          >
            {children}
          </select>
          <span aria-hidden="true" className={selectChevronClassName} />
        </span>
        {error ? (
          <span className={fieldMessageClassName({})} id={messageId} {...(errorSource ? { 'data-i18n-text': errorSource } : {})}>
            {error}
          </span>
        ) : null}
      </label>
    )
  }
)

Select.displayName = 'Select'

export type SelectGroupProps = HTMLAttributes<HTMLDivElement>

export const SelectGroup = forwardRef<HTMLDivElement, SelectGroupProps>(({ className, ...props }, ref) => (
  <div className={cx(selectGroupClassName, className)} ref={ref} role="group" {...props} />
))

SelectGroup.displayName = 'SelectGroup'

export interface SelectValueProps extends HTMLAttributes<HTMLSpanElement> {
  placeholder?: ReactNode
}

export const SelectValue = forwardRef<HTMLSpanElement, SelectValueProps>(
  ({ children, className, placeholder, ...props }, ref) => {
    const context = useContext(SelectContext)

    return (
      <span className={['vds-select__value', className].filter(Boolean).join(' ')} ref={ref} {...props}>
        {children ?? context?.selectedLabel ?? placeholder}
      </span>
    )
  }
)

SelectValue.displayName = 'SelectValue'

export type SelectTriggerProps = ButtonHTMLAttributes<HTMLButtonElement>

export const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(({ className, ...props }, ref) => (
  <SelectTriggerInner className={className} ref={ref} {...props} />
))

const SelectTriggerInner = forwardRef<HTMLButtonElement, SelectTriggerProps>(({ children, className, disabled, onClick, onKeyDown, ...props }, ref) => {
  const context = useContext(SelectContext)
  const innerRef = useRef<HTMLButtonElement>(null)
  const isDisabled = disabled || context?.disabled
  useImperativeHandle(ref, () => innerRef.current as HTMLButtonElement)

  return (
    <button
      aria-expanded={context?.open ?? false}
      aria-haspopup="listbox"
      aria-controls={context?.contentId}
      className={cx(selectClassName({ className, size: context?.size ?? 'md' }), selectStyleClassName({ size: context?.size ?? 'md' }), 'group')}
      data-state={context?.open ? 'open' : 'closed'}
      disabled={isDisabled}
      ref={innerRef}
      role="combobox"
      type="button"
      {...props}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented || isDisabled || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        context?.setTriggerRect({ bottom: rect.bottom, left: rect.left, top: rect.top, width: rect.width })
        context?.setOpen(true)
      }}
      onClick={(event) => {
        onClick?.(event)
        if (!event.defaultPrevented && !isDisabled) {
          const rect = event.currentTarget.getBoundingClientRect()
          context?.setTriggerRect({ bottom: rect.bottom, left: rect.left, top: rect.top, width: rect.width })
          context?.setOpen(!context.open)
        }
      }}
    >
      <span className={selectTriggerValueClassName}>{children}</span>
      <IconFont aria-hidden="true" className={selectTriggerIconClassName} type="a-line-switch-arrow-down-s" />
    </button>
  )
})

SelectTrigger.displayName = 'SelectTrigger'

export type SelectContentProps = HTMLAttributes<HTMLDivElement>

export const SelectContent = forwardRef<HTMLDivElement, SelectContentProps>(({ className, style, onKeyDown, ...props }, ref) => {
  const context = useContext(SelectContext)
  const fallbackRef = useRef<HTMLDivElement>(null)
  const contentRef = context?.contentRef ?? fallbackRef
  const [contentHeight, setContentHeight] = useState(0)
  useImperativeHandle(ref, () => contentRef?.current as HTMLDivElement)

  useEffect(() => {
    if (!context?.open || !contentRef?.current) return
    setContentHeight(contentRef.current.getBoundingClientRect().height)
  }, [contentRef, context?.open])

  useFocusScope(contentRef, Boolean(context?.open && context.triggerRect), false, true)
  useLayoutEffect(() => {
    if (!context?.open) return
    const selected = contentRef.current?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]:not([aria-disabled="true"])')
    if (selected && visibleContent(selected)) selected.focus({ preventScroll: true })
  }, [contentRef, context?.open])

  if (!context?.open || !context.triggerRect || typeof document === 'undefined') return null
  const viewportHeight = window.innerHeight
  const belowTop = context.triggerRect.bottom + SELECT_CONTENT_OFFSET
  const aboveTop = context.triggerRect.top - contentHeight - SELECT_CONTENT_OFFSET
  const fitsBelow = contentHeight === 0 || belowTop + contentHeight <= viewportHeight - SELECT_VIEWPORT_PADDING
  const fitsAbove = aboveTop >= SELECT_VIEWPORT_PADDING
  const top = fitsBelow || !fitsAbove ? belowTop : aboveTop
  const positionedStyle: CSSProperties = {
    left: context.triggerRect.left,
    minWidth: Math.max(context.triggerRect.width, 128),
    position: 'fixed',
    top: Math.max(SELECT_VIEWPORT_PADDING, Math.min(top, viewportHeight - SELECT_VIEWPORT_PADDING)),
    width: context.triggerRect.width,
    ...style
  }

  return createPortal(
    <div
      className={cx(selectContentClassName, className)}
      ref={contentRef}
      role="listbox"
      id={context.contentId}
      tabIndex={-1}
      style={positionedStyle}
      {...props}
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.defaultPrevented) return
        if (event.key === 'Escape') {
          event.preventDefault()
          context.setOpen(false)
          return
        }
        const items = [...event.currentTarget.querySelectorAll<HTMLElement>(SELECT_OPTION_SELECTOR)].filter(visibleContent)
        if (!items.length) return
        const index = items.indexOf(document.activeElement as HTMLElement)
        if (event.key === 'Enter' || event.key === ' ') {
          if (index >= 0) { event.preventDefault(); items[index].click() }
          return
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length
        items[next].focus()
      }}
    />,
    document.body
  )
})

SelectContent.displayName = 'SelectContent'

export type SelectLabelProps = HTMLAttributes<HTMLDivElement>

export const SelectLabel = forwardRef<HTMLDivElement, SelectLabelProps>(({ className, ...props }, ref) => (
  <div className={cx(selectLabelClassName, className)} ref={ref} {...props} />
))

SelectLabel.displayName = 'SelectLabel'

export interface SelectItemProps extends HTMLAttributes<HTMLDivElement> {
  disabled?: boolean
  value: string
}

export const SelectItem = forwardRef<HTMLDivElement, SelectItemProps>(
  ({ children, className, disabled = false, onClick, value, ...props }, ref) => {
    const context = useContext(SelectContext)
    const selected = context?.value === value

    useEffect(() => {
      if (context && children !== undefined) context.registerLabel(value, children)
    }, [children, context, value])

    return (
      <div
        aria-selected={selected || undefined}
        aria-disabled={disabled || undefined}
        className={cx(selectItemBaseClassName, selected && selectItemSelectedClassName, disabled && 'pointer-events-none opacity-[var(--vds-opacity-disabled)]', className)}
        data-value={value}
        ref={ref}
        role="option"
        tabIndex={disabled ? -1 : 0}
        onClick={(event) => {
          onClick?.(event)
          if (!event.defaultPrevented && !disabled) context?.setValue(value)
        }}
        {...props}
      >
        <span className={selectItemLabelClassName}>{children}</span>
        {selected ? (
          <IconFont aria-hidden="true" className={selectItemIndicatorClassName} type="line-operation-select" />
        ) : null}
      </div>
    )
  }
)

SelectItem.displayName = 'SelectItem'

export type SelectSeparatorProps = HTMLAttributes<HTMLDivElement>

export const SelectSeparator = forwardRef<HTMLDivElement, SelectSeparatorProps>(({ className, ...props }, ref) => (
  <div aria-hidden="true" className={cx(selectSeparatorClassName, className)} ref={ref} {...props} />
))

SelectSeparator.displayName = 'SelectSeparator'

export type SelectScrollButtonProps = HTMLAttributes<HTMLDivElement>

export const SelectScrollUpButton = forwardRef<HTMLDivElement, SelectScrollButtonProps>(
  ({ className, ...props }, ref) => (
    <div className={cx(selectScrollButtonClassName, className)} ref={ref} {...props} />
  )
)

SelectScrollUpButton.displayName = 'SelectScrollUpButton'

export const SelectScrollDownButton = forwardRef<HTMLDivElement, SelectScrollButtonProps>(
  ({ className, ...props }, ref) => (
    <div className={cx(selectScrollButtonClassName, className)} ref={ref} {...props} />
  )
)

SelectScrollDownButton.displayName = 'SelectScrollDownButton'
