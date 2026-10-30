import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MODULE_PANEL_DEFAULT_WIDTH,
  MODULE_PANEL_MAX_WIDTH,
  MODULE_PANEL_WIDTH_STEP,
  constrainFloatingPanel,
  floatingPanelDockPosition,
  nearestFloatingPanelDock,
  modulePanelWidthCss,
  parseModulePanelWidth,
  topBarLeftWidth,
  resizeFloatingPanel,
} from './geometry.ts'

test('floating resize keeps the opposite edge fixed and clamps to host and minimum width', () => {
  const panel = { left: 400, width: 388 }
  assert.deepEqual(resizeFloatingPanel(panel, 'left', -100, 1000, 260, 16), {
    left: 300,
    width: 488,
  })
  assert.deepEqual(resizeFloatingPanel(panel, 'right', 100, 1000, 260, 16), {
    left: 400,
    width: 488,
  })
  assert.deepEqual(resizeFloatingPanel(panel, 'left', -900, 1000, 260, 16), {
    left: 16,
    width: 772,
  })
  assert.deepEqual(resizeFloatingPanel(panel, 'right', 900, 1000, 260, 16), {
    left: 400,
    width: 584,
  })
  assert.deepEqual(resizeFloatingPanel(panel, 'left', 900, 1000, 260, 16), {
    left: 528,
    width: 260,
  })
  assert.deepEqual(resizeFloatingPanel(panel, 'right', -900, 1000, 260, 16), {
    left: 400,
    width: 260,
  })
})

test('floating resize fits a host narrower than the minimum', () => {
  assert.deepEqual(resizeFloatingPanel({ left: 16, width: 168 }, 'right', 100, 200, 260, 16), {
    left: 16,
    width: 168,
  })
})

test('floating resize cannot shrink below its initialized width after expansion', () => {
  assert.deepEqual(resizeFloatingPanel({ left: 400, width: 588 }, 'right', -500, 1200, 388, 16), {
    left: 400,
    width: 388,
  })
  assert.deepEqual(resizeFloatingPanel({ left: 400, width: 588 }, 'left', 500, 1200, 388, 16), {
    left: 600,
    width: 388,
  })
})

test('floating conversation snaps to exactly five workspace docks', () => {
  const bounds = {
    hostWidth: 1000,
    hostHeight: 800,
    panelWidth: 388,
    panelHeight: 56,
    minimumTop: 100,
    inset: 16,
  }
  const docks = {
    topLeft: { left: 16, top: 100 },
    topRight: { left: 596, top: 100 },
    bottomLeft: { left: 16, top: 728 },
    bottomRight: { left: 596, top: 728 },
    bottomCenter: { left: 306, top: 728 },
  } as const
  for (const [dock, position] of Object.entries(docks)) {
    assert.deepEqual(floatingPanelDockPosition(dock as keyof typeof docks, bounds), position)
    assert.equal(
      nearestFloatingPanelDock({ left: position.left + 10, top: position.top - 10 }, bounds),
      dock
    )
  }
})

test('floating docks follow resizing and keep the detached compact header inside the host', () => {
  const bounds = {
    hostWidth: 700,
    hostHeight: 500,
    panelWidth: 388,
    panelHeight: 56,
    minimumTop: 100,
    inset: 16,
  }
  assert.deepEqual(floatingPanelDockPosition('bottomCenter', bounds), { left: 156, top: 428 })
  assert.deepEqual(floatingPanelDockPosition('topRight', bounds), { left: 296, top: 100 })
  assert.deepEqual(
    floatingPanelDockPosition('bottomRight', { ...bounds, hostWidth: 300, hostHeight: 120 }),
    { left: 0, top: 100 }
  )
})

test('minimized docking uses the bubble dimensions rather than the expanded conversation', () => {
  const bubble = {
    hostWidth: 1000,
    hostHeight: 800,
    panelWidth: 44,
    panelHeight: 44,
    minimumTop: 64,
    inset: 16,
  }
  assert.deepEqual(floatingPanelDockPosition('bottomRight', bubble), { left: 940, top: 740 })
  assert.deepEqual(floatingPanelDockPosition('bottomCenter', bubble), { left: 478, top: 740 })
  assert.equal(nearestFloatingPanelDock({ left: 650, top: 740 }, bubble), 'bottomCenter')
  assert.equal(nearestFloatingPanelDock({ left: 925, top: 740 }, bubble), 'bottomRight')
  assert.equal(
    nearestFloatingPanelDock(
      { left: 650, top: 740 },
      {
        ...bubble,
        panelWidth: 388,
        panelHeight: 56,
      }
    ),
    'bottomRight'
  )
})

test('floating panels stay inside their workspace even after shrinking the host', () => {
  assert.deepEqual(constrainFloatingPanel({ left: 120, top: 90 }, 900, 700, 400, 300), {
    left: 120,
    top: 90,
  })
  assert.deepEqual(constrainFloatingPanel({ left: -30, top: -20 }, 900, 700, 400, 300), {
    left: 0,
    top: 0,
  })
  assert.deepEqual(constrainFloatingPanel({ left: 800, top: 600 }, 900, 700, 400, 300), {
    left: 500,
    top: 400,
  })
  assert.deepEqual(constrainFloatingPanel({ left: 500, top: 400 }, 300, 200, 400, 300), {
    left: 0,
    top: 0,
  })
  assert.deepEqual(constrainFloatingPanel({ left: 0, top: -20 }, 900, 700, 400, 300, 48), {
    left: 0,
    top: 48,
  })
})

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
