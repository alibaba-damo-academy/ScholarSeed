import assert from 'node:assert/strict'
import test from 'node:test'

import { createInitialPageStep, installRecorderProbe } from './probe.ts'
import type { NetworkRecord, RecordedStep } from './model.ts'

class FakeXhr extends EventTarget {
  static readonly prototypeOpen = FakeXhr.prototype.open
  static readonly prototypeSend = FakeXhr.prototype.send
  status = 200
  responseType: XMLHttpRequestResponseType = ''
  responseText = ''

  open(): void {}
  send(): void {}
  getResponseHeader(): string | null {
    return null
  }
}

test('recording starts with the current page as its first step', () => {
  const startedAtMs = Date.parse('2026-09-21T06:30:00.000Z')
  const documentTarget = {
    title: '书深',
    querySelector: (selector: string) =>
      selector === '[role="tab"][aria-selected="true"]' ? { textContent: '文献库' } : null,
  }
  const windowTarget = {
    location: {
      href: 'http://127.0.0.1:5173/literature?scope=all#list',
      pathname: '/literature',
      search: '?scope=all',
      hash: '#list',
    },
  }
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowTarget },
    document: { configurable: true, value: documentTarget },
  })
  try {
    const step = createInitialPageStep(startedAtMs)
    assert.equal(step.kind, 'navigation')
    assert.equal(step.occurredAt, '2026-09-21T06:30:00.000Z')
    assert.equal(step.elapsedMs, 0)
    assert.deepEqual(step.page, {
      url: 'http://127.0.0.1:5173/literature?scope=all#list',
      title: '书深',
      path: '/literature?scope=all#list',
      label: '文献库',
    })
    assert.deepEqual(step.target, { tag: 'window', role: 'navigation' })
  } finally {
    delete (globalThis as Record<string, unknown>).window
    delete (globalThis as Record<string, unknown>).document
  }
})

test('probe owns one lease and restores every wrapped browser API', () => {
  const originalFetch = async (): Promise<Response> => new Response('{}')
  const documentTarget = Object.assign(new EventTarget(), { title: 'ScholarSeed' })
  const windowTarget = Object.assign(new EventTarget(), {
    location: { href: 'app://index' },
    fetch: originalFetch,
    setTimeout,
    clearTimeout,
  })
  const originalPushState = (): void => undefined
  const originalReplaceState = (): void => undefined
  const historyValue = { pushState: originalPushState, replaceState: originalReplaceState }
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowTarget },
    document: { configurable: true, value: documentTarget },
    history: { configurable: true, value: historyValue },
    XMLHttpRequest: { configurable: true, value: FakeXhr },
  })
  const options = {
    startedAtMs: Date.now(),
    latestStep: () => undefined,
    onStep: () => undefined,
    onRequest: () => undefined,
  }
  try {
    const first = installRecorderProbe(options)
    assert.notEqual(windowTarget.fetch, originalFetch)
    const second = installRecorderProbe(options)
    assert.notEqual(windowTarget.fetch, originalFetch)
    first.dispose()
    assert.notEqual(windowTarget.fetch, originalFetch)
    second.dispose()
    assert.equal(windowTarget.fetch, originalFetch)
    assert.equal(historyValue.pushState, originalPushState)
    assert.equal(historyValue.replaceState, originalReplaceState)
    assert.equal(FakeXhr.prototype.open, FakeXhr.prototypeOpen)
    assert.equal(FakeXhr.prototype.send, FakeXhr.prototypeSend)
  } finally {
    delete (globalThis as Partial<typeof globalThis>).window
    delete (globalThis as Partial<typeof globalThis>).document
    delete (globalThis as Partial<typeof globalThis>).history
    delete (globalThis as Partial<typeof globalThis>).XMLHttpRequest
  }
})

