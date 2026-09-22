import React from 'react'
import { LockKeyhole } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import { SkillDocumentError, SkillCatalogError, deleteSkill, getSkillDocument, getSkills, setSkillActive, SKILL_ERROR_DUPLICATE, type SkillInfo, uploadSkillFile } from '../../api'
import { SKILL_SURFACE_SETTINGS } from '../../../../skills'
import { Icon } from '../../icons'
import { productSkillGroup, skillActivationControl, skillDescription, skillDocumentBody, SKILL_GROUPS, SKILL_LOGIN_REQUIRED, type SkillInstallNotice, skillMutationMessage, type SkillMutationMessage } from '../../skill'
import { useApp } from '../../store'
import { useAccountAccess } from './access'
import { LoginPrompt } from './LoginPrompt'
import { Markdown } from '../primitive/Markdown'
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogPortal, AlertDialogTitle, Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPortal, DialogTitle, Input, Switch, Tabs, TabsList, TabsTrigger, useToast } from '../ui'

const TAB_ALL = 'all'
const UPLOAD_ACCEPT = '.zip,.md'
const PAGE_CLASS = 'relative flex h-full min-h-0 max-w-[880px] flex-col'
const LIST_SCROLL_CLASS = 'min-h-0 flex-1 overflow-y-auto pr-[6px]'
const GRID_CLASS = 'grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3'
const CARD_CLASS = 'flex min-h-[148px] flex-col gap-2'
const DIALOG_CLASS = 'w-[min(720px,90vw)]'

function groupLabel(skill: SkillInfo, t: TFunction<'skills'>): string {
  const key = SKILL_GROUPS.find((group) => group.id === skill.group)?.labelKey
  return key ? t(key) : ''
}

function skillName(skill: SkillInfo): string {
  return skill.name
}

/** One device-wide settings surface; Composer reuses the same upload dialog. */
type SkillPageNotice = { key: 'loadFailed' | 'toggleFailed' | 'documentFailed' | 'deleteFailed' | 'deleted'; detail?: string }
  | { key: 'enabled' | 'disabled'; name: string }
  | SkillInstallNotice
  | SkillMutationMessage

function SkillNotice({ notice }: { notice: SkillPageNotice | string }): React.JSX.Element {
  const { t } = useTranslation('skills')
  if (typeof notice === 'string') return <>{notice}</>
  return <>{'name' in notice ? t(notice.key, { name: notice.name }) : <>{t(notice.key)}{notice.detail && <span> {notice.detail}</span>}</>}</>
}

