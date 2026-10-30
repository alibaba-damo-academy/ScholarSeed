import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { WebContents } from 'electron'
import {
  createSearchFormBoundary,
  createSearchFormExecutor,
  type SearchFormDiagnostic,
} from './searchform.ts'

const DESTINATION = 'https://www.bing.com/search?q=public+query&form=QBLH'

test('search form boundary binds the empty named submitter value and exact parameter order', () => {
  const destination = 'https://cn.bing.com/search?q=public+query&search=&form=QBLH'
  const approved = createSearchFormBoundary(destination, 'q', () => true)
  assert.equal(
    approved.request({ url: destination, method: 'GET', resourceType: 'mainFrame' }),
    true
  )
  for (const url of [
    'https://cn.bing.com/search?q=public+query&form=QBLH',
    'https://cn.bing.com/search?q=public+query&search=different&form=QBLH',
    'https://cn.bing.com/search?search=&q=public+query&form=QBLH',
    `${destination}&search=`,
  ]) {
    const changed = createSearchFormBoundary(destination, 'q', () => true)
    assert.equal(changed.request({ url, method: 'GET', resourceType: 'mainFrame' }), false)
    assert.equal(changed.valid(), false)
  }
})

test('search form boundary permits one exact GET navigation and refuses redirects or replay', () => {
  const boundary = createSearchFormBoundary(DESTINATION, 'q', () => true)
  assert.equal(
    boundary.request({ url: DESTINATION, method: 'POST', resourceType: 'mainFrame' }),
    false
  )
  assert.equal(boundary.valid(), false)
  const current = createSearchFormBoundary(DESTINATION, 'q', () => true)
  assert.equal(current.navigation(DESTINATION, 'start'), true)
  assert.equal(current.navigation(DESTINATION, 'intent'), true)
  assert.equal(
    current.request({ url: DESTINATION, method: 'GET', resourceType: 'mainFrame' }),
    true
  )
  assert.equal(current.navigation(DESTINATION, 'commit'), true)
  assert.equal(
    current.request({ url: DESTINATION, method: 'GET', resourceType: 'mainFrame' }),
    false
  )
  assert.equal(current.valid(), false)
  const redirected = createSearchFormBoundary(DESTINATION, 'q', () => true)
  assert.equal(redirected.navigation(DESTINATION, 'redirect'), false)
})

test('search form boundary blocks every subordinate request including alternative query disclosure', () => {
  const boundary = createSearchFormBoundary(DESTINATION, 'q', () => true)
  for (const resourceType of ['xhr', 'ping', 'webSocket', 'subFrame', 'other']) {
    assert.equal(
      boundary.request({ url: 'https://www.bing.com/collect', method: 'GET', resourceType }),
      false
    )
  }
  for (const resourceType of ['image', 'stylesheet', 'script', 'font']) {
    for (const url of [
      'https://www.bing.com/static',
      'https://other.example/static',
      'https://www.bing.com/static?q=public+query',
      'https://www.bing.com/static?term=public+query',
      'https://www.bing.com/public%20query',
    ]) {
      for (const method of ['GET', 'HEAD', 'POST']) {
        assert.equal(boundary.request({ url, method, resourceType }), false)
      }
    }
  }
})

test('search form boundary locks on authority revocation and mismatched destination', () => {
  let authorized = true
  const boundary = createSearchFormBoundary(DESTINATION, 'q', () => authorized)
  authorized = false
  assert.equal(
    boundary.request({ url: DESTINATION, method: 'GET', resourceType: 'mainFrame' }),
    false
  )
  authorized = true
  assert.equal(boundary.valid(), false)
  for (const url of [
    'https://other.example/search?q=public+query&form=QBLH',
    'https://www.bing.com/other?q=public+query&form=QBLH',
    `${DESTINATION}&q=extra`,
    `${DESTINATION}&hidden=secret`,
  ]) {
    const changed = createSearchFormBoundary(DESTINATION, 'q', () => true)
    assert.equal(changed.request({ url, method: 'GET', resourceType: 'mainFrame' }), false)
    assert.equal(changed.valid(), false)
  }
})

