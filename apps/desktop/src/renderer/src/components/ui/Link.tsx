import { forwardRef, type AnchorHTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import { Link as LinkIcon } from 'lucide-react'
import { cx } from './utils'

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  href: string
  icon?: ReactNode
  disabled?: boolean
}

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  {
    children,
    className,
    disabled = false,
    href,
    icon,
    onClick,
    onAuxClick,
    rel,
    role,
    tabIndex,
    target,
    ...props
  },
  ref
) {
  const activate = (event: MouseEvent<HTMLAnchorElement>, handler: typeof onClick): void => {
    if (disabled) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    handler?.(event)
  }
  const safeRel =
    target?.toLowerCase() === '_blank'
      ? [
          ...new Set([
            ...(rel ?? '')
              .split(/\s+/)
              .filter((value) => value && value.toLowerCase() !== 'opener'),
            'noopener',
            'noreferrer',
          ]),
        ].join(' ')
      : rel
  return (
    <a
      {...props}
      ref={ref}
      href={disabled ? undefined : href}
      target={target}
      rel={safeRel}
      role={role ?? (disabled ? 'link' : undefined)}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : tabIndex}
      className={cx(
        'no-underline [overflow-wrap:anywhere] focus-visible:[box-shadow:var(--vds-focus-brand)]',
        disabled
          ? 'cursor-not-allowed text-[var(--vds-link-disabled)]!'
          : 'text-[var(--vds-link)]! hover:text-[var(--vds-link-hover)]! active:text-[var(--vds-link-active)]!',
        className
      )}
      onClick={(event) => activate(event, onClick)}
      onAuxClick={(event) => activate(event, onAuxClick)}
    >
      {icon && (
        <span
          aria-hidden
          className="mr-[var(--vds-space-1)] inline-flex items-center align-middle [&>svg]:block [&>svg]:size-[var(--vds-font-body-lv2)]"
        >
          <LinkIcon strokeWidth={1.5} />
        </span>
      )}
      {children}
    </a>
  )
})