for (const inputType of ['text', 'password']) {
  test(`dispose records ordinary input but never password values (${inputType})`, () => {
    class FakeElement extends EventTarget {
      readonly tagName = 'INPUT'
      readonly textContent = ''
      getAttribute(): string | null {
        return null
      }
      hasAttribute(): boolean {
        return false
      }
      closest(): FakeElement {
        return this
      }
      querySelector(): null {
        return null
      }
    }
    class FakeInput extends FakeElement {
      type = inputType
      value = 'final value'
    }
    const listeners = new Map<string, EventListener>()
    const documentTarget = {
      title: 'ScholarSeed',
      addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    }
    const originalFetch = async (): Promise<Response> => new Response('{}')
    const windowTarget = Object.assign(new EventTarget(), {
      location: { href: 'app://index' },
      fetch: originalFetch,
      setTimeout,
      clearTimeout,
    })
    const historyValue = {
      pushState: (): void => undefined,
      replaceState: (): void => undefined,
    }
    const steps: Array<{ kind: string; value?: string }> = []
    Object.defineProperties(globalThis, {
      window: { configurable: true, value: windowTarget },
      document: { configurable: true, value: documentTarget },
      history: { configurable: true, value: historyValue },
      XMLHttpRequest: { configurable: true, value: FakeXhr },
      Element: { configurable: true, value: FakeElement },
      HTMLInputElement: { configurable: true, value: FakeInput },
    })
    try {
      const lease = installRecorderProbe({
        startedAtMs: Date.now(),
        latestStep: () => undefined,
        onStep: (step) => steps.push(step),
        onRequest: () => undefined,
      })
      const input = new FakeInput()
      listeners.get('input')?.({
        target: input,
        composedPath: () => [input],
      } as unknown as Event)
      lease.dispose()
      assert.deepEqual(
        steps.map((step) => ({ kind: step.kind, value: step.value })),
        inputType === 'password' ? [] : [{ kind: 'input', value: 'final value' }]
      )
      assert.equal(windowTarget.fetch, originalFetch)
    } finally {
      for (const key of [
        'window',
        'document',
        'history',
        'XMLHttpRequest',
        'Element',
        'HTMLInputElement',
      ]) {
        delete (globalThis as Record<string, unknown>)[key]
      }
    }
  })
}

test('text input is merged until focus leaves the field', () => {
  class FakeElement extends EventTarget {
    readonly tagName = 'INPUT'
    readonly textContent = ''
    readonly parentElement = null
    getAttribute(): string | null {
      return null
    }
    hasAttribute(): boolean {
      return false
    }
    closest(): FakeElement {
      return this
    }
    querySelector(): null {
      return null
    }
    getBoundingClientRect(): { x: number; y: number; width: number; height: number } {
      return { x: 0, y: 0, width: 100, height: 32 }
    }
  }
  class FakeInput extends FakeElement {
    type = 'text'
    value = ''
  }
  const listeners = new Map<string, EventListener>()
  const documentTarget = {
    title: 'ScholarSeed',
    addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  }
  const originalFetch = async (): Promise<Response> => new Response('{}')
  const windowTarget = Object.assign(new EventTarget(), {
    location: { href: 'app://index' },
    fetch: originalFetch,
    setTimeout,
    clearTimeout,
  })
  const historyValue = {
    pushState: (): void => undefined,
    replaceState: (): void => undefined,
  }
  const steps: RecordedStep[] = []
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowTarget },
    document: { configurable: true, value: documentTarget },
    history: { configurable: true, value: historyValue },
    XMLHttpRequest: { configurable: true, value: FakeXhr },
    Element: { configurable: true, value: FakeElement },
    HTMLElement: { configurable: true, value: FakeElement },
    HTMLInputElement: { configurable: true, value: FakeInput },
    HTMLTextAreaElement: { configurable: true, value: class extends FakeElement {} },
    HTMLSelectElement: { configurable: true, value: class extends FakeElement {} },
  })
  try {
    const lease = installRecorderProbe({
      startedAtMs: Date.now(),
      latestStep: () => undefined,
      onStep: (step) => steps.push(step),
      onRequest: () => undefined,
    })
    const input = new FakeInput()
    input.value = '第'
    listeners.get('input')?.({
      target: input,
      composedPath: () => [input],
    } as unknown as Event)
    input.value = '第二次输入'
    listeners.get('input')?.({
      target: input,
      composedPath: () => [input],
    } as unknown as Event)
    assert.equal(steps.length, 0)
    listeners.get('focusout')?.({ target: input } as unknown as Event)
    assert.deepEqual(
      steps.map((step) => ({ kind: step.kind, value: step.value })),
      [{ kind: 'input', value: '第二次输入' }]
    )
    listeners.get('change')?.({
      target: input,
      composedPath: () => [input],
    } as unknown as Event)
    assert.equal(steps.length, 1)
    lease.dispose()
  } finally {
    for (const key of [
      'window',
      'document',
      'history',
      'XMLHttpRequest',
      'Element',
      'HTMLElement',
      'HTMLInputElement',
      'HTMLTextAreaElement',
      'HTMLSelectElement',
    ]) {
      delete (globalThis as Record<string, unknown>)[key]
    }
  }
})