test('issued submission failure or cancellation is unknown and never replayed', async () => {
  for (const scenario of ['rejected', 'cancelled']) {
    const abort = new AbortController()
    let value = ''
    let focused = false
    let closed = false
    let submissions = 0
    const contents = Object.assign(new EventEmitter(), {
      isDestroyed: () => closed,
      isFocused: () => false,
      getURL: () => 'https://www.bing.com/',
      executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
        if (scripts[0].code.includes('HTMLFormElement.prototype.submit.call')) {
          submissions += 1
          if (scenario === 'rejected') throw new Error('untrusted details')
          abort.abort()
          return
        }
        if (scripts[0].code.includes('requestAnimationFrame')) return true
        return {
          destinationUrl: DESTINATION,
          fingerprint: 'frozen',
          inputValue: value,
          inputFocused: focused,
        }
      },
      debugger: {
        isAttached: () => true,
        sendCommand: async (method: string, parameters: Record<string, unknown>) => {
          if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
          if (method === 'DOM.querySelector')
            return { nodeId: parameters.selector === '#query' ? 2 : 3 }
          if (method === 'DOM.describeNode') return { node: { backendNodeId: parameters.nodeId } }
          if (method === 'DOM.focus') focused = true
          if (method === 'Input.insertText') value = String(parameters.text)

          return {}
        },
      },
    }) as unknown as WebContents
    const executor = createSearchFormExecutor({
      tabId: 'search',
      target: () => ({ contents, instanceId: 'instance', generation: 1, url: contents.getURL() }),
      attach: () => contents,
      close: () => {
        closed = true
      },
    })
    const prepared = await executor.prepare(
      {
        landingUrl: 'https://www.bing.com/',
        resultUrl: 'https://www.bing.com/search',
        inputSelector: '#query',
        submitSelector: '#submit',
        queryParameter: 'q',
        fields: {},
      },
      'public query',
      abort.signal
    )
    await assert.rejects(
      executor.execute(prepared, () => true),
      { message: 'browser_search_submission_unknown' }
    )
    await assert.rejects(
      executor.execute(prepared, () => true),
      { message: 'browser_search_form_stale' }
    )
    assert.equal(submissions, 1)
    assert.equal(closed, true)
  }
})

function diagnosticProbe(observer?: () => void) {
  const abort = new AbortController()
  const events: SearchFormDiagnostic[] = []
  let value = ''
  let focused = false
  let closed = false
  let url = 'https://www.bing.com/'
  let generation = 1
  let submit = async (): Promise<void> => {}
  let render = async (): Promise<unknown> => true
  let startRender: () => void = () => {}
  const rendering = new Promise<void>((resolve) => {
    startRender = resolve
  })
  let acknowledge: () => void = () => {}
  const acknowledged = new Promise<void>((resolve) => {
    acknowledge = resolve
  })
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => closed,
    isFocused: () => false,
    getURL: () => url,
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: { code: string }[]) => {
      if (scripts[0].code.includes('HTMLFormElement.prototype.submit.call')) return await submit()
      if (scripts[0].code.includes('requestAnimationFrame')) {
        startRender()
        return render()
      }
      return {
        destinationUrl: DESTINATION,
        fingerprint: 'private-page-content',
        inputValue: value,
        inputFocused: focused,
        documentFocused: false,
        formValid: true,
      }
    },
    debugger: {
      isAttached: () => true,
      sendCommand: async (method: string, parameters: Record<string, unknown>) => {
        if (method === 'DOM.getDocument') return { root: { nodeId: 1 } }
        if (method === 'DOM.querySelector')
          return { nodeId: parameters.selector === '#query' ? 2 : 3 }
        if (method === 'DOM.describeNode') return { node: { backendNodeId: parameters.nodeId } }
        if (method === 'DOM.focus') focused = true
        if (method === 'Input.insertText') value = String(parameters.text)
        assert.notEqual(parameters?.key, 'Enter')
        return {}
      },
    },
  }) as unknown as WebContents
  const executor = createSearchFormExecutor({
    tabId: 'search',
    target: () => ({ contents, instanceId: 'instance', generation, url }),
    attach: () => contents,
    close: () => {
      closed = true
      executor.invalidate()
    },
    onDiagnostic: (event) => {
      events.push(event)
      if (event.phase === 'submit_ack') acknowledge()
      observer?.()
    },
  })
  return {
    abort,
    contents,
    events,
    executor,
    acknowledged,
    rendering,
    setRender: (callback: () => Promise<unknown>) => {
      render = callback
    },
    changeTarget: () => {
      generation += 1
    },
    setSubmit: (callback: () => Promise<void>) => {
      submit = callback
    },
    prepare: () =>
      executor.prepare(
        {
          landingUrl: 'https://www.bing.com/',
          resultUrl: 'https://www.bing.com/search',
          inputSelector: '#query',
          submitSelector: '#submit',
          queryParameter: 'q',
          fields: {},
        },
        'public query',
        abort.signal
      ),
    commit: (beforeReady?: () => void) => {
      assert.equal(executor.navigation(DESTINATION, 'intent'), true)
      executor.advance(++generation)
      assert.equal(executor.navigation(DESTINATION, 'start'), true)
      assert.equal(
        executor.request({ url: DESTINATION, method: 'GET', resourceType: 'mainFrame' }),
        true
      )
      url = DESTINATION
      assert.equal(executor.navigation(DESTINATION, 'commit'), true)
      executor.advance(++generation)
      beforeReady?.()
      contents.emit('dom-ready')
    },
  }
}

