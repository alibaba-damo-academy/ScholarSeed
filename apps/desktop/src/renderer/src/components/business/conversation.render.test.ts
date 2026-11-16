import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { renderFixture } from '../../../../test-helpers/render.ts'
import { WORKSPACE_WINDOW_MINIMUM, WORKSPACE_WINDOW_SIZE } from '../../../../window.ts'
import { SKILLS_PATH } from '../../../../skills.ts'

const ROOT = path.resolve(import.meta.dirname, '../..')
const FIXTURE = '/components/business/conversation.render.fixture.html'

for (const kind of ['authorization', 'generic']) {
  test(`cancelled ${kind} question keeps its real terminal state without success or submission`, async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    await page.goto(new URL(`${FIXTURE}?cancelledQuestion=${kind}`, fixture.url).href)
    await page.getByRole('button', { name: '短文献确认', exact: true }).click()
    const card = page.getByTestId('hil-card')
    await expect(card).toHaveAttribute('data-hil-state', 'cancelled')
    await expect(card).toContainText(kind === 'authorization' ? '全文授权已取消' : '已取消任务')
    await expect(card).not.toContainText('✓')
    await expect(card.getByRole('button', { name: /一键授权|确认授权|拒绝|提交/ })).toHaveCount(0)
  })
}

const PRESENTATION_SKILLS = [
  {
    name: 'precise-literature-search',
    display_names: { zh: '精确文献检索', en: 'Precise Literature Search' },
  },
  { name: 'literature-review', display_names: { zh: '文献综述', en: 'Literature Review' } },
]

test('sent mixed references keep skills before tasks and text after reopening and wrapping', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  for (const theme of ['', '&dark']) {
    const page = await fixture.page(context)
    await page.route(
      (url) => url.pathname === SKILLS_PATH,
      (route) => route.fulfill({ json: { skills: PRESENTATION_SKILLS } })
    )
    await page.goto(new URL(`${FIXTURE}?mixedReferences${theme}`, fixture.url).href)
    await page.getByRole('button', { name: '技能引用', exact: true }).click()
    const bubble = page.getByTestId('user-bubble')
    const labels = bubble.locator('[data-slot="sent-reference-attachment"]')
    const expected = [
      '精确文献检索',
      '文献综述',
      '自定义历史标题',
      'file原始文件标题',
      'Source task for mixed references',
    ]
    await expect(labels).toHaveText(expected)
    await expect(bubble).toHaveText(expected.join('') + '技能名称验收')
    await page.getByRole('button', { name: '切换新任务', exact: true }).click()
    await expect(bubble).toHaveCount(0)
    await page.getByRole('button', { name: '技能引用', exact: true }).click()
    await page.getByRole('button', { name: '重建消息流', exact: true }).click()
    await page.setViewportSize({
      width: WORKSPACE_WINDOW_MINIMUM.width,
      height: WORKSPACE_WINDOW_MINIMUM.height,
    })
    await expect(labels).toHaveText(expected)
    await expect(bubble).toHaveText(expected.join('') + '技能名称验收')
  }
})

test('sent PDF comment references keep readable labels after reopening', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.goto(new URL(`${FIXTURE}?pdfReferences`, fixture.url).href)
  const openConversation = page.getByRole('button', { name: '技能引用', exact: true })
  const references = page
    .getByTestId('sent-context-references')
    .locator('[data-slot="sent-reference-attachment"]')
  const comments = page.getByTestId('sent-pdf-comment')
  const expected = ['1 条注释PDF·第1页', '1 条注释PDF 评论']
  await openConversation.click()
  await expect(comments).toHaveText(expected)
  await expect(references).toHaveText('demo.pdf')
  await page.getByRole('button', { name: '切换新任务', exact: true }).click()
  await expect(references).toHaveCount(0)
  await openConversation.click()
  await page.getByRole('button', { name: '重建消息流', exact: true }).click()
  await expect(comments).toHaveText(expected)
})

test('sent skill references do not expose internal names while their catalog is unresolved', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  let releaseCatalog: () => void = () => undefined
  const catalogPending = new Promise<void>((resolve) => {
    releaseCatalog = resolve
  })
  context.after(async () => {
    releaseCatalog()
    await fixture.close()
  })
  const page = await fixture.page(context)
  let requests = 0
  await page.route(
    (url) => url.pathname === SKILLS_PATH,
    async (route) => {
      requests += 1
      await catalogPending
      await route.fulfill({ json: { skills: PRESENTATION_SKILLS } })
    }
  )
  await page.goto(new URL(FIXTURE, fixture.url).href)
  await page.getByRole('button', { name: '技能引用', exact: true }).click()
  await expect.poll(() => requests).toBeGreaterThan(0)
  const labels = page.getByTestId('user-bubble').locator('[data-slot="sent-reference-attachment"]')
  await expect(labels).toHaveCount(4)
  await expect(labels.first()).toHaveText('技能')
  await expect(labels.first()).not.toHaveText('precise-literature-search')
  await expect(labels.nth(1)).not.toHaveText('literature-review')
  await expect(labels.nth(2)).toHaveText('自定义历史标题')
  releaseCatalog()
  await expect(labels.first()).toHaveText('精确文献检索')
  await expect(labels.nth(2)).toHaveText('自定义历史标题')
})

test('sent skill references keep resolved names while reopening history and refreshing their catalog', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  let deferCatalog = false
  let releaseCatalog: () => void = () => undefined
  const catalogPending = new Promise<void>((resolve) => {
    releaseCatalog = resolve
  })
  context.after(async () => {
    releaseCatalog()
    await fixture.close()
  })
  const page = await fixture.page(context)
  await page.route(
    (url) => url.pathname === SKILLS_PATH,
    async (route) => {
      if (deferCatalog) await catalogPending
      await route.fulfill({ json: { skills: PRESENTATION_SKILLS } })
    }
  )
  await page.goto(new URL(FIXTURE, fixture.url).href)
  await page.getByRole('button', { name: '技能引用', exact: true }).click()
  const label = page
    .getByTestId('user-bubble')
    .locator('[data-slot="sent-reference-attachment"]')
    .first()
  await expect(label).toHaveText('精确文献检索')
  deferCatalog = true
  await page.getByRole('button', { name: '切换新任务', exact: true }).click()
  await expect(page.getByTestId('user-bubble')).toHaveCount(0)
  await page.getByRole('button', { name: '技能引用', exact: true }).click()
  await expect(label).toHaveText('精确文献检索')
  await page.getByRole('button', { name: '重建消息流', exact: true }).click()
  await expect(label).toHaveText('精确文献检索')
  await page.getByRole('button', { name: '更新技能目录', exact: true }).click()
  await expect(label).toHaveText('精确文献检索')
  await page.getByRole('button', { name: '切换界面语言', exact: true }).click()
  await expect(label).toHaveText('Precise Literature Search')
})

test('sent skill references isolate identity changes and reject the previous identity response', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  const releases: Array<() => void> = []
  context.after(async () => {
    for (const release of releases) release()
    await fixture.close()
  })
  const page = await fixture.page(context)
  let deferCatalog = false
  let deferredRequests = 0
  await page.route(
    (url) => url.pathname === SKILLS_PATH,
    async (route) => {
      let skills = PRESENTATION_SKILLS
      if (deferCatalog) {
        const request = deferredRequests++
        await new Promise<void>((resolve) => releases.push(resolve))
        skills = [
          {
            name: 'precise-literature-search',
            display_names: {
              zh: request === 0 ? '旧身份迟到名称' : '当前身份名称',
              en: 'Current name',
            },
          },
        ]
      }
      await route.fulfill({ json: { skills } })
    }
  )
  await page.goto(new URL(FIXTURE, fixture.url).href)
  await page.getByRole('button', { name: '技能引用', exact: true }).click()
  const label = page
    .getByTestId('user-bubble')
    .locator('[data-slot="sent-reference-attachment"]')
    .first()
  await expect(label).toHaveText('精确文献检索')
  await page.waitForLoadState('networkidle')
  deferCatalog = true
  await page.getByRole('button', { name: '更新技能目录', exact: true }).click()
  await expect.poll(() => deferredRequests).toBe(1)
  await expect(label).toHaveText('精确文献检索')
  await page.evaluate(() => window.dispatchEvent(new Event('scholarseed:auth-required')))
  await expect.poll(() => deferredRequests).toBe(2)
  await expect(label).toHaveText('技能')
  const staleResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === SKILLS_PATH
  )
  releases[0]()
  await (await staleResponse).finished()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  await expect(label).toHaveText('技能')
  releases[1]()
  await expect(label).toHaveText('当前身份名称')
  await expect(page.getByText('旧身份迟到名称', { exact: true })).toHaveCount(0)
})