test('click steps include page path, semantic locator, container chain and geometry', () => {
  const dialog = {
    getAttribute: (name: string) => (name === 'aria-label' ? '导入文献' : null),
    querySelector: () => null,
  }
  class FakeElement extends EventTarget {
    readonly tagName = 'BUTTON'
    readonly textContent = 'Open literature'
    readonly parentElement = {
      parentElement: null,
      getAttribute: (name: string) => (name === 'data-testid' ? 'literature-overview' : null),
    }
    getAttribute(name: string): string | null {
      if (name === 'data-testid') return 'literature-open'
      if (name === 'role') return 'button'
      return null
    }
    hasAttribute(): boolean {
      return false
    }
    closest(selector: string): FakeElement | typeof dialog {
      return selector.includes('[role="dialog"]') ? dialog : this
    }
    getBoundingClientRect(): { x: number; y: number; width: number; height: number } {
      return { x: 10, y: 20, width: 120, height: 36 }
    }
  }
  const listeners = new Map<string, EventListener>()
  const documentTarget = {
    title: 'ScholarSeed',
    querySelector: (selector: string) =>
      selector === '[role="tab"][aria-selected="true"]' ? { textContent: '文献中心' } : null,
    addEventListener: (name: string, listener: EventListener) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  }
  const originalFetch = async (): Promise<Response> => new Response('{}')
  const windowTarget = Object.assign(new EventTarget(), {
    location: {
      href: 'http://127.0.0.1:5173/literature?scope=all#list',
      pathname: '/literature',
      search: '?scope=all',
      hash: '#list',
    },
    fetch: originalFetch,
    setTimeout,
    clearTimeout,
  })
  const historyValue = {
    pushState: (): void => undefined,
    replaceState: (): void => undefined,
  }
  const steps: RecordedStep[] = []
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowTarget },
    document: { configurable: true, value: documentTarget },
    history: { configurable: true, value: historyValue },
    XMLHttpRequest: { configurable: true, value: FakeXhr },
    Element: { configurable: true, value: FakeElement },
  })
  try {
    const lease = installRecorderProbe({
      startedAtMs: Date.now(),
      latestStep: () => undefined,
      onStep: (step) => steps.push(step),
      onRequest: () => undefined,
    })
    const button = new FakeElement()
    listeners.get('click')?.({
      target: button,
      clientX: 42,
      clientY: 64,
      composedPath: () => [button],
    } as unknown as Event)
    lease.dispose()
    assert.equal(steps.length, 1)
    assert.equal(steps[0]?.page.path, '/literature?scope=all#list')
    assert.equal(steps[0]?.page.label, '文献中心')
    assert.equal(steps[0]?.page.dialogLabel, '导入文献')
    assert.deepEqual(steps[0]?.target.locator, { kind: 'testId', value: 'literature-open' })
    assert.deepEqual(steps[0]?.target.containerTestIds, ['literature-overview'])
    assert.deepEqual(steps[0]?.target.bounds, { x: 10, y: 20, width: 120, height: 36 })
    assert.deepEqual(steps[0]?.pointer, { x: 42, y: 64 })
  } finally {
    for (const key of ['window', 'document', 'history', 'XMLHttpRequest', 'Element']) {
      delete (globalThis as Record<string, unknown>)[key]
    }
  }
})

