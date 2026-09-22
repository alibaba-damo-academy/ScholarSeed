import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MODULE_PANEL_DEFAULT_WIDTH,
  MODULE_PANEL_MAX_WIDTH,
  MODULE_PANEL_WIDTH_STEP,
  modulePanelWidthCss,
  parseModulePanelWidth,
  topBarLeftWidth
} from './geometry.ts'

test('module panel geometry snaps drag widths to whole pixels', () => {
  assert.equal(MODULE_PANEL_WIDTH_STEP, 1)
  assert.equal(parseModulePanelWidth('300.75px'), 301)
  assert.equal(modulePanelWidthCss(parseModulePanelWidth('300.75px')), '301px')
  assert.equal(
    topBarLeftWidth(parseModulePanelWidth('300.75px'), true),
    'calc(357px + var(--vds-resizable-handle-size) / 2 + var(--vds-border-width-1))'
  )
})

test('module panel geometry clamps invalid and out-of-range widths', () => {
  assert.equal(parseModulePanelWidth('invalid'), MODULE_PANEL_DEFAULT_WIDTH)
  assert.equal(parseModulePanelWidth('100px'), MODULE_PANEL_DEFAULT_WIDTH)
  assert.equal(parseModulePanelWidth('900px'), MODULE_PANEL_MAX_WIDTH)
  assert.equal(topBarLeftWidth(parseModulePanelWidth('300.75px'), false), '357px')
})
