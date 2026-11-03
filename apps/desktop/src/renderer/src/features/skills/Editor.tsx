import { useId, useRef, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  ConnectorError,
  getMcpConfiguration,
  saveCustomConnectors,
  type ConnectorInfo,
  type McpServerConfig,
} from '../../api'
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPortal,
  DialogTitle,
  FormControl,
  FormDescription,
  FormField,
  FormLabel,
  FormMessage,
  Input,
  IconButton,
  Label,
  PasswordInput,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
} from '../../components/ui'
import {
  CUSTOM_INVALID,
  CUSTOM_UNAVAILABLE,
  CustomImportError,
  customConfig,
  isCustomTimeout,
  parseCustomImport,
  serializeCustom,
  submission,
} from './custom'

type Pair = { name: string; value: string }

export function CustomConnector({
  item,
  sessionId,
  onClose,
  onSaved,
}: {
  item: ConnectorInfo | null
  sessionId?: string
  onClose: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('skills')
  const transportLabelId = useId()
  const argumentId = useId()
  const config = item?.configuration
  const [name, setName] = useState(item?.name ?? '')
  const [description, setDescription] = useState(config?.description ?? '')
  const [timeout, setTimeoutValue] = useState(config?.timeout?.toString() ?? '')
  const timeoutInvalid = timeout !== '' && !isCustomTimeout(Number(timeout))
  const [startupTimeout, setStartupTimeout] = useState(config?.startup_timeout ?? null)
  const [transport, setTransport] = useState<'http' | 'sse' | 'stdio'>(config?.transport ?? 'http')
  const [url, setUrl] = useState(config && config.transport !== 'stdio' ? config.url : '')
  const [command, setCommand] = useState(config?.transport === 'stdio' ? config.command : '')
  const [args, setArgs] = useState<string[]>(config?.transport === 'stdio' ? config.args : [])
  const [cwd, setCwd] = useState(config?.transport === 'stdio' ? (config.cwd ?? '') : '')
  const [headers, setHeaders] = useState<Pair[]>(
    Object.entries(config && config.transport !== 'stdio' ? (config.headers ?? {}) : {}).map(
      ([name, value]) => ({ name, value })
    )
  )
  const [environment, setEnvironment] = useState<Pair[]>(
    Object.entries(config?.transport === 'stdio' ? (config.environment ?? {}) : {}).map(
      ([name, value]) => ({ name, value })
    )
  )
  const [mode, setMode] = useState('form')
  const [source, setSource] = useState('')
  const [preview, setPreview] = useState<McpServerConfig[] | null>(null)
  const [revision, setRevision] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [errorEntry, setErrorEntry] = useState('')
  const [busy, setBusy] = useState(false)
  const writing = useRef(false)
  const errors = {
    connector_custom_invalid: 'connectors.custom.invalid',
    connector_custom_duplicate: 'connectors.custom.duplicate',
    connector_custom_transport_unsupported: 'connectors.custom.unsupported',
    connector_configuration_conflict: 'connectors.custom.conflict',
    connector_custom_target_changed: 'connectors.custom.targetChanged',
    connector_custom_batch: 'connectors.custom.batch',
  } as const
  const message = errors[error as keyof typeof errors] ?? 'connectors.custom.failed'
  const rows = transport === 'stdio' ? environment : headers
  const setRows = transport === 'stdio' ? setEnvironment : setHeaders
  const collect = (): McpServerConfig[] => {
    if (mode === 'json') return parseCustomImport(source)
    const fields: Record<string, string> = {}
    const seen = new Set<string>()
    for (const row of rows) {
      if (!row.name && !row.value) continue
      if (!row.name || seen.has(row.name.toLowerCase())) throw new Error('connector_custom_invalid')
      seen.add(row.name.toLowerCase())
      fields[row.name] = row.value
    }
    return [
      customConfig(
        name.trim(),
        transport !== 'stdio'
          ? {
              transport,
              url: url.trim(),
              headers: fields,
              description,
              timeout: timeout === '' ? null : Number(timeout),
              startup_timeout: startupTimeout,
            }
          : {
              transport,
              command: command.trim(),
              args,
              description,
              timeout: timeout === '' ? null : Number(timeout),
              startup_timeout: startupTimeout,
              ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
              environment: fields,
            }
      ),
    ]
  }
  const changeMode = (value: string): void => {
    if (value === mode) return
    if (value === 'form' && !source.trim()) {
      setMode(value)
      setError('')
      setErrorEntry('')
      return
    }
    if (
      value === 'json' &&
      !item &&
      !name &&
      !url &&
      !command &&
      !description &&
      !timeout &&
      !headers.length &&
      !environment.length &&
      !args.length
    ) {
      setMode(value)
      setError('')
      return
    }
    try {
      const entries = collect()
      if (value === 'form') {
        if (entries.length !== 1) throw new Error('connector_custom_batch')
        const entry = entries[0]
        setName(entry.name)
        setDescription(entry.description ?? '')
        setTimeoutValue(entry.timeout?.toString() ?? '')
        setStartupTimeout(entry.startup_timeout ?? null)
        setTransport(entry.transport)
        if (entry.transport !== 'stdio') {
          setUrl(entry.url)
          setHeaders(Object.entries(entry.headers ?? {}).map(([name, value]) => ({ name, value })))
        } else {
          setCommand(entry.command)
          setArgs(entry.args)
          setCwd(entry.cwd ?? '')
          setEnvironment(
            Object.entries(entry.environment ?? {}).map(([name, value]) => ({ name, value }))
          )
        }
      } else setSource(serializeCustom(entries[0]))
      setMode(value)
      setError('')
    } catch (failure) {
      setErrorEntry(failure instanceof CustomImportError ? failure.entry : '')
      setError(failure instanceof Error ? failure.message : CUSTOM_INVALID)
    }
  }
  const review = async (): Promise<void> => {
    if (writing.current) return
    writing.current = true
    setBusy(true)
    setError('')
    setErrorEntry('')
    try {
      const entries = collect()
      if (item && entries.length !== 1) throw new Error('connector_custom_invalid')
      const view = await getMcpConfiguration()
      if (!view?.supported) throw new Error('connector_service_unavailable')
      const names = new Set(
        view.configuration.servers
          .filter((server) => server.id !== item?.id)
          .map((server) => server.name.toLowerCase())
      )
      if (entries.some((server) => names.has(server.name.toLowerCase())))
        throw new Error('connector_custom_duplicate')
      setRevision(view.configuration.revision)
      setPreview(entries)
    } catch (failure) {
      setErrorEntry(failure instanceof CustomImportError ? failure.entry : '')
      setError(
        failure instanceof SyntaxError
          ? CUSTOM_INVALID
          : failure instanceof Error
            ? failure.message
            : CUSTOM_UNAVAILABLE
      )
    } finally {
      writing.current = false
      setBusy(false)
    }
  }
  const save = async (): Promise<void> => {
    if (!preview || revision === null || writing.current) return
    writing.current = true
    setBusy(true)
    setError('')
    try {
      await saveCustomConnectors(item?.id ?? 'custom', {
        operation: 'custom_save',
        expected_revision: revision,
        session_id: sessionId,
        servers: preview.map(submission),
      })
      await onSaved()
      onClose()
    } catch (failure) {
      setError(failure instanceof ConnectorError ? failure.code : CUSTOM_UNAVAILABLE)
      setPreview(null)
    } finally {
      writing.current = false
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !writing.current) onClose()
      }}
    >
      <DialogPortal>
        <DialogContent
          hideCloseButton={busy}
          closeButtonClassName="!top-[var(--vds-space-3)] !right-[var(--vds-space-2)] !p-0"
          className="!px-[var(--vds-space-5)] !pt-[var(--vds-space-3)] !pb-[var(--vds-space-5)] !flex max-h-[calc(100dvh-var(--vds-space-6)-var(--vds-space-6))] flex-col overflow-hidden [&_label>span:first-child]:!text-[length:var(--vds-font-body-lv1)] [&_label>span:first-child]:!font-[var(--vds-fw-regular)] [&_label>span:first-child]:!text-[var(--vds-text-tertiary)] [&_label]:!text-[length:var(--vds-font-body-lv1)] [&_label]:!gap-[var(--vds-space-2)] [&_label]:!font-[var(--vds-fw-regular)] [&_label]:!text-[var(--vds-text-tertiary)] [&_[role=tab][data-state=inactive]]:!font-[var(--vds-fw-regular)]"
          data-testid="custom-connector-dialog"
          headerLayout="aligned"
        >
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex min-h-[var(--vds-control-height-md)] min-w-0 items-center pr-[var(--vds-control-height-md)] !text-[length:var(--vds-font-subhead)] !leading-[var(--vds-lh-subhead)]">
              {t(item ? 'connectors.custom.edit' : 'connectors.custom.add')}
            </DialogTitle>
          </DialogHeader>
          <div
            data-testid="custom-editor-body"
            className="-mr-[var(--vds-space-5)] grid min-h-0 flex-1 content-start gap-[var(--vds-space-4)] overflow-y-auto pr-[calc(var(--vds-space-5)-var(--vds-scrollbar-size))] [scrollbar-gutter:stable] [&::-webkit-scrollbar]:!w-[var(--vds-scrollbar-size)]"
          >
            {preview ? (
              <>
                <p>{t('connectors.custom.previewCount', { count: preview.length })}</p>
                {preview.map((server) => (
                  <div
                    key={server.name}
                    className="grid gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] p-[var(--vds-space-3)]"
                  >
                    <strong>{server.name}</strong>
                    <code className="break-all">
                      {server.transport !== 'stdio' ? server.url : server.command}
                    </code>
                    <p>{server.transport.toUpperCase()}</p>
                    <p>{t('connectors.custom.hidden')}</p>
                  </div>
                ))}
                {item && item.enabled && (
                  <Alert tone="warning" description={t('connectors.custom.activeEdit')} />
                )}
              </>
            ) : (
              <>
                <Tabs
                  value={mode}
                  disabled={busy}
                  className="w-full"
                  onValueChange={(value) => changeMode(String(value))}
                >
                  <TabsList aria-label={t('connectors.custom.mode')} className="w-full">
                    <TabsTrigger value="form" className="flex-1">
                      {t('connectors.custom.form')}
                    </TabsTrigger>
                    <TabsTrigger value="json" className="flex-1">
                      {t('connectors.custom.jsonMode')}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <Alert
                  id={mode === 'json' ? 'custom-json-hint' : undefined}
                  tone="info"
                  data-testid="custom-connector-hint"
                  description={t(
                    mode === 'json' ? 'connectors.custom.jsonHint' : 'connectors.custom.hint'
                  )}
                />
                {mode === 'json' ? (
                  <>
                    <Textarea
                      rows={10}
                      label={t('connectors.custom.json')}
                      aria-describedby="custom-json-hint"
                      value={source}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setSource(event.target.value)}
                    />
                  </>
                ) : (
                  <>
                    <Input
                      label={t('connectors.custom.name')}
                      required
                      placeholder={t('connectors.custom.namePlaceholder')}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      autoFocus
                      maxLength={128}
                    />
                    <Textarea
                      label={t('connectors.custom.descriptionLabel')}
                      placeholder={t('connectors.custom.descriptionPlaceholder')}
                      value={description}
                      maxLength={1000}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                    <FormField className="!gap-[var(--vds-space-2)]">
                      <FormLabel>{t('connectors.custom.timeout')}</FormLabel>
                      <FormControl invalid={timeoutInvalid}>
                        <Input
                          placeholder={t('connectors.custom.timeoutPlaceholder')}
                          inputMode="numeric"
                          value={timeout}
                          onChange={(event) => setTimeoutValue(event.target.value)}
                        />
                      </FormControl>
                      <FormDescription className="!font-[var(--vds-fw-regular)] !text-[var(--vds-text-tertiary)]">
                        {t('connectors.custom.timeoutHint')}
                      </FormDescription>
                      {timeoutInvalid && (
                        <FormMessage>{t('connectors.custom.timeoutError')}</FormMessage>
                      )}
                    </FormField>
                    <div className="grid gap-[var(--vds-space-2)]">
                      <Label id={transportLabelId}>{t('connectors.custom.transport')}</Label>
                      <Tabs
                        value={transport}
                        className="w-fit justify-self-start"
                        onValueChange={(value) => setTransport(value as 'http' | 'sse' | 'stdio')}
                      >
                        <TabsList aria-labelledby={transportLabelId}>
                          <TabsTrigger value="http">{t('connectors.custom.http')}</TabsTrigger>
                          <TabsTrigger value="sse">{t('connectors.custom.sse')}</TabsTrigger>
                          <TabsTrigger value="stdio">{t('connectors.custom.stdio')}</TabsTrigger>
                        </TabsList>
                      </Tabs>
                    </div>
                    {transport !== 'stdio' ? (
                      <Input
                        label={t('connectors.custom.url')}
                        required
                        placeholder={t('connectors.custom.urlPlaceholder')}
                        value={url}
                        onChange={(event) => setUrl(event.target.value)}
                      />
                    ) : (
                      <>
                        <Input
                          label={t('connectors.custom.command')}
                          required
                          placeholder={t('connectors.custom.commandPlaceholder')}
                          value={command}
                          onChange={(event) => setCommand(event.target.value)}
                        />
                        <div className="grid justify-items-start gap-[var(--vds-space-2)]">
                          <span className="text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]">
                            {t('connectors.custom.args')}
                          </span>
                          {args.map((argument, index) => (
                            <div
                              key={index}
                              className="grid w-full gap-[var(--vds-space-2)] [&+div]:mt-[var(--vds-space-2)]"
                            >
                              <div className="flex items-center justify-between gap-[var(--vds-space-2)]">
                                <Label htmlFor={`${argumentId}-${index}`}>
                                  {t('connectors.custom.argument', { index: index + 1 })}
                                </Label>
                                <IconButton
                                  variant="ghostIcon"
                                  size="xs"
                                  label={t('connectors.custom.removeArgument', {
                                    index: index + 1,
                                  })}
                                  icon={<Trash2 />}
                                  onClick={() =>
                                    setArgs(args.filter((_, position) => position !== index))
                                  }
                                />
                              </div>
                              <Input
                                id={`${argumentId}-${index}`}
                                placeholder={t('connectors.custom.argumentPlaceholder')}
                                value={argument}
                                onChange={(event) =>
                                  setArgs(
                                    args.map((value, position) =>
                                      position === index ? event.target.value : value
                                    )
                                  )
                                }
                              />
                            </div>
                          ))}
                          <Button
                            size="sm"
                            variant="outline"
                            icon={<Plus />}
                            className="justify-self-start"
                            onClick={() => setArgs([...args, ''])}
                          >
                            {t('connectors.custom.addArgument')}
                          </Button>
                        </div>
                        <Input
                          label={t('connectors.custom.cwd')}
                          placeholder={t('connectors.custom.cwdPlaceholder')}
                          value={cwd}
                          onChange={(event) => setCwd(event.target.value)}
                        />
                      </>
                    )}
                    <div className="grid justify-items-start gap-[var(--vds-space-2)]">
                      <span className="text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-regular)] text-[var(--vds-text-tertiary)]">
                        {t(
                          transport !== 'stdio'
                            ? 'connectors.custom.headers'
                            : 'connectors.custom.environment'
                        )}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        icon={<Plus />}
                        onClick={() => setRows([...rows, { name: '', value: '' }])}
                      >
                        {t('connectors.custom.addField')}
                      </Button>
                    </div>
                    {rows.map((row, index) => (
                      <div
                        key={index}
                        data-testid="custom-connector-field"
                        className="relative grid gap-[var(--vds-space-4)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] p-[var(--vds-space-3)]"
                      >
                        <IconButton
                          variant="ghostIcon"
                          size="xs"
                          className="absolute right-[var(--vds-space-2)] top-[var(--vds-space-2)]"
                          label={t('connectors.custom.removeField', { index: index + 1 })}
                          icon={<Trash2 />}
                          onClick={() => setRows(rows.filter((_, position) => position !== index))}
                        />
                        <Input
                          label={t('connectors.custom.fieldName', { index: index + 1 })}
                          placeholder={t('connectors.custom.fieldNamePlaceholder')}
                          value={row.name}
                          onChange={(event) =>
                            setRows(
                              rows.map((current, position) =>
                                position === index
                                  ? { ...current, name: event.target.value }
                                  : current
                              )
                            )
                          }
                        />
                        <PasswordInput
                          label={t('connectors.custom.fieldValue', { index: index + 1 })}
                          placeholder={t('connectors.custom.fieldValuePlaceholder')}
                          value={row.value}
                          autoComplete="off"
                          onChange={(event) =>
                            setRows(
                              rows.map((current, position) =>
                                position === index
                                  ? { ...current, value: event.target.value }
                                  : current
                              )
                            )
                          }
                        />
                      </div>
                    ))}
                    {item && <p>{t('connectors.custom.retain')}</p>}
                  </>
                )}
              </>
            )}
            {error && (
              <Alert
                tone="error"
                description={
                  errorEntry
                    ? t('connectors.custom.entryError', { name: errorEntry, reason: t(message) })
                    : t(message)
                }
              />
            )}
          </div>
          <DialogFooter className="shrink-0">
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => (preview ? setPreview(null) : onClose())}
            >
              {t(preview ? 'connectors.custom.back' : 'connectors.cancel')}
            </Button>
            <Button
              disabled={
                busy ||
                (!preview &&
                  (mode === 'json'
                    ? !source.trim()
                    : timeoutInvalid ||
                      !name.trim() ||
                      !(transport === 'stdio' ? command.trim() : url.trim())))
              }
              loading={busy}
              onClick={() => void (preview ? save() : review())}
            >
              {t(preview ? 'connectors.custom.save' : 'connectors.custom.preview')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