test('sent skill references use catalog display names in both languages and preserve unknown titles', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  for (const language of ['zh', 'en', 'unavailable']) {
    const page = await fixture.page(context)
    await page.route(
      (url) => url.pathname === SKILLS_PATH,
      (route) =>
        route.fulfill(
          language === 'unavailable'
            ? { status: 503, json: { error: 'unavailable' } }
            : { json: { skills: PRESENTATION_SKILLS } }
        )
    )
    await page.goto(new URL(`${FIXTURE}${language === 'en' ? '?english' : ''}`, fixture.url).href)
    await page.getByRole('button', { name: '技能引用', exact: true }).click()
    await expect(
      page.getByTestId('user-bubble').locator('[data-slot="sent-reference-attachment"]')
    ).toHaveText([
      ...(language === 'zh'
        ? ['精确文献检索', '文献综述']
        : language === 'en'
          ? ['Precise Literature Search', 'Literature Review']
          : ['precise-literature-search', 'literature-review']),
      '自定义历史标题',
      'file原始文件标题',
    ])
  }
})

test('sent skill reference display ignores a stale language catalog response', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  let releaseChinese: () => void = () => undefined
  const chinesePending = new Promise<void>((resolve) => {
    releaseChinese = resolve
  })
  context.after(() => releaseChinese())
  await page.route(
    (url) => url.pathname === SKILLS_PATH,
    async (route) => {
      const chinese = new URL(route.request().url()).searchParams.get('locale') === 'zh'
      if (chinese) await chinesePending
      await route.fulfill({
        json: {
          skills: chinese
            ? [{ name: 'precise-literature-search', display_names: { en: 'Stale catalog label' } }]
            : PRESENTATION_SKILLS,
        },
      })
    }
  )
  await page.goto(new URL(FIXTURE, fixture.url).href)
  await page.getByRole('button', { name: '技能引用', exact: true }).click()
  await page.getByRole('button', { name: '切换界面语言', exact: true }).click()
  const labels = page.getByTestId('user-bubble').locator('[data-slot="sent-reference-attachment"]')
  await expect(labels.first()).toHaveText('Precise Literature Search')
  const staleResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === SKILLS_PATH && url.searchParams.get('locale') === 'zh'
  })
  releaseChinese()
  await (await staleResponse).finished()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  await expect(labels.first()).toHaveText('Precise Literature Search')
  await expect(page.getByText('Stale catalog label', { exact: true })).toHaveCount(0)
})

test('clarification supplement matches option spacing in plain and hosted questions', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  for (const query of ['', '?pluginQuestion', '?dark', '?pluginQuestion&dark']) {
    for (const width of [1100, 1440]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(new URL(`${FIXTURE}${query}`, fixture.url).href)
      await page.getByRole('button', { name: '等待确认', exact: true }).click()
      const supplement = page.getByTestId('hil-question-other-0')
      await expect(supplement).toBeEditable()
      await expect
        .poll(async () => {
          const options = page.getByTestId('hil-dock').getByRole('radio')
          const first = await options.nth(0).boundingBox()
          const last = await options.nth(1).boundingBox()
          const input = await supplement.boundingBox()
          assert.ok(first && last && input)
          const optionGap = last.y - first.y - first.height
          const supplementGap = input.y - last.y - last.height
          return Math.abs(supplementGap - optionGap)
        })
        .toBeLessThan(1)
      await supplement.fill('Additional research constraints')
      await expect(supplement).toHaveValue('Additional research constraints')
    }
  }
})

test('generated skill installation stays above the composer as agent logs scroll and grow', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  let status = 'pending'
  await page.route('**/api/capabilities/skills/plugins/delivery', async (route) => {
    if (route.request().postDataJSON().action === 'skip') status = 'skipped'
    await route.fulfill({ json: { status } })
  })
  await page.goto(new URL(FIXTURE, fixture.url).href)
  await page.getByRole('button', { name: '技能安装', exact: true }).click()

  const stream = page.locator('.conversation-stream')
  const card = page.getByTestId('plugin-installation-card')
  const composer = page.getByRole('textbox', { name: '消息' })
  await expect(card.getByRole('button', { name: '安装到书深' })).toBeEnabled()
  await expect(stream.getByTestId('plugin-installation-card')).toHaveCount(0)
  await expect(composer).toBeEditable()
  const dockedBounds = await card.boundingBox()
  assert.ok(dockedBounds)
  assert.ok(dockedBounds.y + dockedBounds.height <= (await composer.boundingBox())!.y)

  await stream.hover()
  await page.mouse.wheel(0, -10000)
  await expect.poll(() => stream.evaluate((element) => element.scrollTop)).toBe(0)
  await page.getByRole('button', { name: '追加日志', exact: true }).click()
  await expect(stream.getByText('安装后日志', { exact: true })).toHaveCount(1)
  await expect.poll(() => card.boundingBox()).toEqual(dockedBounds)
  await expect(card).toHaveCount(1)

  await card.getByRole('button', { name: '暂不安装' }).click()
  const receipt = stream.getByTestId('plugin-installation-card')
  await expect(receipt.getByRole('status')).toHaveText('已跳过安装')
  await expect(card).toHaveCount(1)
})

test('plan confirmation renders structured settings alongside the existing reply controls', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  const submitted: unknown[] = []
  await page.route('**/api/serve/sessions/*/hil/fulltext-confirmation', async (route) => {
    const body = route.request().postDataJSON()
    submitted.push(body)
    await route.fulfill({
      json: { ok: true, interaction: { answer_details: body.answer_details } },
    })
  })
  await page.goto(new URL(`${FIXTURE}?structuredPlan`, fixture.url).href)
  await page.getByRole('button', { name: '等待确认', exact: true }).click()
  const fields = page.getByTestId('hil-question-fields')
  await expect(fields.getByRole('heading', { name: '综述执行方案' })).toBeVisible()
  await expect(fields.locator('dt')).toHaveText(['交付格式', '发表区间'])
  await expect(fields.locator('dd')).toHaveText(['Markdown', '2023–2026'])
  await expect(fields.locator('dd').first()).toHaveCSS('font-size', '12px')
  await expect(fields.locator('dd').first()).toHaveCSS('font-weight', '400')
  await expect(fields).toContainText('五分钟未回复将按已展示方案执行。')
  await expect(page.getByText('旧客户端使用的完整方案文本', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('hil-question-other-0')).toBeEditable()
  await expect(page.getByRole('radio', { name: '按此方案执行' })).toBeChecked()
  assert.deepEqual(submitted, [])
  await expect(page.getByTestId('hil-question-confirm')).toBeEnabled()
  await page.getByTestId('hil-question-other-0').fill('补充第一行\n补充第二行')
  await page.getByTestId('hil-question-confirm').click()
  await expect
    .poll(() => submitted)
    .toEqual([
      {
        answers: { 'plan-review:fixture': '按此方案执行\n补充第一行\n补充第二行' },
        answer_details: {
          'plan-review:fixture': { option_indices: [0], text: '补充第一行\n补充第二行' },
        },
      },
    ])
  const summary = page.getByRole('button', { name: '明确研究关键问题，用户已确认', exact: true })
  await expect(summary).toHaveCount(2)
  await summary.last().click()
  const reply = page.locator(
    '[data-interaction-request-id="fulltext-confirmation"][data-testid="interaction-reply"]'
  )
  await expect(reply.getByRole('heading', { name: '综述执行方案' })).toBeVisible()
  await expect(reply.getByRole('radio', { name: '按此方案执行' })).toBeChecked()
  await expect(reply.getByRole('radio', { name: '按此方案执行' })).toBeDisabled()
  await expect(reply.getByRole('textbox')).toHaveValue('补充第一行\n补充第二行')
  await expect(reply.getByRole('textbox')).not.toBeEditable()
  await expect(reply.getByRole('button')).toHaveCount(1)
  await expect(reply.getByTestId('interaction-reply-copy')).toBeEnabled()
})