test('search diagnostics distinguish form submission rejection from acknowledgement without leaking contents', async () => {
  const probe = diagnosticProbe()
  probe.setSubmit(async () => {
    throw new Error('private-token https://secret.example/?q=private-query')
  })
  const prepared = await probe.prepare()
  await assert.rejects(
    probe.executor.execute(prepared, () => true),
    {
      message: 'browser_search_submission_unknown',
      cause: new Error('submission_failed'),
    }
  )
  const phases = probe.events.map((event) => event.phase)
  assert.ok(phases.includes('input_verified'))
  assert.ok(phases.includes('submit_issued'))
  assert.equal(phases.includes('submit_ack'), false)
  assert.equal(probe.events.filter((event) => event.phase === 'failed').length, 1)
  assert.equal(probe.events.find((event) => event.phase === 'failed')?.reason, 'submission_failed')
  assert.ok(probe.events.every((event) => Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0))
  assert.doesNotMatch(
    JSON.stringify(probe.events),
    /private-|public|https:|fingerprint|inputValue|q=/
  )
})

test(
  'search diagnostics distinguish internal timeout from abort and preserve the first failure',
  { timeout: 1_000 },
  async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] })
    for (const reason of ['timeout', 'aborted']) {
      const probe = diagnosticProbe()
      const prepared = await probe.prepare()
      const execution = assert.rejects(
        probe.executor.execute(prepared, () => true),
        {
          message: 'browser_search_submission_unknown',
          cause: new Error(reason),
        }
      )
      await probe.acknowledged
      if (reason === 'timeout') context.mock.timers.tick(15_000)
      else probe.abort.abort()
      await execution
      const failures = probe.events.filter((event) => event.phase === 'failed')
      assert.equal(failures.length, 1)
      assert.equal(failures[0].reason, reason)
      assert.equal(failures[0].submitIssued, true)
      assert.equal(failures[0].submissionAcknowledged, true)
      await assert.rejects(
        probe.executor.execute(prepared, () => true),
        { message: 'browser_search_form_stale' }
      )
    }
  }
)