export function Skills(): React.JSX.Element {
  const { state } = useApp()
  const { authenticated, revision } = useAccountAccess(state.backendReady)
  const { t, i18n } = useTranslation('skills')
  const { t: ui } = useTranslation('ui')
  const { toast } = useToast()
  const [skills, setSkills] = React.useState<SkillInfo[]>([])
  const [tab, setTab] = React.useState(TAB_ALL)
  const [query, setQuery] = React.useState('')
  const [loading, setLoading] = React.useState(true)
  const [notice, setNotice] = React.useState<SkillPageNotice | string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [toggling, setToggling] = React.useState<string | null>(null)
  const [detail, setDetail] = React.useState<{ skill: SkillInfo; document: string } | null>(null)
  const [adding, setAdding] = React.useState(false)
  const [removing, setRemoving] = React.useState<SkillInfo | null>(null)
  const [loginSkill, setLoginSkill] = React.useState<string | null>(null)

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const rows = await getSkills(SKILL_SURFACE_SETTINGS)
      setSkills(rows.filter((row) => productSkillGroup(row.group) !== null))
    } catch (error) {
      setNotice({ key: 'loadFailed', detail: error instanceof SkillCatalogError ? undefined : error instanceof Error ? error.message : undefined })
    } finally {
      setLoading(false)
    }
  }, [])
  React.useEffect(() => { void load() }, [load, revision])

  const toggle = async (skill: SkillInfo): Promise<void> => {
    if (!skill.toggleable || toggling) return
    const nextEnabled = !skill.enabled
    setToggling(skill.name)
    setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled: nextEnabled } : item))
    try {
      if (!await setSkillActive(skill.name, nextEnabled)) {
        setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled: skill.enabled } : item))
        toast({ tone: 'error', title: t('toggleFailed') })
        return
      }
      setNotice(null)
      toast({ tone: 'success', title: t(skill.enabled ? 'disabled' : 'enabled', { name: skillName(skill) }) })
    } catch (error) {
      setSkills((current) => current.map((item) => item.name === skill.name ? { ...item, enabled: skill.enabled } : item))
      toast({ tone: 'error', title: t('toggleFailed'), description: error instanceof Error ? error.message : undefined })
    } finally { setToggling(null) }
  }

  const view = async (skill: SkillInfo): Promise<void> => {
    setBusy(true)
    try { setDetail({ skill, document: await getSkillDocument(skill.name) }) }
    catch (error) { setNotice({ key: 'documentFailed', detail: error instanceof SkillDocumentError ? undefined : error instanceof Error ? error.message : undefined }) }
    finally { setBusy(false) }
  }

  const remove = async (): Promise<void> => {
    if (!removing) return
    setBusy(true)
    try {
      const result = await deleteSkill(removing.name)
      if (!result.ok) { setNotice(skillMutationMessage(result.code, result.error, 'deleteFailed')); return }
      setRemoving(null)
      setDetail(null)
      setNotice({ key: 'deleted' })
      await load()
    } catch (error) { setNotice({ key: 'deleteFailed', detail: error instanceof Error ? error.message : undefined }) }
    finally { setBusy(false) }
  }

  const language = i18n.resolvedLanguage || i18n.language
  const keyword = query.trim().toLocaleLowerCase()
  const visible = skills.filter((skill) => (tab === TAB_ALL || skill.group === tab)
    && (!keyword || `${skill.name}\n${skillDescription(skill, language)}`.toLocaleLowerCase().includes(keyword)))
  const detailSkill = detail ? skills.find((skill) => skill.name === detail.skill.name) ?? detail.skill : null

  return (
    <section className={PAGE_CLASS} data-testid="skills-page">
      <div className="mb-4 flex flex-wrap items-center gap-[10px]">
        <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
          <TabsList aria-label={t('groups.label')}>
            {[{ id: TAB_ALL, labelKey: 'groups.all' as const }, ...SKILL_GROUPS].map((group) => (
              <TabsTrigger key={group.id} value={group.id} data-testid={`skills-tab-${group.id}`}>{t(group.labelKey)}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="min-w-[180px] flex-1 [&>label]:w-full"><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('search')} aria-label={t('search')} data-testid="skills-search" /></div>
        {query && <Button variant="ghost" onClick={() => setQuery('')} aria-label={t('clearSearch')}><Icon name="close" size={14} /></Button>}
        <Button icon={<Icon name="plus" size={14} color="currentColor" />} onClick={() => setAdding(true)} data-testid="skills-add">{t('add')}</Button>
      </div>
      {notice && <div role="status" className="flex items-center gap-[var(--vds-space-2)] text-sm"><SkillNotice notice={notice} /><Button variant="ghost" onClick={() => setNotice(null)} aria-label={t('dismiss')}><Icon name="close" size={14} /></Button></div>}
      <div className={LIST_SCROLL_CLASS}>
        {loading ? <p role="status">{t('loading')}</p> : <>
          {visible.length === 0 && <div data-testid="skills-empty" className="py-[var(--vds-space-5)] text-[var(--vds-text-secondary)]">{keyword ? t('noMatch') : t('empty')}<Button variant="ghost" onClick={() => void load()}>{ui('refresh')}</Button></div>}
          {SKILL_GROUPS.filter((group) => tab === TAB_ALL || tab === group.id).map((group) => (
            <section key={group.id} className="mt-[22px] first:mt-0">
              <h2 className="mb-[10px] mt-0 text-[13.5px] font-semibold">{t(group.labelKey)}</h2>
              <div className={GRID_CLASS}>
                {visible.filter((skill) => skill.group === group.id).map((skill) => {
                  const control = skillActivationControl(skill)
                  const loginRequired = !authenticated && skill.requires_login
                  const description = skillDescription(skill, language) || t('description')
                  return <Card key={skill.name} className={CARD_CLASS} data-testid={`skill-card-${skill.name}`} data-skill-group={skill.group} data-toggleable={skill.toggleable}>
                    <CardHeader className="mb-0">
                      <div className="flex min-w-0 items-center gap-[var(--vds-space-2)]">
                        <CardTitle className="flex-1 break-words">{skillName(skill)}</CardTitle>
                        {loginRequired ? <Button variant="outline" size="xs" className="shrink-0 !border-[var(--vds-brand-light-border)] !bg-[var(--vds-brand-light-bg-default)] !text-[var(--vds-brand-text-primary)] hover:!border-[var(--vds-brand-bg-default)]" icon={<LockKeyhole className="size-[var(--vds-icon-6)]" />} onClick={() => setLoginSkill(skill.name)} data-testid={`skill-login-${skill.name}`}>{t('loginAvailable')}</Button>
                          : <Switch checked={control.checked} disabled={control.disabled || toggling === skill.name} label={control.disabled ? t('alwaysOn', { name: skillName(skill) }) : skill.enabled ? t('disable', { name: skillName(skill) }) : t('enable', { name: skillName(skill) })} title={control.disabled ? t('alwaysOnHint') : undefined} onCheckedChange={() => void toggle(skill)} data-testid={`skill-toggle-${skill.name}`} />}
                      </div>
                    </CardHeader>
                    <CardContent className="flex-1"><CardDescription className="line-clamp-3" title={description}>{description}</CardDescription>
                      {!loginRequired && skill.enabled && skill.unavailable_reason && skill.unavailable_reason !== SKILL_LOGIN_REQUIRED && <p className="text-sm text-[var(--vds-text-secondary)]">{skill.unavailable_reason}</p>}
                    </CardContent>
                    <CardFooter className="mt-0 gap-1 border-t border-[var(--vds-line-1)] pt-[6px]">
                      <Badge size="sm" variant="secondary">{groupLabel(skill, t)}</Badge>
                      {!loginRequired && !skill.enabled && <Badge size="sm" variant="secondary">{t('paused')}</Badge>}
                      <span className="flex-1" />
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void view(skill)} data-testid={`skill-view-${skill.name}`}>{t('view')}</Button>
                      {skill.group === 'user' && skill.removable && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setRemoving(skill)} data-testid={`skill-remove-${skill.name}`}>{t('delete')}</Button>}
                    </CardFooter>
                  </Card>
                })}
                {group.id === 'user' && !keyword && <Button variant="outline" className="min-h-[148px]" icon={<Icon name="plus" size={16} color="currentColor" />} onClick={() => setAdding(true)} data-testid="skills-add-card">{t('add')}</Button>}
              </div>
            </section>
          ))}
        </>}
      </div>
      <LoginPrompt open={loginSkill !== null} onOpenChange={(open) => { if (!open) setLoginSkill(null) }} skill={loginSkill ?? undefined} />
      <Dialog open={detail !== null} onOpenChange={(open) => { if (!open) setDetail(null) }}>
        <DialogPortal><DialogContent className={`${DIALOG_CLASS} !z-[var(--vds-z-modal-nested)]`} overlayClassName="!z-[var(--vds-z-modal-nested-overlay)]" data-testid="skill-detail">
          {detail && <><DialogHeader><DialogTitle>{skillName(detail.skill)}</DialogTitle><DialogDescription>{groupLabel(detail.skill, t)} · {detail.skill.version ? t('version', { version: detail.skill.version }) : t('noVersion')}</DialogDescription></DialogHeader>
            {detailSkill && <div className="flex items-center justify-between gap-[var(--vds-space-3)]" data-testid="skill-detail-preference">
              <span className="text-[length:var(--vds-font-body-lv2)] text-[var(--vds-text-secondary)]">{t('localPreference')}</span>
              <Switch checked={skillActivationControl(detailSkill).checked} disabled={skillActivationControl(detailSkill).disabled || toggling === detailSkill.name} label={detailSkill.enabled ? t('disable', { name: detailSkill.name }) : t('enable', { name: detailSkill.name })} onCheckedChange={() => void toggle(detailSkill)} data-testid={`skill-detail-toggle-${detailSkill.name}`} />
            </div>}
            <div className="min-w-0 max-h-[60vh] overflow-auto pr-2 text-[13px] leading-relaxed [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto" data-testid="skill-document"><Markdown text={skillDocumentBody(detail.document)} /></div>
            <DialogFooter><Button variant="outline" onClick={() => setDetail(null)}>{t('back')}</Button></DialogFooter></>}
        </DialogContent></DialogPortal>
      </Dialog>
      {adding && <SkillAdd onClose={() => setAdding(false)} onDone={async (message) => { setAdding(false); setNotice(message); await load() }} />}
      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open && !busy) setRemoving(null) }}>
        <AlertDialogPortal>
        <AlertDialogContent className="!z-[var(--vds-z-modal-nested)]" overlayClassName="!z-[var(--vds-z-modal-nested-overlay)]" data-testid="skill-remove-confirm"><AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('deleteDescription', { name: removing ? skillName(removing) : '' })}</AlertDialogDescription>
          <AlertDialogFooter><Button variant="outline" disabled={busy} onClick={() => setRemoving(null)}>{ui('cancel')}</Button><Button disabled={busy} onClick={() => void remove()} data-testid="skill-remove-ok">{busy ? t('deleting') : t('confirmDelete')}</Button></AlertDialogFooter>
        </AlertDialogContent>
        </AlertDialogPortal>
      </AlertDialog>
    </section>
  )
}

