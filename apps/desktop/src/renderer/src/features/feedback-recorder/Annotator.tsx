import React from 'react'
import {
  SquareDashedBottom,
  ArrowUpRight,
  Pencil,
  LetterText,
  Eraser,
  Undo2,
  Copy,
  X,
  ZoomIn,
  ZoomOut,
  Check,
} from 'lucide-react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { writeClipboardImage } from '../../components/primitive/clipboard'

import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  Input,
  IconButton,
  Textarea,
  Tooltip,
  Popover,
  PopoverTrigger,
  PopoverContent,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  FOCUS_SCOPE_EXTENSION_ATTRIBUTE,
} from '../../components/ui'
import { commitActiveTextDraft, type TextDraft } from './draft'
import {
  RECORDER_NOTE_MAX_LENGTH,
  normalizeRectangleAnnotation,
  type Annotation,
  type AnnotationPoint,
} from './model'

type Tool = Annotation['type']

const TOOLS: readonly Tool[] = ['rect', 'text', 'pen', 'arrow', 'redact']
const TOOL_ICONS = {
  rect: SquareDashedBottom,
  arrow: ArrowUpRight,
  pen: Pencil,
  text: LetterText,
  redact: Eraser,
}
const COLORS = [
  {
    key: 'red',
    token: '--vds-error-text-primary',
    appearance: '!bg-[var(--vds-error-text-primary)] !text-[var(--vds-static-white)]',
  },
  {
    key: 'yellow',
    token: '--vds-brand-gold-highlight',
    appearance: '!bg-[var(--vds-brand-gold-highlight)] !text-[var(--vds-static-black)]',
  },
  {
    key: 'blue',
    token: '--vds-link',
    appearance: '!bg-[var(--vds-link)] !text-[var(--vds-static-white)]',
  },
  {
    key: 'green',
    token: '--vds-success-bg-default',
    appearance: '!bg-[var(--vds-success-bg-default)] !text-[var(--vds-static-white)]',
  },
  {
    key: 'black',
    token: '--vds-static-black',
    appearance: '!bg-[var(--vds-static-black)] !text-[var(--vds-static-white)]',
  },
  {
    key: 'gray',
    token: '--vds-icon-outline-default',
    appearance: '!bg-[var(--vds-icon-outline-default)] !text-[var(--vds-static-white)]',
  },
] as const
const LINE_WIDTHS = [1, 2, 4, 6, 8, 12]
const FONT_SIZES = [12, 16, 20, 24, 32, 40, 48]
const REDACTION_COLOR = 'white'
const MIN_ZOOM = 0.05
const MAX_ZOOM = 4
const ZOOM_FACTOR = 1.25
const ANNOTATION_LINE_WIDTH = 4
const ANNOTATION_FONT_SIZE = 24
const ARROW_HEAD_LENGTH = 18

export interface AnnotatorResult {
  renderedFile: File
  annotations: Annotation[]
  note: string
}

interface AnnotatorProps {
  initialAnnotations: readonly Annotation[]
  initialNote: string
  source: File
  onCancel: () => void
  onSave: (result: AnnotatorResult) => void | Promise<void>
}

function textAnnotation(draft: TextDraft): Extract<Annotation, { type: 'text' }> | undefined {
  const value = draft.value.trim()
  if (!value) return undefined
  return {
    type: 'text',
    color: draft.color,
    ...draft.point,
    text: value.slice(0, RECORDER_NOTE_MAX_LENGTH),
    fontSize: draft.fontSize ?? ANNOTATION_FONT_SIZE,
  }
}

function annotationColor(token: string): string {
  const root = getComputedStyle(document.documentElement)
  return root.getPropertyValue(token).trim() || getComputedStyle(document.body).color
}

function point(
  event: React.PointerEvent<HTMLCanvasElement>,
  canvas: HTMLCanvasElement
): AnnotationPoint {
  const bounds = canvas.getBoundingClientRect()
  return {
    x: (event.clientX - bounds.left) * (canvas.width / bounds.width),
    y: (event.clientY - bounds.top) * (canvas.height / bounds.height),
  }
}

export function undoAnnotation(annotations: readonly Annotation[]): Annotation[] {
  return annotations.slice(0, -1)
}

