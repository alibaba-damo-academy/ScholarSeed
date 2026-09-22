import React from 'react'
import { useTranslation } from 'react-i18next'

import { maskPhone } from '../../account'
import { downloadSessionDiagnostics, FEEDBACK_MAX_IMAGES, SESSION_DIAGNOSTIC_FILENAME, submitFeedback } from '../../api'
import { clipboardImageFiles, feedbackImageRoom, mergeFeedbackImages, toScreenshotFile } from '../../attachments'
import { Icon } from '../../icons'
import { writeClipboard } from '../primitive/clipboard'
import { Button, CopyButton, Dialog, DialogContent, DialogTitle, Textarea } from '../ui'
import { Diagnostics } from './Diagnostics'

// Feedback.tsx — 账户菜单里的「问题反馈」弹窗。
//
// 提交经 serve 转发到 Damoclaw-Server 的公开端点（renderer 读不到 `~/.scholarseed/logs/`，
// 日志包只能在 serve 侧打；身份也只认 serve 侧验签后的 user_id）。
//
// 关于「附带对话记录」这个勾选：它会把 LLM trace（完整提问与模型输出，也就是用户的研究
// 内容）打进日志包上传。它默认勾选 —— 排障时拿不到 trace 的反馈基本无法定位，而默认关闭
// 的实际效果就是绝大多数反馈都没有 trace。因此口径是「默认附带、可取消」，文案必须把范围
// 和取消方式写全：设置页「数据共享」区承诺的是不做**被动**上传用于产品改进，这里是用户为
// 排障主动、单次地交出当前这一个会话，两者不冲突；但文案一旦含糊，默认勾选就变成默认偷传。

const DESCRIPTION_MAX = 5000
// 下限就是「非空」—— 与 serve 侧 FeedbackService 和 Damoclaw 的 `description.strip()` 完全对齐。
// 曾经在这里卡过一个 5 字阈值: 中文里「打不开」「闪退」「白屏了」都是 3 字的有效报障,
// 而按钮只会默默置灰不说原因 —— 用户看到的就是「无法提交」。防治水帖靠服务端
// 按 IP 限频 (10 次/小时), 不靠在输入框上拍一个拍脑袋的字数。
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'
const IMAGE_MAX_BYTES = 20 * 1024 * 1024
// 与 serve 侧 MAX_IMAGES_TOTAL_SIZE 对齐。前端先拦一道只为了把超限告知提前到
// 选图那一刻，而不是让用户传完才吃一个 422；真正的闸在 serve 侧。
const IMAGE_MAX_TOTAL_BYTES = 40 * 1024 * 1024

type Phase = 'editing' | 'submitting' | 'done'

const classes = (...values: Array<false | string | undefined>): string => values.filter(Boolean).join(' ')

