import type { Page } from '@playwright/test'
import assert from 'node:assert/strict'

const CENTER_SELECTORS = {
  create: '[data-testid="home-project-create-top"]',
  projects: '#home-projects-heading',
  project: '[data-testid="home-projects-grid"] > :first-child',
  welcome: '[data-testid="project-center"] h1',
}
const FORM_SELECTORS = {
  dialog: '[data-testid="project-new-modal"]',
  name: '[data-testid="project-create-name"]',
  submit: '[data-testid="project-create"]',
}

export async function projectCenterAppearance(page: Page, phase: 'center' | 'form') {
  await page.evaluate(() => document.fonts.ready)
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running' || animation.effect?.getComputedTiming().iterations === Infinity))
  return page.evaluate(selectors => {
    const elements = Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
      const element = document.querySelector(selector)
      if (!element) throw new Error('Missing comparison element: ' + selector)
      const bounds = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      return [name, {
        bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        font: { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, lineHeight: style.lineHeight, spacing: style.letterSpacing },
        surface: { color: style.color, background: style.backgroundColor, border: style.borderColor, radius: style.borderRadius, padding: style.padding },
      }]
    }))
    return {
      environment: { width: innerWidth, height: innerHeight, scale: devicePixelRatio, language: document.documentElement.lang, theme: document.documentElement.dataset.theme, chromium: navigator.userAgent.match(/Chrome\/(\S+)/)?.[1], electron: navigator.userAgent.match(/Electron\/(\S+)/)?.[1] },
      provenance: { userAgent: navigator.userAgent, focused: document.hasFocus() },
      elements,
    }
  }, phase === 'center' ? CENTER_SELECTORS : FORM_SELECTORS)
}

export function assertProjectCenterAppearance(pdfe: Awaited<ReturnType<typeof projectCenterAppearance>>, normal: Awaited<ReturnType<typeof projectCenterAppearance>>): void {
  assert.equal(pdfe.provenance.focused, true)
  assert.equal(normal.provenance.focused, true)
  assert.deepEqual(pdfe.environment, normal.environment)
  assert.deepEqual(pdfe.elements, normal.elements)
}