test('attachment-only turns show the file without an empty user message bubble', async (context) => {
  const fixture = await renderFixture(ROOT)
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.goto(new URL(`${FIXTURE}?attachmentOnly`, fixture.url).href)
  await page.getByRole('button', { name: '短文献确认', exact: true }).click()
  const attachmentTurn = page.locator('[class~="group/message"]').filter({
    has: page.getByTestId('sent-context-layer-files'),
  })
  await expect(
    attachmentTurn.getByRole('button', { name: 'report.docx', exact: true })
  ).toBeVisible()
  await expect(attachmentTurn.getByTestId('user-bubble')).toHaveCount(0)
  await expect(page.getByTestId('user-bubble').first()).toContainText('历史消息 1')
})

test('scroll shortcut disappears when the conversation fits after a container resize while following is paused', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.goto(new URL(FIXTURE, fixture.url).href)
  await page.getByRole('button', { name: '短文献确认', exact: true }).click()
  const stream = page.locator('.conversation-stream')
  await stream.hover()
  await page.mouse.wheel(0, -10000)
  await expect.poll(() => stream.evaluate((element) => element.scrollTop)).toBe(0)
  await expect(page.getByTestId('scroll-to-bottom')).toBeVisible()
  await page.getByTestId('conversation-layout').evaluate((element) => {
    element.parentElement!.style.height = '10000px'
  })
  await expect
    .poll(() => stream.evaluate((element) => element.scrollHeight - element.clientHeight))
    .toBe(0)
  await expect(page.getByTestId('scroll-to-bottom')).toHaveCount(0)
  await page.getByTestId('conversation-layout').evaluate((element) => {
    element.parentElement!.style.height = ''
  })
  await expect(page.getByTestId('scroll-to-bottom')).toBeVisible()
  await page.getByTestId('scroll-to-bottom').click()
  await expect(page.getByTestId('scroll-to-bottom')).toHaveCount(0)
})

test('focused running history recalculates its spacer on resize without resuming reading', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.setViewportSize({ width: WORKSPACE_WINDOW_SIZE.width, height: 1055 })
  await page.goto(new URL(`${FIXTURE}?geometry`, fixture.url).href)
  await page.getByRole('button', { name: '组合历史', exact: true }).click()
  const stream = page.locator('.conversation-stream')
  const geometry = () =>
    stream.evaluate((viewport) => {
      const bounds = viewport.getBoundingClientRect()
      const content = viewport.querySelector('[data-testid="conversation-content"]')!
      const spacer = content.lastElementChild!
      const visible = [
        ...content.querySelectorAll<HTMLElement>(
          '[data-message-kind="user"], [data-message-kind="agent"]'
        ),
      ].filter((anchor) => {
        const element =
          getComputedStyle(anchor).display === 'contents' ? anchor.firstElementChild! : anchor
        const message = element.getBoundingClientRect()
        return message.bottom > bounds.top && message.top < bounds.bottom
      }).length
      return {
        top: viewport.scrollTop,
        client: viewport.clientHeight,
        spacer: spacer.getBoundingClientRect().height,
        visible,
      }
    })
  await expect.poll(async () => (await geometry()).visible).toBeGreaterThan(0)
  await page.setViewportSize(WORKSPACE_WINDOW_MINIMUM)
  await stream.hover({ position: { x: 100, y: 100 } })
  await page.mouse.wheel(0, 300)
  await expect.poll(async () => (await geometry()).visible).toBeGreaterThan(0)
  assert.equal((await geometry()).spacer, 0)
  await page.setViewportSize({ width: WORKSPACE_WINDOW_SIZE.width, height: 1055 })
  await page.getByRole('button', { name: '聚焦末条', exact: true }).click()
  await expect.poll(async () => (await geometry()).spacer).toBeGreaterThan(0)
  const focusTop = (await geometry()).top
  await page.getByRole('button', { name: '新增运行工具', exact: true }).click()
  await page.getByRole('button', { name: '新增结果卡', exact: true }).click()
  await expect(page.getByText('Public geometry result', { exact: true })).toBeVisible()
  await expect.poll(async () => (await geometry()).top).toBe(focusTop)
  await page.setViewportSize({ width: 1920, height: WORKSPACE_WINDOW_MINIMUM.height })
  await expect
    .poll(async () => {
      const current = await geometry()
      return current.spacer < current.client
    })
    .toBe(true)
  assert.equal((await geometry()).top, focusTop)
  await stream.hover({ position: { x: 100, y: 100 } })
  await page.mouse.wheel(0, 300)
  await expect.poll(async () => (await geometry()).top).not.toBe(focusTop)
  await expect.poll(async () => (await geometry()).visible).toBeGreaterThan(0)
  await page.getByRole('button', { name: '切换新任务', exact: true }).click()
  await page.getByRole('button', { name: '组合历史', exact: true }).click()
  await expect.poll(async () => (await geometry()).spacer).toBe(0)
  await expect.poll(async () => (await geometry()).visible).toBeGreaterThan(0)
  await stream.hover({ position: { x: 100, y: 100 } })
  await page.mouse.wheel(0, -1200)
  await expect.poll(async () => (await geometry()).top).toBeLessThan(focusTop - 1200)
  const readingTop = (await geometry()).top
  await page.getByRole('button', { name: '新增运行工具', exact: true }).click()
  assert.equal((await geometry()).top, readingTop)
  await page.getByTestId('conversation-layout').evaluate((element) => {
    element.style.width = '360px'
  })
  await page.getByRole('button', { name: '聚焦末条', exact: true }).click()
  await expect.poll(async () => (await geometry()).spacer).toBeGreaterThan(0)
  await page.getByTestId('conversation-layout').evaluate((element) => {
    element.style.width = ''
  })
  await expect.poll(async () => (await geometry()).visible).toBeGreaterThan(0)
})