const scrimClassName = 'feedback-scrim z-[var(--vds-z-dialog-overlay)] bg-[rgb(38_32_20_/_45%)]'
const dialogClassName = 'feedback-dialog vds-panel z-[var(--vds-z-dialog)] flex w-[min(520px,calc(100vw-40px))] max-h-[calc(100vh-80px)] flex-col gap-[9px] overflow-y-auto px-[18px] pb-[15px] pt-[var(--vds-space-4)]'
const titleClassName = 'feedback-title m-[var(--vds-space-0)] text-[14px] font-semibold text-[var(--text)]'
const doneClassName = 'feedback-done flex flex-col items-start gap-[7px] py-[var(--vds-space-1)] pb-[2px]'
const doneTitleClassName = 'feedback-done-title m-[var(--vds-space-0)] text-[12.5px] text-[var(--text)]'
const doneIdClassName = 'feedback-done-id m-[var(--vds-space-0)] flex items-center gap-[6px] text-[10.5px] text-[var(--text-3)] [font-family:var(--font-mono)]'
const doneTicketClassName = 'feedback-done-ticket cursor-text select-all text-[var(--text-2)]'
const doneCopyClassName = 'feedback-done-copy inline-flex cursor-pointer items-center gap-[3px] rounded-[5px] border border-[var(--border)] bg-transparent px-[6px] py-[2px] text-[10.5px] text-[var(--text-3)] [font-family:var(--font)] hover:bg-[var(--bg-2)] hover:text-[var(--text)]'
const labelClassName = 'feedback-label text-[11.5px] text-[var(--text-2)]'
const textareaClassName = 'feedback-textarea min-h-[116px] resize-y rounded-[7px] border border-[var(--border)] bg-[var(--paper)] px-[var(--vds-space-3)] py-[9px] text-[12.5px] leading-[1.55] text-[var(--text)] [font-family:var(--font)] focus:border-[var(--active-border)] focus:outline-none'
const counterClassName = 'feedback-counter -mt-[5px] text-right text-[10px] text-[var(--text-3)]'
const imagesClassName = 'feedback-images flex flex-wrap gap-[6px] py-[var(--vds-space-1)]'
const autoShotClassName = 'feedback-auto-screenshot flex items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border border-[var(--border-soft)] bg-[var(--bg-2)] px-[var(--vds-space-2)] py-[var(--vds-space-2)]'
const autoShotThumbClassName = 'feedback-auto-screenshot-thumb h-[var(--vds-control-height-lg)] w-auto flex-none rounded-[var(--vds-radius-2)] border border-[var(--border)]'
const autoShotTextClassName = 'feedback-auto-screenshot-text flex min-w-0 flex-1 flex-col gap-[var(--vds-space-1)]'
const chipClassName = 'feedback-chip inline-flex max-w-full items-center gap-[5px] overflow-hidden text-ellipsis whitespace-nowrap rounded-full border border-[var(--border)] px-[var(--vds-space-2)] py-[var(--vds-space-1)] text-[10.5px] text-[var(--text-2)]'
const attachClassName = 'feedback-attach inline-flex min-h-[26px] max-w-full cursor-pointer items-center gap-[5px] overflow-hidden text-ellipsis whitespace-nowrap rounded-full border border-dashed border-[var(--border)] px-[9px] py-[5px] text-[10.5px] text-[var(--text-2)] hover:bg-[var(--hover-bg)] hover:text-[var(--text)]'
const chipRemoveClassName = 'feedback-chip-remove grid cursor-pointer place-items-center border-0 bg-transparent p-[var(--vds-space-0)]'
const consentClassName = 'feedback-consent my-[var(--vds-space-1)] flex flex-col gap-[7px] rounded-[7px] border border-[var(--border-soft)] bg-[var(--bg-2)] px-[11px] py-[10px]'
const checkClassName = 'feedback-check flex cursor-pointer gap-[var(--vds-space-2)]'
const checkDisabledClassName = 'is-disabled cursor-default opacity-50'
const checkInputClassName = 'feedback-check-input mt-[2px] flex-none accent-[var(--accent-ink)]'
const checkTextClassName = 'feedback-check-text flex flex-col gap-[2px]'
const checkTitleClassName = 'feedback-check-title text-[11.5px] font-[550] text-[var(--text)]'
const checkDescriptionClassName = 'feedback-check-description text-[10.5px] not-italic leading-normal text-[var(--text-3)]'
const errorClassName = 'feedback-error text-[11px] leading-[1.45] text-[var(--c-tension)]'
const actionsClassName = 'feedback-actions flex items-center justify-between gap-[10px] pt-[3px]'
const contactClassName = 'feedback-contact text-[10.5px] text-[var(--text-3)]'

