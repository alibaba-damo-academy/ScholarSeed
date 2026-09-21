import React from 'react'
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
  Input
} from '../../components/ui'
import { commitActiveTextDraft, type TextDraft } from './draft'
import { RECORDER_NOTE_MAX_LENGTH, type Annotation, type AnnotationPoint } from './model'

type Tool = Annotation['type']

const TOOLS: readonly Tool[] = ['rect', 'arrow', 'pen', 'text']
const ANNOTATION_COLOR_TOKEN = '--vds-error-text-primary'
const ANNOTATION_LINE_WIDTH = 4
const ANNOTATION_FONT_SIZE = 24
const ARROW_HEAD_LENGTH = 18

export interface AnnotatorResult {
  file: File
  previewUrl: string
  annotations: Annotation[]
  note: string
}

interface AnnotatorProps {
  source: File
  onCancel: () => void
  onSave: (result: AnnotatorResult) => void
}

function textAnnotation(draft: TextDraft): Extract<Annotation, { type: 'text' }> | undefined {
  const value = draft.value.trim()
  if (!value) return undefined
  return {
    type: 'text',
    color: draft.color,
    ...draft.point,
    text: value
  }
}

function annotationColor(): string {
  const root = getComputedStyle(document.documentElement)
  return root.getPropertyValue(ANNOTATION_COLOR_TOKEN).trim() || getComputedStyle(document.body).color
}

function point(event: React.PointerEvent<HTMLCanvasElement>, canvas: HTMLCanvasElement): AnnotationPoint {
  const bounds = canvas.getBoundingClientRect()
  return {
    x: (event.clientX - bounds.left) * (canvas.width / bounds.width),
    y: (event.clientY - bounds.top) * (canvas.height / bounds.height)
  }
}

export function undoAnnotation(annotations: readonly Annotation[]): Annotation[] {
  return annotations.slice(0, -1)
}

export function drawAnnotation(context: CanvasRenderingContext2D, annotation: Annotation): void {
  context.save()
  context.strokeStyle = annotation.color
  context.fillStyle = annotation.color
  context.lineWidth = ANNOTATION_LINE_WIDTH
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
    context.font = `600 ${ANNOTATION_FONT_SIZE}px sans-serif`
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
  return t('feedbackRecorder.annotator.tools.text')
}