test('scroll shortcut follows the execution steps and moves above composer obstructions', async (context) => {
  const fixture = await renderFixture(ROOT)
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.goto(new URL(`${FIXTURE}?scrollControl`, fixture.url).href)
  await page.getByRole('button', { name: '滚动历史', exact: true }).click()
  const stream = page.locator('.conversation-stream')
  await stream.hover()
  await page.mouse.wheel(0, -10000)
  const shortcut = page.getByTestId('scroll-to-bottom')
  const plan = page.getByTestId('todo-toggle')
  await expect(shortcut).toHaveCSS('border-top-left-radius', '12px')
  const geometry = async () => {
    const arrow = (await shortcut.boundingBox())!
    const steps = (await plan.boundingBox())!
    const row = (await plan.locator('..').boundingBox())!
    return {
      rightAligned: Math.abs(arrow.x + arrow.width - row.x - row.width) < 1,
      centered: Math.abs(arrow.x + arrow.width / 2 - row.x - row.width / 2) < 1,
      sameRow: arrow.y === steps.y,
      square: arrow.width === steps.height && arrow.height === steps.height,
    }
  }
  await expect.poll(geometry).toMatchObject({ centered: true, sameRow: true, square: true })
  await plan.locator('..').evaluate(
    (row, width) => {
      row.style.width = `${width}px`
    },
    (await plan.boundingBox())!.width + 64
  )
  await expect.poll(geometry).toMatchObject({ rightAligned: true, sameRow: true, square: true })
  await expect(stream).toHaveCSS('mask-image', /linear-gradient/)
  await expect
    .poll(async () => {
      const streamBox = (await stream.boundingBox())!
      const steps = (await plan.boundingBox())!
      return streamBox.y + streamBox.height >= steps.y + steps.height
    })
    .toBe(true)

  for (const testId of ['hil-dock', 'composer-message-queue']) {
    await plan.locator('..').evaluate((row, id) => {
      const obstruction = document.createElement('div')
      obstruction.dataset.testid = id
      obstruction.style.height = '96px'
      row.before(obstruction)
    }, testId)
    const obstruction = page.getByTestId(testId)
    await expect
      .poll(async () => {
        const arrow = (await shortcut.boundingBox())!
        const card = (await obstruction.boundingBox())!
        return arrow.y + arrow.height <= card.y
      })
      .toBe(true)
    await obstruction.evaluate((element) => element.remove())
    await expect.poll(geometry).toMatchObject({ rightAligned: true, sameRow: true })
  }
  await shortcut.click()
  await expect(shortcut).toHaveCount(0)
})

test('tool details hide previews, retain batch timing, reveal the caret on hover and fade only overflowing edges', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.goto(new URL(FIXTURE, fixture.url).href)
  await page.getByRole('button', { name: '分段执行', exact: true }).click()
  const batch = page.getByTestId('turn-activity-trigger').first()
  if ((await batch.getAttribute('aria-expanded')) === 'false') await batch.click()
  await expect(batch).toContainText('用时0 分 1 秒')
  const warning = batch.getByTestId('tool-batch-warning')
  await expect(warning).toHaveAttribute('aria-label', '1 个工具步骤失败，请查看执行记录确认影响。')
  await expect(warning.locator('svg')).toHaveCSS('width', '12px')
  await expect(warning.locator('svg')).toHaveCSS('color', 'rgb(185, 86, 0)')
  await expect(
    page.getByTestId('turn-activity-trigger').last().getByTestId('tool-batch-warning')
  ).toHaveCount(0)
  await expect(
    page.getByTestId('thinking-activity-step').locator(':scope > button')
  ).not.toContainText('隐藏的思考详情')
  await expect(page.getByText('工具外说明', { exact: true })).toHaveCSS('font-size', '14px')
  await expect(page.getByText('工具外说明', { exact: true })).toHaveCSS('color', 'rgb(39, 39, 39)')
  const tool = page.getByTestId('tool-run-step').first()
  const trigger = tool.locator(':scope > button')
  await expect(trigger).toHaveCSS('height', '28px')
  await expect(trigger).toHaveCSS('padding-top', '2px')
  await expect(trigger).toHaveCSS('padding-bottom', '2px')
  await expect(trigger).toHaveCSS('border-top-left-radius', '8px')
  await expect(trigger).not.toContainText('cat research.md')
  await expect(tool.getByTestId('tool-run-step-duration')).toHaveCount(0)
  const caret = trigger.locator(':scope > span').last()
  await page.mouse.move(0, 0)
  await expect(caret).toHaveCSS('opacity', '0')
  await trigger.hover()
  await expect(caret).toHaveCSS('opacity', '1')
  await trigger.click()
  const cards = tool.getByTestId('execution-io')
  const short = cards.first().locator('.vds-scroll-area')
  const long = cards.last().locator('.vds-scroll-area')
  await expect(short).toHaveAttribute('data-fade-bottom', 'false')
  await expect(long).toHaveAttribute('data-fade-top', 'false')
  await expect(long).toHaveAttribute('data-fade-bottom', 'true')
  const edge = await long.evaluate((e) => ({
    border: getComputedStyle(e.parentElement!).borderTopWidth,
    fadeTop: getComputedStyle(e, '::before').top,
    offset: e.getBoundingClientRect().top - e.parentElement!.getBoundingClientRect().top,
  }))
  assert.equal(edge.border, '1px')
  assert.equal(edge.fadeTop, '0px')
  assert.equal(edge.offset, 1)
  const viewport = long.locator('.vds-scroll-area__viewport')
  await viewport.hover()
  await page.mouse.wheel(0, 120)
  await expect(long).toHaveAttribute('data-fade-top', 'true')
  await expect(long).toHaveAttribute('data-fade-bottom', 'true')
  await long.getByRole('scrollbar').focus()
  await page.keyboard.press('End')
  await expect(long).toHaveAttribute('data-fade-bottom', 'false')
  for (const text of [cards.first().locator('pre'), cards.last().locator('pre')]) {
    await expect(text).toHaveCSS('font-weight', '400')
    const colors = await text.evaluate((e) => ({
      actual: getComputedStyle(e).color,
      token: getComputedStyle(e).getPropertyValue('--vds-text-tertiary').trim(),
    }))
    assert.ok(colors.actual && colors.token)
  }
  await page.getByRole('button', { name: '执行完成', exact: true }).click()
  await expect(page.getByTestId('turn-process-trigger')).toHaveText('已完成 用时 2 分 5 秒')
  const durations = page.getByTestId('turn-process-trigger')
  await expect(durations.first()).toBeVisible()
  const typography = await durations.evaluateAll((elements) => {
    const probe = document.createElement('span')
    probe.style.fontFamily = 'var(--vds-font-main)'
    document.body.append(probe)
    const expectedFamily = getComputedStyle(probe).fontFamily
    probe.remove()
    return {
      expectedFamily,
      actual: elements.map((element) => {
        const style = getComputedStyle(element)
        return { family: style.fontFamily, numbers: style.fontVariantNumeric }
      }),
    }
  })
  assert.ok(typography.expectedFamily)
  assert.doesNotMatch(typography.expectedFamily, /monospace/i)
  assert.ok(typography.actual.length > 0)
  for (const style of typography.actual) {
    assert.equal(style.family, typography.expectedFamily)
    assert.equal(style.numbers, 'normal')
  }
  await expect(page.getByTestId('turn-process').first()).toHaveCSS('margin-bottom', '12px')
})

test(
  'web retrieval matches keyword and result title colors',
  { timeout: 120_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    for (const theme of ['', '&dark']) {
      await page.goto(new URL(`${FIXTURE}?retrieval${theme}`, fixture.url).href)
      const record = page.getByTestId('web-search-step')
      const resultTitle = record.getByTestId('web-search-results').getByRole('button').first()
      await expect(record.locator('li span').first()).toHaveCSS(
        'color',
        await resultTitle.evaluate((element) => getComputedStyle(element).color)
      )
    }
  }
)

