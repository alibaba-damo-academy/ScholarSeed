import React, { useMemo } from 'react'

import {
  drawingBounds,
  drawingLineHeight,
  type DrawingGrid,
  type DrawingParagraph,
  type WorkbookDrawing,
} from './drawing'

interface Props extends DrawingGrid {
  items: readonly WorkbookDrawing[]
  onNavigate: (target: NonNullable<WorkbookDrawing['hyperlink']>) => void
}

const EMU_PER_PIXEL = 9525
const POINTS_TO_PIXELS = 4 / 3
const ROUND_RECT_RADIUS = 1 / 6
const MULTILINE_ROWS = 2

function fontFamily(font: string | undefined): string {
  return font ? `${JSON.stringify(font)}, Arial, sans-serif` : 'Arial, sans-serif'
}

function paragraphWidth(
  paragraph: DrawingParagraph,
  context: CanvasRenderingContext2D,
  scale: number
): number {
  let width = 0
  let maximum = 0
  for (const run of paragraph.runs) {
    context.font = `${run.italic ? 'italic' : 'normal'} ${run.bold ? 'bold' : 'normal'} ${run.sizePt * POINTS_TO_PIXELS * scale}px ${fontFamily(run.font)}`
    const lines = run.text.split('\n')
    for (let index = 0; index < lines.length; index++) {
      if (index) {
        maximum = Math.max(maximum, width)
        width = 0
      }
      width += context.measureText(lines[index]).width
    }
  }
  return Math.max(maximum, width)
}

