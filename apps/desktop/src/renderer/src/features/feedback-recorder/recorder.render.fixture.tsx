import React from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { createLocalization } from '../../../../localization/engine'
import zh from '../../../../localization/locales/zh/components.json'
import en from '../../../../localization/locales/en/components.json'
import zhUi from '../../../../localization/locales/zh/ui.json'
import enUi from '../../../../localization/locales/en/ui.json'
import { Button, ToastProvider, Toaster, useToast } from '../../components/ui'
import { ScreenshotShutter, useScreenshotShutter } from './Shutter'
import { Capture } from './Capture'
import { Annotator } from './Annotator'
import { useFloatingSurface } from './drag'
import { createInitialPageStep, installRecorderProbe } from './probe'
import { Review } from './Review'
import type { RecordedScreenshot, SummaryFields, RecordedStep } from './model'
import '../../styles.css'

const localization = createLocalization(
  'zh',
  { zh: { components: zh, ui: zhUi }, en: { components: en, ui: enUi } },
  { report: () => undefined }
)
function Saved(): React.JSX.Element {
  const { t } = useTranslation('components')
  return <>{t('feedbackRecorder.screenshotSubmitted')}</>
}
function Preview(): React.JSX.Element {
  const shutter = useScreenshotShutter()
  const [steps, setSteps] = React.useState<RecordedStep[]>([])
  const [paused, setPaused] = React.useState(false)
  const [note, setNote] = React.useState('')
  const [reviewPage, setReviewPage] = React.useState(0)
  const [review, setReview] = React.useState(false)
  const [exited, setExited] = React.useState(false)
  const [notes, setNotes] = React.useState<Record<string, string>>({})
  const [screenshots, setScreenshots] = React.useState<RecordedScreenshot[]>([])
  const [editingScreenshotNote, setEditingScreenshotNote] = React.useState('')
  const [editingScreenshot, setEditingScreenshot] = React.useState<string | null>(null)
  const [summary, setSummary] = React.useState<SummaryFields>({
    generated: '',
    final: '',
    actual: '',
    expected: '',
    additional: '',
  })
  const [reviewError, setReviewError] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)
  const captureStep = React.useRef<string | undefined>(undefined)
  const [source, setSource] = React.useState<File | null>(null)
  const [theme, setTheme] = React.useState(false)
  const [fail, setFail] = React.useState(false)
  const [page, setPage] = React.useState('项目总览')
  const started = React.useRef(Date.now())
  const floating = useFloatingSurface('recording')
  const latest = React.useRef<RecordedStep>()
  const { toast } = useToast()
  React.useEffect(() => {
    const step = createInitialPageStep(started.current)
    latest.current = step
    setSteps([step])
  }, [])
  React.useEffect(() => {
    if (exited || paused || source || review || shutter.busy) return
    const lease = installRecorderProbe({
      startedAtMs: started.current,
      latestStep: () => latest.current,
      onStep: (step) => {
        latest.current = step
        setSteps((current) => [...current, step])
      },
      onRequest: () => undefined,
    })
    return () => {
      lease.dispose()
    }
  }, [exited, paused, source, review, shutter.busy])
  const capture = async (): Promise<void> => {
    const canvas = document.createElement('canvas')
    canvas.width = 1440
    canvas.height = 740
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#faf8f4'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#e8e8e8'
    ctx.fillRect(260, 0, 1, canvas.height)
    ctx.fillStyle = '#272727'
    ctx.font = '24px sans-serif'
    ctx.fillText('书深 / 项目工作台', 28, 45)
    ctx.fillText(page, 300, 65)
    ctx.font = '18px sans-serif'
    ctx.fillText('新任务', 28, 120)
    ctx.fillText('搜索', 28, 175)
    ctx.fillText('项目文件', 28, 230)
    ctx.fillText('从科研任务开始', 300, 145)
    ctx.fillText('选择一项能力，或直接描述任务。', 300, 190)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(300, 230, 1050, 430)
    ctx.fillStyle = '#4c4c4c'
    ctx.fillText('精准检索文献', 330, 280)
    ctx.fillText('撰写文献综述', 330, 350)
    ctx.fillText('生成科研想法', 330, 420)
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((value) => resolve(value!), 'image/png')
    )
    setEditingScreenshot(null)
    setSource(new File([blob], 'preview.png', { type: 'image/png' }))
  }
  return (
    <main className="min-h-screen bg-[var(--vds-bg-page)] p-[var(--vds-space-8)] text-[var(--vds-text-primary)]">
      <h1>问题反馈 · 交互验收</h1>
      <p>
        组件预览：点击下面的页面操作，观察右下角步骤更新。截图为示例图片，提交为模拟回执，不会上传后台。
      </p>
      <div
        data-feedback-recorder-root="preview-controls"
        className="flex flex-wrap gap-[var(--vds-space-2)]"
      >
        <Button
          variant="outline"
          onClick={() =>
            void localization.changeLanguage(localization.language === 'zh' ? 'en' : 'zh')
          }
        >
          中 / EN
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            setTheme(!theme)
            document.documentElement.dataset.theme = theme ? 'light' : 'dark'
          }}
        >
          切换主题
        </Button>
        <Button variant="outline" onClick={() => setFail(!fail)}>
          {fail ? '模拟提交失败' : '模拟提交成功'}
        </Button>
      </div>
      <section className="mt-[var(--vds-space-8)] flex flex-wrap gap-[var(--vds-space-3)]">
        {['项目总览', '新任务', '搜索文献', '项目文件', '文献库', '任务列表'].map((name) => (
          <Button key={name} variant="secondary" onClick={() => setPage(name)}>
            {name}
          </Button>
        ))}
      </section>
      <h2>{page}</h2>
      {!exited && !source && !review && (
        <div className="relative z-[var(--vds-z-feedback-recorder)]">
          <Capture
            capturing={shutter.busy}
            error=""
            floating={floating}
            hasStep={steps.length > 0}
            note={note}
            paused={paused}
            stepCount={steps.length}
            steps={steps}
            notes={notes}
            screenshots={screenshots}
            onCapture={() => {
              captureStep.current = latest.current?.stepId
              void shutter.run(capture)
            }}
            onNoteChange={(value) => {
              setNote(value)
              if (latest.current)
                setNotes((current) => ({ ...current, [latest.current!.stepId]: value }))
            }}
            onExit={() => {
              setExited(true)
              screenshots.forEach((image) => URL.revokeObjectURL(image.previewUrl))
              setScreenshots([])
              setNote('')
              setNotes({})
              latest.current = undefined
              setSteps([])
            }}
            onPauseChange={setPaused}
            onStop={() => setReview(true)}
          />
        </div>
      )}
      {shutter.active && <ScreenshotShutter />}
      {source && (
        <Annotator
          initialAnnotations={
            screenshots.find((item) => item.screenshotId === editingScreenshot)?.annotations ?? []
          }
          initialNote={editingScreenshot ? editingScreenshotNote : note}
          source={source}
          onCancel={() => setSource(null)}
          onSave={async (result) => {
            if (fail && !editingScreenshot) throw new Error('preview_failure')
            if (editingScreenshot) {
              const stepId = screenshots.find(
                (image) => image.screenshotId === editingScreenshot
              )?.stepId
              if (stepId) setNotes((current) => ({ ...current, [stepId]: result.note }))
            }
            const previewUrl = URL.createObjectURL(result.renderedFile)
            setScreenshots((current) =>
              editingScreenshot
                ? current.map((item) =>
                    item.screenshotId === editingScreenshot
                      ? { ...item, ...result, previewUrl }
                      : item
                  )
                : [
                    ...current,
                    {
                      ...result,
                      sourceFile: source,
                      previewUrl,
                      screenshotId: crypto.randomUUID(),
                      stepId: captureStep.current,
                    },
                  ]
            )
            setSource(null)
            if (!editingScreenshot) toast({ tone: 'success', description: <Saved /> })
          }}
        />
      )}
      {review && !source && (
        <Review
          page={reviewPage}
          onPageChange={setReviewPage}
          error={reviewError}
          warning=""
          hasSession={false}
          submitting={submitting}
          summary={summary}
          session={{
            sessionId: 'preview',
            startedAt: new Date(started.current).toISOString(),
            startedAtMs: started.current,
            initialPage: location.href,
            steps,
            notes,
            screenshots,
            requests: [],
            truncated: { steps: false, requests: false },
          }}
          onCancel={() => {
            setReview(false)
            setReviewError('')
          }}
          onSummaryChange={(field, value) =>
            setSummary((current) => ({ ...current, [field]: value }))
          }
          onNoteChange={(stepId, text) => setNotes((current) => ({ ...current, [stepId]: text }))}
          onDeleteScreenshot={(screenshotId) =>
            setScreenshots((current) =>
              current.filter((item) => item.screenshotId !== screenshotId)
            )
          }
          onEditScreenshot={(screenshotId, text) => {
            setEditingScreenshotNote(text)
            const image = screenshots.find((item) => item.screenshotId === screenshotId)!
            setEditingScreenshot(screenshotId)
            setSource(image.sourceFile)
          }}
          onSubmit={() => {
            setSubmitting(true)
            window.setTimeout(() => {
              setSubmitting(false)
              if (fail)
                setReviewError(localization.t('components:feedbackRecorder.note.submitFailed'))
              else {
                setReview(false)
                toast({
                  tone: 'success',
                  description: localization.t('components:feedback.received'),
                })
              }
            }, 400)
          }}
        />
      )}
      <Toaster />
    </main>
  )
}
createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <ToastProvider>
      <Preview />
    </ToastProvider>
  </I18nextProvider>
)