test(
  'web retrieval shows compact results immediately and keeps error feedback',
  { timeout: 120_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    for (const theme of ['', '&dark']) {
      await page.goto(new URL(`${FIXTURE}?retrieval${theme}`, fixture.url).href)
      const record = page.getByTestId('web-search-step')
      const query = record.locator('li').first()
      await expect(query).toHaveCSS('height', '24px')
      await expect(query).toHaveCSS('padding', '4px 8px')
      await expect(query).toHaveCSS('gap', '4px')
      await expect(query).toHaveCSS('font-size', '10px')
      await expect(query.locator('svg')).toHaveCSS(
        'color',
        theme ? 'rgb(109, 109, 109)' : 'rgb(162, 162, 162)'
      )
      await expect(record).toHaveCSS('border-radius', '12px')
      await expect(record).toHaveCSS('border-top-width', '1px')
      const trigger = page.getByRole('button', { name: '网页检索', exact: true })
      const summary = record.getByTestId('web-search-summary')
      await expect(summary).toHaveText('搜索了 2 个关键词，16 个网页结果')
      await expect(summary).not.toHaveAttribute('aria-expanded')
      await trigger.click()
      await expect(record).toBeHidden()
      await expect(trigger).toHaveAttribute('aria-expanded', 'false')
      await trigger.focus()
      await page.keyboard.press('Enter')
      await expect(query).toBeVisible()
      await expect(trigger).toHaveAttribute('aria-expanded', 'true')
      await expect(summary).toHaveCSS('font-weight', '400')
      const toggle = record.getByRole('button', { name: '+其他 13 个', exact: true })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(record.locator('[data-testid=web-search-results] > div')).toHaveCount(3)
      await toggle.focus()
      await page.keyboard.press('Enter')
      const collapse = record.getByRole('button', { name: '收起', exact: true })
      await expect(collapse).toHaveAttribute('aria-expanded', 'true')
      await expect(query).toBeVisible()
      await expect(query).toHaveCSS(
        'background-color',
        theme ? 'rgba(255, 255, 255, 0.04)' : 'rgba(103, 73, 15, 0.04)'
      )
      await expect(record.locator('[data-testid=web-search-results] > div')).toHaveCount(16)
      const fades = record.locator('[data-fade-bottom]')
      await expect(fades).toHaveAttribute('data-fade-bottom', 'true')
      const scrollbar = record.getByRole('scrollbar', { name: '搜索了 2 个关键词，16 个网页结果' })
      await page.mouse.move(0, 0)
      await expect(scrollbar).toHaveCSS('opacity', '0')
      await query.hover()
      await expect(scrollbar).toHaveCSS('opacity', '1')
      const rightEdge = (element: Element) => element.getBoundingClientRect().right
      assert.equal(await scrollbar.evaluate(rightEdge), (await record.evaluate(rightEdge)) - 1)
      await page.mouse.move(0, 0)
      await scrollbar.focus()
      await page.keyboard.press('End')
      await expect(scrollbar).toHaveCSS('opacity', '1')
      await expect(fades).toHaveAttribute('data-fade-bottom', 'false')
      await record
        .getByRole('button', {
          name: 'Experimental evidence on the productivity effects of generative artificial intelligence.pdf',
          exact: true,
        })
        .first()
        .click()
      await expect(record.getByRole('alert')).toBeVisible()
      await collapse.click()
      await expect(record.locator('[data-testid=web-search-results] > div')).toHaveCount(3)
      await expect(toggle).toBeVisible()
      await expect(summary).toHaveText('搜索了 2 个关键词，16 个网页结果')
    }
  }
)

test(
  'project source links retain complete names, file icons and independent navigation',
  { timeout: 120_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    for (const theme of ['', '&dark']) {
      await page.goto(new URL(`${FIXTURE}?project-source${theme}`, fixture.url).href)
      const links = page.getByTestId('project-source-link')
      await expect(links).toHaveCount(2)
      const first = links.first()
      const name = 'TH167-甲-完整的原始无页码文本与复核记录-长文件名.txt'
      await expect(first).toHaveAccessibleName(name)
      assert.equal(
        await first.evaluate((element) => getComputedStyle(element).display.endsWith('flex')),
        true
      )
      assert.equal(
        await first.evaluate(
          (element) =>
            element.getBoundingClientRect().width <=
            element.parentElement!.getBoundingClientRect().width
        ),
        true
      )
      await expect(first.locator('[data-citation-icon]')).toBeVisible()
      await first.hover()
      await expect(page.getByRole('tooltip')).toHaveText(name)
      await first.focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('body')).toHaveAttribute('data-opened-source', 'first')
      await links.last().click()
      await expect(page.locator('body')).toHaveAttribute('data-opened-source', 'second')
      assert.equal(
        await first.evaluate((element) => element.scrollWidth <= element.clientWidth),
        true
      )
      await expect(links).not.toContainText(['+1', '+1'])
    }
  }
)

test(
  'web retrieval only offers expansion when results exceed the preview',
  { timeout: 120_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    for (const count of [0, 3, 4]) {
      await page.goto(new URL(`${FIXTURE}?retrieval&resultCount=${count}`, fixture.url).href)
      const record = page.getByTestId('web-search-step')
      const rows = record.locator('[data-testid=web-search-results] > div')
      await expect(rows).toHaveCount(Math.min(count, 3))
      if (count <= 3) {
        await expect(record.locator('[aria-expanded]')).toHaveCount(0)
      } else {
        const toggle = record.getByRole('button', { name: '+其他 1 个', exact: true })
        const resultsId = await toggle.getAttribute('aria-controls')
        assert.equal(resultsId, await record.getByTestId('web-search-results').getAttribute('id'))
        await toggle.click()
        await expect(rows).toHaveCount(count)
        await record.getByRole('button', { name: '收起', exact: true }).click()
        await expect(rows).toHaveCount(3)
      }
    }
  }
)

test(
  'segmented execution keeps one turn status through confirmation and terminal states',
  { timeout: 120_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    await page.goto(new URL(FIXTURE, fixture.url).href, { timeout: 60_000 })
    await page.getByRole('button', { name: '分段执行', exact: true }).click()
    const processes = page.getByTestId('turn-process')
    const triggers = processes.getByTestId('turn-process-trigger')
    await expect(processes).toHaveCount(1)
    await expect(triggers).toHaveCount(0)
    await expect(processes.locator('[data-testid=turn-activity-trigger]').first()).toBeVisible()
    const liveGroup = page.getByTestId('turn-activity-trigger').last()
    await expect(liveGroup).toContainText(/\d+ 分 \d+ 秒/)
    await expect(liveGroup).not.toContainText('·')
    const toolRecord = page.getByTestId('turn-activity-trigger').first()
    await expect(toolRecord).toBeVisible()
    const expanded = await toolRecord.getAttribute('aria-expanded')
    await toolRecord.focus()
    await page.keyboard.press('Enter')
    await expect(toolRecord).toHaveAttribute(
      'aria-expanded',
      expanded === 'true' ? 'false' : 'true'
    )
    await page.keyboard.press('Space')
    await expect(toolRecord).toHaveAttribute('aria-expanded', expanded ?? 'false')
    await page.getByRole('button', { name: '等待确认', exact: true }).click()
    await expect(triggers).toHaveCount(0)
    await expect(page.getByTestId('hil-card')).toBeVisible()
    await expect(page.getByTestId('hil-card')).toContainText('是否读取？')
    await page.getByRole('button', { name: '分段执行', exact: true }).click()
    await expect(triggers).toHaveCount(0)
    await page.getByRole('button', { name: '执行完成', exact: true }).click()
    await expect(triggers).toHaveText(['已完成 用时 2 分 5 秒'])
    await page.getByRole('button', { name: '执行失败', exact: true }).click()
    await expect(triggers).toHaveText(['失败 用时 2 分 5 秒'])
    await page.getByRole('button', { name: '执行中断', exact: true }).click()
    await expect(triggers).toHaveText(['已中断 用时 2 分 5 秒'])
    await page.getByRole('button', { name: '结果未知', exact: true }).click()
    await expect(triggers).toHaveText(['结果待确认 用时 2 分 5 秒'])
    await page.getByRole('button', { name: '历史加载', exact: true }).click()
    await expect(triggers).toHaveText(['结果待确认'])
    await page.getByRole('button', { name: '执行完成', exact: true }).click()
    await expect(triggers).toHaveText(['已完成 用时 2 分 5 秒'])
    await triggers.click()
    await expect(
      page.getByRole('img', { name: '1 个工具步骤失败，请查看执行记录确认影响。' })
    ).toBeVisible()
    await toolRecord.click()
    await page
      .getByRole('button', { name: 'Command 失败 · 此工具步骤未成功完成。', exact: true })
      .click()
    await page.getByRole('button', { name: '技术详情', exact: true }).click()
    await expect(page.getByText('Failed command', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '无计划工具间隙', exact: true }).click()
    await expect(processes).toHaveCount(1)
    await expect(triggers).toHaveCount(0)
    await expect(page.getByText('准备完成', { exact: true })).toBeVisible()
    await expect(page.getByTestId('assistant-working')).toBeVisible()
    await expect(page.getByTestId('turn-activity-trigger')).toContainText('执行工具 1 次')
  }
)

