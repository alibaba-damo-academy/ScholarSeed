import React from 'react'

interface Frame {
  element: HTMLElement
  rect: DOMRect
  radius: string
  kind: string | undefined
}

interface MotionProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  revision: string
  project: string | null
  dragging: boolean
}

/** Measure before React moves the live surfaces; inputs and scroll owners stay mounted. */
export class Motion extends React.Component<MotionProps> {
  private host = React.createRef<HTMLDivElement>()
  private animations = new Map<HTMLElement, Animation>()
  private reduced: MediaQueryList | undefined

  componentDidMount(): void {
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    this.reduced.addEventListener('change', this.cancel)
  }

  componentWillUnmount(): void {
    this.reduced?.removeEventListener('change', this.cancel)
    this.cancel()
  }

  private cancel = (): void => {
    this.animations.forEach((animation) => animation.cancel())
    this.animations.clear()
  }

  private frames(): Map<string, Frame> {
    const frames = new Map<string, Frame>()
    this.host.current
      ?.querySelectorAll<HTMLElement>('[data-workbench-motion]')
      .forEach((element) => {
        const rect = element.getBoundingClientRect()
        if (!rect.width || !rect.height || element.closest('[hidden]')) return
        frames.set(element.dataset.workbenchMotion!, {
          element,
          rect,
          radius: getComputedStyle(element).borderRadius,
          kind: element.dataset.workbenchMotionKind,
        })
      })
    return frames
  }

  getSnapshotBeforeUpdate(previous: MotionProps): Map<string, Frame> | null {
    if (
      this.props.dragging ||
      this.reduced?.matches ||
      previous.project !== this.props.project ||
      (previous.revision === this.props.revision && previous.dragging === this.props.dragging)
    )
      return null
    return this.frames()
  }

  componentDidUpdate(
    previous: MotionProps,
    _state: unknown,
    before: Map<string, Frame> | null
  ): void {
    if (this.props.dragging || this.reduced?.matches || previous.project !== this.props.project) {
      this.cancel()
      return
    }
    if (!before) return
    this.cancel()
    const style = getComputedStyle(this.host.current!)
    const duration = Number.parseFloat(style.getPropertyValue('--vds-duration-normal'))
    const easing = style.getPropertyValue('--vds-ease-standard').trim()
    this.frames().forEach((next, key) => {
      const old = before.get(key)
      if (!old || !next.element.animate) return
      const x = old.rect.left - next.rect.left
      const y = old.rect.top - next.rect.top
      const entryChanged = old.kind !== next.kind
      const computed = getComputedStyle(next.element)
      const anchor =
        computed.position === 'absolute' || computed.position === 'fixed'
          ? { left: computed.left, top: computed.top, right: 'auto', bottom: 'auto' }
          : {}
      if (
        !entryChanged &&
        !x &&
        !y &&
        old.rect.width === next.rect.width &&
        old.rect.height === next.rect.height
      )
        return
      // A compact entry is a separate control: fade it at its own size, never stretch its icon.
      const animation = next.element.animate(
        entryChanged
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              {
                ...anchor,
                boxSizing: 'border-box',
                transform: `translate(${x}px, ${y}px)`,
                width: `${old.rect.width}px`,
                minWidth: `${old.rect.width}px`,
                maxWidth: `${old.rect.width}px`,
                height: `${old.rect.height}px`,
                minHeight: `${old.rect.height}px`,
                maxHeight: `${old.rect.height}px`,
                borderRadius: old.radius,
              },
              {
                ...anchor,
                boxSizing: 'border-box',
                transform: 'none',
                width: `${next.rect.width}px`,
                minWidth: `${next.rect.width}px`,
                maxWidth: `${next.rect.width}px`,
                height: `${next.rect.height}px`,
                minHeight: `${next.rect.height}px`,
                maxHeight: `${next.rect.height}px`,
                borderRadius: next.radius,
              },
            ],
        { duration, easing }
      )
      this.animations.set(next.element, animation)
      animation.onfinish = () => {
        if (this.animations.get(next.element) === animation) this.animations.delete(next.element)
      }
    })
  }

  render(): React.JSX.Element {
    const {
      children,
      revision: _revision,
      project: _project,
      dragging: _dragging,
      ...props
    } = this.props
    return (
      <div {...props} ref={this.host}>
        {children}
      </div>
    )
  }
}
