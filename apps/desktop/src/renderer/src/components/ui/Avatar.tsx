import type { HTMLAttributes, ImgHTMLAttributes, ReactNode } from 'react'
import { forwardRef, useEffect, useState } from 'react'

import { avatarClassName, avatarStyleClassName, type AvatarSize } from './classes'
import { cx } from './utils'

export type { AvatarSize }

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  alt?: string
  fallback?: ReactNode
  image?: string
  size?: AvatarSize
}

export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(
  ({ alt = '', children, className, fallback, image, size = 'md', ...props }, ref) => {
    const [imageFailed, setImageFailed] = useState(false)

    useEffect(() => {
      setImageFailed(false)
    }, [image])

    return (
      <span className={cx(avatarClassName({ className, size }), avatarStyleClassName({ size }))} ref={ref} {...props}>
        {children}
        {!children && image && !imageFailed ? (
          <AvatarImage alt={alt} src={image} onError={() => setImageFailed(true)} />
        ) : (
          !children ? <AvatarFallback>{fallback}</AvatarFallback> : null
        )}
      </span>
    )
  }
)

Avatar.displayName = 'Avatar'

export type AvatarImageProps = ImgHTMLAttributes<HTMLImageElement>

export const AvatarImage = forwardRef<HTMLImageElement, AvatarImageProps>(
  ({ className, ...props }, ref) => (
    <img className={cx('vds-ui-avatar__image size-full object-cover', className)} ref={ref} {...props} />
  )
)

AvatarImage.displayName = 'AvatarImage'

export type AvatarFallbackProps = HTMLAttributes<HTMLSpanElement>

export const AvatarFallback = forwardRef<HTMLSpanElement, AvatarFallbackProps>(
  ({ className, ...props }, ref) => (
    <span className={cx('vds-ui-avatar__fallback grid size-full place-items-center', className)} ref={ref} {...props} />
  )
)

AvatarFallback.displayName = 'AvatarFallback'