test('batch timing retains its own wall clock, disclosure metadata and empty history boundaries', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  for (const [timing, duration] of [
    ['parallel', '1 分 0 秒'],
    ['serial', '1 分 30 秒'],
    ['missing', null],
  ] as const) {
    await page.goto(new URL(`${FIXTURE}?batchTiming=${timing}`, fixture.url).href)
    await page.getByRole('button', { name: '执行完成', exact: true }).click()
    await page.getByTestId('turn-process-trigger').click()
    const batch = page.getByTestId('turn-activity-trigger').first()
    if (duration) {
      await expect(batch).toContainText(`用时${duration}`)
      await expect(batch).toHaveAttribute('aria-label', `执行工具 2 次，用时${duration}`)
      await expect(batch).toHaveAttribute('title', new RegExp(`用时${duration}$`))
      await batch.click()
      await page.getByTestId('tool-run-step').first().locator(':scope > button').click()
      await batch.click()
      await expect(batch).toContainText(`用时${duration}`)
    } else {
      await expect(batch).not.toContainText('用时')
      await expect(batch).toHaveAttribute('aria-label', '执行工具 2 次')
    }
    await expect(page.getByTestId('turn-activity-trigger').nth(1)).not.toContainText('用时')
    await page.getByRole('button', { name: '重建消息流', exact: true }).click()
    await page.getByTestId('turn-process-trigger').click()
    if (duration)
      await expect(page.getByTestId('turn-activity-trigger').first()).toContainText(duration)
    else await expect(page.getByTestId('turn-activity-trigger').first()).not.toContainText('用时')
  }
})

test('batch timing freezes settled groups and preserves terminal failure and interruption labels', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.clock.setFixedTime(130000)
  await page.goto(new URL(`${FIXTURE}?batchTiming=parallel`, fixture.url).href)
  await page.getByRole('button', { name: '分段执行', exact: true }).click()
  const batches = page.getByTestId('turn-activity-trigger')
  await expect(batches.first()).toContainText('用时1 分 0 秒')
  await expect(batches.last()).toContainText('0 分 39 秒')
  await page.clock.setFixedTime(135000)
  await expect(batches.first()).toContainText('用时1 分 0 秒')
  await expect(batches.last()).toContainText('0 分 44 秒')
  let now = 135000
  for (const [action, state] of [
    ['执行完成', ''],
    ['执行失败', '失败'],
    ['执行中断', '已取消'],
    ['结果未知', '失败'],
  ]) {
    await page.getByRole('button', { name: action, exact: true }).click()
    await page.getByTestId('turn-process-trigger').click()
    await expect(batches.last()).toContainText('用时0 分 10 秒')
    if (state) await expect(batches.last()).toContainText(state)
    const label = await batches.last().textContent()
    now += 5000
    await page.clock.setFixedTime(now)
    await expect(batches.last()).toHaveText(label!)
    await expect(batches.first()).toContainText('用时1 分 0 秒')
  }
})

test(
  'pending tool permission uses the shared authorization card without losing scope actions',
  { timeout: 60_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    await page.goto(new URL(FIXTURE, fixture.url).href)
    await page.getByRole('button', { name: '权限确认', exact: true }).click()
    const dock = page.getByTestId('hil-card')
    const card = dock.getByRole('group', { name: '书深请求命令执行权限', exact: true })
    await expect(card).toBeVisible()
    await expect(dock).toBeFocused()
    await expect(card.getByRole('button', { name: '拒绝', exact: true })).toHaveClass(
      /vds-button--tertiary/
    )
    await expect(card.locator('svg.lucide-triangle-alert')).toBeVisible()
    await expect(card).toContainText('当前操作已暂停，')
    await expect(card.getByText(/当前操作已暂停/)).toHaveCSS('font-weight', '400')
    await expect(card.locator('dt')).toHaveText(['操作', '授权范围', '命令详情'])
    await expect(card.locator('dd [data-slot="ellipsis-text"]')).toHaveCount(3)
    for (const detail of await card.locator('dt, dd [data-slot="ellipsis-text"]').all()) {
      await expect(detail).toHaveCSS('font-weight', '400')
    }
    for (const text of await card.locator('[data-slot="ellipsis-text"]').all()) {
      await expect(text).toHaveCSS('white-space', 'nowrap')
      await expect(text).toHaveCSS('text-overflow', 'ellipsis')
    }
    await expect(card.getByRole('button', { name: '命令详情', exact: true })).toHaveCount(0)
    await expect(card.getByRole('button', { name: '允许一次', exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: '拒绝', exact: true })).toBeVisible()
    await expect(card.getByTestId('hil-permission-acceptForSession')).toBeVisible()
    await expect(card).toContainText('仅本次命令执行；不是仅限文件路径的授权')
    await expect(card.getByTestId('hil-command-details')).toBeVisible()
    await expect(card.getByTestId('hil-command-details')).toHaveText('echo authorization-preview')
    await expect(card.locator('svg.lucide-triangle-alert')).toBeVisible()
  }
)

test(
  'file recovery uses the shared high-risk confirmation without changing its actions',
  {
    timeout: 60_000,
  },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    await page.setViewportSize({ width: 360, height: 900 })
    const submitted: unknown[] = []
    await page.route('**/api/serve/sessions/*/hil/*', async (route) => {
      submitted.push(route.request().postDataJSON())
      await route.fulfill({ json: { ok: true } })
    })
    await page.goto(new URL(FIXTURE, fixture.url).href)
    for (const scenario of [
      {
        trigger: '文件无法读取',
        title: 'resources/broken.pdf 无法读取',
        primary: '重试',
        secondary: '移除这个文件',
        answer: 'remove_file',
      },
      {
        trigger: '没有文件夹权限',
        title: '书深没有「组会材料」文件夹的写入权限',
        primary: '去授权',
        secondary: '取消',
        answer: 'cancel_save',
      },
    ]) {
      await page.getByRole('button', { name: scenario.trigger, exact: true }).click()
      const dock = page.getByTestId('hil-card')
      const card = dock.getByRole('group', { name: scenario.title, exact: true })
      await expect(card).toBeVisible()
      await expect(card.locator('svg.lucide-triangle-alert')).toBeVisible()
      await expect(
        card.getByRole('button', { name: scenario.primary, exact: true })
      ).toHaveAttribute('data-testid', 'hil-question-option-0-0')
      await expect(
        card.getByRole('button', { name: scenario.secondary, exact: true })
      ).toHaveAttribute('data-testid', 'hil-question-option-0-1')
      const primary = await card
        .getByRole('button', { name: scenario.primary, exact: true })
        .boundingBox()
      const secondary = await card
        .getByRole('button', { name: scenario.secondary, exact: true })
        .boundingBox()
      assert.ok(primary && secondary)
      assert.equal(primary.width, secondary.width)
      assert.ok(primary.y >= secondary.y + secondary.height)
      if (scenario.answer === 'cancel_save') {
        await card.getByRole('button', { name: scenario.primary, exact: true }).click()
        await expect(card.getByRole('alert')).toContainText('无法打开系统权限设置')
        assert.equal(submitted.length, 1)
      }
      await card.getByRole('button', { name: scenario.secondary, exact: true }).click()
      await expect(dock).toHaveCount(0)
      assert.deepEqual(submitted.at(-1), {
        answers: { 'file-recovery:fixture': scenario.answer },
      })
    }
  }
)

