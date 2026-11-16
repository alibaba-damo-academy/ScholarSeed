import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { previewPdfComment } from './api'
import { AnnotationDetails, AnnotationSummary } from './Notes'

export function PdfCommentReference({
  id,
  sourceId,
  sourceRevision,
  label,
  onClear,
  presentation,
  testId,
}: {
  id: string
  sourceId?: string
  sourceRevision?: string | null
  label: string
  onClear?: () => void
  presentation: 'draft' | 'sent'
  testId?: string
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const title = label.trim()
  const page = /^PDF\s*·\s*([1-9]\d*)$/u.exec(title)?.[1]
  return (
    <AnnotationSummary
      count={1}
      description={page ? t('pdfComment.page', { page }) : title || t('pdfComment.title')}
      details={
        <PdfCommentDetails
          key={JSON.stringify([sourceId, sourceRevision])}
          id={id}
          sourceId={sourceId}
          sourceRevision={sourceRevision}
        />
      }
      onClear={onClear}
      presentation={presentation}
      testId={testId}
    />
  )
}

function PdfCommentDetails({
  id,
  sourceId,
  sourceRevision,
}: {
  id: string
  sourceId?: string
  sourceRevision?: string | null
}): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const [preview, setPreview] = useState<{ comment: string } | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = true
    if (sourceId && sourceRevision) {
      void previewPdfComment(sourceId, sourceRevision).then(
        (value) => {
          if (current) setPreview(value)
        },
        () => {
          if (current) setFailed(true)
        }
      )
    }
    return () => {
      current = false
    }
  }, [sourceId, sourceRevision])
  return (
    <div data-testid="pdf-comment-context-preview">
      {preview ? (
        <AnnotationDetails annotations={[{ id, previewText: '', comment: preview.comment }]} />
      ) : (
        <div className="p-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
          {failed || !sourceId || !sourceRevision ? (
            <p role="alert">{t('pdfComment.unavailable')}</p>
          ) : (
            <p role="status">{t('panel.loadingContext')}</p>
          )}
        </div>
      )}
    </div>
  )
}
