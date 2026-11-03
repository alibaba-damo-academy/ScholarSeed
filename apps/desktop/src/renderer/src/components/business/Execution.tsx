import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import aiThinking from '../../assets/ai-thinking.gif'
import { Icon } from '../../icons'
import type { ConvItem, TurnOutcome } from '../../model'
import { Badge, Button, Spinner, Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui'
import { cx } from '../ui/utils'
import { IconFont } from '../primitive/Iconfont'

type ExecutionStatusKind = Extract<ConvItem, { kind: 'tool' }>['status']

const BATCH_TRIGGER_CLASS =
  'group/activity m-0 !flex !min-h-[var(--vds-control-height-sm)] w-fit max-w-full cursor-pointer items-center gap-[var(--vds-space-2)] !border-0 !bg-transparent !p-0 text-left text-[length:var(--vds-execution-batch-font)] !font-[var(--vds-fw-regular)] leading-[var(--vds-execution-batch-leading)] !text-[var(--vds-text-tertiary)] shadow-none transition-colors duration-[var(--vds-execution-batch-transition)] hover:!bg-transparent hover:!text-[var(--vds-text-primary)]'
export interface ExecutionBatchProps {
  label: string
  state?: string | null
  title?: string
  accessibleLabel?: string
  turnId?: string
  expanded: boolean
  onExpandedChange: (open: boolean) => void
  failed?: boolean
  running?: boolean
  locked?: boolean
  animated?: boolean
  children: React.ReactNode
}

export function ExecutionBatch({
  label,
  state,
  title,
  accessibleLabel,
  turnId,
  expanded,
  onExpandedChange,
  failed,
  running,
  locked,
  animated = true,
  children,
}: ExecutionBatchProps): React.JSX.Element {
  return (
    <Collapsible
      animated={animated}
      open={expanded}
      onOpenChange={onExpandedChange}
      disabled={locked}
      className={cx(
        'group my-[var(--vds-space-2)] min-w-0 [--vds-collapsible-content-gap:0px]',
        expanded && 'is-open'
      )}
      data-testid="turn-activity"
      data-turn-id={turnId}
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          size="content"
          variant="ghost"
          className={cx(
            BATCH_TRIGGER_CLASS,
            failed && '!text-[var(--vds-execution-tone-error)]',
            running && '!text-[var(--vds-execution-tone-running)]',
            locked && 'disabled:!cursor-default disabled:!opacity-[var(--vds-opacity-full)]'
          )}
          data-testid="turn-activity-trigger"
          aria-label={accessibleLabel ?? label}
          title={title ?? label}
        >
          <Badge
            size="sm"
            tone="neutral"
            className="!inline-flex !size-[var(--vds-execution-disclosure-size)] shrink-0 !justify-center !rounded-[var(--vds-radius-3)] !border !border-solid !border-[var(--vds-border-default)] !bg-[var(--vds-bg-white-default)] !p-0"
          >
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} sw={1.8} />
          </Badge>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
          {state ? (
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              · {state}
            </span>
          ) : null}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-[var(--vds-space-3)] !rounded-none !border-0 !bg-transparent !p-0">
        <div className="mb-[var(--vds-space-3)] min-w-0 border-l border-[var(--vds-border-default)] pl-[var(--vds-space-2)]">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function ExecutionProcess({
  outcome,
  turnId,
  reveal = false,
  children,
}: {
  outcome?: TurnOutcome
  turnId?: string
  reveal?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const [expanded, setExpanded] = useState(false)
  const running = outcome === 'running'
  useEffect(() => {
    if (reveal) setExpanded(true)
  }, [reveal])
  const labels = {
    running: 'process.running',
    completed: 'process.completed',
    failed: 'process.incomplete',
    interrupted: 'process.interrupted',
    unknown: 'process.unknown',
  } as const
  return (
    <ExecutionBatch
      label={t(labels[outcome ?? 'unknown'])}
      turnId={turnId}
      expanded={running || reveal || expanded}
      onExpandedChange={setExpanded}
      locked={running}
      animated={false}
      running={running}
      failed={outcome === 'failed'}
    >
      {children}
    </ExecutionBatch>
  )
}

export const TOOL_RUN_STEP_STATUS_CLASS =
  'inline-flex min-w-0 flex-1 items-center gap-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]'
export const TOOL_RUN_STATUS_TONE_CLASS: Record<string, string> = {
  'is-running': 'text-[var(--vds-execution-tone-running)]',
  'is-done': 'text-[var(--vds-execution-tone-done)]',
  'is-error': 'text-[var(--vds-execution-tone-error)]',
  'is-cancelled': 'text-[var(--vds-text-tertiary)]',
}
export const TOOL_RUN_CONTENT_INNER_CLASS = 'min-h-0 overflow-hidden'
export const TOOL_RUN_STEP_CLASS = 'group/step min-w-0 !gap-0 !border-0 !bg-transparent'
export const TOOL_RUN_STEP_TRIGGER_CLASS =
  'group/trigger !flex min-h-[var(--vds-control-height-md)] w-full cursor-pointer items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-2)] !border-0 !bg-transparent px-[var(--vds-space-2)] py-[var(--vds-space-1)] text-left text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)] transition-colors duration-[var(--vds-duration-fast)] hover:!bg-[var(--vds-surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[var(--vds-execution-focus-offset)] focus-visible:outline-[var(--vds-brand-text-primary)]'
export const TOOL_RUN_STEP_NAME_CLASS =
  'shrink-0 font-[var(--vds-fw-regular)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]'
export const TOOL_RUN_STEP_CARET_CLASS =
  'inline-flex items-center text-[var(--vds-text-tertiary)] transition-[transform,color] duration-[var(--vds-execution-caret-transition)] ease-[var(--vds-execution-ease)] motion-reduce:transition-none group-aria-expanded/trigger:rotate-90 group-aria-expanded/trigger:text-[var(--vds-text-secondary)]'
export const TOOL_RUN_STEP_CONTENT_CLASS =
  'grid min-h-0 grid-rows-[0fr] opacity-0 pointer-events-none transition-[grid-template-rows,opacity] duration-[var(--vds-execution-transition)] ease-[var(--vds-execution-ease)] motion-reduce:transition-none aria-[hidden=false]:grid-rows-[1fr] aria-[hidden=false]:opacity-[var(--vds-opacity-full)] aria-[hidden=false]:pointer-events-auto'
export const TOOL_RUN_IO_STACK_CLASS =
  'ml-[calc(var(--vds-space-4)*2)] mr-[var(--vds-space-2)] mb-[var(--vds-space-3)] flex flex-col gap-[var(--vds-space-3)] pt-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)]'
export const TOOL_RUN_IO_LABEL_CLASS =
  'mb-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-medium)] text-[var(--vds-text-secondary)]'
export const TOOL_RUN_IO_CLASS =
  'm-[var(--vds-space-0)] max-h-[var(--vds-execution-detail-height)] overflow-auto rounded-[var(--vds-radius-3)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] font-[family-name:var(--vds-font-code)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)] whitespace-pre-wrap break-words [overflow-wrap:anywhere]'

const ERROR_STATUS_ICON = 'a-line-status-error'
const STATUS_ICONS: Record<ExecutionStatusKind, string> = {
  done: 'a-line-status-success',
  error: ERROR_STATUS_ICON,
  cancelled: 'a-line-status-notfull',
  running: 'fill-status-loading',
}

export interface ToolExecutionData {
  name: string
  label: string
  status: ExecutionStatusKind
  statusLabel: string
  failure?: { summary?: string; help: string }
  summary?: { text: string; badge?: boolean }
  preview?: string
  duration?: string
  input?: string
  output?: string
  exitCode?: number
}

export function ExecutionStatus({ status }: { status: ExecutionStatusKind }): React.JSX.Element {
  if (status === 'running')
    return (
      <Spinner
        imageSrc={aiThinking}
        size="sm"
        className="!size-[var(--vds-icon-7)] shrink-0"
        aria-hidden="true"
      />
    )
  return (
    <IconFont
      type={STATUS_ICONS[status]}
      className={cx(
        'inline-flex size-[var(--vds-icon-7)] shrink-0 items-center justify-center !text-[length:var(--vds-icon-7)]',
        TOOL_RUN_STATUS_TONE_CLASS[`is-${status}`]
      )}
    />
  )
}

export function ExecutionIO({
  label,
  text,
  err,
}: {
  label: string
  text: string
  err?: boolean
}): React.JSX.Element {
  return (
    <div>
      <div className={TOOL_RUN_IO_LABEL_CLASS}>{label}</div>
      <pre className={cx(TOOL_RUN_IO_CLASS, err && 'shadow-[var(--vds-execution-error-shadow)]')}>
        {text}
      </pre>
    </div>
  )
}

export function ToolExecution({
  data,
  groupOpen = true,
  actions,
}: {
  data: ToolExecutionData
  groupOpen?: boolean
  actions?: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: conversation } = useTranslation('conversation')
  const [open, setOpen] = useState(false)
  const [technicalOpen, setTechnicalOpen] = useState(false)
  const hasBody = Boolean(
    data.failure || data.input !== undefined || data.output !== undefined || actions
  )
  return (
    <div className={cx(TOOL_RUN_STEP_CLASS, open && 'is-open')} data-testid="tool-run-step">
      <Button
        unstyled
        type="button"
        className={TOOL_RUN_STEP_TRIGGER_CLASS}
        aria-expanded={hasBody ? open : undefined}
        tabIndex={groupOpen ? 0 : -1}
        onClick={() => hasBody && setOpen((value) => !value)}
      >
        <ExecutionStatus status={data.status} />
        <span className={TOOL_RUN_STEP_NAME_CLASS} title={data.name}>
          {data.label}
        </span>
        <span
          className={cx(
            TOOL_RUN_STEP_STATUS_CLASS,
            TOOL_RUN_STATUS_TONE_CLASS[`is-${data.status}`]
          )}
        >
          <span className="shrink-0">{data.statusLabel}</span>
          {data.failure?.summary ? (
            <span className="min-w-0 truncate" title={data.failure.summary}>
              · {data.failure.summary}
            </span>
          ) : null}
          {data.summary ? (
            data.summary.badge ? (
              <Badge
                size="sm"
                tone="neutral"
                className="min-w-0 truncate"
                title={data.summary.text}
              >
                {data.summary.text}
              </Badge>
            ) : (
              <span
                className="min-w-0 truncate text-[var(--vds-text-tertiary)]"
                title={data.summary.text}
              >
                · {data.summary.text}
              </span>
            )
          ) : null}
          {data.preview ? (
            <span className="min-w-0 truncate text-[var(--vds-text-tertiary)]" title={data.preview}>
              · {data.preview}
            </span>
          ) : null}
          {data.duration ? (
            <span
              className="flex-none border-l border-[var(--vds-divider-default)] pl-[var(--vds-execution-duration-padding)]"
              data-testid="tool-run-step-duration"
            >
              {data.duration}
            </span>
          ) : null}
        </span>
        {hasBody ? (
          <span className={TOOL_RUN_STEP_CARET_CLASS}>
            <Icon name="chevron-right" size={12} sw={1.8} />
          </span>
        ) : null}
      </Button>
      {hasBody ? (
        <div
          className={TOOL_RUN_STEP_CONTENT_CLASS}
          aria-hidden={!open}
          ref={(element) => {
            if (element) element.inert = !open || !groupOpen
          }}
        >
          <div className={TOOL_RUN_CONTENT_INNER_CLASS}>
            <div className={TOOL_RUN_IO_STACK_CLASS}>
              {data.failure ? (
                <>
                  <div>{data.failure.help}</div>
                  <Button
                    unstyled
                    type="button"
                    onClick={() => setTechnicalOpen((value) => !value)}
                    aria-expanded={technicalOpen}
                  >
                    {conversation('toolOutcome.technicalDetails')}
                  </Button>
                </>
              ) : null}
              {!data.failure || technicalOpen ? (
                <>
                  <div className={TOOL_RUN_IO_LABEL_CLASS}>{data.name}</div>
                  {typeof data.exitCode === 'number' ? (
                    <div>{conversation('toolOutcome.exitCode', { code: data.exitCode })}</div>
                  ) : null}
                  {data.input !== undefined ? (
                    <ExecutionIO label={t('stream.input')} text={data.input} />
                  ) : null}
                  {data.output !== undefined ? (
                    <ExecutionIO label={t('stream.output')} text={data.output} />
                  ) : null}
                </>
              ) : null}
              {actions}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