test(
  'narrow English literature authorization stacks full-width actions and restores the wide layout',
  { timeout: 60_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    await page.setViewportSize({ width: 360, height: 900 })
    await page.goto(new URL(`${FIXTURE}?english`, fixture.url).href)
    await page.getByRole('button', { name: '长文献确认', exact: true }).click()
    const card = page.getByRole('group', { name: 'Request literature access', exact: true })
    const deny = card.getByRole('button', { name: 'Deny', exact: true })
    const allow = card.getByRole('button', { name: 'Confirm authorization', exact: true })
    await expect(allow).toBeVisible()
    const denyBounds = await deny.boundingBox()
    const allowBounds = await allow.boundingBox()
    assert.ok(denyBounds && allowBounds)
    assert.equal(denyBounds.x, allowBounds.x)
    assert.equal(denyBounds.width, allowBounds.width)
    assert.ok(allowBounds.y >= denyBounds.y + denyBounds.height)
    assert.equal(
      await card.evaluate((element) => element.scrollWidth),
      await card.evaluate((element) => element.clientWidth)
    )
    await page.setViewportSize({ width: 1200, height: 900 })
    await expect
      .poll(async () => (await deny.boundingBox())?.y)
      .toBe((await allow.boundingBox())?.y)
    const header = await card.locator('[data-confirmation-header]').boundingBox()
    const wideAllow = await allow.boundingBox()
    assert.ok(header && wideAllow)
    assert.ok(wideAllow.y < header.y + header.height)
    assert.ok(wideAllow.x >= header.x + header.width)
  }
)

test(
  'paper authorization keeps decisions visible when its scope is collapsed',
  { timeout: 60_000 },
  async (context) => {
    const fixture = await renderFixture(ROOT, {
      launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
    })
    context.after(() => fixture.close())
    const page = await fixture.page(context)
    await page.goto(new URL(FIXTURE, fixture.url).href)
    await page.getByRole('button', { name: '长文献确认', exact: true }).click()
    await page.setViewportSize({ width: 360, height: 900 })
    const card = page.getByTestId('hil-card')
    const toggle = card.getByRole('button', { name: '调整授权范围', exact: true })
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(card.getByTestId('hil-question-scroll-area')).toBeHidden()
    await expect(card.getByRole('button', { name: '确认授权', exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: '确认授权', exact: true })).toBeEnabled()
    await expect(card.getByRole('button', { name: '拒绝', exact: true })).toBeEnabled()
    await toggle.click()
    const paper = card.getByTestId('hil-subset-paper-0-paper-1')
    const scope = await card.getByTestId('hil-question-scroll-area').boundingBox()
    const actions = await card.getByRole('button', { name: '确认授权', exact: true }).boundingBox()
    assert.ok(scope && actions)
    assert.ok(actions.y >= scope.y + scope.height)
    await paper.click()
    await expect(card.getByTestId('hil-subset-all-0')).toHaveAttribute('aria-checked', 'mixed')
    await toggle.click()
    await expect(card.getByTestId('hil-question-scroll-area')).toBeHidden()
    await expect(card.getByRole('button', { name: '确认授权', exact: true })).toBeVisible()
    await expect(card.getByRole('button', { name: '拒绝', exact: true })).toBeVisible()
    await toggle.focus()
    await page.keyboard.press('Enter')
    await expect(paper).not.toBeChecked()
    await expect(card.getByTestId('hil-question-scroll-area')).toBeVisible()
    await card.getByTestId('hil-subset-all-0').click()
    await card.getByTestId('hil-subset-all-0').click()
    await expect(card.getByRole('button', { name: '确认授权', exact: true })).toBeDisabled()
    await expect(card.getByRole('button', { name: '拒绝', exact: true })).toBeEnabled()
  }
)

for (const english of [false, true]) {
  test(
    `completed answers expand as immutable history: english=${english}`,
    { timeout: 60_000 },
    async (context) => {
      const fixture = await renderFixture(ROOT, {
        launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
      })
      context.after(() => fixture.close())
      const page = await fixture.page(context)
      const writes: string[] = []
      page.on('request', (request) => {
        if (request.method() === 'POST') writes.push(request.url())
      })
      await page.goto(new URL(`${FIXTURE}${english ? '?english&dark' : ''}`, fixture.url).href)
      await page.getByRole('button', { name: '已完成回答', exact: true }).click()
      const confirmedSummary = english
        ? 'Clarify key research questions, confirmed by user'
        : '明确研究关键问题，用户已确认'
      await page.getByRole('button', { name: confirmedSummary, exact: true }).click()
      const plain = page.getByTestId('interaction-reply')
      await expect(plain.getByRole('radio')).toHaveCount(4)
      await expect(plain.getByRole('checkbox')).toHaveCount(3)
      await expect(plain.getByRole('radio', { name: /持久化记忆机制/ })).toBeChecked()
      await expect(plain.getByRole('radio', { name: '长上下文' })).not.toBeChecked()
      await expect(plain.getByRole('checkbox', { name: '实验' })).toBeChecked()
      await expect(plain.getByRole('checkbox', { name: '理论' })).toBeChecked()
      await expect(plain.getByRole('checkbox', { name: '调研' })).not.toBeChecked()
      await expect(plain.getByRole('radio', { name: '默认方案' })).not.toBeChecked()
      await expect(plain.getByRole('radio', { name: '提供' })).not.toBeChecked()
      for (const option of await plain.locator('[role=radio], [role=checkbox]').all()) {
        await expect(option).toBeDisabled()
      }
      const fields = plain.getByRole('textbox')
      await expect(fields).toHaveCount(5)
      await expect(fields.nth(0)).toHaveValue('聚焦跨会话')
      await expect(fields.nth(1)).toHaveValue('补充：保留已有基线')
      await expect(fields.nth(2)).toHaveValue('第一行约束\n第二行约束')
      await expect(fields.nth(3)).toHaveValue('自定义研究方向')
      await expect(fields.nth(4)).toHaveValue('')
      for (const field of await fields.all()) {
        await expect(field).not.toBeEditable()
        await expect(field).toBeEnabled()
      }
      await fields.nth(0).press('End')
      await page.keyboard.type('不能写入')
      await expect(fields.nth(0)).toHaveValue('聚焦跨会话')
      await expect(plain.getByRole('button')).toHaveCount(1)
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
      const copy = plain.getByTestId('interaction-reply-copy')
      await copy.click()
      await expect(copy).toHaveAttribute('data-copy-status', 'success')
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain('持久化记忆机制（推荐）\n聚焦跨会话')
      await page.getByRole('button', { name: '过期澄清', exact: true }).click()
      const expired = page.locator('[data-hil-state="stale"]')
      const expiredToggle = expired.getByRole('button', {
        name: english
          ? 'Clarify key research questions, request expired'
          : '明确关键研究问题，请求已过期',
        exact: true,
      })
      await expect(expiredToggle).toHaveAttribute('aria-expanded', 'false')
      const expiredContent = expired.locator('[id$="-content"][aria-hidden]')
      await expect(expiredContent).toHaveAttribute('aria-hidden', 'true')
      await expiredToggle.focus()
      await page.keyboard.press('Enter')
      await expect(expiredToggle).toHaveAttribute('aria-expanded', 'true')
      await expect(expiredContent).toHaveAttribute('aria-hidden', 'false')
      const expiredOption = expired.getByRole('radio', { name: /持久化记忆机制/ })
      await expect(expiredOption).toBeVisible()
      await expect(expiredOption).toBeDisabled()
      await expect(expired.getByRole('button')).toHaveCount(1)
      await expect(expired.getByRole('textbox')).toHaveCount(0)
      await page.getByRole('button', { name: '组件历史回答', exact: true }).click()
      const card = page.getByTestId('interaction-reply')
      const toggle = page.getByRole('button', {
        name: confirmedSummary,
        exact: true,
      })
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await expect(toggle).toBeVisible()
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'true')
      await expect(
        card.getByText(english ? 'Previous answers are read-only' : '此前回答仅供查看，无法修改', {
          exact: true,
        })
      ).toBeVisible()
      const radios = card.getByRole('radio')
      const checkboxes = card.getByRole('checkbox')
      await expect(radios).toHaveCount(4)
      await expect(checkboxes).toHaveCount(3)
      const selected = card.getByRole('radio', {
        name: '持久化记忆机制（推荐） 研究跨会话的记忆保持。',
        exact: true,
      })
      await expect(selected).toBeChecked()
      for (const control of await card.locator('[role=radio], [role=checkbox]').all()) {
        await expect(control).toBeDisabled()
      }
      await expect(checkboxes.nth(0)).toBeChecked()
      await expect(checkboxes.nth(1)).toBeChecked()
      await expect(checkboxes.nth(2)).not.toBeChecked()
      await expect(card.getByText('第一行约束\n第二行约束', { exact: true })).toBeVisible()
      await expect(card.getByText('自定义研究方向', { exact: true })).toBeVisible()
      await expect(
        card.getByText(english ? 'Not answered' : '未作答', { exact: true })
      ).toBeVisible()
      await expect(card.getByRole('textbox')).toHaveCount(0)
      await expect(card.getByTestId('hil-question-confirm')).toHaveCount(0)
      for (const control of [selected, checkboxes.nth(2)]) {
        const bounds = (await control.boundingBox())!
        await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      }
      await expect(selected).toBeChecked()
      await expect(checkboxes.nth(2)).not.toBeChecked()
      for (const size of [WORKSPACE_WINDOW_SIZE, WORKSPACE_WINDOW_MINIMUM]) {
        await page.setViewportSize(size)
        await toggle.focus()
        await page.keyboard.press('Enter')
        await expect(toggle).toHaveAttribute('aria-expanded', 'false')
        await page.keyboard.press('Space')
        await expect(toggle).toHaveAttribute('aria-expanded', 'true')
        await expect(selected).toBeChecked()
        const neutralColor = await selected
          .getByText(/^持久化记忆机制/)
          .last()
          .evaluate((element) => getComputedStyle(element).color)
        await expect(selected.locator(':scope > span').first()).toHaveCSS(
          'background-color',
          neutralColor
        )
        await expect(checkboxes.nth(0).locator(':scope > span').first()).toHaveCSS(
          'background-color',
          neutralColor
        )
      }
      await page.getByRole('button', { name: '短文献确认', exact: true }).click()
      await page.getByRole('button', { name: '组件历史回答', exact: true }).click()
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      await expect(selected).toBeChecked()
      assert.deepEqual(writes, [])
    }
  )
}