export function drawAnnotation(context: CanvasRenderingContext2D, annotation: Annotation): void {
  context.save()
  if (annotation.type === 'redact') {
    context.globalAlpha = 1
    context.fillStyle = REDACTION_COLOR
    context.fillRect(annotation.x, annotation.y, annotation.width, annotation.height)
    context.restore()
    return
  }
  context.strokeStyle = annotation.color
  context.fillStyle = annotation.color
  context.lineWidth =
    'lineWidth' in annotation
      ? (annotation.lineWidth ?? ANNOTATION_LINE_WIDTH)
      : ANNOTATION_LINE_WIDTH
  context.lineCap = 'round'
  context.lineJoin = 'round'
  if (annotation.type === 'rect') {
    context.strokeRect(annotation.x, annotation.y, annotation.width, annotation.height)
  } else if (annotation.type === 'pen') {
    const [first, ...rest] = annotation.points
    if (first) {
      context.beginPath()
      context.moveTo(first.x, first.y)
      rest.forEach((entry) => context.lineTo(entry.x, entry.y))
      context.stroke()
    }
  } else if (annotation.type === 'arrow') {
    const [start, end] = annotation.points
    const angle = Math.atan2(end.y - start.y, end.x - start.x)
    context.beginPath()
    context.moveTo(start.x, start.y)
    context.lineTo(end.x, end.y)
    context.moveTo(end.x, end.y)
    context.lineTo(
      end.x - ARROW_HEAD_LENGTH * Math.cos(angle - Math.PI / 6),
      end.y - ARROW_HEAD_LENGTH * Math.sin(angle - Math.PI / 6)
    )
    context.moveTo(end.x, end.y)
    context.lineTo(
      end.x - ARROW_HEAD_LENGTH * Math.cos(angle + Math.PI / 6),
      end.y - ARROW_HEAD_LENGTH * Math.sin(angle + Math.PI / 6)
    )
    context.stroke()
  } else {
    context.font = `600 ${annotation.fontSize ?? ANNOTATION_FONT_SIZE}px sans-serif`
    context.textBaseline = 'top'
    context.fillText(annotation.text, annotation.x, annotation.y)
  }
  context.restore()
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('annotation_export_failed'))
    }, 'image/png')
  })
}

function toolLabel(t: TFunction<'components'>, tool: Tool): string {
  if (tool === 'rect') return t('feedbackRecorder.annotator.tools.rect')
  if (tool === 'arrow') return t('feedbackRecorder.annotator.tools.arrow')
  if (tool === 'pen') return t('feedbackRecorder.annotator.tools.pen')
  if (tool === 'text') return t('feedbackRecorder.annotator.tools.text')
  return t('feedbackRecorder.annotator.tools.redact')
}

function colorLabel(t: TFunction<'components'>, color: (typeof COLORS)[number]['key']): string {
  if (color === 'red') return t('feedbackRecorder.annotator.colors.red')
  if (color === 'yellow') return t('feedbackRecorder.annotator.colors.yellow')
  if (color === 'blue') return t('feedbackRecorder.annotator.colors.blue')
  if (color === 'green') return t('feedbackRecorder.annotator.colors.green')
  if (color === 'black') return t('feedbackRecorder.annotator.colors.black')
  return t('feedbackRecorder.annotator.colors.gray')
}

