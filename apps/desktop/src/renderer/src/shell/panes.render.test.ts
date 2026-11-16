import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { chromium, expect } from '@playwright/test'
import { build } from 'esbuild'
import tailwindcss from '@tailwindcss/postcss'
import postcss from 'postcss'
import ts from 'typescript'

const DESKTOP = path.resolve(import.meta.dirname, '../../../..')
const TOLERANCE_PX = 1
const RATIOS = [0.2, 0.37, 0.65, 0.8]
const WIDTHS = [420, 800, 1000]

test('workspace actions and native title inset stay inside the first and last tab panes', async () => {
  const workspace = ts.createSourceFile(
    'Workspace.tsx',
    readFileSync(path.join(import.meta.dirname, 'Workspace.tsx'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const tabs = ts.createSourceFile(
    'TabBar.tsx',
    readFileSync(path.join(import.meta.dirname, 'TabBar.tsx'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  let header: ts.JsxElement | undefined
  let workspaceClass: ts.Expression | undefined
  const declarations = new Map<string, string>()
  const visitWorkspace = (node: ts.Node): void => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(workspace) === 'header') {
      if (node.getText(workspace).includes('<TabBar')) header = node
    }
    if (ts.isJsxOpeningElement(node)) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute)
      if (
        attributes.some(
          (attribute) =>
            attribute.name.getText(workspace) === 'data-testid' &&
            attribute.initializer &&
            ts.isStringLiteral(attribute.initializer) &&
            attribute.initializer.text === 'project-workspace'
        )
      ) {
        const value = attributes.find(
          (attribute) => attribute.name.getText(workspace) === 'className'
        )?.initializer
        if (value && ts.isJsxExpression(value)) workspaceClass = value.expression
      }
    }
    ts.forEachChild(node, visitWorkspace)
  }
  const visitTabs = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (['renderPane', 'renderSplitTabs'].includes(node.name.text)) {
        declarations.set(node.name.text, `const ${node.getText(tabs)}`)
      }
    }
    ts.forEachChild(node, visitTabs)
  }
  visitWorkspace(workspace)
  visitTabs(tabs)
  assert.ok(header)
  assert.ok(workspaceClass)
  assert.equal(declarations.size, 2)
  const bundle = await build({
    stdin: {
      resolveDir: DESKTOP,
      loader: 'tsx',
      contents: `
        import React, {useState} from 'react'
        import {createRoot} from 'react-dom/client'
        import {MessageCircle, Minimize2, Maximize2, PanelRight} from 'lucide-react'
        import {Button, IconButton, Tooltip} from './src/renderer/src/components/ui'
        import {DOCK_DIVIDER_SIZE} from './src/renderer/src/features/workbench/layout'
        const t = value => value
        const PROJECT_GUIDE_ANCHORS = {workspace:'workspace',closeWorkspace:'closeWorkspace'}
        const patch = () => {}
        const changeLayout = () => {}
        const setTabOverflowTarget = () => {}
        const tabOverflowTarget = null
        const NewTabButton = () => <IconButton label="New tab" icon={<MessageCircle/>}/>
        function Fixture() {
          const [scenario,setScenario] = useState({width:800,ratio:0.5,leading:false,full:false})
          window.setScenario = setScenario
          const state = {modulePanelOpen:!scenario.leading}
          const conversationFull = false
          const conversationHeaderLeading = !scenario.leading
          const conversationMode = scenario.full ? 'hidden' : 'split'
          const layout = {full:scenario.full,taskTab:scenario.full,open:true}
          const sidebarToggle = <IconButton label="Sidebar" icon={<PanelRight/>}/>
          const workspaceControls = <IconButton label="Workspace controls" icon={<MessageCircle/>}/>
          function TabBar({leading:leadingAction,actions,trailing}) {
            ${declarations.get('renderPane')}
            const renderLeafTabs = (leaf,leading,last) => renderPane(
              <div className="flex min-w-0 flex-1 overflow-hidden">
                <Button className="min-w-0 flex-1">{leaf.id}</Button>{trailing(leaf)}
              </div>,leaf,leading,last)
            ${declarations.get('renderSplitTabs')}
            return renderSplitTabs({kind:'split',direction:'horizontal',ratio:scenario.ratio,
              first:{kind:'leaf',id:'first'},second:{kind:'leaf',id:'last'}},true,true)
          }
          return <div style={{width:scenario.width}}>
            <div className={${workspaceClass.getText(workspace)}} data-testid="project-workspace">
              <section className="w-full min-w-0" data-testid="workspace-content">
                ${header.getText(workspace)}
              </section>
            </div>
          </div>
        }
        window.scholarseed = {platform:'darwin'}
        window.dividerSize = DOCK_DIVIDER_SIZE
        createRoot(document.getElementById('root')).render(<Fixture/>)
      `,
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'import.meta.env.DEV': 'false' },
    loader: { '.css': 'empty', '.svg': 'dataurl', '.png': 'dataurl' },
  })
  const stylesheet = path.join(DESKTOP, 'src/renderer/src/styles.css')
  const styles = await postcss([tailwindcss({ base: path.join(DESKTOP, 'src/renderer') })]).process(
    readFileSync(stylesheet, 'utf8'),
    { from: stylesheet }
  )
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 600 } })
    await page.setContent('<div id="root"></div>')
    await page.addStyleTag({ content: styles.css })
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    for (const platform of ['darwin', 'win32']) {
      await page.evaluate((value) => {
        Reflect.get(window, 'scholarseed').platform = value
      }, platform)
      for (const leading of [false, true]) {
        for (const full of [false, true]) {
          for (const width of WIDTHS) {
            for (const ratio of RATIOS) {
              await page.evaluate((scenario) => Reflect.get(window, 'setScenario')(scenario), {
                width,
                ratio,
                leading,
                full,
              })
              await expect
                .poll(async () => {
                  const host = await page.getByTestId('workspace-content').boundingBox()
                  const divider = await page.getByTestId('navigation-split-divider').boundingBox()
                  const dividerSize = await page.evaluate(() => Reflect.get(window, 'dividerSize'))
                  assert.ok(host && divider)
                  return Math.abs(divider.x - (host.x + (host.width - dividerSize) * ratio))
                })
                .toBeLessThanOrEqual(TOLERANCE_PX)
              await expect(page.locator('[data-navigation-leaf]')).toHaveCount(2)
              await expect(
                page.locator('[data-navigation-leaf="last"]').getByTestId('workbench-actions')
              ).toBeVisible()
              if (leading) {
                await expect(
                  page
                    .locator('[data-navigation-leaf="first"]')
                    .getByRole('button', { name: 'Sidebar', exact: true })
                ).toBeVisible()
              }
            }
          }
        }
      }
    }
  } finally {
    await browser.close()
  }
})
