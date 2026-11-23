import React, { useEffect, useState } from 'react'
import { CircleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import aiThinking from '../../assets/ai-thinking.gif'
import { Icon } from '../../icons'
import type { ConvItem, TurnOutcome, TurnTiming } from '../../model'
import {
  Badge,
  Button,
  Card,
  Spinner,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ScrollArea,
  Tooltip,
} from '../ui'
import { cx } from '../ui/utils'
import { IconFont } from '../primitive/Iconfont'
import { processDurationLabel } from './duration'

type ExecutionStatusKind = Extract<ConvItem, { kind: 'tool' }>['status']

const ACTIVITY_LINE_CLASS =
  '!flex !min-h-[var(--vds-control-height-sm)] w-fit max-w-full items-center gap-[var(--vds-space-2)] text-left text-[length:var(--vds-font-body-lv2)] !font-[var(--vds-fw-regular)] leading-[var(--vds-lh-body-lv2)] !text-[var(--vds-text-tertiary)]'
const BATCH_TRIGGER_CLASS =
  'group/activity m-0 cursor-pointer !border-0 !bg-transparent !p-0 shadow-none transition-colors duration-[var(--vds-execution-batch-transition)] hover:!bg-transparent hover:!text-[var(--vds-text-tertiary)]'

function ExecutionActivityIcon({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Badge
      size="sm"
      tone="neutral"
      className="!inline-flex !size-[var(--vds-execution-disclosure-size)] shrink-0 !justify-center !rounded-[var(--vds-radius-3)] !border !border-solid !border-[var(--vds-border-default)] !bg-[var(--vds-bg-white-default)] !p-0"
    >
      {children}
    </Badge>
  )
}

function ExecutionActivityWarning({
  label,
  testId,
}: {
  label: string
  testId?: string
}): React.JSX.Element {
  return (
    <Tooltip content={label} portalled>
      <span
        role="img"
        aria-label={label}
        data-testid={testId}
        className="inline-flex shrink-0 items-center"
      >
        <CircleAlert
          aria-hidden="true"
          className="size-[var(--vds-icon-6)] text-[var(--vds-warning-text-primary)]"
        />
      </span>
    </Tooltip>
  )
}

export function ExecutionActivityStatus({
  label,
  icon,
  warning,
  role = 'status',
  busy,
  testId,
}: {
  label: string
  icon: React.ReactNode
  warning?: string
  role?: 'status' | 'alert'
  busy?: boolean
  testId?: string
}): React.JSX.Element {
  return (
    <div
      role={role}
      aria-busy={busy}
      data-testid={testId}
      className={cx(ACTIVITY_LINE_CLASS, 'my-[var(--vds-conversation-block-gap)]')}
    >
      <ExecutionActivityIcon>{icon}</ExecutionActivityIcon>
      <span className="min-w-0">{label}</span>
      {warning && <ExecutionActivityWarning label={warning} />}
    </div>
  )
}

export interface ExecutionBatchProps {
  label: string
  icon?: React.ReactNode
  warning?: string
  state?: string | null
  title?: string
  accessibleLabel?: string
  turnId?: string
  expanded: boolean
  onExpandedChange: (open: boolean) => void
  failed?: boolean
  failureCount?: number
  running?: boolean
  locked?: boolean
  animated?: boolean
  children: React.ReactNode
}

export function ExecutionBatch({
  label,
  icon,
  warning: warningLabel,
  state,
  title,
  accessibleLabel,
  turnId,
  expanded,
  onExpandedChange,
  failed,
  failureCount = 0,
  running,
  locked,
  animated = true,
  children,
}: ExecutionBatchProps): React.JSX.Element {
  const { t } = useTranslation('assistant')
  const warning = warningLabel ?? t('toolProcess.failures', { count: failureCount })
  return (
    <Collapsible
      animated={animated}
      open={expanded}
      onOpenChange={onExpandedChange}
      disabled={locked}
      className={cx(
        'group my-[var(--vds-conversation-block-gap)] min-w-0 [--vds-collapsible-content-gap:0px]',
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
            ACTIVITY_LINE_CLASS,
            BATCH_TRIGGER_CLASS,
            locked && 'disabled:!cursor-default disabled:!opacity-[var(--vds-opacity-full)]'
          )}
          data-testid="turn-activity-trigger"
          aria-label={accessibleLabel ?? label}
          title={title ?? label}
        >
          <ExecutionActivityIcon>
            {icon ?? (
              <Icon
                name="chevron-down"
                size={13}
                sw={1.8}
                className={expanded ? undefined : '-rotate-90'}
              />
            )}
          </ExecutionActivityIcon>
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
          {state ? (
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{state}</span>
          ) : null}
          {(warningLabel || failureCount > 0) && (
            <ExecutionActivityWarning label={warning} testId="tool-batch-warning" />
          )}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="ml-[var(--vds-space-3)] !rounded-none !border-0 !bg-transparent !p-0">
        <div className="min-w-0 border-l border-[var(--vds-border-default)] pl-[var(--vds-space-2)]">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function ExecutionProcess({
  outcome,
  statusOwner = true,
  turnId,
  reveal = false,
  timing,
  children,
}: {
  outcome?: TurnOutcome
  statusOwner?: boolean
  turnId?: string
  reveal?: boolean
  timing?: TurnTiming
  children: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation('conversation')
  const [expanded, setExpanded] = useState(false)
  const running = outcome === 'running'
  const duration = running ? null : processDurationLabel(timing, t)
  useEffect(() => {
    if (reveal) setExpanded(true)
  }, [reveal])
  const labels = {
    running: 'process.running',
    completed: 'process.completed',
    failed: 'process.failed',
    interrupted: 'process.interrupted',
    unknown: 'process.unknown',
  } as const
  if (!statusOwner) return <>{children}</>
  return (
    <Collapsible
      open={running || reveal || expanded}
      onOpenChange={setExpanded}
      disabled={running}
      className="mb-[var(--vds-conversation-block-gap)] !gap-0"
      data-testid="turn-process"
      data-turn-id={turnId}
    >
      {!running && (
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="content"
            className="w-fit !justify-start !gap-[var(--vds-space-1)] !px-0 disabled:!opacity-[var(--vds-opacity-full)] !font-[var(--vds-fw-regular)] !text-[var(--vds-text-tertiary)] disabled:!text-[var(--vds-text-tertiary)]"
            data-testid="turn-process-trigger"
          >
            <span className="text-left">{t(labels[outcome ?? 'unknown'])}</span>
            {duration && (
              <>
                {' '}
                <span data-testid="turn-process-duration">{duration}</span>
              </>
            )}
            <Icon name={reveal || expanded ? 'chevron-down' : 'chevron-right'} size={13} />
          </Button>
        </CollapsibleTrigger>
      )}
      <CollapsibleContent
        className={cx(
          '!rounded-none !border-0 !bg-transparent !p-0 [&>[data-testid=turn-activity]:last-child]:mb-0',
          running && '[&>[data-testid=turn-activity]:first-child]:!mt-0'
        )}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
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
export const TOOL_RUN_STEP_CLASS =
  'group/step min-w-0 !gap-0 !border-0 !bg-transparent font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)] [&_*:not(:where(.vds-button))]:!font-[var(--vds-fw-regular)] [&_*:not(:where(.vds-button))]:!text-[var(--vds-text-tertiary)]'
export const TOOL_RUN_STEP_TRIGGER_CLASS =
  'group/trigger !font-[var(--vds-fw-regular)] !text-[var(--vds-text-tertiary)] !flex min-h-[var(--vds-control-height-sm)] w-full cursor-pointer items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] !border-0 !bg-transparent px-[var(--vds-space-2)] py-[var(--vds-space-half)] text-left text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)] transition-colors duration-[var(--vds-duration-fast)] hover:!bg-[var(--vds-surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[var(--vds-execution-focus-offset)] focus-visible:outline-[var(--vds-brand-text-primary)]'
export const TOOL_RUN_STEP_NAME_CLASS =
  'shrink-0 font-[var(--vds-fw-regular)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]'
export const TOOL_ACTIVITY_LABEL_CLASS =
  'flex min-h-[var(--vds-control-height-sm)] min-w-0 items-center gap-[var(--vds-space-2)] !px-[var(--vds-space-2)] !py-[var(--vds-space-1)] font-[var(--vds-fw-regular)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]'
export const TOOL_ACTIVITY_DETAIL_INSET_CLASS =
  '!ml-[calc(var(--vds-space-2)*2+var(--vds-icon-7))] !mr-[var(--vds-space-2)] !mb-[var(--vds-space-3)]'
export const TOOL_RUN_STEP_CARET_CLASS =
  'inline-flex items-center opacity-0 group-hover/trigger:opacity-[var(--vds-opacity-full)] group-focus-visible/trigger:opacity-[var(--vds-opacity-full)] text-[var(--vds-text-tertiary)] transition-[transform,color] duration-[var(--vds-execution-caret-transition)] ease-[var(--vds-execution-ease)] motion-reduce:transition-none group-aria-expanded/trigger:rotate-90 group-aria-expanded/trigger:text-[var(--vds-text-tertiary)]'
export const TOOL_RUN_STEP_CONTENT_CLASS =
  'grid min-h-0 grid-rows-[0fr] opacity-0 pointer-events-none transition-[grid-template-rows,opacity] duration-[var(--vds-execution-transition)] ease-[var(--vds-execution-ease)] motion-reduce:transition-none aria-[hidden=false]:grid-rows-[1fr] aria-[hidden=false]:opacity-[var(--vds-opacity-full)] aria-[hidden=false]:pointer-events-auto'
export const TOOL_RUN_IO_STACK_CLASS =
  'ml-[calc(var(--vds-space-4)*2)] mr-[var(--vds-space-2)] mb-[var(--vds-space-3)] flex flex-col gap-[var(--vds-space-3)] pt-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]'
export const TOOL_RUN_IO_LABEL_CLASS =
  'mb-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]'
export const TOOL_RUN_IO_CLASS =
  'm-[var(--vds-space-0)] max-h-[var(--vds-execution-detail-height)] overflow-auto rounded-[var(--vds-radius-3)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] font-[family-name:var(--vds-font-code)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)] whitespace-pre-wrap break-words [overflow-wrap:anywhere]'

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
        status === 'done'
          ? '[&.iconfont]:!text-[var(--vds-success-text-primary)]'
          : TOOL_RUN_STATUS_TONE_CLASS[`is-${status}`],
        status === 'error' && '[&.iconfont]:!text-[var(--vds-error-text-primary)]'
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
    <div data-testid="execution-io">
      <div className={TOOL_RUN_IO_LABEL_CLASS}>{label}</div>
      <div
        className={cx(
          'overflow-hidden rounded-[var(--vds-radius-3)] border border-solid border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)]',
          err && 'shadow-[var(--vds-execution-error-shadow)]'
        )}
      >
        <ScrollArea
          shadow="auto"
          overlay
          className={cx(
            '!rounded-none before:!bg-[linear-gradient(to_bottom,var(--vds-bg-gray-default),transparent)] after:!bg-[linear-gradient(to_top,var(--vds-bg-gray-default),transparent)]'
          )}
          viewportClassName="max-h-[var(--vds-execution-detail-height)]"
        >
          <pre className="m-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] px-[var(--vds-space-3)] py-[var(--vds-space-2)] font-[family-name:var(--vds-font-code)] font-[var(--vds-fw-regular)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
            {text}
          </pre>
        </ScrollArea>
      </div>
    </div>
  )
}

export function ToolExecution({
  data,
  groupOpen = true,
  actions,
  reveal = false,
  itemId,
  turnId,
}: {
  data: ToolExecutionData
  groupOpen?: boolean
  actions?: React.ReactNode
  reveal?: boolean
  itemId?: string
  turnId?: string
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const { t: conversation } = useTranslation('conversation')
  const [open, setOpen] = useState(false)
  const [technicalOpen, setTechnicalOpen] = useState(false)
  useEffect(() => {
    if (reveal) setOpen(true)
  }, [reveal])
  const hasBody = Boolean(
    data.failure || data.input !== undefined || data.output !== undefined || actions
  )
  return (
    <div
      className={cx(TOOL_RUN_STEP_CLASS, open && 'is-open')}
      data-testid="tool-run-step"
      data-message-item-id={itemId}
      data-message-turn-id={turnId}
      data-message-kind="tool"
    >
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
        <span className={cx(TOOL_RUN_STEP_STATUS_CLASS)}>
          <span className="shrink-0">{data.statusLabel}</span>
          {data.failure?.summary ? (
            <span className="min-w-0 truncate" title={data.failure.summary}>
              · {data.failure.summary}
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
            <div
              className={cx(
                TOOL_RUN_IO_STACK_CLASS,
                data.failure && TOOL_ACTIVITY_DETAIL_INSET_CLASS
              )}
            >
              {data.failure ? (
                <Card
                  variant="flat"
                  padding="none"
                  className="flex items-center gap-[var(--vds-space-2)] !rounded-[var(--vds-radius-3)] !border-[var(--vds-divider-default)] !bg-transparent px-[var(--vds-space-3)] py-[var(--vds-space-2)]"
                >
                  <p className="m-0 min-w-0 [overflow-wrap:anywhere]">{data.failure.help}</p>
                  <Button
                    variant="ghost"
                    size="xs"
                    type="button"
                    className="shrink-0 !text-[var(--vds-brand-text-primary)]"
                    onClick={() => setTechnicalOpen((value) => !value)}
                    aria-expanded={technicalOpen}
                  >
                    {conversation('toolOutcome.technicalDetails')}
                  </Button>
                </Card>
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
