import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { measureHistoryClick } from './profiling.mjs'

const SCREENSHOT_TIMEOUT_MS = 10_000
const MAX_SCROLL_ATTEMPTS = 100
const SCROLL_DELTA_Y_PX = -12_000
const SCROLL_SETTLE_MS = 100
const SCROLL_LOCATOR_TIMEOUT_MS = 5_000

export function observationTimeLeft(deadline, phase) {
  const timeLeft = deadline - Date.now()
  if (timeLeft <= 0) throw new Error(`Observation window exhausted during ${phase}`)
  return timeLeft
}

async function withinObservation(deadline, phase, observe) {
  const remaining = () => observationTimeLeft(deadline, phase)
  remaining()
  try {
    return await observe(remaining)
  } catch (error) {
    // Report the round deadline when it limited a Playwright operation.
    if (error.name === 'TimeoutError') remaining()
    throw error
  }
}

export async function captureFirstScreen(
  page,
  { lastTurnId, desktopStartedAt, artifact, profileHistory, emit, deadline },
  firstScreen
) {
  await withinObservation(deadline, 'first history screen', async (remaining) => {
    firstScreen.visibleAt = await page
      .waitForFunction(
        (tail) => {
          const turn = tail ? `[data-message-turn-id="${tail}"]` : '[data-message-turn-id]'
          const selector = `.conversation-stream ${turn}[data-message-kind="agent"] > div`
          const visible = [...document.querySelectorAll(selector)].some((element) => {
            const { left, right, top, bottom } = element.getBoundingClientRect()
            const x = (Math.max(0, left) + Math.min(innerWidth, right)) / 2
            const y = (Math.max(0, top) + Math.min(innerHeight, bottom)) / 2
            return element.contains(document.elementFromPoint(x, y)) && !!element.textContent.trim()
          })
          return visible ? Date.now() : false
        },
        lastTurnId ?? null,
        { timeout: remaining() }
      )
      .then((handle) => handle.jsonValue())
    emit('history_visible', { elapsedMs: firstScreen.visibleAt - desktopStartedAt })
    if (profileHistory) {
      firstScreen.firstInteraction = await measureHistoryClick(
        page,
        lastTurnId,
        'firstClick',
        remaining
      )
      emit('first_history_interaction', firstScreen.firstInteraction)
    }
    await page.screenshot({
      path: join(
        artifact,
        profileHistory ? 'history-after-first-click.png' : 'history-visible.png'
      ),
      timeout: Math.min(SCREENSHOT_TIMEOUT_MS, remaining()),
    })
  })
}

async function scrollToOldTurn(page, turnId, artifact, emit, remaining) {
  const stream = page.locator('.conversation-stream')
  emit('older_turn_scroll_started', { turnId })
  await stream.hover({ timeout: Math.min(SCROLL_LOCATOR_TIMEOUT_MS, remaining()) })
  const oldTurn = stream.locator(`[data-message-turn-id="${turnId}"]`).first()
  const intersectsViewport = async () => {
    const timeout = remaining()
    const [viewport, row] = await Promise.all([
      stream.boundingBox({ timeout }),
      oldTurn.boundingBox({ timeout }),
    ])
    remaining()
    return (
      viewport &&
      row &&
      viewport.height > 0 &&
      row.height > 0 &&
      row.y + row.height > viewport.y &&
      row.y < viewport.y + viewport.height
    )
  }
  // Scroll using native wheel input to exercise the production viewport observer.
  for (let count = 0; count < MAX_SCROLL_ATTEMPTS; count++) {
    if (await intersectsViewport()) break
    remaining()
    await page.mouse.wheel(0, SCROLL_DELTA_Y_PX)
    await delay(Math.min(SCROLL_SETTLE_MS, remaining()))
  }
  await oldTurn.waitFor({
    state: 'visible',
    timeout: Math.min(SCROLL_LOCATOR_TIMEOUT_MS, remaining()),
  })
  if (!(await intersectsViewport())) {
    throw new Error(`Older turn ${turnId} did not enter the viewport`)
  }
  const oldVisibleAt = Date.now()
  emit('older_turn_visible', { turnId })
  await page.screenshot({
    path: join(artifact, 'older-turn.png'),
    timeout: Math.min(SCREENSHOT_TIMEOUT_MS, remaining()),
  })
  return oldVisibleAt
}

async function openOldSources(page, turnId, profileHistory, remaining) {
  if (profileHistory) return measureHistoryClick(page, turnId, 'olderClick', remaining)
  const answer = page
    .locator('.conversation-stream')
    .locator(`[data-message-turn-id="${turnId}"][data-message-kind="agent"]`)
    .last()
  const trigger = answer.locator('[data-answer-source-list]').getByRole('button').first()
  await trigger.click({ timeout: remaining() })
  const panel = page.locator('[data-citation-source-panel]').last()
  await panel
    .locator('[data-citation-source-entry]')
    .first()
    .waitFor({ state: 'visible', timeout: remaining() })
}

export async function observeOldTurn(
  page,
  { oldTurn, checkOldSources, profileHistory },
  artifact,
  emit,
  deadline
) {
  const visibleAt = await withinObservation(
    deadline,
    `scrolling to older turn ${oldTurn}`,
    (remaining) => scrollToOldTurn(page, oldTurn, artifact, emit, remaining)
  )
  if (!checkOldSources) return
  await withinObservation(
    deadline,
    `opening sources for older turn ${oldTurn}`,
    async (remaining) => {
      const interaction = await openOldSources(page, oldTurn, profileHistory, remaining)
      remaining()
      emit('older_turn_sources_opened', {
        turnId: oldTurn,
        ...interaction,
        elapsedSinceVisibleMs: (interaction?.visibleAt ?? Date.now()) - visibleAt,
      })
      await page.screenshot({
        path: join(artifact, 'older-sources.png'),
        timeout: Math.min(SCREENSHOT_TIMEOUT_MS, remaining()),
      })
    }
  )
}
