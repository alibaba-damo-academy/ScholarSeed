import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { IconFont } from '../primitive/Iconfont'

import { Button } from './Button'
import { cx } from './utils'

export type NavigationButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  label: string
  icon?: ReactNode
} & ({ onBack: () => void; backLabel: string } | { onBack?: never; backLabel?: never })

const ICON_CLASS_NAME =
  'flex size-[var(--vds-navigation-button-icon-size)] shrink-0 items-center justify-center text-[var(--vds-text-tertiary)] [&_.iconfont]:!text-[length:var(--vds-navigation-button-icon-size)] [&_.iconfont]:!leading-none [&_svg]:!size-[var(--vds-navigation-button-icon-size)]'
const SURFACE_CLASS_NAME =
  'flex h-[var(--vds-control-height-md)] w-[var(--vds-navigation-button-width)] min-w-0 shrink-0 items-center rounded-[var(--vds-radius-4)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-control-label-line-height)] font-[var(--vds-fw-semibold)] text-[var(--vds-text-primary)]'
const INTERACTION_CLASS_NAME =
  'rounded-[var(--vds-radius-4)] hover:bg-[var(--vds-bg-gray-hover-transparent)] focus-visible:shadow-[var(--vds-focus-brand)] disabled:text-[var(--vds-text-disabled)] disabled:hover:bg-transparent'

export const NavigationButton = forwardRef<HTMLButtonElement, NavigationButtonProps>(
  (
    {
      label,
      icon = <IconFont type="a-line-switch-arrow-left-s" />,
      onBack,
      backLabel,
      className,
      title = label,
      ...props
    },
    ref
  ) => {
    const leading = icon !== null && (
      <span aria-hidden="true" className={ICON_CLASS_NAME}>
        {icon}
      </span>
    )
    const trigger = (
      <Button
        unstyled
        ref={ref}
        title={title}
        className={cx(
          onBack
            ? 'flex h-full min-w-0 flex-1 items-center gap-[var(--vds-navigation-button-gap)] [padding:var(--vds-navigation-button-gap)_var(--vds-navigation-button-gap)_var(--vds-navigation-button-gap)_0] [font:inherit] text-inherit'
            : cx(
                SURFACE_CLASS_NAME,
                'gap-[var(--vds-navigation-button-gap)] p-[var(--vds-navigation-button-gap)]'
              ),
          INTERACTION_CLASS_NAME,
          !onBack && className
        )}
        {...props}
      >
        {!onBack && leading}
        <span className="min-w-0 flex-1 truncate text-left" data-slot="navigation-label">
          {label}
        </span>
        <span aria-hidden="true" className={ICON_CLASS_NAME}>
          <IconFont type="a-line-switch-arrow-down-s" />
        </span>
      </Button>
    )
    return onBack ? (
      <div
        className={cx(SURFACE_CLASS_NAME, 'gap-0 p-0', className)}
        data-slot="navigation-control"
      >
        <Button
          unstyled
          aria-label={backLabel}
          disabled={props.disabled}
          onClick={onBack}
          className={cx(
            'flex h-full w-[calc(var(--vds-navigation-button-icon-size)+var(--vds-navigation-button-gap)*2)] shrink-0 items-center justify-center py-[var(--vds-navigation-button-gap)] px-[var(--vds-navigation-button-gap)]',
            INTERACTION_CLASS_NAME
          )}
        >
          {leading}
        </Button>
        {trigger}
      </div>
    ) : (
      trigger
    )
  }
)

NavigationButton.displayName = 'NavigationButton'