test('search diagnostics observe requests, navigation and dom-ready without changing successful submission', async () => {
  const probe = diagnosticProbe()
  probe.setSubmit(async () => {
    probe.commit()
  })
  const prepared = await probe.prepare()
  await probe.executor.execute(prepared, () => true)
  const phases = probe.events.map((event) => event.phase)
  for (const phase of [
    'effect_issued',
    'effect_ack',
    'input_verified',
    'submit_issued',
    'submit_ack',
    'request',
    'navigation_intent',
    'navigation_start',
    'navigation_commit',
    'dom_ready',
    'completed',
  ] as const) {
    assert.ok(phases.includes(phase), phase)
  }
  assert.equal(phases.includes('failed'), false)
  assert.equal(probe.events.find((event) => event.phase === 'request')?.allowed, true)
  assert.equal(probe.events.find((event) => event.phase === 'request')?.exact, true)
  assert.equal(probe.events.find((event) => event.phase === 'request')?.mainFrame, true)
  assert.equal(
    probe.events.find((event) => event.phase === 'input_verified')?.documentFocused,
    false
  )
  assert.equal(probe.events.find((event) => event.phase === 'input_verified')?.formValid, true)
  probe.executor.invalidate()
  assert.equal(
    probe.events.some((event) => event.phase === 'failed'),
    false
  )
})

test('search diagnostics retain a rejected request as the first cause through close invalidation', async () => {
  const probe = diagnosticProbe()
  probe.setSubmit(async () => {
    assert.equal(
      probe.executor.request({
        url: `${DESTINATION}&token=private-token`,
        method: 'GET',
        resourceType: 'mainFrame',
      }),
      false
    )
  })
  const prepared = await probe.prepare()
  await assert.rejects(
    probe.executor.execute(prepared, () => true),
    {
      message: 'browser_search_submission_unknown',
      cause: new Error('request_rejected'),
    }
  )
  assert.equal(probe.events.find((event) => event.phase === 'request')?.allowed, false)
  assert.equal(probe.events.find((event) => event.phase === 'request')?.exact, false)
  assert.equal(probe.events.find((event) => event.phase === 'failed')?.reason, 'request_rejected')
  assert.doesNotMatch(JSON.stringify(probe.events), /private-|public|https:|q=/)
})

test('search diagnostics classify invalid dom-ready and revoked authority without broadening effects', async () => {
  const rejected = diagnosticProbe()
  rejected.setSubmit(async () => {
    rejected.contents.emit('dom-ready')
  })
  const prepared = await rejected.prepare()
  await assert.rejects(
    rejected.executor.execute(prepared, () => true),
    {
      message: 'browser_search_submission_unknown',
      cause: new Error('dom_ready_rejected'),
    }
  )
  assert.equal(rejected.events.find((event) => event.phase === 'dom_ready')?.allowed, false)
  const revoked = diagnosticProbe()
  const stale = await revoked.prepare()
  await assert.rejects(
    revoked.executor.execute(stale, () => false),
    { message: 'browser_search_form_stale' }
  )
  assert.equal(
    revoked.events.find((event) => event.phase === 'failed')?.reason,
    'authority_invalid'
  )
  assert.equal(
    revoked.events.some((event) => event.phase === 'effect_issued'),
    false
  )
})

test('a throwing diagnostic observer cannot prevent navigation or rejection', async () => {
  for (const allowed of [true, false]) {
    const probe = diagnosticProbe(() => {
      throw new Error('diagnostic sink unavailable')
    })
    probe.setSubmit(async () => {
      if (allowed) probe.commit()
      else
        assert.equal(
          probe.executor.request({
            url: `${DESTINATION}&extra=1`,
            method: 'GET',
            resourceType: 'mainFrame',
          }),
          false
        )
    })
    const prepared = await probe.prepare()
    if (allowed) await probe.executor.execute(prepared, () => true)
    else
      await assert.rejects(
        probe.executor.execute(prepared, () => true),
        {
          message: 'browser_search_submission_unknown',
          cause: new Error('request_rejected'),
        }
      )
  }
})

