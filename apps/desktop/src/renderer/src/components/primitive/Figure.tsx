import type { JSX } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Check, Copy, Maximize2 } from 'lucide-react'
import {
  Button,
  Chart,
  CopyButton,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  IconButton,
  ScrollArea,
  Tooltip,
  type ChartDatum,
} from '../ui'
import { AnswerCode } from './Code'
import { AnswerTable } from './Answer'
import { writeClipboard } from './clipboard'
import { ImagePreview, type ImagePreviewItem } from './Gallery'

export function AnswerArtwork({
  image,
  caption,
}: {
  image: ImagePreviewItem
  caption: string
}): JSX.Element {
  const { t } = useTranslation('components')
  const [opened, setOpened] = useState(false)
  return (
    <figure className="m-0 min-w-0" data-testid="answer-artwork">
      <Button
        variant="ghost"
        size="content"
        className="block w-full overflow-hidden rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)]"
        aria-label={t('answer.enlarge')}
        onClick={() => setOpened(true)}
      >
        <img className="block h-auto w-full" src={image.src} alt={image.name} />
      </Button>
      <figcaption className="mt-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] text-[var(--vds-text-secondary)]">
        {caption}
      </figcaption>
      <ImagePreview
        images={[image]}
        open={opened}
        index={0}
        onOpenChange={setOpened}
        onIndexChange={() => undefined}
      />
    </figure>
  )
}

/** Source/data and the rendered figure are supplied together by the content owner. */
export function AnswerFigure({
  title,
  data,
  unit,
  source,
  nodes,
  failed = false,
  caption,
}: {
  title: string
  data?: ChartDatum[]
  unit?: string
  source?: string
  nodes?: readonly string[]
  failed?: boolean
  caption: string
}): JSX.Element {
  const { t } = useTranslation('components')
  const [raw, setRaw] = useState(false)
  const [zoomed, setZoomed] = useState(false)
  const flow = Boolean(source)
  const figure = () =>
    nodes ? (
      <ScrollArea orientation="horizontal" viewportProps={{ tabIndex: 0, 'aria-label': title }}>
        <div className="flex w-max min-w-full items-center justify-center gap-[var(--vds-space-3)] p-[var(--vds-space-6)]">
          {nodes.map((node, index) => (
            <div key={node} className="flex items-center gap-[var(--vds-space-3)]">
              {index > 0 && (
                <ArrowRight
                  aria-hidden
                  className="size-[var(--vds-icon-7)] text-[var(--vds-text-tertiary)]"
                />
              )}
              <div className="rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-[var(--vds-space-4)] py-[var(--vds-space-3)]">
                {node}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    ) : (
      <div className="grid gap-[var(--vds-space-2)] p-[var(--vds-space-4)]">
        <Chart data={data ?? []} className="!w-full !border-0 !bg-transparent !p-0" />
        <div className="flex flex-wrap justify-center gap-[var(--vds-space-4)] text-[length:var(--vds-font-caption)] text-[var(--vds-text-secondary)]">
          {data?.map((datum) => (
            <Tooltip
              key={datum.label}
              content={`${datum.label}: ${datum.value}${unit ?? ''} · ${caption}`}
            >
              <Button variant="ghost" size="xs">
                {datum.label} · {datum.value}
                {unit}
              </Button>
            </Tooltip>
          ))}
        </div>
      </div>
    )
  return (
    <figure data-testid="answer-figure" className="m-0 min-w-0">
      <div className="overflow-hidden rounded-[var(--vds-radius-6)] border border-[var(--vds-border-default)]">
        <header className="flex flex-wrap items-center gap-[var(--vds-space-2)] border-b border-[var(--vds-divider-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)]">
          <span className="mr-auto text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-medium)]">
            {title}
          </span>
          <Button
            variant="ghost"
            size="xs"
            disabled={failed}
            aria-pressed={!raw && !failed}
            onClick={() => setRaw(false)}
          >
            {t(flow ? 'answer.diagram' : 'answer.chart')}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={raw || failed}
            onClick={() => setRaw(true)}
          >
            {t(flow ? 'answer.source' : 'answer.data')}
          </Button>
          {source && (
            <CopyButton
              iconOnly
              icon={<Copy />}
              copiedIcon={<Check />}
              variant="ghostIcon"
              size="xs"
              tooltip
              value={source}
              writeText={writeClipboard}
            />
          )}
          <IconButton
            label={t('answer.enlarge')}
            size="xs"
            variant="ghostIcon"
            icon={<Maximize2 />}
            disabled={failed}
            onClick={() => setZoomed(true)}
          />
        </header>
        {failed || raw ? (
          source ? (
            <AnswerCode source={source} language="mermaid" />
          ) : (
            <div className="p-[var(--vds-space-3)]">
              <AnswerTable
                columns={[
                  { id: 'label', label: t('answer.category') },
                  { id: 'value', label: unit ?? t('answer.value'), numeric: true },
                ]}
                rows={(data ?? []).map((datum) => ({
                  id: datum.label,
                  cells: [datum.label, datum.value],
                }))}
                copyText={(data ?? []).map((datum) => `${datum.label}\t${datum.value}`).join('\n')}
              />
            </div>
          )
        ) : (
          figure()
        )}
      </div>
      <figcaption className="mt-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
        {failed ? t('answer.diagramError') : caption}
      </figcaption>
      <Dialog open={zoomed} onOpenChange={setZoomed}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          {figure()}
          <p className="m-0 text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
            {caption}
          </p>
        </DialogContent>
      </Dialog>
    </figure>
  )
}
