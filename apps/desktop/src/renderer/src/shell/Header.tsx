import { useLayoutEffect, useRef, useState } from 'react'

export function HomeHeader({
  title,
  avoidWindowControls,
}: {
  title: string
  avoidWindowControls: boolean
}): React.JSX.Element {
  const navigationRef = useRef<HTMLDivElement>(null)
  const [hasNavigation, setHasNavigation] = useState(false)
  useLayoutEffect(() => {
    const host = navigationRef.current
    if (!host) return
    const update = (): void => setHasNavigation(host.childElementCount > 0)
    const observer = new MutationObserver(update)
    observer.observe(host, { childList: true })
    update()
    return () => observer.disconnect()
  }, [])
  return (
    <header className="flex h-[var(--vds-workbench-header-height)] shrink-0 items-center border-b border-[var(--vds-divider-default)] pl-[var(--vds-layout-rail-width)] [-webkit-app-region:drag]">
      <div
        className={`min-w-0 flex-1 px-[var(--vds-space-5)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-semibold)]${avoidWindowControls ? ' !pl-[var(--vds-layout-overview-title-inset)]' : ''}`}
      >
        <h1 className={hasNavigation ? 'sr-only' : undefined}>{title}</h1>
        <div ref={navigationRef} data-home-header-navigation className="no-drag w-fit" />
      </div>
      <div
        data-home-header-actions
        className="no-drag flex shrink-0 items-center gap-[var(--vds-space-3)] pr-[var(--vds-space-4)] empty:hidden"
      />
    </header>
  )
}
