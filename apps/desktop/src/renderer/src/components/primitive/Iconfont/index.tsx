import { useTranslation } from 'react-i18next'
import type { CSSProperties, HTMLAttributes } from 'react'

import catalog from './download/iconfont.json'

const ICON_GLYPHS = new Map(
  catalog.glyphs.map((glyph) => [
    `${catalog.css_prefix_text}${glyph.font_class}`,
    String.fromCodePoint(glyph.unicode_decimal),
  ])
)
const ICON_CLASS_NAME =
  'iconfont ![font-family:var(--vds-font-icon)] text-[length:var(--vds-font-icon-size)] not-italic antialiased before:content-[attr(data-icon-glyph)]'

const MISSING_ICON_CLASS_NAME =
  'inline-flex items-center justify-center rounded-[2px] bg-[#ff00ff] text-black font-bold leading-none align-middle'

export interface IconFontProps extends HTMLAttributes<HTMLSpanElement> {
  type: string
  style?: CSSProperties
}

export function IconFont({ type, className = '', style, ...props }: IconFontProps): JSX.Element {
  const iconClassName = type.startsWith('icon-') ? type : `icon-${type}`
  const mergedClassName = [ICON_CLASS_NAME, iconClassName, className].filter(Boolean).join(' ')

  return (
    <span
      aria-hidden="true"
      className={mergedClassName}
      style={style}
      data-icon-glyph={ICON_GLYPHS.get(iconClassName)}
      {...props}
    />
  )
}

export interface MissingIconProps extends HTMLAttributes<HTMLSpanElement> {
  name?: string
  size?: number
  style?: CSSProperties
}

export function MissingIcon({
  name,
  size = 16,
  className = '',
  style,
  ...props
}: MissingIconProps): JSX.Element {
  const { t } = useTranslation('ui')
  const missingLabel = name ? t('icon.missingNamed', { name }) : t('icon.missing')
  const mergedClassName = [MISSING_ICON_CLASS_NAME, className].filter(Boolean).join(' ')

  return (
    <span
      aria-label={missingLabel}
      className={mergedClassName}
      data-missing-icon={name ?? ''}
      role="img"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.6),
        ...style,
      }}
      title={missingLabel}
      {...props}
    >
      {t('icon.missingMark')}
    </span>
  )
}

export default IconFont
