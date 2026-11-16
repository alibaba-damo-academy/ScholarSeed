import {
  cloneElement,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactElement,
  type JSX,
} from 'react'
import { useTranslation } from 'react-i18next'
import { RESIZE_PORTAL } from '../../../portal'
import { FloatingPortal, useFloatingPortal } from './Floating'

export function Divider({
  children,
}: {
  children: ReactElement<ComponentPropsWithRef<'button'>>
}): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const region = useRef<HTMLButtonElement>(null)
  const [failed, setFailed] = useState(false)
  const { t } = useTranslation('ui')
  const bridge = window.scholarseed?.resizePortal
  const presentation = useFloatingPortal({
    capturePointer: true,
    enabled: Boolean(bridge) && !failed,
    bridge,
    surface: RESIZE_PORTAL,
    failureText: t('nativeResizeUnavailable'),
    host,
    regions: [region],
    onFailure: () => setFailed(true),
  })
  if (!bridge) return children
  return (
    <>
      <div
        ref={host}
        aria-hidden
        data-native-resize-anchor
        className={`${children.props.className ?? ''} pointer-events-none after:!hidden`}
      />
      {!failed && (
        <FloatingPortal presentation={presentation}>
          <div className="relative h-full w-full" data-native-resize-surface>
            {cloneElement(children, {
              ref: region,
              className: `${children.props.className ?? ''} !absolute inset-0 !m-0 !h-full !w-full !flex-none before:invisible hover:before:visible focus-visible:before:visible data-[resizing=true]:before:visible`,
            })}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