test('search waits for rendering cycles before input without requiring native focus', async () => {
  const probe = diagnosticProbe()
  probe.setSubmit(async () => probe.commit())
  const prepared = await probe.prepare()
  await probe.executor.execute(prepared, () => true)
  const phases = probe.events.map((event) => event.phase)
  assert.ok(phases.includes('render_wait'))
  assert.ok(phases.includes('render_cycles'))
  assert.ok(phases.indexOf('render_wait') < phases.indexOf('render_cycles'))
  assert.ok(phases.indexOf('render_cycles') < phases.indexOf('effect_issued'))
  const rendered = probe.events.find((event) => event.phase === 'render_cycles')
  assert.equal(rendered?.viewportPositive, true)
  assert.equal(rendered?.nativeFocused, false)
})

test('search refuses invalid or failed rendering observations before input', async () => {
  for (const scenario of ['empty_viewport', 'invalid_result', 'rejected']) {
    const probe = diagnosticProbe()
    probe.setRender(async () => {
      if (scenario === 'rejected') throw new Error('private-page-content')
      return scenario === 'empty_viewport' ? false : { viewportPositive: true }
    })
    const prepared = await probe.prepare()
    await assert.rejects(
      probe.executor.execute(prepared, () => true),
      {
        message: 'browser_search_form_stale',
      }
    )
    assert.equal(probe.events.find((event) => event.phase === 'failed')?.reason, 'render_not_ready')
    assert.equal(
      probe.events.some((event) => event.phase === 'effect_issued'),
      false
    )
    assert.equal(probe.contents.isDestroyed(), true)
    assert.doesNotMatch(JSON.stringify(probe.events), /private-|public|https:|q=/)
  }
})

test('render waiting shares the execution timeout and abort without late input', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  for (const reason of ['timeout', 'aborted']) {
    const probe = diagnosticProbe()
    let finishRender: (value: boolean) => void = () => {}
    probe.setRender(
      () =>
        new Promise((resolve) => {
          finishRender = resolve
        })
    )
    const prepared = await probe.prepare()
    const execution = assert.rejects(
      probe.executor.execute(prepared, () => true),
      {
        message: 'browser_search_submission_blocked',
      }
    )
    await probe.rendering
    assert.equal(
      probe.events.some((event) => event.phase === 'effect_issued'),
      false
    )
    if (reason === 'timeout') context.mock.timers.tick(15_000)
    else probe.abort.abort()
    await execution
    finishRender(true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(probe.events.find((event) => event.phase === 'failed')?.reason, reason)
    assert.equal(probe.events.filter((event) => event.phase === 'failed').length, 1)
    assert.equal(
      probe.events.some((event) => event.phase === 'effect_issued'),
      false
    )
    assert.equal(
      probe.events.some((event) => event.phase === 'render_cycles'),
      false
    )
    assert.equal(probe.contents.isDestroyed(), true)
    await assert.rejects(
      probe.executor.execute(prepared, () => true),
      {
        message: 'browser_search_form_stale',
      }
    )
  }
})

test('render waiting revalidates authority and target identity before input', async () => {
  for (const reason of ['authority_invalid', 'target_changed']) {
    const probe = diagnosticProbe()
    let authorized = true
    probe.setRender(async () => {
      if (reason === 'authority_invalid') authorized = false
      else probe.changeTarget()
      return true
    })
    const prepared = await probe.prepare()
    await assert.rejects(
      probe.executor.execute(prepared, () => authorized),
      {
        message: 'browser_search_form_stale',
      }
    )
    assert.equal(probe.events.find((event) => event.phase === 'failed')?.reason, reason)
    assert.equal(
      probe.events.some((event) => event.phase === 'effect_issued'),
      false
    )
  }
})

test('always-denied subordinate requests never invoke the authority validator', () => {
  for (const scenario of ['revoked', 'throwing']) {
    let validations = 0
    const boundary = createSearchFormBoundary(DESTINATION, 'q', () => {
      validations += 1
      if (scenario === 'throwing') throw new Error('private-validator-content')
      return false
    })
    const rejectedRequests = () => {
      for (const resourceType of [
        'image',
        'stylesheet',
        'font',
        'script',
        'xhr',
        'ping',
        'webSocket',
        'subFrame',
        'other',
      ]) {
        for (const method of ['GET', 'HEAD', 'POST']) {
          assert.equal(boundary.request({ url: DESTINATION, method, resourceType }), false)
        }
      }
    }
    rejectedRequests()
    assert.equal(validations, 0)
    assert.equal(
      boundary.request({ url: DESTINATION, method: 'GET', resourceType: 'mainFrame' }),
      false
    )
    assert.equal(validations, 1)
    rejectedRequests()
    assert.equal(validations, 1)
  }
})