test('composer-only surfaces retain their full height without a pending confirmation', async (context) => {
  const fixture = await renderFixture(ROOT, {
    launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
  })
  context.after(() => fixture.close())
  const page = await fixture.page(context)
  await page.goto(new URL(`${FIXTURE}?compact`, fixture.url).href)
  const controls = page.locator('.vds-ai-composer-host')
  assert.equal(await controls.evaluate((element) => getComputedStyle(element).maxHeight), '100%')
  const composer = await page.getByRole('textbox', { name: '消息', exact: true }).boundingBox()
  const send = await page.getByRole('button', { name: '发送', exact: true }).boundingBox()
  const host = await controls.boundingBox()
  assert.ok(composer!.y >= host!.y)
  assert.ok(send!.y + send!.height <= host!.y + host!.height)
})

for (const embedded of [false, true]) {
  test(
    `long confirmation preserves independently scrollable history: embedded=${embedded}`,
    { timeout: 60_000 },
    async (context) => {
      const fixture = await renderFixture(ROOT, {
        launch: () => chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL }),
      })
      context.after(() => fixture.close())
      const page = await fixture.page(context)
      const submissions: unknown[] = []
      await page.route('**/api/serve/sessions/conversation-layout/hil/**', async (route) => {
        submissions.push(route.request().postDataJSON())
        await route.fulfill({ json: { ok: true } })
      })
      await page.goto(new URL(`${FIXTURE}${embedded ? '?embedded' : ''}`, fixture.url).href)
      await page.getByRole('button', { name: '长文献确认', exact: true }).click()
      const history = page.locator('.conversation-stream')
      const papers = page.getByTestId('hil-question-scroll-area')
      const toggle = page.getByTestId('hil-question-toggle')
      await expect(toggle).toHaveAttribute('aria-expanded', 'false')
      await toggle.click()
      const layout = page.getByTestId('conversation-layout')
      const controls = page.locator('.vds-ai-composer-host')
      for (const size of [WORKSPACE_WINDOW_SIZE, WORKSPACE_WINDOW_MINIMUM]) {
        await page.setViewportSize(size)
        await expect(papers).toBeVisible()
        await expect
          .poll(async () => {
            const available = await layout.boundingBox()
            const stream = await history.boundingBox()
            return stream!.height / available!.height
          })
          .toBeGreaterThanOrEqual(0.24)
        assert.equal(
          await controls.evaluate((element) => getComputedStyle(element).overflowY),
          'visible'
        )
        await papers.hover()
        await page.mouse.wheel(0, 10000)
        await expect
          .poll(() =>
            papers.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop
            )
          )
          .toBeLessThanOrEqual(1)
        const papersScroll = await papers.evaluate((element) => element.scrollTop)
        await history.hover()
        await page.mouse.wheel(0, 10000)
        await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
        await page.mouse.wheel(0, -10000)
        await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBe(0)
        await expect(
          history.getByText('历史消息 1：保留此前的研究背景和讨论内容。', { exact: true })
        ).toBeInViewport()
        assert.equal(await papers.evaluate((element) => element.scrollTop), papersScroll)
        await toggle.click()
        await expect(papers).toBeHidden()
        await toggle.click()
        await expect(papers).toBeVisible()
      }
      await papers.hover()
      await page.mouse.wheel(0, 10000)
      await page
        .getByTestId('hil-dock')
        .getByRole('button', { name: '确认授权', exact: true })
        .click()
      await expect(page.getByTestId('hil-dock')).toHaveCount(0)
      const receipt = page.getByTestId('literature-authorization-receipt')
      await expect(receipt).toBeVisible()
      // HTTP acknowledgement alone does not establish the server event's decision source.
      await expect(receipt).toContainText('全文授权已记录，批准来源待核对')
      const replyToggle = receipt.getByRole('button', {
        name: '查看本次全部 24 篇文献',
        exact: true,
      })
      await expect(replyToggle).toHaveAttribute('aria-expanded', 'false')
      await replyToggle.click()
      await expect(replyToggle).toHaveAttribute('aria-expanded', 'true')
      await expect(receipt.getByRole('listitem')).toHaveCount(24)
      await expect(receipt.getByRole('listitem').first()).toHaveText(
        '文献 1：Long-Context Language Models and Evidence Retrieval in Research'
      )
      await expect(receipt.getByRole('listitem').last()).toHaveText(
        '文献 24：Long-Context Language Models and Evidence Retrieval in Research'
      )
      await expect(receipt.getByRole('radio')).toHaveCount(0)
      await expect(receipt.getByRole('checkbox')).toHaveCount(0)
      await expect(receipt.getByRole('button', { name: '确认授权', exact: true })).toHaveCount(0)
      assert.equal(submissions.length, 1)
      assert.deepEqual((submissions[0] as { values: unknown }).values, {
        selected_paper_ids: Array.from({ length: 24 }, (_, index) => `paper-${index + 1}`),
      })
      await page.getByRole('button', { name: '短文献确认', exact: true }).click()
      await expect
        .poll(async () => {
          const stream = await history.boundingBox()
          const available = await layout.boundingBox()
          return stream!.height / available!.height
        })
        .toBeGreaterThan(0.25)
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeInViewport()
    }
  )
}