export function Annotator({
  initialAnnotations,
  initialNote,
  source,
  onCancel,
  onSave,
}: AnnotatorProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const surfaceRef = React.useRef<HTMLDivElement>(null)
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const panRef = React.useRef<{
    pointerId: number
    x: number
    y: number
    startX: number
    startY: number
  } | null>(null)
  const [pan, setPan] = React.useState({ x: 0, y: 0 })
  const [panning, setPanning] = React.useState(false)
  const imageRef = React.useRef<HTMLImageElement | null>(null)
  const draftRef = React.useRef<Annotation | null>(null)
  const textDraftRef = React.useRef<TextDraft | null>(null)
  const textDraftSequenceRef = React.useRef(0)
  const textInputRef = React.useRef<HTMLInputElement>(null)
  const [tool, setTool] = React.useState<Tool | null>(null)
  const [color, setColor] = React.useState<(typeof COLORS)[number]>(COLORS[0])
  const [lineWidth, setLineWidth] = React.useState(ANNOTATION_LINE_WIDTH)
  const [fontSize, setFontSize] = React.useState(ANNOTATION_FONT_SIZE)
  const [textDraft, setTextDraftState] = React.useState<TextDraft | null>(null)
  const [note, setNote] = React.useState(initialNote)
  const [saveError, setSaveError] = React.useState(false)
  const [annotations, setAnnotations] = React.useState<Annotation[]>([...initialAnnotations])
  const [saving, setSaving] = React.useState(false)
  const [copying, setCopying] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [naturalSize, setNaturalSize] = React.useState({ width: 0, height: 0 })
  const [viewportSize, setViewportSize] = React.useState({ width: 0, height: 0 })
  const [manualZoom, setManualZoom] = React.useState<number | null>(null)
  const fitZoom =
    naturalSize.width && naturalSize.height && viewportSize.width && viewportSize.height
      ? Math.min(
          1,
          viewportSize.width / naturalSize.width,
          viewportSize.height / naturalSize.height
        )
      : 1
  const zoom = manualZoom ?? fitZoom
  const zoomReady = naturalSize.width > 0
  const viewRef = React.useRef({ zoom, pan })
  React.useLayoutEffect(() => {
    viewRef.current = { zoom, pan }
  }, [zoom, pan])
  const changeZoom = React.useCallback(
    (factor: number, anchor?: { x: number; y: number }): void => {
      const current = viewRef.current
      const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current.zoom * factor))
      const viewport = viewportRef.current?.getBoundingClientRect()
      const x = anchor && viewport ? anchor.x - viewport.left - viewport.width / 2 : 0
      const y = anchor && viewport ? anchor.y - viewport.top - viewport.height / 2 : 0
      const ratio = nextZoom / current.zoom
      const nextPan = { x: x - (x - current.pan.x) * ratio, y: y - (y - current.pan.y) * ratio }
      viewRef.current = { zoom: nextZoom, pan: nextPan }
      setManualZoom(nextZoom)
      setPan(nextPan)
    },
    []
  )

  const startPan = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (tool || saving || copying || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    panRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: pan.x,
      startY: pan.y,
    }
    setPanning(true)
  }
  const movePan = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = panRef.current
    if (!start || start.pointerId !== event.pointerId) return
    setPan({ x: start.startX + event.clientX - start.x, y: start.startY + event.clientY - start.y })
  }
  const finishPan = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (panRef.current?.pointerId !== event.pointerId) return
    panRef.current = null
    setPanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  React.useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) return
    const observer = new ResizeObserver(([entry]) =>
      setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    )
    observer.observe(surface)
    return () => observer.disconnect()
  }, [])

  const redraw = React.useCallback(
    (entries: readonly Annotation[], draft?: Annotation | null): void => {
      const canvas = canvasRef.current
      const image = imageRef.current
      if (!canvas || !image) return
      const context = canvas.getContext('2d')
      if (!context) return
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      entries.forEach((entry) => drawAnnotation(context, entry))
      if (draft) drawAnnotation(context, draft)
    },
    []
  )

  React.useEffect(() => {
    setManualZoom(null)
    setPan({ x: 0, y: 0 })
    const url = URL.createObjectURL(source)
    const image = new Image()
    image.onload = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      imageRef.current = image
      setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight })
      redraw(initialAnnotations)
    }
    image.src = url
    return () => URL.revokeObjectURL(url)
  }, [initialAnnotations, source, redraw])

  React.useEffect(() => redraw(annotations), [annotations, redraw])

  React.useEffect(() => {
    if (!textDraft) return
    const frame = requestAnimationFrame(() => textInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [textDraft?.id])

  const setTextDraft = React.useCallback((next: TextDraft | null): void => {
    textDraftRef.current = next
    setTextDraftState(next)
  }, [])

  const commitTextDraft = React.useCallback(
    (draft: TextDraft): void => {
      if (textDraftRef.current?.id !== draft.id) return
      setTextDraft(null)
      const annotation = textAnnotation(draft)
      if (annotation) setAnnotations((current) => [...current, annotation])
    },
    [setTextDraft]
  )

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const wheel = (event: WheelEvent): void => {
      if (saving || copying || !imageRef.current || !event.deltaY) return
      event.preventDefault()
      commitActiveTextDraft(textDraftRef.current, commitTextDraft)
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? viewport.clientHeight
            : 1
      changeZoom(Math.exp(-event.deltaY * unit * 0.002), { x: event.clientX, y: event.clientY })
    }
    viewport.addEventListener('wheel', wheel, { passive: false })
    return () => viewport.removeEventListener('wheel', wheel)
  }, [saving, copying, changeZoom, commitTextDraft])

  const start = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (saving || copying || !tool || event.button !== 0) return
    const canvas = event.currentTarget
    const origin = point(event, canvas)
    if (tool === 'text') {
      const surface = surfaceRef.current
      if (!surface) return
      const activeTextDraft = textDraftRef.current
      if (commitActiveTextDraft(activeTextDraft, commitTextDraft)) return
      const bounds = surface.getBoundingClientRect()
      const surfaceX = event.clientX - bounds.left + surface.scrollLeft - surface.clientLeft
      const surfaceY = event.clientY - bounds.top + surface.scrollTop - surface.clientTop
      textDraftSequenceRef.current += 1
      setTextDraft({
        id: textDraftSequenceRef.current,
        alignRight: event.clientX > bounds.left + bounds.width / 2,
        color: annotationColor(color.token),
        fontSize,
        point: origin,
        surfaceX,
        surfaceY,
        value: '',
      })
      return
    }
    canvas.setPointerCapture(event.pointerId)
    draftRef.current =
      tool === 'pen'
        ? { type: 'pen', color: annotationColor(color.token), lineWidth, points: [origin] }
        : tool === 'rect'
          ? {
              type: 'rect',
              color: annotationColor(color.token),
              lineWidth,
              ...origin,
              width: 0,
              height: 0,
            }
          : tool === 'redact'
            ? { type: 'redact', ...origin, width: 0, height: 0 }
            : {
                type: 'arrow',
                color: annotationColor(color.token),
                lineWidth,
                points: [origin, origin],
              }
  }

  const finishTextBeforeCanvasPointer = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (tool !== 'text') return
    if (!commitActiveTextDraft(textDraftRef.current, commitTextDraft)) return
    event.preventDefault()
    event.stopPropagation()
  }

  const move = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const draft = draftRef.current
    if (!draft) return
    const current = point(event, event.currentTarget)
    if (draft.type === 'pen') draftRef.current = { ...draft, points: [...draft.points, current] }
    else if (draft.type === 'rect' || draft.type === 'redact')
      draftRef.current = { ...draft, width: current.x - draft.x, height: current.y - draft.y }
    else if (draft.type === 'arrow')
      draftRef.current = { ...draft, points: [draft.points[0], current] }
    redraw(annotations, draftRef.current)
  }

  const finish = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const draft = draftRef.current
    draftRef.current = null
    if (draft) {
      const annotation =
        draft.type === 'rect' || draft.type === 'redact'
          ? normalizeRectangleAnnotation(draft)
          : draft
      setAnnotations((current) => [...current, annotation])
    }
  }

  const save = async (): Promise<void> => {
    const canvas = canvasRef.current
    if (!canvas || saving) return
    const pendingText = textDraftRef.current
    const pendingAnnotation = pendingText ? textAnnotation(pendingText) : undefined
    const finalAnnotations = pendingAnnotation ? [...annotations, pendingAnnotation] : annotations
    setTextDraft(null)
    setSaving(true)
    setSaveError(false)
    try {
      redraw(finalAnnotations)
      const blob = await canvasBlob(canvas)
      const renderedFile = new File([blob], `feedback-${Date.now()}.png`, { type: 'image/png' })
      await onSave({ renderedFile, annotations: finalAnnotations, note: note.trim() })
    } catch {
      setSaveError(true)
    } finally {
      setSaving(false)
    }
  }

  const copy = async (): Promise<void> => {
    const canvas = canvasRef.current
    if (!canvas || copying) return
    setCopying(true)
    setCopied(false)
    try {
      const pendingText = textDraftRef.current
      const pendingAnnotation = pendingText ? textAnnotation(pendingText) : undefined
      const finalAnnotations = pendingAnnotation ? [...annotations, pendingAnnotation] : annotations
      setTextDraft(null)
      redraw(finalAnnotations)
      await writeClipboardImage(await canvasBlob(canvas))
      setCopied(true)
    } finally {
      setCopying(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onCancel()
      }}
    >
      <DialogPortal>
        <DialogContent
          hideCloseButton
          className="!z-[var(--vds-z-feedback-recorder-dialog)] !flex h-[var(--vds-feedback-dialog-height)] !w-[var(--vds-feedback-dialog-width)] !max-w-none flex-col gap-[var(--vds-space-3)] overflow-hidden !rounded-[var(--vds-radius-6)] !p-[var(--vds-space-5)]"
          overlayClassName="!z-[var(--vds-z-feedback-recorder-overlay)]"
          data-feedback-recorder-root="annotator"
        >
          <DialogHeader className="!flex !flex-row items-center justify-between !space-y-0">
            <DialogTitle>{t('feedbackRecorder.annotator.title')}</DialogTitle>
            <IconButton
              variant="ghost"
              label={t('feedbackRecorder.cancel')}
              icon={<X />}
              disabled={saving}
              onClick={onCancel}
            />
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-[var(--vds-space-1)]">
            {TOOLS.map((entry) => {
              const ToolIcon = TOOL_ICONS[entry]
              return (
                <Popover
                  key={entry}
                  open={tool === entry && entry !== 'redact'}
                  onOpenChange={() => undefined}
                >
                  <Tooltip
                    content={toolLabel(t, entry)}
                    side="top"
                    contentClassName="!z-[var(--vds-z-feedback-recorder-nested-dialog)]"
                  >
                    <PopoverTrigger asChild>
                      <IconButton
                        size="sm"
                        variant={tool === entry ? 'secondary' : 'ghost'}
                        aria-pressed={tool === entry}
                        label={toolLabel(t, entry)}
                        icon={<ToolIcon />}
                        disabled={saving}
                        onClick={() => setTool((current) => (current === entry ? null : entry))}
                      />
                    </PopoverTrigger>
                  </Tooltip>
                  {entry !== 'redact' && (
                    <PopoverContent
                      side="bottom"
                      align="start"
                      autoFocus={false}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape' && !event.defaultPrevented) {
                          event.preventDefault()
                          event.stopPropagation()
                          setTool(null)
                        }
                      }}
                      {...{ [FOCUS_SCOPE_EXTENSION_ATTRIBUTE]: '' }}
                      aria-label={t('feedbackRecorder.annotator.toolSettings', {
                        tool: toolLabel(t, entry),
                      })}
                      data-feedback-recorder-root="tool-settings"
                      data-testid="feedback-annotator-tool-settings"
                      className="!z-[var(--vds-z-feedback-recorder-nested-dialog)] !w-max !flex !flex-row !max-w-[var(--vds-popover-available-width)] flex-wrap items-center gap-[var(--vds-space-2)] !p-[var(--vds-space-3)]"
                    >
                      <ToolIcon className="shrink-0 size-[var(--vds-space-4)] text-[var(--vds-icon-outline-default)]" />
                      {entry === 'text' ? (
                        <div className="w-max shrink-0">
                          <Select
                            size="sm"
                            value={String(fontSize)}
                            onValueChange={(value) => setFontSize(Number(value))}
                          >
                            <SelectTrigger
                              aria-label={t('feedbackRecorder.annotator.fontSize')}
                              className="!w-max !min-w-0 !inline-flex !items-center !gap-[var(--vds-space-2)] !px-[var(--vds-space-2)]"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent
                              {...{ [FOCUS_SCOPE_EXTENSION_ATTRIBUTE]: '' }}
                              data-feedback-recorder-root="font-sizes"
                              className="!z-[var(--vds-z-feedback-recorder-nested-dialog)] !max-h-none !overflow-visible"
                            >
                              {FONT_SIZES.map((size) => (
                                <SelectItem key={size} value={String(size)}>
                                  {t('feedbackRecorder.annotator.fontSizeValue', { size })}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ) : (
                        <div
                          className="flex shrink-0 items-center gap-[var(--vds-space-1)]"
                          role="group"
                          aria-label={t('feedbackRecorder.annotator.lineWidth')}
                        >
                          {LINE_WIDTHS.map((size) => (
                            <Button
                              key={size}
                              size="sm"
                              variant={lineWidth === size ? 'secondary' : 'ghost'}
                              aria-pressed={lineWidth === size}
                              aria-label={t('feedbackRecorder.annotator.lineWidthValue', { size })}
                              className="!min-w-[var(--vds-space-8)] !px-[var(--vds-space-1)]"
                              onClick={() => setLineWidth(size)}
                            >
                              {size}
                            </Button>
                          ))}
                        </div>
                      )}
                      <div className="mx-[var(--vds-space-1)] h-[var(--vds-space-5)] border-l border-[var(--vds-divider-default)]" />
                      {COLORS.map((choice) => (
                        <Button
                          key={choice.key}
                          size="content"
                          variant="ghost"
                          aria-label={colorLabel(t, choice.key)}
                          aria-pressed={color.key === choice.key}
                          className={`!size-[var(--vds-space-6)] shrink-0 !rounded-[var(--vds-radius-2)] border border-[var(--vds-border-default)] !p-0 ${choice.appearance}`}
                          onClick={() => setColor(choice)}
                        >
                          {color.key === choice.key && (
                            <Check className="size-[var(--vds-space-4)]" />
                          )}
                        </Button>
                      ))}
                    </PopoverContent>
                  )}
                </Popover>
              )
            })}
            <div className="mx-[var(--vds-space-2)] h-[var(--vds-space-4)] border-l border-[var(--vds-divider-default)]" />
            <Tooltip
              content={t('feedbackRecorder.annotator.undo')}
              contentClassName="!z-[var(--vds-z-feedback-recorder-nested-dialog)]"
              side="top"
            >
              <span className="inline-flex">
                <IconButton
                  size="sm"
                  label={t('feedbackRecorder.annotator.undo')}
                  icon={<Undo2 />}
                  disabled={!annotations.length || saving}
                  variant="ghost"
                  onClick={() => setAnnotations((current) => undoAnnotation(current))}
                />
              </span>
            </Tooltip>
            <div className="ms-auto flex items-center gap-[var(--vds-space-1)]">
              <Tooltip
                content={t('feedbackRecorder.annotator.zoomOut')}
                contentClassName="!z-[var(--vds-z-feedback-recorder-nested-dialog)]"
              >
                <span className="inline-flex">
                  <IconButton
                    size="sm"
                    variant="ghost"
                    label={t('feedbackRecorder.annotator.zoomOut')}
                    icon={<ZoomOut />}
                    disabled={!zoomReady || saving || zoom <= MIN_ZOOM}
                    onClick={() => changeZoom(1 / ZOOM_FACTOR)}
                  />
                </span>
              </Tooltip>
              <Tooltip
                content={t('feedbackRecorder.annotator.fitImage')}
                contentClassName="!z-[var(--vds-z-feedback-recorder-nested-dialog)]"
              >
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!zoomReady || saving}
                  aria-label={t('feedbackRecorder.annotator.fitImage')}
                  aria-pressed={manualZoom === null}
                  onClick={() => {
                    setManualZoom(null)
                    setPan({ x: 0, y: 0 })
                  }}
                >
                  <span data-testid="feedback-annotator-zoom">{Math.round(zoom * 100)}%</span>
                </Button>
              </Tooltip>
              <Tooltip
                content={t('feedbackRecorder.annotator.zoomIn')}
                contentClassName="!z-[var(--vds-z-feedback-recorder-nested-dialog)]"
              >
                <span className="inline-flex">
                  <IconButton
                    size="sm"
                    variant="ghost"
                    label={t('feedbackRecorder.annotator.zoomIn')}
                    icon={<ZoomIn />}
                    disabled={!zoomReady || saving || zoom >= MAX_ZOOM}
                    onClick={() => changeZoom(ZOOM_FACTOR)}
                  />
                </span>
              </Tooltip>
              <div className="mx-[var(--vds-space-2)] h-[var(--vds-space-4)] border-l border-[var(--vds-divider-default)]" />
              <Tooltip
                content={t('feedbackRecorder.annotator.copy')}
                contentClassName="!z-[var(--vds-z-feedback-recorder-nested-dialog)]"
                side="top"
              >
                <Button
                  variant="tertiary"
                  icon={<Copy />}
                  loading={copying}
                  disabled={saving}
                  onClick={() => void copy()}
                >
                  {copied
                    ? t('feedbackRecorder.annotator.copied')
                    : t('feedbackRecorder.annotator.copy')}
                </Button>
              </Tooltip>
            </div>
          </div>
          <div
            ref={surfaceRef}
            data-testid="feedback-annotator-surface"
            className="relative min-h-0 flex-1 overflow-hidden rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] bg-[var(--vds-other-overlay-3)] p-[var(--vds-space-2)]"
          >
            <div
              ref={viewportRef}
              data-testid="feedback-annotator-viewport"
              className={`relative h-full w-full touch-none overflow-hidden ${tool ? 'cursor-crosshair' : panning ? 'cursor-grabbing' : 'cursor-grab'}`}
              onPointerDown={startPan}
              onPointerMove={movePan}
              onPointerUp={finishPan}
              onPointerCancel={finishPan}
              onLostPointerCapture={() => {
                panRef.current = null
                setPanning(false)
              }}
            >
              <canvas
                ref={canvasRef}
                style={{
                  left: `calc(50% + ${pan.x}px)`,
                  top: `calc(50% + ${pan.y}px)`,
                  width: naturalSize.width ? naturalSize.width * zoom : undefined,
                  height: naturalSize.height ? naturalSize.height * zoom : undefined,
                }}
                className="absolute -translate-x-1/2 -translate-y-1/2 block max-w-none touch-none cursor-inherit border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] shadow-[var(--vds-shadow-3-center)]"
                onPointerDownCapture={finishTextBeforeCanvasPointer}
                onPointerDown={start}
                onPointerMove={move}
                onPointerUp={finish}
                onPointerCancel={() => {
                  draftRef.current = null
                  redraw(annotations)
                }}
              />
            </div>
            {textDraft ? (
              <div
                key={textDraft.id}
                className="absolute z-[var(--vds-z-local-control)] w-[var(--vds-feedback-annotator-width)] max-w-[calc(100%-var(--vds-space-4))] shadow-[var(--vds-shadow-2-center)]"
                style={{
                  left: textDraft.alignRight ? undefined : textDraft.surfaceX,
                  right: textDraft.alignRight
                    ? surfaceRef.current!.scrollWidth - textDraft.surfaceX
                    : undefined,
                  top: textDraft.surfaceY,
                }}
              >
                <Input
                  ref={textInputRef}
                  aria-label={t('feedbackRecorder.annotator.textLabel')}
                  className="shadow-[var(--vds-shadow-2-center)]"
                  data-testid="feedback-recorder-annotation-text"
                  placeholder={t('feedbackRecorder.annotator.textLabel')}
                  maxLength={RECORDER_NOTE_MAX_LENGTH}
                  value={textDraft.value}
                  onBlur={() => commitTextDraft(textDraft)}
                  onChange={(event) =>
                    setTextDraft({ ...textDraft, value: event.currentTarget.value })
                  }
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    event.currentTarget.blur()
                  }}
                />
              </div>
            ) : null}
          </div>
          <div className="grid gap-[var(--vds-space-2)]">
            <label
              htmlFor="feedback-screenshot-note"
              className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-regular)] text-[var(--vds-text-primary)]"
            >
              {t('feedbackRecorder.annotator.noteLabel')}
            </label>
            <div className="overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-control-border)] bg-[var(--vds-bg-white-default)] focus-within:border-[var(--vds-border-brand)]">
              <Textarea
                id="feedback-screenshot-note"
                aria-label={t('feedbackRecorder.annotator.noteLabel')}
                rows={3}
                className="!min-h-0 !resize-none !overflow-y-auto !border-0 !bg-transparent !shadow-none"
                maxLength={RECORDER_NOTE_MAX_LENGTH}
                placeholder={t('feedbackRecorder.note.label')}
                value={note}
                disabled={saving}
                onChange={(event) => setNote(event.currentTarget.value)}
              />
              <div className="px-[var(--vds-space-3)] pb-[var(--vds-space-2)] text-right text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                {note.length}/{RECORDER_NOTE_MAX_LENGTH}
              </div>
            </div>
          </div>
          {saveError && (
            <p role="alert" className="text-[var(--vds-error-text-primary)]">
              {t('feedbackRecorder.screenshotFailed')}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={onCancel}>
              {t('feedbackRecorder.cancel')}
            </Button>
            <Button loading={saving} onClick={() => void save()}>
              {t('feedbackRecorder.annotator.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