export function Feedback({
  phone,
  sessionId,
  autoScreenshot,
  onClose
}: {
  /** 登录手机号原值。上报用原值 (管理台要能真的拨回去), 展示用掩码。 */
  phone: string
  /** 当前点开的会话; null = 没打开任何会话, 对话项直接不可选。 */
  sessionId: string | null
  /** 打开弹窗前抓取的当前窗口截图字节; null/缺省 = 没有自动截图 (抓取失败已静默降级)。 */
  autoScreenshot?: Uint8Array | null
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation('components')
  const [description, setDescription] = React.useState('')
  const [includeLogs, setIncludeLogs] = React.useState(true)
  const [includeTrace, setIncludeTrace] = React.useState(true)
  const [images, setImages] = React.useState<File[]>([])
  // 自动截图作为独立、显著、可删的预附件; 不混进手动 images chip, 提交时再合并到首位。
  const [autoShot, setAutoShot] = React.useState<File | null>(
    () => (autoScreenshot ? toScreenshotFile(autoScreenshot, Date.now()) : null)
  )
  const [phase, setPhase] = React.useState<Phase>('editing')
  const [error, setError] = React.useState<{ kind: 'limit' } | { kind: 'file' | 'total'; name: string } | { kind: 'message'; messageKey: 'feedback.rateLimited' | 'feedback.failed' | 'feedback.exportMissing' | 'feedback.saveFailed' | 'feedback.exportFailed' } | { kind: 'raw'; text: string } | null>(null)
  const [ticket, setTicket] = React.useState('')
  const [exporting, setExporting] = React.useState(false)
  const [exportSaved, setExportSaved] = React.useState(false)
  const errorText = !error ? ''
    : error.kind === 'raw' ? error.text
    : error.kind === 'message' ? t(error.messageKey)
    : error.kind === 'limit' ? t('feedback.limit', { count: FEEDBACK_MAX_IMAGES })
    : t(error.kind === 'file' ? 'feedback.fileSize' : 'feedback.totalSize', {
      name: error.name, limit: (error.kind === 'file' ? IMAGE_MAX_BYTES : IMAGE_MAX_TOTAL_BYTES) / 1024 / 1024
    })
  const areaRef = React.useRef<HTMLTextAreaElement>(null)

  React.useEffect(() => {
    areaRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      // 提交中不给 Esc 关：请求已经在飞，关掉窗口只会让用户以为没提交而重复提交。
      if (event.key === 'Escape' && phase !== 'submitting') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, phase])

  // objectURL 必须在 effect 内创建、并由同一个 effect 自管回收。若用 useMemo 建 URL、
  // 另用 effect cleanup 回收, StrictMode 双挂载与 Fast Refresh 重跑 effect 时会 revoke
  // 掉仍被 <img> 引用的 memo 缓存 URL(dev 下缩略图破图); 在 effect 内重建可保证 img
  // 始终指向活 URL, 且 autoShot 变化/卸载时旧 URL 仍被回收、不泄漏。
  const [autoShotUrl, setAutoShotUrl] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (!autoShot) {
      setAutoShotUrl(null)
      return
    }
    const url = URL.createObjectURL(autoShot)
    setAutoShotUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [autoShot])

  const addImages = (picked: ArrayLike<File> | null): void => {
    if (!picked?.length) return
    // 自动截图占用 5 张名额之一: 手动余量与总量预检都要把它算进去。
    const room = feedbackImageRoom(images.length, autoShot !== null, FEEDBACK_MAX_IMAGES)
    if (room <= 0) {
      setError({ kind: 'limit' })
      return
    }
    const accepted: File[] = []
    let total = images.reduce((sum, file) => sum + file.size, 0) + (autoShot?.size ?? 0)
    for (const file of Array.from(picked).slice(0, room)) {
      if (file.size > IMAGE_MAX_BYTES) {
        setError({ kind: 'file', name: file.name })
        continue
      }
      if (total + file.size > IMAGE_MAX_TOTAL_BYTES) {
        setError({ kind: 'total', name: file.name })
        continue
      }
      total += file.size
      accepted.push(file)
    }
    if (accepted.length) {
      setImages((current) => [...current, ...accepted])
      setError(null)
    }
  }

  const removeImage = (index: number): void => {
    setImages((current) => current.filter((_, i) => i !== index))
  }

  const trimmed = description.trim()
  const ready = trimmed.length > 0 && phase === 'editing'
  // 对话项的前提是真的有一个被点开的会话。没有就置灰 + 改文案, 而不是给一个
  // 勾了也不会生效的勾选框 —— 那等于向用户谎报了上传范围。
  const hasSession = Boolean(sessionId)
  const traceEnabled = includeLogs && hasSession

  const handleSubmit = async (): Promise<void> => {
    if (!ready) return
    setPhase('submitting')
    setError(null)
    const result = await submitFeedback({
      description: trimmed,
      includeLogs,
      includeTrace: includeLogs && includeTrace && hasSession,
      sessionId,
      // 自动截图 (若保留) 排首位, 其后是手动附图; 共用同一个 images[] 通道与上限。
      images: mergeFeedbackImages(autoShot, images)
    })
    if (!result.ok) {
      setPhase('editing')
      setError(
        result.rateLimited
          ? { kind: 'message', messageKey: 'feedback.rateLimited' }
          : result.error ? { kind: 'raw', text: result.error } : { kind: 'message', messageKey: 'feedback.failed' }
      )
      return
    }
    setTicket(result.id || '')
    setPhase('done')
  }

  const exportDiagnostics = async (): Promise<void> => {
    if (!sessionId || exporting) return
    setExporting(true)
    setExportSaved(false)
    setError(null)
    try {
      const file = await downloadSessionDiagnostics(sessionId)
      if (!file) {
        setError({ kind: 'message', messageKey: 'feedback.exportMissing' })
        return
      }
      const result = await window.scholarseed?.saveFileCopy({
        suggestedName: SESSION_DIAGNOSTIC_FILENAME,
        bytes: file.bytes
      })
      if (result?.ok) setExportSaved(true)
      else if (!result?.canceled) setError({ kind: 'message', messageKey: 'feedback.saveFailed' })
    } catch {
      setError({ kind: 'message', messageKey: 'feedback.exportFailed' })
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && phase !== 'submitting' && onClose()}>
      <DialogContent
        aria-label={t('feedback.title')}
        className={dialogClassName}
        data-testid="feedback-dialog"
        onPaste={(event) => {
          if (phase !== 'editing') return
          const pastedImages = clipboardImageFiles(event.clipboardData.items)
          if (!pastedImages.length) return
          event.preventDefault()
          addImages(pastedImages)
        }}
        overlayClassName={scrimClassName}
        overlayProps={{
          onClick: () => phase !== 'submitting' && onClose()
        }}
      >
        <DialogTitle className={titleClassName}>{t('feedback.title')}</DialogTitle>

        {phase === 'done' ? (
          <div className={doneClassName} data-testid="feedback-done">
            <p className={doneTitleClassName}>{t('feedback.received')}</p>
            {ticket && (
              <p className={doneIdClassName}>
                {t('feedback.ticket')}
                <span className={doneTicketClassName} data-testid="feedback-ticket">{ticket}</span>
                <CopyButton
                  type="button"
                  value={ticket}
                  writeText={writeClipboard}
                  idleLabel={t('feedback.copy')}
                  copiedLabel={t('feedback.copied')}
                  className={doneCopyClassName}
                  data-testid="feedback-copy"
                />
              </p>
            )}
            <Button type="button" size="sm" onClick={onClose}>{t('feedback.done')}</Button>
          </div>
        ) : (
          <>
            <label className={labelClassName} htmlFor="feedback-description">
              {t('feedback.question')}
            </label>
            <Textarea
              id="feedback-description"
              ref={areaRef}
              className={textareaClassName}
              data-testid="feedback-description"
              value={description}
              maxLength={DESCRIPTION_MAX}
              placeholder={t('feedback.placeholder')}
              onChange={(event) => setDescription(event.target.value)}
              disabled={phase === 'submitting'}
              unstyled
            />
            <div className={counterClassName}>{description.length} / {DESCRIPTION_MAX}</div>

            {autoShot && (
              <div className={autoShotClassName} data-testid="feedback-auto-screenshot">
                <img
                  src={autoShotUrl ?? undefined}
                  alt={t('feedback.autoScreenshot')}
                  className={autoShotThumbClassName}
                  data-testid="feedback-auto-screenshot-thumb"
                />
                <span className={autoShotTextClassName}>
                  <strong className={checkTitleClassName}>{t('feedback.autoScreenshot')}</strong>
                  <em className={checkDescriptionClassName}>{t('feedback.autoScreenshotDescription')}</em>
                </span>
                <Button
                  type="button"
                  aria-label={t('feedback.autoScreenshotRemove')}
                  onClick={() => setAutoShot(null)}
                  disabled={phase === 'submitting'}
                  className={chipRemoveClassName}
                  data-testid="feedback-auto-screenshot-remove"
                  unstyled
                >
                  <Icon name="close" size={12} color="var(--text-3)" />
                </Button>
              </div>
            )}

            <div className={imagesClassName}>
              {images.map((file, index) => (
                <span key={`${file.name}-${index}`} className={chipClassName}>
                  {file.name}
                  <Button
                    type="button"
                    aria-label={t('feedback.remove', { name: file.name })}
                    onClick={() => removeImage(index)}
                    disabled={phase === 'submitting'}
                    className={chipRemoveClassName}
                    unstyled
                  >
                    <Icon name="close" size={12} color="var(--text-3)" />
                  </Button>
                </span>
              ))}
              {feedbackImageRoom(images.length, autoShot !== null, FEEDBACK_MAX_IMAGES) > 0 && (
                <label className={attachClassName}>
                  <Icon name="plus" size={13} color="var(--text-2)" />
                  {t('feedback.attach')}
                  <input
                    type="file"
                    accept={IMAGE_ACCEPT}
                    multiple
                    hidden
                    data-testid="feedback-images"
                    disabled={phase === 'submitting'}
                    onChange={(event) => {
                      addImages(event.target.files)
                      event.target.value = ''
                    }}
                  />
                </label>
              )}
            </div>

            <div className={consentClassName}>
              <label className={checkClassName}>
                <input
                  type="checkbox"
                  checked={includeLogs}
                  data-testid="feedback-include-logs"
                  disabled={phase === 'submitting'}
                  onChange={(event) => setIncludeLogs(event.target.checked)}
                  className={checkInputClassName}
                />
                <span className={checkTextClassName}>
                  <strong className={checkTitleClassName}>{t('feedback.logs')}</strong>
                  <em className={checkDescriptionClassName}>{t('feedback.logsDescription')}</em>
                </span>
              </label>
              <label className={classes(checkClassName, !traceEnabled && checkDisabledClassName)}>
                <input
                  type="checkbox"
                  checked={traceEnabled && includeTrace}
                  data-testid="feedback-include-trace"
                  disabled={!traceEnabled || phase === 'submitting'}
                  onChange={(event) => setIncludeTrace(event.target.checked)}
                  className={checkInputClassName}
                />
                <span className={checkTextClassName}>
                  <strong className={checkTitleClassName}>{t('feedback.trace')}</strong>
                  <em className={checkDescriptionClassName}>
                    {hasSession
                      ? t('feedback.traceDescription')
                      : t('feedback.noSession')}
                  </em>
                </span>
              </label>
            </div>

            <Button
              variant="secondary"
              size="sm"
              disabled={!hasSession || phase === 'submitting'}
              loading={exporting}
              data-testid="feedback-export-diagnostics"
              onClick={() => void exportDiagnostics()}
            >
              {t('feedback.export')}
            </Button>
            <p className={contactClassName}>
              {t('feedback.exportDescription')}
            </p>
            {exportSaved && <div role="status">{t('feedback.exportSaved')}</div>}
            {sessionId && <Diagnostics key={sessionId} sessionId={sessionId} disabled={phase === 'submitting'} />}
            {error && <div className={errorClassName} role="alert" data-testid="feedback-error">{errorText}</div>}

            <div className={actionsClassName}>
              <span className={contactClassName}>
                {phone ? t('feedback.contact', { phone: maskPhone(phone) }) : ''}
              </span>
              <Button
                type="button"
                size="sm"
                data-testid="feedback-submit"
                disabled={!ready}
                onClick={() => void handleSubmit()}
              >
                {t(phase === 'submitting' ? 'feedback.submitting' : 'feedback.submit')}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
