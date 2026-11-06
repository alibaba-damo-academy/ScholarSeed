import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as engine from '../localization/engine.ts'
import * as catalog from '../localization/catalog.ts'
import type * as Localization from './localization'
import type { DesktopNotificationInput } from '../notifications.ts'
import { notificationXml } from './notification.ts'

const source = new URL('./localization.ts', import.meta.url)
const requireResource = createRequire(source)

for (const language of ['zh', 'en'] as const) {
  for (const kind of ['waiting', 'completed', 'failed'] as const) {
    test(`native ${kind} notification preserves plain text in ${language}`, async () => {
      const main = mainInstance()
      await main.applyMainLanguage(language)
      const summary = String.raw`/bin/zsh "quoted" 'single' https://example.test/?a=1&b=2 C:\Users\name <tag> &quot; &#x2F;`
      const resource = requireResource(`../localization/locales/${language}/native.json`)
      const expected = resource.notifications[kind].replace('{{summary}}', summary)
      const captured: DesktopNotificationInput[] = []
      const reminderExports = {} as { DesktopReminders: { prototype: object } }
      const compiled = ts.transpileModule(
        readFileSync(new URL('./reminders.ts', import.meta.url), 'utf8'),
        {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }
      ).outputText
      runInNewContext(compiled, {
        exports: reminderExports,
        require: (name: string) => {
          if (name === './localization') return main
          if (name === './preferences')
            return { loadRendererPreferences: () => ({ soundAlerts: true }) }
          return {}
        },
      })
      const reminder = Object.assign(Object.create(reminderExports.DesktopReminders.prototype), {
        dependencies: {
          windows: { show: (input: DesktopNotificationInput) => captured.push(input) },
        },
        logError: (error: unknown) => {
          throw error
        },
      })
      reminder.show({ id: 'notification-test', kind, title: summary, body: summary })
      assert.equal(captured.length, 1)
      assert.equal(captured[0].body, expected)
      assert.equal(captured[0].title, summary)
      assert.ok(
        notificationXml(captured[0], 'scholarseed://notification/test').includes(
          '&amp;quot; &amp;#x2F;'
        )
      )
      assert.equal(
        main.mainLocalization().getFixedT(null, 'native')('notifications.waiting', {
          summary: '<tag>',
        }),
        resource.notifications.waiting.replace('{{summary}}', '&lt;tag&gt;')
      )
    })
  }
}

for (const [language, expected] of [
  ['zh', '任务已完成：通知复测产物已就绪'],
  ['en', 'Task completed: 通知复测产物已就绪'],
] as const) {
  test(`main completion notification uses task wording and preserves the summary in ${language}`, async () => {
    const main = mainInstance()
    await main.applyMainLanguage(language)
    assert.equal(
      main.mainLocalization().getFixedT(null, 'native')('notifications.completed', {
        summary: '通知复测产物已就绪',
      }),
      expected
    )
  })
}

function mainInstance(): typeof Localization {
  const exports = {}
  const compiled = ts.transpileModule(readFileSync(source, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  runInNewContext(compiled, {
    exports,
    require: (name: string) => {
      if (name === '../localization/engine') return engine
      if (name === '../localization/catalog') return catalog
      return requireResource(name)
    },
  })
  return exports as typeof Localization
}

for (const language of ['zh', 'en'] as const) {
  test(`main seeds the default project from the confirmed ${language} language`, async () => {
    const main = mainInstance()
    await main.applyMainLanguage(language)
    const expected = language === 'en' ? 'Default Project' : '书深默认项目'
    assert.equal(main.mainLocalization().getFixedT(null, 'project')('defaultName'), expected)
  })

  test(`main reports update recovery in ${language} without a localization fallback`, async () => {
    const main = mainInstance()
    await main.applyMainLanguage(language)
    const account = requireResource(`../localization/locales/${language}/account.json`)
    const foundation = requireResource(`../localization/locales/${language}/foundation.json`)
    const native = requireResource(`../localization/locales/${language}/native.json`)
    const recovery = main.startupAdmissionText()
    for (const status of ['installing', 'restoring', 'unconfirmed'] as const)
      assert.equal(recovery[status], native.admissionRecovery[status])
    const message = main.mainLocalization().getFixedT(null, 'account')(
      'update.activationRecoveryRequired'
    )
    assert.equal(message, account.update.activationRecoveryRequired)
    assert.notEqual(message, foundation.startup.failed)
    assert.equal(
      main.mainLocalization().getFixedT(null, 'foundation')('startup.applicationFailed'),
      foundation.startup.applicationFailed
    )
  })
}
