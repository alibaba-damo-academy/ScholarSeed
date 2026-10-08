import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createInstance } from 'i18next'

import { filterProjects, projectFileLabel, projectSummary, projectTimeLabel } from './project.ts'

const localization = createInstance()
await localization.init({ lng: 'zh', resources: { zh: { project: JSON.parse(readFileSync(new URL('../../localization/locales/zh/project.json', import.meta.url), 'utf8')) } } })
const t = localization.getFixedT('zh', 'project')
const format = {
  date: (value: Date | number) => new Date(value).toISOString(),
  number: (value: number) => String(value),
  relative: (value: number) => String(value),
  bytes: (value: number) => String(value)
}

const project = {
  id: '01m1grdrqwwcr7vh9tzh70r2bq',
  name: '钙钛矿稳定性',
  path: '/research/perovskite',
  added_at: 100,
  updated_at: 200,
  file_count: 12
}

test('project summary groups only sessions explicitly assigned to the project', () => {
  const sessions = [
    { id: 'a', title: 'A', status: 'done' as const, projectPath: project.path, activityAt: 300 },
    { id: 'b', title: 'B', status: 'done' as const, projectPath: '/research/other', activityAt: 400 }
  ]
  assert.deepEqual(projectSummary(project, sessions), { chats: 1, activityAt: 300 })
})

test('project search matches user-visible name and local path', () => {
  assert.deepEqual(filterProjects([project], '稳定'), [project])
  assert.deepEqual(filterProjects([project], 'PEROVSKITE'), [project])
  assert.deepEqual(filterProjects([project], 'missing'), [])
})

test('project card labels expose bounded real metadata', () => {
  assert.equal(projectFileLabel(project, t), '12 文件')
  assert.equal(projectFileLabel({ ...project, file_count: 5000, file_count_capped: true }, t), '5000+ 文件')
  assert.equal(projectFileLabel({ ...project, file_count: null, available: false }, t), '目录不可访问')
  assert.equal(projectTimeLabel(100, t, format, 100 + 3 * 60 * 60), '3 小时前')
})
