import { useTranslation } from 'react-i18next'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { forwardRef, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { IconFont } from '../primitive/Iconfont'
import { toastClassName, toastStyleClassName } from './classes'
import { ToastContext } from './toastContext'
import { cx } from './utils'

export type ToastTone = 'error' | 'info' | 'success' | 'warning'
export type ToastDuration = false | number

export interface ToastData {
  action?: ReactNode
  closeLabel?: string
  dedupeKey?: string
  description?: ReactNode
  duration?: ToastDuration
  id: string
  revision?: number
  title?: ReactNode
  tone?: ToastTone
}

export interface ToastInput extends Omit<ToastData, 'id' | 'revision'> {
  id?: string
}

export interface ToastContextValue {
  dismiss: (id: string) => void
  toast: (toast: ToastInput) => string
  toasts: ToastData[]
}

export interface ToastProviderProps {
  children: ReactNode
  defaultToasts?: ToastData[]
}

export interface ToasterProps extends HTMLAttributes<HTMLOListElement> {
  closeLabel?: string
  onDismiss?: (id: string) => void
  placement?: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'
  toasts?: ToastData[]
}

export interface ToastProps extends Omit<HTMLAttributes<HTMLLIElement>, 'title'> {
  action?: ReactNode
  closeButtonProps?: ButtonHTMLAttributes<HTMLButtonElement>
  closeLabel?: string
  description?: ReactNode
  duration?: ToastDuration
  id?: string
  onDismiss?: (id: string) => void
  revision?: number
  title?: ReactNode
  tone?: ToastTone
}

const DEFAULT_TOAST_DURATION = 6000
const TOAST_ID_RADIX = 36
const TOAST_ICON_BY_TONE: Record<ToastTone, string> = {
  error: 'fill-status-error',
  info: 'fill-status-tips',
  success: 'fill-status-success',
  warning: 'fill-status-warning',
}
const TOASTER_STYLE_CLASS_NAME = [
  'fixed left-1/2 -translate-x-1/2 z-[var(--vds-toast-z-index)] block w-[min(var(--vds-toast-width),calc(100%-var(--vds-toast-viewport-gap)*2))]',
  // 多条提示垂直流式排列, 上下间距统一取 --vds-toast-stack-gap。
  'flex flex-col gap-[var(--vds-toast-stack-gap)] m-0 p-0 list-none pointer-events-none',
  '[&.vds-toaster--top-right]:top-[var(--vds-toast-viewport-top-offset)]',
  '[&.vds-toaster--top-left]:top-[var(--vds-toast-viewport-top-offset)]',
  '[&.vds-toaster--bottom-right]:bottom-[var(--vds-toast-viewport-gap)]',
  '[&.vds-toaster--bottom-left]:bottom-[var(--vds-toast-viewport-gap)]',
].join(' ')
// icon 与标题首行顶对齐: 不加额外 margin, 直接随行顶排列。
const TOAST_ICON_CLASS_NAME =
  'vds-toast__icon [width:16px] [height:16px] [font-size:16px] [line-height:var(--vds-lh-body-lv1)]'
const TOAST_ICON_TONE_CLASS_NAMES: Record<ToastTone, string> = {
  error: 'text-[var(--vds-error-bg-default)]',
  info: 'text-[var(--vds-notice-bg-default)]',
  success: 'text-[var(--vds-success-bg-default)]',
  warning: 'text-[var(--vds-warning-bg-default)]',
}
const TOAST_BODY_CLASS_NAME = 'vds-toast__body grid min-w-0 gap-[var(--vds-toast-text-gap)]'
const TOAST_TITLE_CLASS_NAME =
  'vds-toast__title text-[length:var(--vds-font-body-lv1)] font-semibold leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]'
const TOAST_TEXT_CLASS_NAME =
  'line-clamp-2 overflow-hidden text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]'
const TOAST_ACTION_CLASS_NAME =
  'vds-toast__action mt-[var(--vds-space-1)] flex flex-wrap gap-[var(--vds-space-2)]'
// 关闭按钮与弹窗(Dialog)关闭按钮同尺寸: 32px 命中区 + 14px 字形,
// 绝对定位右上角; top-[4px] 使字形顶边(盒顶+9px=13px)与 icon 字形顶边
// (12px padding 行顶)齐平。字形尺寸经 IconFont style 内联下发,
// 覆盖无层级 .iconfont 基础类的 16px(Tailwind v4 层内 utilities 压不过它)。
const TOAST_CLOSE_CLASS_NAME =
  'vds-toast__close absolute top-[var(--vds-space-1)] right-[var(--vds-space-2)] inline-grid place-items-center [width:var(--vds-toast-close-size)] [height:var(--vds-toast-close-size)] [padding:0] [border:0] [border-radius:var(--vds-radius-3)] [background:transparent] [color:var(--vds-text-tertiary)] [line-height:1] cursor-pointer hover:[background:var(--vds-surface-hover)] hover:[color:var(--vds-text-primary)] focus-visible:outline-none focus-visible:shadow-[var(--vds-focus-brand)]'
const TOAST_CLOSE_GLYPH_STYLE = { fontSize: 'var(--vds-icon-7)' }
// 带关闭按钮时正文预留右侧空间, 避免文本钻到按钮下方。
const TOAST_CLOSEABLE_PADDING_CLASS_NAME =
  '[padding-right:calc(var(--vds-space-2)+var(--vds-toast-close-size))]'

function createToastId(): string {
  return `toast-${Date.now().toString(TOAST_ID_RADIX)}-${Math.random().toString(TOAST_ID_RADIX).slice(2)}`
}

function toastIdentity(toast: ToastInput): string | undefined {
  if (toast.dedupeKey !== undefined) return JSON.stringify(['key', toast.dedupeKey])
  if (toast.tone !== 'error') return undefined
  const content = [toast.title, toast.description]
  if (!content.some((value) => typeof value === 'string' && value.length > 0)) return undefined
  if (
    !content.every(
      (value) => value == null || typeof value === 'string' || typeof value === 'number'
    )
  )
    return undefined
  return JSON.stringify(['error', toast.duration === false, ...content])
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used inside ToastProvider')
  return context
}

export function ToastProvider({ children, defaultToasts = [] }: ToastProviderProps): JSX.Element {
  const [toasts, setToasts] = useState<ToastData[]>(defaultToasts)
  const toastsRef = useRef(toasts)

  const dismiss = useCallback((id: string) => {
    toastsRef.current = toastsRef.current.filter((toast) => toast.id !== id)
    setToasts(toastsRef.current)
  }, [])

  const toast = useCallback((nextToast: ToastInput) => {
    const identity = toastIdentity(nextToast)
    const existing = toastsRef.current.find((current) =>
      nextToast.id !== undefined
        ? current.id === nextToast.id
        : identity !== undefined && toastIdentity(current) === identity
    )
    const id = existing?.id ?? nextToast.id ?? createToastId()
    const updated = { ...nextToast, id, revision: (existing?.revision ?? 0) + 1 }
    toastsRef.current = existing
      ? toastsRef.current.map((current) => (current.id === id ? updated : current))
      : [...toastsRef.current, updated]
    setToasts(toastsRef.current)
    return id
  }, [])

  const value = useMemo<ToastContextValue>(
    () => ({ dismiss, toast, toasts }),
    [dismiss, toast, toasts]
  )

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>
}

export const Toaster = forwardRef<HTMLOListElement, ToasterProps>(
  (
    {
      'aria-live': ariaLive = 'polite',
      children,
      className,
      closeLabel,
      onDismiss,
      placement = 'top-right',
      toasts,
      ...props
    },
    ref
  ) => {
    const context = useContext(ToastContext)
    const controlled = toasts !== undefined
    const currentToasts = toasts ?? context?.toasts ?? []
    const dismiss = useMemo<((id: string) => void) | undefined>(() => {
      if (controlled) return onDismiss
      return context?.dismiss
    }, [context, controlled, onDismiss])
    const handleDismiss = useCallback(
      (id: string) => {
        dismiss?.(id)
      },
      [dismiss]
    )

    const viewport = (
      <ol
        aria-live={ariaLive}
        className={cx(
          'vds-toaster',
          `vds-toaster--${placement}`,
          TOASTER_STYLE_CLASS_NAME,
          className
        )}
        ref={ref}
        role="region"
        {...props}
      >
        {[...currentToasts].reverse().map((toast) => (
          <Toast
            action={toast.action}
            closeLabel={toast.closeLabel ?? closeLabel}
            description={toast.description}
            duration={dismiss ? toast.duration : false}
            id={toast.id}
            key={toast.id}
            onDismiss={dismiss ? handleDismiss : undefined}
            revision={toast.revision}
            title={toast.title}
            tone={toast.tone}
          />
        ))}
        {children}
      </ol>
    )
    return typeof document === 'undefined' ? viewport : createPortal(viewport, document.body)
  }
)

Toaster.displayName = 'Toaster'

export const Toast = forwardRef<HTMLLIElement, ToastProps>(
  (
    {
      action,
      children,
      className,
      closeButtonProps,
      closeLabel,
      description,
      duration = DEFAULT_TOAST_DURATION,
      id,
      onDismiss,
      onMouseEnter,
      onMouseLeave,
      onFocusCapture,
      onBlurCapture,
      revision = 0,
      title,
      tone = 'info',
      ...props
    },
    ref
  ) => {
    const { t } = useTranslation('ui')
    const role = tone === 'error' ? 'alert' : 'status'
    const closeable = Boolean(id && onDismiss)
    const [hovered, setHovered] = useState(false)
    const [focused, setFocused] = useState(false)
    const paused = hovered || focused
    const remaining = useRef(0)
    const dismissRef = useRef(onDismiss)

    useEffect(() => {
      dismissRef.current = onDismiss
    }, [onDismiss])

    useEffect(() => {
      remaining.current = duration === false ? 0 : duration
    }, [duration, id, revision])

    useEffect(() => {
      if (!id || !closeable || paused || duration === false || duration <= 0) return undefined
      const startedAt = performance.now()
      const timeout = window.setTimeout(() => dismissRef.current?.(id), remaining.current)
      return () => {
        window.clearTimeout(timeout)
        remaining.current = Math.max(0, remaining.current - (performance.now() - startedAt))
      }
    }, [closeable, duration, id, paused, revision])

    return (
      <li
        aria-atomic="true"
        className={cx(
          toastClassName({ className, tone }),
          toastStyleClassName(),
          closeable && TOAST_CLOSEABLE_PADDING_CLASS_NAME
        )}
        data-tone={tone}
        ref={ref}
        role={role}
        {...props}
        onMouseEnter={(event) => {
          setHovered(true)
          onMouseEnter?.(event)
        }}
        onMouseLeave={(event) => {
          setHovered(false)
          onMouseLeave?.(event)
        }}
        onFocusCapture={(event) => {
          setFocused(true)
          onFocusCapture?.(event)
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
          onBlurCapture?.(event)
        }}
      >
        <IconFont
          aria-hidden="true"
          className={cx(TOAST_ICON_CLASS_NAME, TOAST_ICON_TONE_CLASS_NAMES[tone])}
          type={TOAST_ICON_BY_TONE[tone]}
        />
        <div className={TOAST_BODY_CLASS_NAME}>
          {title ? <div className={TOAST_TITLE_CLASS_NAME}>{title}</div> : null}
          {description ? (
            <div className={cx('vds-toast__description', TOAST_TEXT_CLASS_NAME)}>{description}</div>
          ) : null}
          {children ? (
            <div className={cx('vds-toast__content', TOAST_TEXT_CLASS_NAME)}>{children}</div>
          ) : null}
          {action ? <div className={TOAST_ACTION_CLASS_NAME}>{action}</div> : null}
        </div>
        {id && onDismiss ? (
          <button
            {...closeButtonProps}
            aria-label={closeLabel ?? t('toast.close')}
            className={cx(TOAST_CLOSE_CLASS_NAME, closeButtonProps?.className)}
            type="button"
            onClick={(event) => {
              closeButtonProps?.onClick?.(event)
              if (event.defaultPrevented) return
              onDismiss(id)
            }}
          >
            <IconFont
              aria-hidden="true"
              style={TOAST_CLOSE_GLYPH_STYLE}
              type="line-operation-close"
            />
          </button>
        ) : null}
      </li>
    )
  }
)

Toast.displayName = 'Toast'
export const SonnerToaster = Toaster