test('fetch probe records ordinary response data and a reliable recent-step association', async () => {
  const originalFetch: typeof fetch = async () =>
    new Response('{"ok":true}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  const documentTarget = Object.assign(new EventTarget(), { title: 'ScholarSeed' })
  const windowTarget = Object.assign(new EventTarget(), {
    location: { href: 'app://index' },
    fetch: originalFetch,
    setTimeout,
    clearTimeout,
  })
  const historyValue = {
    pushState: (): void => undefined,
    replaceState: (): void => undefined,
  }
  const latestStep: RecordedStep = {
    stepId: 'step-recent',
    occurredAt: new Date().toISOString(),
    elapsedMs: 0,
    kind: 'click',
    page: { url: 'app://index', title: 'ScholarSeed' },
    target: { tag: 'button', testId: 'save' },
  }
  const requests: NetworkRecord[] = []
  let completeSummary = (): void => undefined
  const summaryReady = new Promise<void>((resolve) => {
    completeSummary = resolve
  })
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowTarget },
    document: { configurable: true, value: documentTarget },
    history: { configurable: true, value: historyValue },
    XMLHttpRequest: { configurable: true, value: FakeXhr },
  })
  try {
    const lease = installRecorderProbe({
      startedAtMs: Date.now(),
      latestStep: () => latestStep,
      onStep: () => undefined,
      onRequest: (request) => {
        const index = requests.findIndex((entry) => entry.requestId === request.requestId)
        if (index === -1) requests.push(request)
        else requests[index] = request
        if (request.responseBody !== '[正文摘要生成中]') completeSummary()
      },
    })
    await windowTarget.fetch('https://example.test/items', {
      method: 'POST',
      body: '{"name":"demo"}',
    })
    await summaryReady
    lease.dispose()
    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.method, 'POST')
    assert.equal(requests[0]?.url, 'https://example.test/items')
    assert.equal(requests[0]?.status, 201)
    assert.equal(requests[0]?.requestBody, '{"name":"demo"}')
    assert.equal(requests[0]?.responseBody, '{"ok":true}')
    assert.equal(requests[0]?.stepId, 'step-recent')
  } finally {
    for (const key of ['window', 'document', 'history', 'XMLHttpRequest']) {
      delete (globalThis as Record<string, unknown>)[key]
    }
  }
})

async function captureRejection(error: unknown): Promise<NetworkRecord[]> {
  const originalFetch: typeof fetch = async () => {
    throw error
  }
  const documentTarget = Object.assign(new EventTarget(), { title: 'ScholarSeed' })
  const windowTarget = Object.assign(new EventTarget(), {
    location: { href: 'app://index' },
    fetch: originalFetch,
    setTimeout,
    clearTimeout,
  })
  const historyValue = {
    pushState: (): void => undefined,
    replaceState: (): void => undefined,
  }
  const requests: NetworkRecord[] = []
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: windowTarget },
    document: { configurable: true, value: documentTarget },
    history: { configurable: true, value: historyValue },
    XMLHttpRequest: { configurable: true, value: FakeXhr },
  })
  try {
    const lease = installRecorderProbe({
      startedAtMs: Date.now(),
      latestStep: () => undefined,
      onStep: () => undefined,
      onRequest: (request) => requests.push(request),
    })
    await assert.rejects(() => windowTarget.fetch('https://example.test/literatures'))
    lease.dispose()
    return requests
  } finally {
    for (const key of ['window', 'document', 'history', 'XMLHttpRequest']) {
      delete (globalThis as Record<string, unknown>)[key]
    }
  }
}

test('a fetch cancelled by its own signal is recorded as cancelled, not as a failure', async () => {
  const requests = await captureRejection(
    new DOMException('signal is aborted without reason', 'AbortError')
  )
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.cancelled, true)
  assert.equal(requests[0]?.status, undefined)
  // 原始 reason 仍然留着备查, 只是不再顶替状态位。
  assert.equal(requests[0]?.error, 'signal is aborted without reason')
})

test('a fetch rejected by a real failure keeps its error and is not marked cancelled', async () => {
  const requests = await captureRejection(new TypeError('Failed to fetch'))
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.cancelled, undefined)
  assert.equal(requests[0]?.error, 'Failed to fetch')
})