/** SVG is the user's DrawingML document content; it is not a product icon or cell evidence. */
export function Drawing({ items, onNavigate, ...grid }: Props): React.JSX.Element {
  const scale = grid.zoom / 100
  const measurement = useMemo(() => document.createElement('canvas').getContext('2d'), [])
  return (
    <div className="pointer-events-none absolute inset-0" data-testid="office-workbook-drawings">
      {items.map((item) => {
        const box = drawingBounds(item, grid)
        if (!box.width || !box.height) return null
        const text = item.paragraphs
          .map((paragraph) => paragraph.runs.map((run) => run.text).join(''))
          .join('\n')
        const label = text || item.name
        const strokeWidth = (item.lineWidthEmu / EMU_PER_PIXEL) * scale
        const inset = strokeWidth / 2
        const background =
          item.geometry === 'ellipse' ? (
            <ellipse
              cx={box.width / 2}
              cy={box.height / 2}
              rx={Math.max(0, box.width / 2 - inset)}
              ry={Math.max(0, box.height / 2 - inset)}
            />
          ) : (
            <rect
              x={inset}
              y={inset}
              width={Math.max(0, box.width - strokeWidth)}
              height={Math.max(0, box.height - strokeWidth)}
              rx={
                item.geometry === 'roundRect'
                  ? Math.min(box.width, box.height) * ROUND_RECT_RADIUS
                  : 0
              }
            />
          )
        let leftInset = (item.insetsEmu.left / EMU_PER_PIXEL) * scale
        let rightInset = (item.insetsEmu.right / EMU_PER_PIXEL) * scale
        const longestLine = Math.max(
          0,
          ...item.paragraphs.map((paragraph) =>
            Math.max(0, ...paragraph.runs.map((run) => run.sizePt * POINTS_TO_PIXELS * scale))
          )
        )
        // Fit a single-line source shape with the actual font fallback metrics. Taller shapes retain their intended wrapping.
        if (
          measurement &&
          item.paragraphs.length === 1 &&
          !text.includes('\n') &&
          box.height < longestLine * MULTILINE_ROWS
        ) {
          const measuredWidth = Math.ceil(paragraphWidth(item.paragraphs[0], measurement, scale))
          if (measuredWidth <= box.width) {
            const availableHorizontalInset = Math.max(0, (box.width - measuredWidth) / 2)
            leftInset = Math.min(leftInset, availableHorizontalInset)
            rightInset = Math.min(rightInset, availableHorizontalInset)
          }
        }
        // Office centers text even when an auto-fit shape's cached height is smaller than its default text insets.
        const availableInset = Math.max(0, (box.height - longestLine) / 2)
        const topInset = Math.min((item.insetsEmu.top / EMU_PER_PIXEL) * scale, availableInset)
        const bottomInset = Math.min(
          (item.insetsEmu.bottom / EMU_PER_PIXEL) * scale,
          availableInset
        )
        const navigate = (): void => {
          if (item.hyperlink) onNavigate(item.hyperlink)
        }
        return (
          <svg
            key={item.id}
            data-testid="office-workbook-drawing"
            data-drawing-id={item.id}
            aria-label={label}
            role={item.hyperlink ? 'group' : 'img'}
            className="absolute overflow-visible"
            width={box.width}
            height={box.height}
            style={{ left: box.x, top: box.y }}
          >
            <title>{label}</title>
            <g
              transform={
                item.rotation
                  ? `rotate(${item.rotation} ${box.width / 2} ${box.height / 2})`
                  : undefined
              }
              role={item.hyperlink ? 'link' : undefined}
              aria-label={item.hyperlink ? label : undefined}
              tabIndex={item.hyperlink ? 0 : undefined}
              pointerEvents={item.hyperlink ? 'all' : 'none'}
              cursor={item.hyperlink ? 'pointer' : undefined}
              onPointerDown={
                item.hyperlink
                  ? (event) => {
                      event.stopPropagation()
                    }
                  : undefined
              }
              onClick={
                item.hyperlink
                  ? (event) => {
                      event.stopPropagation()
                      navigate()
                    }
                  : undefined
              }
              onKeyDown={
                item.hyperlink
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        event.stopPropagation()
                        navigate()
                      }
                    }
                  : undefined
              }
            >
              {item.type === 'image' ? (
                item.imageDataUrl && (
                  <image
                    href={item.imageDataUrl}
                    width={box.width}
                    height={box.height}
                    preserveAspectRatio="none"
                  />
                )
              ) : (
                <g
                  fill={item.fill ?? 'none'}
                  fillOpacity={item.fillOpacity}
                  stroke={item.line ?? 'none'}
                  strokeOpacity={item.lineOpacity}
                  strokeWidth={strokeWidth}
                >
                  {background}
                </g>
              )}
              {!!text && (
                <foreignObject
                  x={leftInset}
                  y={topInset}
                  width={Math.max(0, box.width - leftInset - rightInset)}
                  height={Math.max(0, box.height - topInset - bottomInset)}
                >
                  <div
                    className={`flex h-full flex-col ${item.verticalAlignment === 'center' ? 'justify-center' : item.verticalAlignment === 'bottom' ? 'justify-end' : 'justify-start'}`}
                  >
                    {item.paragraphs.map((paragraph, paragraphIndex) => (
                      <div
                        key={paragraphIndex}
                        className="whitespace-pre-wrap [text-align:var(--office-drawing-text-align)] [line-height:var(--office-drawing-line-height)] [font-size:var(--office-drawing-paragraph-size)] [font-family:var(--office-drawing-font-family)]"
                        style={
                          {
                            '--office-drawing-text-align': paragraph.alignment,
                            '--office-drawing-line-height': drawingLineHeight(paragraph, grid.zoom),
                            '--office-drawing-paragraph-size': `${Math.max(0, ...paragraph.runs.map((run) => run.sizePt)) * POINTS_TO_PIXELS * scale}px`,
                            '--office-drawing-font-family': fontFamily(paragraph.runs[0]?.font),
                          } as React.CSSProperties
                        }
                      >
                        {paragraph.runs.map((run, runIndex) => (
                          <span
                            key={runIndex}
                            className="[font-size:var(--office-drawing-font-size)] [font-family:var(--office-drawing-font-family)] [font-weight:var(--office-drawing-font-weight)] [font-style:var(--office-drawing-font-style)] text-[var(--office-drawing-font-color)]"
                            style={
                              {
                                '--office-drawing-font-size': `${run.sizePt * POINTS_TO_PIXELS * scale}px`,
                                '--office-drawing-font-family': fontFamily(run.font),
                                '--office-drawing-font-weight': run.bold ? 'bold' : 'normal',
                                '--office-drawing-font-style': run.italic ? 'italic' : 'normal',
                                '--office-drawing-font-color': run.color,
                              } as React.CSSProperties
                            }
                          >
                            {run.text}
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                </foreignObject>
              )}
            </g>
          </svg>
        )
      })}
    </div>
  )
}
