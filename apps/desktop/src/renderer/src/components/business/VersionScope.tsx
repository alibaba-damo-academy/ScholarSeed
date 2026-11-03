import { groupedExclusions } from '../../features/resources/exclusions'
import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
  RadioGroup,
  RadioGroupItem,
  Textarea,
} from '../ui'
import {
  changeScenes,
  matchingScenes,
  VERSION_SCENES,
  VERSION_TYPE_PATTERNS,
  VERSION_EXCLUSION_TYPES,
  VERSION_TYPE_LABELS,
  type VersionScene,
} from '../../features/resources/scenes'

interface Props {
  mode: 'whitelist' | 'blacklist'
  onMode: (mode: Props['mode']) => void
  includes: string
  ignores: string
  onIncludes: (value: string) => void
  onIgnores: (value: string) => void
  commonPatterns: string[]
  disabled: boolean
}
const parse = (value: string): string[] => [
  ...new Set(
    value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  ),
]
const TYPE_PREFIX = '*.'
const DIRECTORY_SUFFIX = '/'

export function VersionScope(props: Props): React.JSX.Element {
  const { t } = useTranslation('resources')
  const [scenes, setScenes] = React.useState<VersionScene[]>(() =>
    matchingScenes(parse(props.includes))
  )
  const [adjusting, setAdjusting] = React.useState(false)
  const [folder, setFolder] = React.useState('')
  const [addingFolder, setAddingFolder] = React.useState(false)
  const [folderError, setFolderError] = React.useState(false)
  const patterns = parse(props.mode === 'whitelist' ? props.includes : props.ignores)
  const write = (next: string[]): void => {
    if (props.mode === 'whitelist') {
      setScenes([])
      props.onIncludes(next.join('\n'))
    } else props.onIgnores(next.join('\n'))
  }
  const visiblePatterns =
    props.mode === 'whitelist'
      ? patterns.filter((pattern) => VERSION_TYPE_PATTERNS.some((type) => type === pattern))
      : patterns
  const typeLabel = (pattern: string): string => {
    const key = VERSION_TYPE_LABELS[pattern as keyof typeof VERSION_TYPE_LABELS]
    return key ? `${t(key)} (${pattern.slice(TYPE_PREFIX.length)})` : pattern
  }
  const types = [
    ...new Set([
      ...VERSION_TYPE_PATTERNS,
      ...props.commonPatterns,
      ...(props.mode === 'blacklist' ? VERSION_EXCLUSION_TYPES : []),
    ]),
  ]
  return (
    <div className="grid gap-[var(--vds-space-6)]">
      <div className="grid gap-[var(--vds-space-4)]" data-testid="file-version-scope">
        <RadioGroup
          value={props.mode}
          onValueChange={(value) => props.onMode(value as Props['mode'])}
          className="grid grid-cols-1 gap-[var(--vds-space-2)] sm:grid-cols-2 [&>button]:rounded-[var(--vds-radius-4)] [&>button]:border [&>button]:border-[var(--vds-border-default)] [&>button]:p-[var(--vds-space-3)]"
        >
          <RadioGroupItem
            value="whitelist"
            disabled={props.disabled}
            label={t('fileSettings.whitelistMode')}
            data-testid="file-version-mode-whitelist"
          />
          <RadioGroupItem
            value="blacklist"
            disabled={props.disabled}
            label={t('fileSettings.blacklistMode')}
            data-testid="file-version-mode-blacklist"
          />
        </RadioGroup>
        {props.mode === 'whitelist' ? (
          <p className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-control-label-line-height)] text-[var(--vds-text-tertiary)]">
            {t('fileSettings.whitelistHelp')}
          </p>
        ) : (
          <div
            className="grid gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] bg-[var(--vds-surface-hover)] p-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-control-label-line-height)] text-[var(--vds-text-tertiary)]"
            data-testid="file-version-blacklist-help"
          >
            <p>{t('fileSettings.blacklistHelp')}</p>
            <p>{t('fileSettings.exclusionMeaning')}</p>
          </div>
        )}
      </div>
      {props.mode === 'whitelist' && (
        <>
          <div>
            <strong>{t('fileSettings.scenes')}</strong>
            <p className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]">
              {t('fileSettings.scenesHelp')}
            </p>
          </div>
          <div className="grid grid-cols-1 gap-[var(--vds-space-3)] sm:grid-cols-2 xl:grid-cols-4">
            {VERSION_SCENES.map((scene) => (
              <div
                key={scene.id}
                data-selected={scenes.includes(scene.id)}
                className="rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] p-[var(--vds-space-3)] data-[selected=true]:border-[var(--vds-brand-bg-default)] data-[selected=true]:bg-[var(--vds-surface-hover)]"
              >
                <Checkbox
                  label={t(scene.titleKey)}
                  checked={scenes.includes(scene.id)}
                  disabled={props.disabled}
                  data-testid={`file-version-scene-${scene.id}`}
                  onCheckedChange={(checked) => {
                    const next = checked
                      ? [...scenes, scene.id]
                      : scenes.filter((id) => id !== scene.id)
                    props.onIncludes(changeScenes(parse(props.includes), scenes, next).join('\n'))
                    setScenes(next)
                  }}
                />
                <p className="mt-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]">
                  {t(scene.descriptionKey)}
                </p>
              </div>
            ))}
          </div>
          {!scenes.length && (
            <p className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]">
              {t('fileSettings.customized')}
            </p>
          )}
        </>
      )}
      <div className="grid gap-[var(--vds-space-3)]" data-testid="file-version-rules">
        <strong>
          {t(props.mode === 'whitelist' ? 'fileSettings.types' : 'fileSettings.exclusions')}
        </strong>
        <div
          className={
            props.mode === 'whitelist'
              ? 'flex flex-wrap gap-[var(--vds-space-2)]'
              : 'grid gap-[var(--vds-space-2)]'
          }
        >
          {props.mode === 'whitelist'
            ? visiblePatterns.map((pattern) => (
                <Button
                  key={pattern}
                  size="sm"
                  variant="secondary"
                  disabled={props.disabled}
                  aria-label={t('fileSettings.removeRule', { rule: pattern })}
                  onClick={() => write(patterns.filter((item) => item !== pattern))}
                >
                  {typeLabel(pattern)} ×
                </Button>
              ))
            : groupedExclusions(patterns).map((group) => (
                <div
                  key={group.patterns[0]}
                  data-testid="file-version-exclusion-group"
                  className="grid grid-cols-[160px_minmax(0,1fr)] items-start gap-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] p-[var(--vds-space-3)]"
                >
                  <div className="min-w-0 leading-[var(--vds-lh-title)]">
                    <strong>{t(group.explanation.titleKey)}</strong>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-start content-start gap-[var(--vds-space-2)]">
                    {group.patterns.map((pattern) => (
                      <Button
                        key={pattern}
                        size="sm"
                        variant="secondary"
                        className="max-w-full !h-[var(--vds-control-height-sm)] !min-h-[var(--vds-control-height-sm)] break-all whitespace-normal !px-[var(--vds-space-2)]"
                        disabled={props.disabled}
                        aria-label={t('fileSettings.removeRule', { rule: pattern })}
                        onClick={() => write(patterns.filter((item) => item !== pattern))}
                      >
                        {pattern} ×
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
          {!patterns.length && (
            <p className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]">
              {t(props.mode === 'whitelist' ? 'fileSettings.noTypes' : 'fileSettings.noExclusions')}
            </p>
          )}
        </div>
      </div>
      <div className="grid gap-[var(--vds-space-2)]">
        <Collapsible open={adjusting} onOpenChange={setAdjusting} disabled={props.disabled}>
          <CollapsibleTrigger>
            {t(props.mode === 'whitelist' ? 'fileSettings.adjustTypes' : 'fileSettings.addType')}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div
              className="grid grid-cols-2 gap-[var(--vds-space-2)] sm:grid-cols-3"
              data-testid="file-version-type-picker"
            >
              {types.map((pattern) => (
                <Checkbox
                  key={pattern}
                  label={typeLabel(pattern)}
                  checked={patterns.includes(pattern)}
                  disabled={props.disabled}
                  onCheckedChange={(checked) =>
                    write(
                      checked ? [...patterns, pattern] : patterns.filter((item) => item !== pattern)
                    )
                  }
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
        {props.mode === 'blacklist' && (
          <Button
            size="sm"
            variant="outline"
            aria-expanded={addingFolder}
            disabled={props.disabled}
            onClick={() => setAddingFolder(!addingFolder)}
          >
            {t('fileSettings.addFolder')}
          </Button>
        )}
        {addingFolder && (
          <div className="grid gap-[var(--vds-space-2)]">
            <Input
              label={t('fileSettings.folderLabel')}
              helperText={t('fileSettings.folderHelp')}
              value={folder}
              disabled={props.disabled}
              onChange={(event) => {
                setFolder(event.target.value)
                setFolderError(false)
              }}
            />
            {folderError && <p role="alert">{t('fileSettings.folderError')}</p>}
            <Button
              size="sm"
              disabled={props.disabled || !folder.trim()}
              onClick={() => {
                const value = folder.trim().replace(/\\/g, DIRECTORY_SUFFIX).replace(/\/+$/, '')
                if (
                  value.startsWith(DIRECTORY_SUFFIX) ||
                  /^[A-Za-z]:/.test(value) ||
                  value
                    .split(DIRECTORY_SUFFIX)
                    .some((part) => part === '..' || part === '.' || !part) ||
                  /[\n\r*?![\]#]/.test(value)
                ) {
                  setFolderError(true)
                  return
                }
                write([...patterns, `${value}${DIRECTORY_SUFFIX}`])
                setFolder('')
                setAddingFolder(false)
              }}
            >
              {t('fileSettings.addFolder')}
            </Button>
          </div>
        )}
        <Collapsible>
          <CollapsibleTrigger data-testid="file-version-advanced">
            {t('fileSettings.advanced')}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Textarea
              data-testid={
                props.mode === 'whitelist'
                  ? 'file-version-include-patterns'
                  : 'file-version-ignore-patterns'
              }
              label={t(
                props.mode === 'whitelist'
                  ? 'fileSettings.includeLabel'
                  : 'fileSettings.ignoreLabel'
              )}
              helperText={t(
                props.mode === 'whitelist' ? 'fileSettings.includeHelp' : 'fileSettings.ignoreHelp'
              )}
              rows={5}
              value={props.mode === 'whitelist' ? props.includes : props.ignores}
              disabled={props.disabled}
              onChange={(event) => {
                if (props.mode === 'whitelist') {
                  setScenes([])
                  props.onIncludes(event.target.value)
                } else props.onIgnores(event.target.value)
              }}
            />
          </CollapsibleContent>
        </Collapsible>
      </div>
      <p className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]">
        {t('fileSettings.manualHelp')}
      </p>
    </div>
  )
}