export function Annotator({ source, onCancel, onSave }: AnnotatorProps): React.JSX.Element {
  const { t } = useTranslation('components')
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const surfaceRef = React.useRef<HTMLDivElement>(null)
  const imageRef = React.useRef<HTMLImageElement | null>(null)
  const draftRef = React.useRef<Annotation | null>(null)
  const textDraftRef = React.useRef<TextDraft | null>(null)
  const textDraftSequenceRef = React.useRef(0)
  const textInputRef = React.useRef<HTMLInputElement>(null)
  const [tool, setTool] = React.useState<Tool>('rect')
  const [textDraft, setTextDraftState] = React.useState<TextDraft | null>(null)
  const [note, setNote] = React.useState('')
  const [annotations, setAnnotations] = React.useState<Annotation[]>([])
  const [saving, setSaving] = React.useState(false)
  const [copying, setCopying] = React.useState(false)
  const [copied, setCopied] = React.useState(false)

  const redraw = React.useCallback((entries: readonly Annotation[], draft?: Annotation | null): void => {
    const canvas = canvasRef.current
    const image = imageRef.current
    if (!canvas || !image) return
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    entries.forEach((entry) => drawAnnotation(context, entry))
    if (draft) drawAnnotation(context, draft)
  }, [])

  React.useEffect(() => {
    const url = URL.createObjectURL(source)
    const image = new Image()
    image.onload = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      imageRef.current = image
      redraw([])
    }
    image.src = url
    return () => URL.revokeObjectURL(url)
  }, [source, redraw])

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

  const commitTextDraft = React.useCallback((draft: TextDraft): void => {
    if (textDraftRef.current?.id !== draft.id) return
    setTextDraft(null)
    const annotation = textAnnotation(draft)
    if (annotation) setAnnotations((current) => [...current, annotation])
  }, [setTextDraft])

  const start = (event: React.PointerEvent<HTMLCanvasElement>): void => {
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
        color: annotationColor(),
        point: origin,
        surfaceX,
        surfaceY,
        value: ''
      })
      return
    }
    canvas.setPointerCapture(event.pointerId)
    draftRef.current = tool === 'pen'
      ? { type: 'pen', color: annotationColor(), points: [origin] }
      : tool === 'rect'
        ? { type: 'rect', color: annotationColor(), ...origin, width: 0, height: 0 }
        : { type: 'arrow', color: annotationColor(), points: [origin, origin] }
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
    else if (draft.type === 'rect') draftRef.current = { ...draft, width: current.x - draft.x, height: current.y - draft.y }
    else if (draft.type === 'arrow') draftRef.current = { ...draft, points: [draft.points[0], current] }
    redraw(annotations, draftRef.current)
  }

  const finish = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const draft = draftRef.current
    draftRef.current = null
    if (draft) setAnnotations((current) => [...current, draft])
  }

  const save = async (): Promise<void> => {
    const canvas = canvasRef.current
    if (!canvas) return
    const pendingText = textDraftRef.current
    const pendingAnnotation = pendingText ? textAnnotation(pendingText) : undefined
    const finalAnnotations = pendingAnnotation ? [...annotations, pendingAnnotation] : annotations
    setTextDraft(null)
    setSaving(true)
    try {
      redraw(finalAnnotations)
      const blob = await canvasBlob(canvas)
      const file = new File([blob], `feedback-${Date.now()}.png`, { type: 'image/png' })
      onSave({ file, previewUrl: URL.createObjectURL(file), annotations: finalAnnotations, note: note.trim() })
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
    <Dialog open onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogPortal>
        <DialogContent
          hideCloseButton
          className="!top-0 !left-0 !z-[var(--vds-z-feedback-recorder-dialog)] !flex !h-screen !w-screen !max-w-none !translate-x-0 !translate-y-0 !transform-none flex-col gap-[var(--vds-space-3)] overflow-hidden !rounded-none !border-0 !px-[calc(var(--vds-space-10)+var(--vds-space-3))] !pb-[var(--vds-space-5)] !pt-[var(--vds-space-10)]"
          overlayClassName="!z-[var(--vds-z-feedback-recorder-overlay)]"
          data-feedback-recorder-root="annotator"
        >
        <DialogHeader>
          <DialogTitle>{t('feedbackRecorder.annotator.title')}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-[var(--vds-space-2)]">
          {TOOLS.map((entry) => (
            <Button
              key={entry}
              variant={tool === entry ? 'primary' : 'secondary'}
              onClick={() => setTool(entry)}
            >
              {toolLabel(t, entry)}
            </Button>
          ))}
          <Input
            aria-label={t('feedbackRecorder.annotator.noteLabel')}
            className="min-w-52 flex-1"
            maxLength={RECORDER_NOTE_MAX_LENGTH}
            placeholder={t('feedbackRecorder.annotator.noteLabel')}
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
          <Button
            disabled={!annotations.length}
            variant="secondary"
            onClick={() => setAnnotations((current) => undoAnnotation(current))}
          >
            {t('feedbackRecorder.annotator.undo')}
          </Button>
        </div>
        <div
          ref={surfaceRef}
          className="relative min-h-0 flex-1 overflow-auto rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-gray-active)] p-[var(--vds-space-2)] [background-image:linear-gradient(45deg,var(--vds-other-overlay-2)_25%,transparent_25%),linear-gradient(-45deg,var(--vds-other-overlay-2)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--vds-other-overlay-2)_75%),linear-gradient(-45deg,transparent_75%,var(--vds-other-overlay-2)_75%)] [background-position:0_0,0_var(--vds-space-2),var(--vds-space-2)_calc(-1*var(--vds-space-2)),calc(-1*var(--vds-space-2))_0] [background-size:var(--vds-space-4)_var(--vds-space-4)]"
        >
          <canvas
            ref={canvasRef}
            className="mx-auto block max-h-full max-w-full touch-none cursor-crosshair border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] shadow-[var(--vds-shadow-lg)]"
            onPointerDownCapture={finishTextBeforeCanvasPointer}
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={finish}
            onPointerCancel={() => { draftRef.current = null; redraw(annotations) }}
          />
          {textDraft ? (
            <div
              key={textDraft.id}
              className="absolute z-[var(--vds-z-local-control)] w-64 max-w-[calc(100%-var(--vds-space-4))] shadow-[var(--vds-shadow-md)]"
              style={{
                left: textDraft.alignRight ? undefined : textDraft.surfaceX,
                right: textDraft.alignRight ? surfaceRef.current!.scrollWidth - textDraft.surfaceX : undefined,
                top: textDraft.surfaceY
              }}
            >
              <Input
                ref={textInputRef}
                aria-label={t('feedbackRecorder.annotator.textLabel')}
                className="shadow-[var(--vds-shadow-md)]"
                data-testid="feedback-recorder-annotation-text"
                placeholder={t('feedbackRecorder.annotator.textLabel')}
                value={textDraft.value}
                onBlur={() => commitTextDraft(textDraft)}
                onChange={(event) => setTextDraft({ ...textDraft, value: event.currentTarget.value })}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  event.preventDefault()
                  event.currentTarget.blur()
                }}
              />
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onCancel}>{t('feedbackRecorder.cancel')}</Button>
          <Button variant="secondary" loading={copying} onClick={() => void copy()}>
            {copied ? t('feedbackRecorder.annotator.copied') : t('feedbackRecorder.annotator.copy')}
          </Button>
          <Button loading={saving} onClick={() => void save()}>{t('feedbackRecorder.annotator.save')}</Button>
        </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
