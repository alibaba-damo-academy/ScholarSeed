import { execFile } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const RSS_INTERVAL_MS = 250
const RSS_COMMAND_TIMEOUT_MS = 2000
const PROFILE_MARK = 'scholarseed.history.profile'
const PROFILE_READ_TIMEOUT_MS = 3000

export async function boundedProfileRead(read) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('Renderer profile read timed out')),
      PROFILE_READ_TIMEOUT_MS
    )
  })
  try {
    return await Promise.race([read, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export async function enableHistoryProfile(page) {
  await page.evaluate((name) => performance.mark(name), PROFILE_MARK)
}

export function sampleHistoryMemory(serve, desktop, emit) {
  let stopped = false
  const samples = []
  const reading = (async () => {
    while (!stopped && serve.exitCode === null && desktop.exitCode === null) {
      const startedAt = Date.now()
      try {
        let children = ''
        try {
          children = (
            await execute('/usr/bin/pgrep', ['-P', String(desktop.pid)], {
              timeout: RSS_COMMAND_TIMEOUT_MS,
            })
          ).stdout.trim()
        } catch (error) {
          if (error.code !== 1) throw error
        }
        const pids = [serve.pid, desktop.pid, ...children.split(/\s+/).filter(Boolean)]
        const { stdout } = await execute(
          '/bin/ps',
          ['-p', pids.join(','), '-o', 'pid=,ppid=,rss=,comm='],
          { timeout: RSS_COMMAND_TIMEOUT_MS }
        )
        const rows = stdout
          .trim()
          .split('\n')
          .flatMap((line) => {
            const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)
            if (!match) return []
            const [, pid, parentPid, kib, executable] = match
            const id = Number(pid)
            if (id === serve.pid) return [{ pid: id, role: 'serve', rssKiB: Number(kib) }]
            if (id === desktop.pid) return [{ pid: id, role: 'main', rssKiB: Number(kib) }]
            if (Number(parentPid) === desktop.pid && executable.endsWith(' (Renderer)'))
              return [{ pid: id, role: 'renderer', rssKiB: Number(kib) }]
            return []
          })
        samples.push({ at: Date.now(), rows })
        emit('resident_memory', { startedAt, rows })
      } catch (error) {
        emit('resident_memory_sample_failed', { name: error.name, code: error.code })
      }
      if (!stopped) await delay(RSS_INTERVAL_MS)
    }
  })()
  return async (firstClickResponseAt) => {
    stopped = true
    await reading
    const peaks = new Map()
    let rendererPeakKiB = 0
    let coldRendererPeakKiB = 0
    let coldServePeakKiB = 0
    for (const { at, rows } of samples) {
      let renderersKiB = 0
      for (const row of rows) {
        const peak = peaks.get(row.pid)
        if (!peak || row.rssKiB > peak.rssKiB) peaks.set(row.pid, row)
        if (row.role === 'renderer') renderersKiB += row.rssKiB
        if (firstClickResponseAt && at <= firstClickResponseAt && row.role === 'serve')
          coldServePeakKiB = Math.max(coldServePeakKiB, row.rssKiB)
      }
      rendererPeakKiB = Math.max(rendererPeakKiB, renderersKiB)
      if (firstClickResponseAt && at <= firstClickResponseAt)
        coldRendererPeakKiB = Math.max(coldRendererPeakKiB, renderersKiB)
    }
    return {
      intervalMs: RSS_INTERVAL_MS,
      sampleCount: samples.length,
      rendererPeakKiB,
      throughFirstClickResponse: firstClickResponseAt
        ? { servePeakKiB: coldServePeakKiB, rendererPeakKiB: coldRendererPeakKiB }
        : null,
      processPeaks: [...peaks.values()],
    }
  }
}

export async function measureHistoryClick(page, turnId, stage, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  const remaining = () => Math.max(1, deadline - Date.now())
  const mark = `scholarseed.history.${stage}`
  const stream = page.locator('.conversation-stream')
  const answer = stream
    .locator(`[data-message-turn-id="${turnId}"][data-message-kind="agent"]`)
    .last()
  const trigger = answer.locator('[data-answer-source-list]').getByRole('button').first()
  await trigger.evaluate(
    (button, name) => {
      button.addEventListener(
        'click',
        (event) => {
          if (event.isTrusted) performance.mark(name, { startTime: event.timeStamp })
        },
        { capture: true, once: true }
      )
    },
    mark,
    { timeout: remaining() }
  )
  const response = page
    .waitForFunction(
      (name) => {
        const click = performance.getEntriesByName(name, 'mark')[0]
        if (!click) return false
        const entry = document.querySelector(
          '[data-citation-source-panel] [data-citation-source-entry]'
        )
        if (!entry?.textContent.trim()) return false
        const bounds = entry.getBoundingClientRect()
        const x = (Math.max(0, bounds.left) + Math.min(innerWidth, bounds.right)) / 2
        const y = (Math.max(0, bounds.top) + Math.min(innerHeight, bounds.bottom)) / 2
        if (!entry.contains(document.elementFromPoint(x, y))) return false
        return {
          inputAt: performance.timeOrigin + click.startTime,
          visibleAt: performance.timeOrigin + performance.now(),
        }
      },
      mark,
      { timeout: remaining() }
    )
    .then((handle) => handle.jsonValue())
  const [, interaction] = await Promise.all([trigger.click({ timeout: remaining() }), response])
  if (stage === 'firstClick') {
    await trigger.click({ timeout: remaining() })
    await page
      .locator('[data-citation-source-panel]')
      .waitFor({ state: 'hidden', timeout: remaining() })
  }
  return interaction
}

export async function rendererHistoryPhases(page) {
  return page.evaluate(() =>
    performance
      .getEntriesByType('measure')
      .filter((entry) =>
        ['scholarseed.history.projection', 'scholarseed.history.projectionToCommit'].includes(
          entry.name
        )
      )
      .map((entry) => ({
        phase: entry.name.split('.').at(-1),
        caller: entry.detail.caller,
        startAt: performance.timeOrigin + entry.startTime,
        endAt: performance.timeOrigin + entry.startTime + entry.duration,
        durationMs: entry.duration,
      }))
  )
}

export function oldSourceTimings(records, turnId) {
  const scroll = records.find((row) => row.event === 'older_turn_scroll_started')
  if (!scroll) return null
  const body = records.find((row) => row.event === 'older_turn_visible')
  const requests = records.filter(
    (row) => row.event === 'renderer_request' && row.kind === 'sources'
  )
  const request = requests.find((row) => row.path.endsWith(`/turns/${turnId}/sources`))
  const response =
    request &&
    records.find((row) => row.event === 'renderer_headers' && row.requestId === request.requestId)
  const server =
    response?.serverRequestId &&
    records.find(
      (row) =>
        row.event === 'serve_request' &&
        row.phase === 'headers' &&
        row.record.request_id === response.serverRequestId
    )?.record
  const panel = records.find((row) => row.event === 'older_turn_sources_opened')
  const sinceScroll = (at) => (Number.isFinite(at) ? Math.round(at - scroll.observedAt) : null)
  return {
    serverRequestId: response?.serverRequestId ?? null,
    bodyVisibleMs: sinceScroll(body?.observedAt),
    rendererRequestMs: sinceScroll(request?.startedAt),
    serveReceivedMs: sinceScroll(server && server.started_at * 1000),
    serveHeadersMs: sinceScroll(server && server.started_at * 1000 + server.headers_ms),
    rendererHeadersMs: sinceScroll(response?.at),
    trustedClickMs: sinceScroll(panel?.inputAt),
    panelVisibleMs: sinceScroll(panel?.visibleAt),
    sourceRequestsSinceScroll: requests.filter((row) => row.startedAt >= scroll.observedAt).length,
  }
}
