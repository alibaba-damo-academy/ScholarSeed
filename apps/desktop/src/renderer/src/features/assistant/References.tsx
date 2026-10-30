import React, { useState } from 'react'
import { AppWindow, BookOpen, File, Folder, Globe, Link, MessageSquare, Plug } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  EllipsisText,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  useToast,
} from '../../components/ui'
import type { MessageReference } from '../../model'
import { openSystemPath } from '../../api'
import {
  OVERVIEW_ROW_CLASS,
  OverviewGroup,
  OverviewSection,
} from '../../components/business/SessionArtifacts'
import { FileFormatIcon } from '../../components/primitive'
import { activeThread, useApp } from '../../store'
import { getLiterature } from '../literature/api'
import { resolveRevealTarget } from '../resources/api'
import { fetchSessionReferencePreview } from './api'
import { referenceLabel } from './text'
import { sharedTaskSources, type TaskSource } from './sources'

const SOURCE_ICONS = {
  file: File,
  'external-resource': Link,
  'web-app': AppWindow,
  tool: Plug,
  web: Globe,
}
const SOURCE_LABELS = {
  file: 'overview.sourceFiles',
  'external-resource': 'overview.sourceExternal',
  'web-app': 'overview.sourceApps',
  tool: 'overview.sourceTools',
  web: 'overview.sourceWeb',
} as const

export function OverviewReferences({
  onOpened,
  boundaryRef,
}: {
  onOpened: () => void
  boundaryRef?: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const { state, act } = useApp()
  const { t: text } = useTranslation('components')
  const { t: assistantText } = useTranslation('assistant')
  const { toast } = useToast()
  const [detail, setDetail] = useState<TaskSource | null>(null)
  const [opening, setOpening] = useState(false)
  const thread = activeThread(state)
  const project = state.projects.find((project) => project.path === thread.projectPath)
  const sources = sharedTaskSources(thread.conversation, project?.id ?? '')
  const open = async (reference: MessageReference): Promise<void> => {
    if (opening) return
    setOpening(true)
    try {
      const sourceId = reference.sourceId ?? reference.id
      if ((reference.kind === 'dir' || reference.type === 'directory') && project) {
        const resolved = await resolveRevealTarget(
          reference.sourceId ?? reference.path ?? reference.id,
          project.id
        )
        const opened =
          resolved.ok && resolved.absolute ? await openSystemPath(resolved.absolute) : null
        if (!opened?.ok) {
          toast({ title: text('overview.sourceUnavailable'), tone: 'error' })
          return
        }
      } else if (reference.type === 'file' && thread.sessionId) {
        act.openFilePreview({
          path: reference.path ?? reference.id,
          title: reference.title,
          sessionId: thread.sessionId,
        })
      } else if (
        reference.kind === 'session' &&
        thread.sessionId &&
        reference.snapshotId &&
        reference.sourceId
      ) {
        await fetchSessionReferencePreview(
          thread.sessionId,
          reference.snapshotId,
          reference.sourceId
        )
        act.openSession(sourceId)
      } else if (reference.kind === 'literature' && project) {
        try {
          const detail = await getLiterature(sourceId, project.id)
          const attachmentId = reference.anchor?.documentId ?? detail.primary_attachment?.id
          const opened = attachmentId
            ? await act.openLiteratureAttachment(sourceId, attachmentId, undefined, {
                projectId: project.id,
              })
            : await act.openLiteratureItem(sourceId, project.id)
          if (opened === false) return
        } catch {
          toast({ title: text('overview.sourceUnavailable'), tone: 'error' })
          return
        }
      } else if (
        project &&
        sourceId &&
        reference.type !== 'directory' &&
        reference.kind !== 'session'
      ) {
        act.openResourceFile(sourceId, project.id)
      } else {
        toast({ title: text('overview.sourceUnavailable'), tone: 'error' })
        return
      }
      onOpened()
    } catch {
      toast({ title: text('overview.sourceUnavailable'), tone: 'error' })
    } finally {
      setOpening(false)
    }
  }
  return (
    <OverviewSection title={text('overview.references')} collapsible={sources.length > 0}>
      <div className="grid gap-[var(--vds-space-1)]">
        {sources.length === 0 && (
          <p className="m-0 px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
            {text('overview.empty')}
          </p>
        )}
        {(Object.keys(SOURCE_ICONS) as Array<keyof typeof SOURCE_ICONS>).map((kind) => {
          const items = sources.filter((source) => source.kind === kind)
          const CategoryIcon = SOURCE_ICONS[kind]
          return (
            <OverviewGroup
              boundaryRef={boundaryRef}
              key={kind}
              title={text(SOURCE_LABELS[kind])}
              previewLimit={0}
              testId={`overview-sources-${kind}`}
              icon={<CategoryIcon aria-hidden />}
              items={items.map((source) => {
                const SourceIcon =
                  source.reference?.kind === 'literature'
                    ? BookOpen
                    : source.reference?.kind === 'session'
                      ? MessageSquare
                      : source.reference?.kind === 'dir' || source.reference?.type === 'directory'
                        ? Folder
                        : SOURCE_ICONS[source.kind]
                return (
                  <Button
                    key={source.id}
                    unstyled
                    className={OVERVIEW_ROW_CLASS}
                    data-testid="overview-source"
                    data-source-kind={source.kind}
                    disabled={opening}
                    onClick={() => {
                      if (source.reference) void open(source.reference)
                      else if (source.url) void window.scholarseed.openExternal(source.url)
                      else setDetail(source)
                    }}
                  >
                    {source.kind === 'file' && SourceIcon === File ? (
                      <FileFormatIcon name={source.reference?.path ?? source.title} />
                    ) : (
                      <SourceIcon aria-hidden />
                    )}
                    <EllipsisText
                      wrapperClassName="min-w-0 flex-1"
                      tooltip={source.reference?.sourceId ?? source.url ?? source.title}
                      tooltipPortalled
                    >
                      {source.reference
                        ? referenceLabel(source.reference, assistantText)
                        : source.title}
                    </EllipsisText>
                  </Button>
                )
              })}
            />
          )
        })}
        <Dialog open={Boolean(detail)} onOpenChange={(value) => !value && setDetail(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{detail?.title}</DialogTitle>
            </DialogHeader>
            <pre className="max-h-[var(--vds-dialog-list-max-height)] overflow-auto whitespace-pre-wrap break-words text-[length:var(--vds-font-body-lv1)]">
              {detail?.tools
                ?.map((tool) =>
                  JSON.stringify(
                    { name: tool.name, input: tool.input, result: tool.result },
                    null,
                    2
                  )
                )
                .join('\n\n')}
            </pre>
          </DialogContent>
        </Dialog>
      </div>
    </OverviewSection>
  )
}