export function SkillAdd({ onClose, onDone }: { onClose: () => void; onDone: (message: SkillInstallNotice) => Promise<void> }): React.JSX.Element {
  const { t } = useTranslation('skills')
  const { t: ui } = useTranslation('ui')
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [file, setFile] = React.useState<File | null>(null)
  const [over, setOver] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<SkillMutationMessage | { key: 'upload.rejected'; detail?: string } | null>(null)
  const [conflict, setConflict] = React.useState(false)
  const pick = (incoming?: File): void => {
    if (!incoming || busy) return
    setConflict(false)
    if (!/\.(md|zip)$/i.test(incoming.name)) { setFile(null); setError({ key: 'upload.rejected' }); return }
    setFile(incoming)
    setError(null)
  }
  const install = async (overwrite = false): Promise<void> => {
    if (!file || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await uploadSkillFile(file, overwrite)
      if (!result.ok) {
        setConflict(result.code === SKILL_ERROR_DUPLICATE)
        setError(skillMutationMessage(result.code, result.error, 'upload.failed'))
        return
      }
      await onDone({ namespace: 'skills', key: 'installed', name: result.name || file.name })
    } catch (error) { setError({ key: 'upload.failed', detail: error instanceof Error ? error.message : undefined }) }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}><DialogPortal>
    <DialogContent className={`${DIALOG_CLASS} !z-[var(--vds-z-modal-nested)]`} overlayClassName="!z-[var(--vds-z-modal-nested-overlay)]" data-testid="skill-add-modal" hideCloseButton={busy}>
      <DialogHeader><DialogTitle>{t('add')}</DialogTitle><DialogDescription>{t('upload.description')}</DialogDescription></DialogHeader>
      <div className="grid gap-[var(--vds-space-3)] rounded-[var(--vds-radius-6)] border border-dashed border-[var(--vds-border-default)] p-[var(--vds-space-5)]" data-testid="skill-drop-zone" data-drag-over={over} onDragOver={(event) => { event.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)} onDrop={(event) => { event.preventDefault(); setOver(false); pick(event.dataTransfer.files[0]) }}>
        {file ? <div className="flex items-center gap-[var(--vds-space-2)]" data-testid="skill-upload-file"><Icon name="doc" size={18} /><span className="min-w-0 flex-1 break-words">{file.name}</span><Button variant="ghost" disabled={busy} aria-label={t('upload.remove')} onClick={() => { setFile(null); setConflict(false); setError(null); if (inputRef.current) inputRef.current.value = '' }}><Icon name="close" size={14} /></Button></div> : <p className="m-0 text-center">{over ? t('upload.drop') : t('upload.drag')}</p>}
        <Button variant="outline" disabled={busy} onClick={() => inputRef.current?.click()}>{file ? t('upload.reselect') : t('upload.select')}</Button>
        <Input ref={inputRef} type="file" aria-label={t('upload.select')} accept={UPLOAD_ACCEPT} className="hidden" disabled={busy} data-testid="skill-upload-input" onChange={(event) => pick(event.target.files?.[0])} />
      </div>
      {error && <div role="alert" data-testid="skill-upload-error">{t(error.key)}{error.detail && <span> {error.detail}</span>}<p className="text-sm">{conflict ? t('upload.conflictHint') : t('upload.retryHint')}</p></div>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>{ui('cancel')}</Button><Button disabled={!file || busy} data-testid={conflict ? 'skill-install-overwrite' : 'skill-install'} onClick={() => void install(conflict)}>{busy ? t('upload.installing') : conflict ? t('upload.overwrite') : t('upload.install')}</Button></DialogFooter>
    </DialogContent>
  </DialogPortal></Dialog>
}
