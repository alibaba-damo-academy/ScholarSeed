import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { block } from '../../../../test-helpers/source-contract.ts'

/**
 * 总览空态的数据源契约（Bug 87192946）。
 *
 * Workbench.tsx 是 JSX，运行时 import 会失败，仓库既有做法是把它当契约文本钉住
 * （见 scope.test.ts、store.test.ts）。这里钉的是「项目有无文献」的判据来源：
 * 必须与文献库权威计数 /literatures/counts 同源，且随当前项目刷新；
 * 不得再读不随项目刷新、又带筛选语义的旧 app-store 切片 state.literature.total。
 */
const workbenchSource = readFileSync(new URL('./Workbench.tsx', import.meta.url), 'utf8')
const overview = block(
  workbenchSource,
  'function Overview(): React.JSX.Element {',
  '/**\n * 未选择项目时的工作台内容'
)

test('overview empty state reads the authoritative per-project literature count', () => {
  assert.match(overview, /getLiteratureCounts\(projectId\)/)
  // 计数必须按当前项目作用域拉取，并随项目切换重拉。
  assert.match(overview, /const projectId = state\.homeSelectedProjectId/)
  assert.match(overview, /\}, \[projectId\]\)/)
})

test('overview no longer trusts the stale app-store literature slice', () => {
  // state.literature.total 不随项目切换/启动恢复刷新，且是筛选态计数；用它当判据
  // 会把有文献的项目误报为空。Overview 内不得再出现这个读取。
  assert.doesNotMatch(overview, /state\.literature\.total/)
})

test('overview only reports empty once the authoritative count is known to be zero', () => {
  // 计数未到位（null）或取数失败时不得渲染空态，避免加载期/失败时误报「暂无」。
  assert.match(overview, /literatureTotal === 0/)
  assert.match(overview, /setLiteratureTotal\(null\)/)
  assert.match(overview, /state\.resource\.tree\.length === 0 && literatureTotal === 0/)
})