test('denied resource storms spend no policy budget and do not delay dom-ready', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const probe = diagnosticProbe()
  let storm = false
  let resourceValidations = 0
  probe.setSubmit(async () => {
    probe.commit(() => {
      storm = true
      for (let index = 0; index < 80; index += 1) {
        assert.equal(
          probe.executor.request({
            url: `https://www.bing.com/resource/${index}`,
            method: 'GET',
            resourceType: 'image',
          }),
          false
        )
      }
      storm = false
    })
  })
  const prepared = await probe.prepare()
  await probe.executor.execute(prepared, () => {
    if (storm) {
      resourceValidations += 1
      context.mock.timers.tick(200)
    }
    return true
  })
  assert.equal(resourceValidations, 0)
  assert.equal(
    probe.events.filter((event) => event.phase === 'request' && !event.mainFrame).length,
    0
  )
  assert.equal(probe.events.find((event) => event.phase === 'completed')?.deniedSubresources, 80)
  assert.doesNotMatch(JSON.stringify(probe.events), /private-|public|https:|q=|resource\//)
  assert.equal(probe.events.find((event) => event.phase === 'dom_ready')?.allowed, true)
  assert.equal(
    probe.events.some((event) => event.phase === 'failed'),
    false
  )
})

test('denied resource fast paths cannot authorize a revoked main frame or dom-ready', async () => {
  for (const phase of ['mainFrame', 'dom-ready']) {
    const probe = diagnosticProbe()
    let authorized = true
    probe.setSubmit(async () => {
      const revoke = () => {
        authorized = false
        assert.equal(
          probe.executor.request({ url: DESTINATION, method: 'GET', resourceType: 'image' }),
          false
        )
      }
      if (phase === 'mainFrame') {
        revoke()
        assert.equal(
          probe.executor.request({ url: DESTINATION, method: 'GET', resourceType: 'mainFrame' }),
          false
        )
      } else probe.commit(revoke)
    })
    const prepared = await probe.prepare()
    await assert.rejects(
      probe.executor.execute(prepared, () => authorized),
      {
        message: 'browser_search_submission_unknown',
        cause: new Error('authority_invalid'),
      }
    )
    assert.equal(
      probe.events.find((event) => event.phase === 'failed')?.reason,
      'authority_invalid'
    )
    assert.equal(probe.events.find((event) => event.phase === 'failed')?.deniedSubresources, 1)
    assert.equal(probe.contents.isDestroyed(), true)
  }
})

test('a main-frame request is rejected when its final fresh authority check fails', async () => {
  const probe = diagnosticProbe()
  let checkingRequest = false
  let requestValidations = 0
  let requestAllowed: boolean | undefined
  probe.setSubmit(async () => {
    checkingRequest = true
    requestAllowed = probe.executor.request({
      url: DESTINATION,
      method: 'GET',
      resourceType: 'mainFrame',
    })
    checkingRequest = false
  })
  const prepared = await probe.prepare()
  await assert.rejects(
    probe.executor.execute(prepared, () => {
      if (!checkingRequest) return true
      requestValidations += 1
      return requestValidations === 1
    }),
    {
      message: 'browser_search_submission_unknown',
      cause: new Error('authority_invalid'),
    }
  )
  assert.equal(requestValidations, 2)
  assert.equal(requestAllowed, false)
  assert.equal(probe.events.find((event) => event.phase === 'request')?.allowed, false)
  assert.equal(probe.events.find((event) => event.phase === 'failed')?.reason, 'authority_invalid')
})
