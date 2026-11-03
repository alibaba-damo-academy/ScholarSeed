const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync, spawn } = require('node:child_process')
const { packageManagerCommand } = require('../pre/toolchain.cjs')
const ts = require('../../apps/desktop/node_modules/typescript')
const { isolatedCIEnvironment, prepareModelHome, cleanupModelHome,
  validateOfficeCorpus } = require('./model.cjs')
const { prepareSkillHub } = require('./skillhub.cjs')
const { judgeRun } = require('./verdict.cjs')
const { parseNodeEvents, nodeReporterArgs } = require('./events.cjs')
const EXTERNAL_CASES = require('./external-cases.json')
const QUARANTINE = require('./quarantine.json')
const { NODE_ARGS, testFiles, expandTestGlob } = require('../../apps/desktop/scripts/ci/test.cjs')
const { CONTRACT_FILES } = require('../../apps/desktop/scripts/ci/pretest.cjs')

const ROOT = path.resolve(__dirname, '../..')
const DESKTOP = path.join(ROOT, 'apps', 'desktop')
const SERVE = path.join(ROOT, 'apps', 'serve')
const PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const PYTEST_PLUGIN = 'scripts.ci.quality'
const PLAYWRIGHT = path.join(DESKTOP, 'node_modules', '@playwright', 'test', 'cli.js')
const CODEX_TOOLCHAIN = path.join(ROOT, 'scripts', 'pre', 'toolchain.cjs')
const STAGE_TIMEOUT_MS = 1_800_000
const LIVE_TIMEOUT_MS = 3_600_000
const RUN_ALL_TIMEOUT_EXIT_CODE = 124
const DESKTOP_TEST_CONCURRENCY_DEFAULT = 4
const CI_JOB_QUOTA_MAX = 8
// run_all.py 缺省 min(8, CPU)；此处显式接线同语义的 CPU-aware jobs，保持既有默认上限。
const RUN_ALL_DEFAULT_JOBS = 8
// 并发收益只在独占运行面成立：与其他 ci:test/E2E 会话并行时满核反而拖慢（实测 desktop-unit
// 4→10 并发在双运行下 481s→600s）。CI_STAGE_QUOTA 由调度器或调用方按预算显式注入；
// 无显式预算时保持历史默认（desktop 4 / run-all 8），CPU-aware 扩展只走调度器配额。
const STAGE_QUOTA_ENV = 'CI_STAGE_QUOTA'

function ciStageQuota(budget, fallback) {
  const override = Number.parseInt(process.env[STAGE_QUOTA_ENV] || '', 10)
  if (Number.isFinite(override) && override >= 1 && override <= CI_JOB_QUOTA_MAX) return override
  return budget === null ? fallback : Math.max(1, Math.min(CI_JOB_QUOTA_MAX, budget))
}
const NODE_OMISSION_METHOD = 'node-test-skip-pattern'
const SKIP_RESTORE_CONDITIONS = {
  real_model_config: '准备有效的真实模型配置与凭据，使用 --with-external 执行对应原用例并通过',
  skillhub_config: '准备专用 SkillHub 测试 namespace、配置与凭据，使用 --with-external 执行原阶段并通过'
}
const SUPPORTED_PLATFORMS = ['darwin', 'win32']
const PYTEST_ARGS = ['-m', 'pytest', '-q', '-o', 'python_files=test_*.py contract_*.py e2e_*.py']
const SKILLHUB_DENIAL_CHECKS = [
  'read_token_publish_denied', 'read_token_delete_denied',
  'read_token_management_denied', 'file_501_rejected'
]
const FOREIGN_PLATFORM_SKIP = {
  darwin: [
    { title: 'Windows 关闭弹窗：zh light、缩放、键盘与托盘', reason: '必须在真实 Windows 运行，不模拟平台' },
    { title: 'Windows 关闭弹窗：en dark、缩放、键盘与托盘', reason: '必须在真实 Windows 运行，不模拟平台' },
    { title: 'Windows 从统一弹窗退出应用', reason: '必须在真实 Windows 运行' }
  ],
  win32: [
    { title: 'macOS 关闭仍隐藏主窗口，恢复后渲染器与后端保持可用', reason: '仅在 macOS 验证原生关闭行为' }
  ]
}
const NODE_NOT_APPLICABLE = [
  { stage: 'desktop-unit', platform: 'darwin',
    name: 'Windows updater command parses as PowerShell before signature verification',
    reason: 'requires the Windows PowerShell parser' },
  { stage: 'desktop-unit', platform: 'darwin',
    name: 'Windows handshake writer isolates prior errors and reports file failures',
    reason: 'Requires Windows and NSISDIR pointing to the packaging NSIS toolchain' },
  { stage: 'desktop-unit', platform: 'darwin',
    name: 'Windows privilege probe reads the real primary token and creation time',
    reason: 'Requires Windows and NSISDIR pointing to the packaging NSIS toolchain' },
  { stage: 'desktop-unit', platform: 'darwin',
    name: 'Windows privilege diagnostics write valid JSON and preserve the caller error flag',
    reason: 'Requires Windows and NSISDIR pointing to the packaging NSIS toolchain' },
  { stage: 'desktop-pretest', platform: 'win32',
    name: 'Intel macOS runtime probe tolerates Rosetta bootstrap latency' },
  { stage: 'desktop-pretest', platform: 'win32',
    name: 'Generated Skill launcher refuses managed execution without a valid bridge scope' },
  { stage: 'desktop-unit', platform: 'win32',
    name: 'readHdiutilInfoPlist sees a live mount and the sweep sequence re-attaches' },
  { stage: 'desktop-unit', platform: 'win32',
    name: 'a mountable empty DMG fails during installed-app selection' }
]
const NODE_SUMMARY_KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']
const FOREIGN_PYTEST_SKIP_RULES = [
  { platform: 'darwin', stage: 'python-precise-independent',
    prefix: 'tests/integration/precise/test_filesystem.py::WindowsPathTests::',
    reasons: ['Skipped: requires native Windows path resolution'] },
  { platform: 'darwin', stage: 'python-precise-independent',
    prefix: 'tests/integration/precise/test_filesystem.py::LongPathDownloadTests::',
    reasons: ['Skipped: requires native Windows filename validation',
      'Skipped: requires native Windows MAX_PATH boundaries'] },
  { platform: 'darwin', stage: 'python-precise-independent',
    prefix: 'tests/integration/precise/test_filesystem.py::PostOpenGateRoutingTests::',
    reasons: ['Skipped: requires native Windows MAX_PATH boundaries'] },
  { platform: 'darwin', stage: 'python-precise-independent',
    ids: [
      'tests/integration/precise/test_filesystem.py::PaperDlLibraryPathTests::test_guard_passes_incident_shaped_run_directory',
      'tests/integration/precise/test_filesystem.py::PaperDlLibraryPathTests::test_guard_fails_deep_attempt_paths_with_named_state'
    ],
    reasons: ['Skipped: requires native Windows path budget'] },
  { platform: 'darwin', stage: 'python-literature-independent',
    prefix: 'skills/community/literature-review/scripts/test_platform_runtime.py::PlatformRuntimeTest::test_windows_skill_wrapper',
    reasons: ['Skipped: native Windows launcher'] }
]
const MODEL_SKIP_REASONS = new Set([
  'requires an authorized real model configuration',
  'SCHOLARSEED_REAL_HOME is not set',
  'SCHOLARSEED_REAL_HOME is required for the real model flow',
  'Requires an existing DeepSeek connection',
  'Requires real provider credentials',
  'requires explicitly enabled real Codex action acceptance',
  'requires explicitly enabled real model acceptance'
])

function listedExternalCase(project, file, title) {
  return EXTERNAL_CASES.cases.some(item => item.project === project && item.file === file &&
    item.title === title)
}

function nodeOmissions(stageId) {
  return QUARANTINE.nodeCases.filter(item => (item.stage || 'desktop-unit') === stageId)
}

function nodeOmissionPattern(stageId = 'desktop-unit') {
  return `^(${nodeOmissions(stageId).map(item => item.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`
}

function validateNodeOmissions() {
  const seen = new Set()
  for (const item of QUARANTINE.nodeCases) {
    const identity = `${item.stage || 'desktop-unit'}:${item.title}`
    if (seen.has(identity)) throw new Error('duplicate quarantined Node title')
    seen.add(identity)
    const filename = path.join(DESKTOP, item.file)
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'),
      ts.ScriptTarget.Latest, true)
    let matches = 0
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
          node.expression.text === 'test' && node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === item.title) matches += 1
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (matches !== 1) throw new Error(`quarantined Node case missing or ambiguous: ${item.file}:${item.title}`)
  }
}

function validatePlaywrightOmissions(readSource = filename =>
  fs.readFileSync(path.join(DESKTOP, 'e2e', filename), 'utf8')) {
  for (const filename of new Set(QUARANTINE.playwright.map(item => item.file))) {
    const source = ts.createSourceFile(filename, readSource(filename),
      ts.ScriptTarget.Latest, true)
    const importsPolicy = source.statements.some(statement =>
      ts.isImportDeclaration(statement) && statement.moduleSpecifier.text === './fixtures/quarantine' &&
      !statement.importClause?.isTypeOnly &&
      statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(binding => !binding.isTypeOnly &&
        binding.name.text === 'skipQuarantined' &&
        (binding.propertyName?.text || binding.name.text) === 'skipQuarantined'))
    if (!importsPolicy) throw new Error(`quarantined Playwright file lacks policy import: ${filename}`)
    const registered = source.statements.some(statement => {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) return false
      const call = statement.expression
      if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== 'beforeEach' ||
          !ts.isIdentifier(call.expression.expression) || call.expression.expression.text !== 'test') return false
      let invokesPolicy = false
      const visit = node => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
            node.expression.text === 'skipQuarantined') invokesPolicy = true
        ts.forEachChild(node, visit)
      }
      call.arguments.forEach(visit)
      return invokesPolicy
    })
    if (!registered) throw new Error(`quarantined Playwright file lacks policy hook: ${filename}`)
  }
}

function desktopCoverageArgs(quarantine, budget = null) {
  return [path.join(DESKTOP, 'node_modules', 'c8', 'bin', 'c8.js'), process.execPath,
    ...NODE_ARGS,
    `--test-concurrency=${ciStageQuota(budget, DESKTOP_TEST_CONCURRENCY_DEFAULT)}`,
    ...(quarantine ? [`--test-skip-pattern=${nodeOmissionPattern()}`] : []),
    ...testFiles()]
}

function planStages(platform, skillHubEnvironment = process.env, { profile = 'full', quarantine = false, quota = null } = {}) {
  if (!SUPPORTED_PLATFORMS.includes(platform)) throw new Error(`unsupported platform: ${platform}`)
  if (!['full', 'offline'].includes(profile)) throw new Error(`unsupported CI profile: ${profile}`)
  const offline = profile === 'offline'
  if (quarantine && !offline) throw new Error('temporary quarantine requires offline profile')
  // 默认（quota=null）与历史行为一致（desktop 4 / run-all 8）；并行调度器显式传入每 stage 预算。
  const budget = quota ?? null
  const stages = [
    { id: 'skills-source-build', kind: 'python', cwd: ROOT,
      args: ['-m', 'service.cli.prebundle', '--build'],
      env: { PYTHONPATH: [ROOT, SERVE].join(path.delimiter) } },
    { id: 'skills-source-verify', kind: 'python', cwd: ROOT,
      args: ['-m', 'service.cli.prebundle', '--verify-source'],
      env: { PYTHONPATH: [ROOT, SERVE].join(path.delimiter) },
      dependsOn: 'skills-source-build' },
    { id: 'python-public-projection', kind: 'python', cwd: ROOT,
      args: [...PYTEST_ARGS, 'scripts/cd/public/__tests__/test_sync.py',
        'scripts/cd/public/__tests__/test_tooling.py'], reportKind: 'pytest' }
  ]
  if (platform === 'darwin') {
    stages.push({ id: 'python-run-all', kind: 'python', cwd: SERVE,
      dependsOn: 'skills-source-verify',
      args: ['-m', 'tests.run_all', ...(offline ? ['--fast'] : []),
        '--jobs', String(ciStageQuota(budget, RUN_ALL_DEFAULT_JOBS)),        ...(quarantine ? QUARANTINE.suites.flatMap(suite => ['--exclude-suite', suite.id]) : [])],
      quarantine, env: { PYTHONPATH: ROOT },
      reportArg: true, reportKind: 'runall' })
    if (offline) stages.push({ id: 'python-integration-serve', kind: 'skip',
      skipReason: 'real_model_config' })
    stages.push({ id: 'python-serve-independent', kind: 'python', cwd: SERVE,
      args: [...PYTEST_ARGS, 'tests/contract_literature_fulltext.py',
        'tests/contract_literature_papermeta.py', 'tests/contract_pdf_engine.py',
        'tests/contract_ppt.py', 'tests/contract_pptx.py'], env: { PYTHONPATH: [ROOT, SERVE].join(path.delimiter) },
      reportKind: 'pytest' })
    stages.push({ id: 'python-root-independent', kind: 'python', cwd: ROOT,
      args: [...PYTEST_ARGS, 'tests/test_codex_loop.py'], env: { PYTHONPATH: ROOT }, reportKind: 'pytest' })
    stages.push({ id: 'python-precise-independent', kind: 'python', cwd: ROOT,
      args: [...PYTEST_ARGS, 'tests/integration/precise'], env: { PYTHONPATH: [
        path.join(ROOT, 'skills', 'community', 'precise-literature-search', 'scripts'),
        path.join(ROOT, 'skills', 'community', 'precise-literature-search', 'modules', 'search'),
        path.join(ROOT, 'skills', 'community', 'precise-literature-search', 'modules', 'search', 'tools'),
        path.join(ROOT, 'tests', 'integration', 'precise')
      ].join(path.delimiter) }, reportKind: 'pytest', quarantine })
    stages.push({ id: 'python-trace-independent', kind: 'python', cwd: ROOT,
      args: [...PYTEST_ARGS, 'packages/damoatrace/damoatrace/tests'], reportKind: 'pytest' })
    stages.push({ id: 'python-literature-independent', kind: 'python', cwd: ROOT,
      args: [...PYTEST_ARGS, 'skills/community/literature-review/scripts'], reportKind: 'pytest' })
    stages.push({ id: 'python-websearch-independent', kind: 'python', cwd: ROOT,
      args: [...PYTEST_ARGS, 'skills/community/web-search/scripts/test_search.py'], reportKind: 'pytest' })
    stages.push({ id: 'python-agentic-independent', kind: 'python', cwd: ROOT,
      args: [...PYTEST_ARGS, 'skills/community/agentic-search/tools/tests'], reportKind: 'pytest' })
    stages.push({ id: 'python-acceptance-all', kind: 'python', cwd: SERVE,
      args: ['-m', 'tests.acceptance_all'], reportKind: 'acceptance-all',
      requiresLivePrerequisites: !offline, skipReason: offline ? 'real_model_config' : undefined })
    stages.push({ id: 'python-acceptance-p09', kind: 'python', cwd: SERVE,
      args: ['-m', 'tests.acceptance_p09_real'], reportKind: 'acceptance-p09',
      requiresLivePrerequisites: !offline, skipReason: offline ? 'real_model_config' : undefined })
    stages.push({ id: 'python-skillhub', kind: 'python', cwd: SERVE,
      args: ['-m', 'tests.e2e_skillhub', '--config', skillHubEnvironment.SCHOLARSEED_CI_SKILLHUB_CONFIG || '',
        '--url', skillHubEnvironment.SCHOLARSEED_CI_SKILLHUB_URL || '',
        '--read-token-file', skillHubEnvironment.SCHOLARSEED_CI_SKILLHUB_READ_TOKEN_FILE || '',
        '--publish-token-file', skillHubEnvironment.SCHOLARSEED_CI_SKILLHUB_PUBLISH_TOKEN_FILE || '',
        '--packages', skillHubEnvironment.SCHOLARSEED_CI_SKILLHUB_PACKAGES || '',
        '--cache', skillHubEnvironment.SCHOLARSEED_CI_SKILLHUB_CACHE || ''],
      reportArg: true, reportKind: 'skillhub', dependsOn: 'ci-skillhub-prerequisites',
      skipReason: offline ? 'skillhub_config' : undefined })
    stages.push({ id: 'python-trace', kind: 'python', cwd: ROOT,
      args: ['-m', 'damoatrace.tests.e2e_trace_query_cli'] })
  }
  stages.push({ id: 'desktop-pretest', kind: 'npm', cwd: ROOT,
    args: ['--prefix', 'apps/desktop', 'run', 'pretest'], reportKind: 'node-summary',
    env: platform === 'darwin' ? { SCHOLARSEED_NATIVE_MATRIX: '1' } : undefined })
  if (quarantine) {
    const pretest = stages.at(-1)
    pretest.kind = 'node'
    pretest.args = ['--test', ...CONTRACT_FILES.map(filename =>
      path.relative(ROOT, path.resolve(DESKTOP, filename)).split(path.sep).join('/'))]
    stages.push({ id: 'desktop-toolchain', kind: 'node', cwd: ROOT,
      args: ['scripts/pre/toolchain.cjs', 'check'] })
    stages.push({ id: 'desktop-i18n-test', kind: 'node', cwd: DESKTOP,
      args: ['--test', `--test-skip-pattern=${nodeOmissionPattern('desktop-i18n-test')}`,
        'scripts/ci/localization/__tests__/*.test.mjs'], quarantine, reportKind: 'node-summary' })
    stages.push(...QUARANTINE.stages.map(stage => ({ id: stage.id, kind: 'skip',
      skipReason: stage.reason })))
  }
  stages.push({ id: 'desktop-unit', kind: 'node', cwd: DESKTOP,
    args: desktopCoverageArgs(quarantine, budget),
    quarantine, ignoreLifecycle: true,
    reportKind: 'node-summary' })
  stages.push({ id: 'desktop-extra-node', kind: 'node', cwd: ROOT,
    args: ['--experimental-transform-types', '--test',
      ...(quarantine ? [`--test-skip-pattern=${nodeOmissionPattern('desktop-extra-node')}`] : []),
      'scripts/__tests__/ops.test.cjs', 'scripts/__tests__/desktop.test.cjs', 'scripts/__tests__/organization.test.cjs', 'scripts/ci/__tests__/routing.test.cjs',
      'scripts/shared/__tests__/interpreter.test.cjs',
      'scripts/shared/__tests__/source.test.cjs',
      'scripts/cd/public/__tests__/npm.test.mjs', 'scripts/ci/__tests__/test.test.cjs', 'scripts/ci/__tests__/affected.test.mjs',
      'scripts/cd/__tests__/package.test.cjs', 'scripts/cd/__tests__/distribution.test.cjs', 'scripts/ci/__tests__/verdict.test.cjs', 'scripts/ci/__tests__/model.test.cjs',
      'scripts/ci/__tests__/events.test.cjs', 'scripts/ci/__tests__/transport.test.cjs', 'scripts/ci/__tests__/smoke.test.cjs',
      'scripts/ci/__tests__/skillhub.test.cjs', 'scripts/ci/__tests__/progress.test.cjs', 'scripts/ci/__tests__/diagnostics.test.cjs',
      'apps/desktop/scripts/ci/__tests__/visual.test.mjs',
      'apps/desktop/src/renderer/src/features/workbench/office/local-fonts.test.cjs'],
    quarantine, reportKind: 'node-summary' })
  stages.push({ id: 'desktop-bun', kind: 'bun', cwd: DESKTOP,
    args: ['test', 'src/renderer/src/directive.test.js', 'src/renderer/src/drag.test.js'] })
  stages.push({ id: 'desktop-build', kind: 'npm', cwd: ROOT,
    dependsOn: 'skills-source-verify',
    args: ['--prefix', 'apps/desktop', 'run', 'build'] })
  stages.push({ id: 'desktop-e2e', kind: 'playwright', cwd: DESKTOP,
    args: ['test', '--project=smoke', '--project=workbench', '--project=update', '--project=live', '--reporter=json', '--retries=0'],
    dependsOn: 'desktop-build', requiresLivePrerequisites: !offline, profile, quarantine })
  return stages
}

function stageBlockReason(stage, prerequisiteError, completedStages, npmAvailable = true) {
  if (!npmAvailable) return { code: 'npm_invocation_missing' }
  if (prerequisiteError && stage.requiresLivePrerequisites) return { code: 'prerequisite_failed' }
  if (stage.dependsOn && completedStages.find(item => item.id === stage.dependsOn)?.exitCode !== 0) {
    return { code: 'dependency_failed', stage: stage.dependsOn }
  }
  return null
}

function summarizePlaywright(report, platform, profile = 'full', requireAllExternal = false, quarantine = false) {
  if (!report || !Array.isArray(report.suites) || !report.stats || !Array.isArray(report.errors)) {
    throw new Error('invalid Playwright JSON report')
  }
  if (report.errors.length > 0) throw new Error('Playwright reported global errors')
  const cases = []
  const observedExternal = new Set()
  const observedQuarantine = new Set()
  let reportedTests = 0
  const visit = suite => {
    for (const spec of suite.specs || []) {
      for (const entry of spec.tests || []) {
        reportedTests += 1
        const reason = (entry.annotations || []).find(item => item.type === 'skip')?.description || ''
        const foreign = entry.status === 'skipped' && entry.projectName === 'smoke' &&
          spec.file === 'close.spec.ts' && FOREIGN_PLATFORM_SKIP[platform].some(allowed =>
            spec.title === allowed.title && reason === allowed.reason)
        if (foreign) continue
        const results = entry.results || []
        const listed = listedExternalCase(entry.projectName, spec.file, spec.title)
        const external = profile === 'offline' && listed && entry.status === 'skipped' &&
          MODEL_SKIP_REASONS.has(reason)
        const quarantineEntry = QUARANTINE.playwright.find(item => item.project === entry.projectName &&
          item.file === spec.file && item.title === spec.title && item.reason === reason)
        const quarantined = profile === 'offline' && quarantine && entry.status === 'skipped' && quarantineEntry
        if (quarantined) observedQuarantine.add(`${entry.projectName}:${spec.file}:${spec.title}`)
        if (external) observedExternal.add(`${entry.projectName}:${spec.file}:${spec.title}`)
        const passed = entry.status === 'expected' && entry.expectedStatus === 'passed' &&
          results.length === 1 && results[0].status === 'passed' &&
          Array.isArray(results[0].errors) && results[0].errors.length === 0
        cases.push(external || quarantined
          ? { id: `${entry.projectName}:${spec.id}`, status: 'skipped', reason: external ? EXTERNAL_CASES.reason : reason,
            restoreCondition: external ? SKIP_RESTORE_CONDITIONS[EXTERNAL_CASES.reason] :
              quarantineEntry.restoreCondition || QUARANTINE.restoreCondition,
            retries: Math.max(0, results.length - 1), project: entry.projectName,
            file: spec.file, title: spec.title }
          : { id: `${entry.projectName}:${spec.id}`, status: passed ? 'passed' : 'failed',
            retries: Math.max(0, results.length - 1) })
      }
    }
    for (const child of suite.suites || []) visit(child)
  }
  for (const suite of report.suites) visit(suite)
  const counts = ['expected', 'skipped', 'unexpected', 'flaky'].map(key => report.stats[key])
  if (counts.some(value => !Number.isInteger(value) || value < 0) ||
      counts.reduce((sum, value) => sum + value, 0) !== reportedTests) {
    throw new Error('Playwright case count does not match report statistics')
  }
  if (requireAllExternal && EXTERNAL_CASES.cases.some(item =>
    !observedExternal.has(`${item.project}:${item.file}:${item.title}`) &&
    !observedQuarantine.has(`${item.project}:${item.file}:${item.title}`))) {
    throw new Error('Playwright real-model skip policy has missing cases')
  }
  if (requireAllExternal && quarantine && QUARANTINE.playwright.some(item =>
    !observedQuarantine.has(`${item.project}:${item.file}:${item.title}`))) {
    throw new Error('Playwright quarantine policy has missing cases')
  }
  return cases
}

function summarizeRunAll(report, profile = 'full', quarantine = false, selection = null) {
  if (report?.schemaVersion !== 1 || !Array.isArray(report.planned) || !report.planned.length ||
      !Array.isArray(report.results) || !Array.isArray(report.omitted)) {
    throw new Error('invalid Python full-suite report')
  }
  let expectedOmitted = [...(profile === 'offline' ? ['integration_serve'] : []),
    ...(quarantine && profile === 'offline' ? QUARANTINE.suites.map(suite => suite.id) : [])]
  if (selection !== null) {
    const registry = selection?.registry
    const suites = selection?.suites
    if (quarantine || !Array.isArray(registry) || !registry.length ||
        !Array.isArray(suites) || !suites.length ||
        registry.some(suite => typeof suite !== 'string' || !suite) ||
        new Set(registry).size !== registry.length || new Set(suites).size !== suites.length ||
        suites.some(suite => !registry.includes(suite))) {
      throw new Error('invalid Python selected suite plan')
    }
    const expected = registry.filter(suite => suites.includes(suite))
    if (JSON.stringify(expected) !== JSON.stringify(suites) ||
        JSON.stringify(report.planned) !== JSON.stringify(expected)) {
      throw new Error('Python selected suite plan does not match results')
    }
    expectedOmitted = registry.filter(suite => !suites.includes(suite))
  }
  if (report.omitted.length !== expectedOmitted.length ||
      new Set(report.omitted).size !== report.omitted.length ||
      report.omitted.some(suite => !expectedOmitted.includes(suite))) {
    throw new Error('Python full-suite report has unexpected omitted suites')
  }
  const planned = report.planned
  if (planned.some(suite => typeof suite !== 'string' || !suite) || new Set(planned).size !== planned.length) {
    throw new Error('Python full-suite report has invalid or duplicate suites')
  }
  if (planned.some(suite => report.omitted.includes(suite))) {
    throw new Error('Python full-suite planned and omitted suites overlap')
  }
  if (report.results.length !== planned.length) throw new Error('Python full-suite case count mismatch')
  const cases = report.results.map((result, index) => {
    if (result?.suite !== planned[index] ||
        !(result.exitCode === null || Number.isInteger(result.exitCode)) ||
        typeof result.timedOut !== 'boolean' ||
        result.timedOut !== (result.exitCode === RUN_ALL_TIMEOUT_EXIT_CODE)) {
      throw new Error('Python full-suite result does not match planned suite')
    }
    const expectedStatus = result.exitCode === null ? 'missing' : result.exitCode === 0 ? 'passed' : 'failed'
    if (result.status !== expectedStatus) throw new Error('Python full-suite status mismatch')
    return { id: `python-run-all:${result.suite}`, status: result.status === 'passed' ? 'passed' : 'failed',
      retries: 0 }
  })
  if (report.verdict !== (cases.every(item => item.status === 'passed') ? 'pass' : 'fail')) {
    throw new Error('Python full-suite verdict mismatch')
  }
  if (quarantine && profile === 'offline') {
    cases.push(...QUARANTINE.suites.map(suite => ({ id: `python-run-all:${suite.id}`,
      status: 'skipped', reason: suite.reason, retries: 0 })))
  }
  return cases
}

function summarizePytest(report, stageId, exitCode, platform = process.platform, quarantine = false) {
  if (report?.schemaVersion !== 1 || report.exitStatus !== exitCode ||
      !Array.isArray(report.planned) || !Array.isArray(report.cases)) {
    throw new Error('invalid pytest JSON report')
  }
  const planned = new Set(report.planned)
  if (planned.size !== report.planned.length ||
      report.planned.some(nodeid => typeof nodeid !== 'string' || !nodeid)) {
    throw new Error('invalid pytest planned cases')
  }
  const seen = new Set()
  const cases = report.cases.map(item => {
    if (typeof item?.id !== 'string' || !item.id || seen.has(item.id) ||
        !['passed', 'failed', 'skipped'].includes(item.status) ||
        !Number.isInteger(item.retries) || item.retries < 0) {
      throw new Error('invalid or duplicate pytest result')
    }
    seen.add(item.id)
    const parent = item.id.match(/^(.*)::subtest\[\d+\]$/)?.[1]
    if (!planned.has(item.id) && !(parent && planned.has(parent)) &&
        !(item.id.startsWith('collection:') && item.status === 'failed')) {
      throw new Error('unexpected pytest result')
    }
    const foreign = item.status === 'skipped' && item.retries === 0 && FOREIGN_PYTEST_SKIP_RULES.some(rule =>
      rule.platform === platform && rule.stage === stageId &&
      (rule.ids ? rule.ids.includes(item.id) : item.id.startsWith(rule.prefix)) &&
      rule.reasons.includes(item.skipReason))
    const policy = quarantine && QUARANTINE.pytest.find(entry => entry.stage === stageId &&
      entry.id === item.id && item.status === 'skipped' && item.skipReason === `Skipped: ${entry.reason}`)
    return foreign ? null : { id: `${stageId}:${item.id}`, status: item.status, retries: item.retries,
      ...(policy ? { reason: policy.reason, restoreCondition: policy.restoreCondition } : {}) }
  }).filter(Boolean)
  if (!planned.size && (exitCode === 0 || !cases.length ||
      cases.some(item => !item.id.startsWith(`${stageId}:collection:`) || item.status !== 'failed'))) {
    throw new Error('pytest JSON report has no planned cases or collection errors')
  }
  if ([...planned].some(nodeid => !seen.has(nodeid))) throw new Error('missing pytest result')
  return cases
}

function summarizeNodeTests(output, stageId, platform, arch, quarantine = false) {
  const cases = []
  let runNumber = 0
  let summary = null
  let pendingSkips = []
  const finish = () => {
    if (!summary) return
    if (NODE_SUMMARY_KEYS.some(key => !Number.isInteger(summary[key]) || summary[key] < 0) ||
        summary.tests === 0 ||
        summary.pass + summary.fail + summary.cancelled + summary.skipped !== summary.tests ||
        summary.skipped !== summary.skips.length) {
      throw new Error('Node test summary count mismatch')
    }
    const declared = summary.skips.map(skip => ({ skip, policy: QUARANTINE.nodeSkips.find(item =>
      item.stage === stageId && item.platform === platform && item.title === skip.name &&
      item.reason === skip.reason && (!item.quarantine || quarantine)) }))
    const unexpected = declared.filter(({ skip, policy }) => !policy && !NODE_NOT_APPLICABLE.some(exception =>
      exception.stage === stageId && exception.platform === platform &&
      (!exception.arch || exception.arch === arch) && exception.name === skip.name &&
      (!exception.reason || exception.reason === skip.reason))).map(item => item.skip)
    const status = summary.fail || summary.cancelled || summary.todo || unexpected.length ? 'failed' : 'passed'
    runNumber += 1
    cases.push({ id: `${stageId}:node-run-${runNumber}`, status, retries: 0 })
    for (const { skip, policy } of declared) {
      if (policy) cases.push({ id: `${stageId}:node-run-${runNumber}:skip:${skip.name}`,
        status: 'skipped', retries: 0, title: skip.name, reason: skip.reason,
        restoreCondition: policy.restoreCondition, omissionMethod: 'node-declared-skip' })
    }
    for (const [index, skip] of unexpected.entries()) {
      cases.push({ id: `${stageId}:node-run-${runNumber}:skip-${index + 1}:${skip.name}`,
        status: 'failed', retries: 0 })
    }
  }
  for (const line of output.split(/\r?\n/)) {
    const skipped = line.match(/^﹣ (.+?) \([^\n]*?ms\) # (.+)$/)
    if (skipped) pendingSkips.push({ name: skipped[1], reason: skipped[2] })
    const metric = line.match(/^ℹ (tests|pass|fail|cancelled|skipped|todo) (\d+)$/)
    if (!metric) continue
    if (metric[1] === 'tests') {
      finish()
      summary = { tests: Number(metric[2]), skips: pendingSkips }
      pendingSkips = []
    } else if (summary) {
      if (Object.hasOwn(summary, metric[1])) throw new Error('duplicate Node test summary metric')
      summary[metric[1]] = Number(metric[2])
    }
  }
  finish()
  if (!cases.length || pendingSkips.length) throw new Error('missing Node test summary')
  return cases
}

function summarizeAcceptance(output, kind) {
  const finalLine = output.trimEnd().split(/\r?\n/).at(-1)
  let report
  try {
    report = JSON.parse(finalLine)
  } catch {
    throw new Error('Python acceptance final line is not JSON')
  }
  if (!report || !Array.isArray(report.results) || !report.results.length) {
    throw new Error('Python acceptance requires nonempty results')
  }
  const names = new Set()
  const cases = report.results.map(result => {
    if (!result || typeof result.name !== 'string' || !result.name.trim()) {
      throw new Error('Python acceptance result has no name')
    }
    if (names.has(result.name)) throw new Error('Python acceptance has duplicate results')
    names.add(result.name)
    let passed
    if (kind === 'acceptance-all') {
      if (typeof result.ok !== 'boolean' || typeof result.evidence !== 'string') {
        throw new Error('Python acceptance-all result has invalid schema')
      }
      passed = result.ok
    } else if (kind === 'acceptance-p09') {
      if (!['PASS', 'FAIL', 'BLOCKED'].includes(result.verdict) ||
          typeof result.reason !== 'string' || !Array.isArray(result.command) ||
          !result.artifacts || typeof result.artifacts !== 'object' || Array.isArray(result.artifacts)) {
        throw new Error('Python acceptance-p09 result has invalid schema')
      }
      passed = result.verdict === 'PASS'
    } else {
      throw new Error(`unsupported Python acceptance report: ${kind}`)
    }
    return { id: `python-${kind}:${result.name}`, status: passed ? 'passed' : 'failed', retries: 0 }
  })
  const expectedVerdict = kind === 'acceptance-p09' && report.results.some(result => result.verdict === 'FAIL')
    ? 'FAIL'
    : cases.every(item => item.status === 'passed')
      ? 'PASS'
      : kind === 'acceptance-p09' ? 'BLOCKED' : 'FAIL'
  if (report.verdict !== expectedVerdict) throw new Error('Python acceptance verdict mismatch')
  return cases
}

function validateSkillHub(report) {
  if (report?.migration_passed !== true || report.build_approved !== true ||
      report.checks?.exact_namespace !== true ||
      SKILLHUB_DENIAL_CHECKS.some(key => typeof report.checks[key] !== 'string' ||
        !report.checks[key].trim()) ||
      !Array.isArray(report.skills) || !report.skills.length) return false
  const names = new Set()
  return report.skills.every(skill => {
    if (!skill || typeof skill.name !== 'string' || !skill.name.trim() || names.has(skill.name) ||
        typeof skill.version !== 'string' || !skill.version.trim() ||
        typeof skill.fingerprint !== 'string' || !skill.fingerprint.trim() ||
        skill.bytes_and_modes_identical !== true || skill.scans_passed !== true) return false
    names.add(skill.name)
    return true
  })
}

function atomicJSON(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
  fs.renameSync(temporary, filename)
}

function gitSource(directory = ROOT) {
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' })
  if (revision.status !== 0) throw new Error(`cannot resolve source commit: ${revision.stderr}`)
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: directory, encoding: 'utf8' })
  if (status.status !== 0) throw new Error(`cannot inspect source checkout: ${status.stderr}`)
  return { commit: revision.stdout.trim(), clean: status.stdout.length === 0 }
}

function sourceStayedClean(start, end) {
  return start.clean && end.clean && start.commit === end.commit
}

function reportSha256(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
}

function recordSkippedStage(stage, directory, platform, commit) {
  const report = path.join(directory, `${stage.id}.json`)
  atomicJSON(report, { status: 'skipped', reason: stage.skipReason, stage: stage.id })
  return { id: stage.id, platform, commit, status: 'skipped', reason: stage.skipReason,
    exitCode: null, timedOut: false, report, reportSha256: reportSha256(report),
    cases: [{ id: stage.id, status: 'skipped', reason: stage.skipReason, retries: 0 }] }
}

function recordBlockedStage(stage, directory, platform, commit, reason) {
  const report = path.join(directory, `${stage.id}.json`)
  atomicJSON(report, { status: 'blocked', reason, stage: stage.id })
  return { id: stage.id, platform, commit, status: 'blocked', reason,
    exitCode: null, timedOut: false, report, reportSha256: reportSha256(report), cases: [] }
}

function reportsIntact(stages, directory) {
  return stages.every(stage => {
    const expected = path.join(directory, `${stage.id}.json`)
    if (stage.report !== expected || !/^[a-f0-9]{64}$/.test(stage.reportSha256 || '')) return false
    try {
      return reportSha256(expected) === stage.reportSha256
    } catch {
      return false
    }
  })
}

function skipEvidence(stages) {
  return stages.flatMap(stage => stage.cases.filter(item => item.status === 'skipped')
    .map(item => ({ stage: stage.id, ...item,
      restoreCondition: item.restoreCondition || SKIP_RESTORE_CONDITIONS[item.reason] || QUARANTINE.restoreCondition })))
}

function reviewedCodex(run = spawnSync) {
  const result = run(process.execPath, [CODEX_TOOLCHAIN, 'codex'], {
    cwd: ROOT, env: isolatedCIEnvironment(), encoding: 'utf8', timeout: STAGE_TIMEOUT_MS
  })
  const executable = result.stdout?.trim()
  if (result.status !== 0 || !executable || !path.isAbsolute(executable) ||
      !fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`reviewed Codex unavailable: ${result.stderr?.trim() || result.error?.message || 'invalid executable'}`)
  }
  return executable
}

function executable(stage) {
  if (stage.kind === 'python') return [PYTHON, stage.args]
  if (stage.kind === 'node') return [process.execPath, stage.args]
  if (stage.kind === 'bun') return [process.platform === 'win32' ? 'bun.exe' : 'bun', stage.args]
  if (stage.kind === 'playwright') return [process.execPath, [PLAYWRIGHT, ...stage.args]]
  const npmCli = process.env.npm_execpath
  if (!npmCli) throw new Error('quality workflow requires the package-manager context established by pnpm ops ci test --profile quality')
  const manager = packageManagerCommand()
  return [manager.executable, [...manager.args, ...stage.args], manager.shell]
}

function stageLaunch(stage, directory) {
  const raw = path.join(directory, `${stage.id}.json`)
  const [command, declaredArgs, shell] = executable(stage)
  let args = [...declaredArgs]
  let nodeEvents = null
  if (stage.reportKind === 'node-summary' && stage.quarantine) {
    validateNodeOmissions()
    if (!stage.args.includes(`--test-skip-pattern=${nodeOmissionPattern(stage.id)}`)) {
      throw new Error('quarantined Node command does not match policy')
    }
  }
  if (stage.kind === 'node' && stage.reportKind === 'node-summary') {
    const destination = path.resolve(directory, `${stage.id}.node.jsonl`)
    const observed = nodeReporterArgs(args, destination)
    if (observed) {
      args = observed
      nodeEvents = destination
    }
  }
  if (stage.reportArg) args.push('--report', raw)
  if (stage.reportKind === 'pytest') args.push('-p', PYTEST_PLUGIN, '--ci-report', raw)
  if (stage.reportKind === 'pytest' && stage.quarantine) args.push('--ci-quarantine-stage', stage.id)
  const env = { ...isolatedCIEnvironment(), CI: '1' }
  delete env.NODE_TEST_CONTEXT
  Object.assign(env, stage.env)
  if (stage.kind === 'python') {
    env.PATH = [path.dirname(PYTHON), env.PATH].filter(Boolean).join(path.delimiter)
  }
  if (stage.reportKind === 'pytest') {
    env.PYTHONPATH = [env.PYTHONPATH, ROOT].filter(Boolean).join(path.delimiter)
  }
  if (stage.id === 'desktop-e2e') {
    if (stage.quarantine) validatePlaywrightOmissions()
    delete env.SCHOLARSEED_CI_QUARANTINE
    if (stage.quarantine) env.SCHOLARSEED_CI_QUARANTINE = '1'
    env.SCHOLARSEED_ONE_SHOT_E2E = stage.profile === 'offline' ? '0' : '1'
    env.SCHOLARSEED_CONTEXT_SOURCES_E2E = '1'
    if (stage.profile === 'offline') {
      delete env.SCHOLARSEED_REAL_HOME
      delete env.SCHOLARSEED_ACTION_MODEL
      delete env.SCHOLARSEED_ALTERNATE_MODEL
      env.SCHOLARSEED_CI_OFFLINE = '1'
      env.SCHOLARSEED_OFFICE_DOCUMENT = path.join(DESKTOP, 'e2e', 'fixtures',
        'office-corpus', 'doc', 'selection-multipage.doc')
    }
  }
  if (stage.ignoreLifecycle) env.npm_config_ignore_scripts = 'true'
  return { command, args, env, raw, shell, nodeEvents }
}

function summarizeStageResult(stage, directory, platform, commit, launch, result, started) {
  const { command, args, raw } = launch
  fs.writeFileSync(path.join(directory, `${stage.id}.stdout.log`), result.stdout || '')
  fs.writeFileSync(path.join(directory, `${stage.id}.stderr.log`), result.stderr || result.error?.message || String(result.error || ''))
  const exitCode = result.status ?? 1
  let cases = [{ id: stage.id, status: exitCode === 0 ? 'passed' : 'failed', retries: 0 }]
  let reportValid = true
  let reportError = null
  if (stage.kind === 'playwright') {
    try {
      fs.writeFileSync(raw, result.stdout || '')
      cases = summarizePlaywright(JSON.parse(result.stdout), platform, stage.profile,
        stage.profile === 'offline', stage.quarantine)
      if (!cases.length) reportValid = false
    } catch {
      cases = []
      reportValid = false
    }
  } else if (stage.reportKind === 'pytest') {
    try {
      cases = summarizePytest(JSON.parse(fs.readFileSync(raw, 'utf8')), stage.id, exitCode, platform, stage.quarantine)
    } catch {
      cases = []
      reportValid = false
    }
  } else if (stage.reportKind === 'node-summary') {
    try {
      cases = summarizeNodeTests(result.stdout || '', stage.id, platform, process.arch, stage.quarantine)
      if (stage.kind === 'node' && !launch.nodeEvents) {
        throw new Error('Node observations require a direct --test command')
      }
      const observations = launch.nodeEvents
        ? parseNodeEvents(fs.readFileSync(launch.nodeEvents, 'utf8'), stage.id)
        : { available: false, reason: 'not-a-direct-node-test-command' }
      const omittedCases = stage.quarantine ? nodeOmissions(stage.id) : []
      cases.push(...omittedCases.map(item => ({ id: `${stage.id}:quarantine:${item.file}:${item.title}`,
        status: 'skipped', reason: item.reason, retries: 0, file: item.file,
        title: item.title, restoreCondition: item.restoreCondition || QUARANTINE.restoreCondition,
        omissionMethod: NODE_OMISSION_METHOD })))
      atomicJSON(raw, { schemaVersion: 1, command: [command, ...args], omittedCases, cases, observations })
    } catch (error) {
      cases = []
      reportValid = false
      reportError = error.message
    }
  } else if (stage.reportKind?.startsWith('acceptance-')) {
    try {
      fs.writeFileSync(raw, result.stdout || '')
      cases = summarizeAcceptance(result.stdout || '', stage.reportKind)
    } catch {
      cases = []
      reportValid = false
    }
  } else if (stage.reportArg) {
    try {
      const payload = JSON.parse(fs.readFileSync(raw, 'utf8'))
      if (stage.reportKind === 'runall') cases = summarizeRunAll(payload,
        stage.args.includes('--fast') ? 'offline' : 'full', stage.quarantine, stage.selection ?? null)
      const valid = stage.reportKind === 'skillhub'
        ? validateSkillHub(payload)
        : stage.reportKind === 'runall'
      if (!valid) {
        reportValid = false
      }
    } catch {
      reportValid = false
    }
  } else {
    atomicJSON(raw, { command: [command, ...args], exitCode, durationMs: Date.now() - started })
  }
  return { id: stage.id, platform, commit, exitCode, timedOut: result.error?.code === 'ETIMEDOUT',
    report: reportValid ? raw : null,
    reportSha256: reportValid ? reportSha256(raw) : null,
    cases, durationMs: Date.now() - started, ...(reportError ? { reportError } : {}) }
}

function formatStageProgress(stageId, status, durationMs, timestamp = new Date()) {
  const duration = Number.isFinite(durationMs) ? ` duration=${(durationMs / 1000).toFixed(3)}s` : ''
  return `[ci:test] [${timestamp.toISOString()}] ${stageId} ${status}${duration}\n`
}

function logStageResult(record) {
  const status = record.status === 'skipped'
    ? `skipped=${record.reason}` : `exit=${record.exitCode ?? 'blocked'}`
  process.stderr.write(formatStageProgress(record.id, status, record.durationMs))
}

function runStage(stage, directory, platform, commit) {
  const launch = stageLaunch(stage, directory)
  const started = Date.now()
  let result
  if (stage.progress) {
    const progress = path.join(directory, `${stage.id}.progress`)
    fs.mkdirSync(progress)
    const spec = { id: stage.id, command: launch.command, args: launch.args, cwd: stage.cwd,
      shell: launch.shell, timeout: stage.id === 'desktop-e2e' ? LIVE_TIMEOUT_MS : STAGE_TIMEOUT_MS,
      progress, stdout: path.join(directory, `${stage.id}.stdout.log`),
      stderr: path.join(directory, `${stage.id}.stderr.log`),
      result: path.join(directory, `${stage.id}.process.json`) }
    const request = path.join(directory, `${stage.id}.launch.json`)
    fs.writeFileSync(request, JSON.stringify(spec))
    const wrapper = spawnSync(process.execPath, [path.join(__dirname, 'progress.cjs'), request], {
      cwd: stage.cwd, env: { ...launch.env, CI_PROGRESS_DIRECTORY: progress }, stdio: 'inherit', shell: false
    })
    result = fs.existsSync(spec.result) ? JSON.parse(fs.readFileSync(spec.result, 'utf8'))
      : { status: wrapper.status, error: wrapper.error || { code: 'EPROGRESS', message: 'missing child exit record' } }
    result.stdout = fs.existsSync(spec.stdout) ? fs.readFileSync(spec.stdout, 'utf8') : ''
    result.stderr = fs.existsSync(spec.stderr) ? fs.readFileSync(spec.stderr, 'utf8') : ''
  } else {
    result = spawnSync(launch.command, launch.args, { cwd: stage.cwd, env: launch.env, encoding: 'utf8',
      shell: launch.shell,
      timeout: stage.id === 'desktop-e2e' ? LIVE_TIMEOUT_MS : STAGE_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024 })
  }
  return summarizeStageResult(stage, directory, platform, commit, launch, result, started)
}

// CPU-aware 核数预算：默认满核串行（与旧行为一致）；CI_PARALLEL=1 且非 full profile
// 时按核数并行独立依赖分支。full（发布级证据）保持确定性串行，需显式 CI_PARALLEL=1 才放开。
const PARALLEL_ENV_FLAG = 'CI_PARALLEL'
const PARALLEL_PROFILES = ['offline']

function stageQuota(stage, cpus) {
  if (stage.kind === 'playwright') return Math.max(2, Math.ceil(cpus / 2))
  return Math.max(1, cpus - 1)
}

function planQuotas(planned, parallel, cpus = os.cpus().length) {
  const runnable = planned.filter(item => !item.skipReason)
  const total = Math.max(2, cpus - 1)
  // 串行兼容: 首个可运行 stage 独享全部预算（历史 env 语义）。
  if (!parallel) return new Map([[runnable[0]?.id, total]])
  // 并行: 按声明权重比例切分核预算，向下取整保底 1，余数按权重降序补齐，总量恒等预算。
  const weights = runnable.map(stage => ({ id: stage.id, want: stageQuota(stage, cpus) }))
  const sum = weights.reduce((acc, item) => acc + item.want, 0)
  const quota = new Map(weights.map(item => [item.id, Math.max(1, Math.floor(item.want * total / sum))]))
  let leftover = total - [...quota.values()].reduce((acc, value) => acc + value, 0)
  for (const item of [...weights].sort((a, b) => b.want - a.want)) {
    if (leftover <= 0) break
    quota.set(item.id, quota.get(item.id) + 1)
    leftover -= 1
  }
  return quota
}

function scheduleStages({ planned, directory, platform, commit, prerequisiteError, npmAvailable,
  parallel, quota = null, onSettled }) {
  const effectiveQuota = quota ?? planQuotas(planned, parallel)
  const pending = new Map(planned.map(stage => [stage.id, stage]))
  const settled = new Map()
  const running = new Map()
  const launchErrors = []
  const blockedDependents = new Set()
  let usedQuota = 0
  let resolveDone
  const done = new Promise(resolve => { resolveDone = resolve })
  const tryResolve = () => { if (!pending.size && !running.size) resolveDone([...settled.values()]) }
  const finish = record => {
    settled.set(record.id, record)
    pending.delete(record.id)
    usedQuota -= effectiveQuota.get(record.id) || 1
    logStageResult(record)
    onSettled?.(record)
    pump()
    tryResolve()
  }
  function pump() {
    for (const stage of [...pending.values()]) {
      if (running.has(stage.id)) continue
      if (stage.dependsOn && !settled.has(stage.dependsOn)) continue
      const dependencyFailed = blockedDependents.has(stage.dependsOn) ||
        (stage.dependsOn && settled.get(stage.dependsOn).exitCode !== 0)
      if (dependencyFailed) {
        blockedDependents.add(stage.id)
        finish(recordBlockedStage(stage, directory, platform, commit,
          { code: 'dependency_failed', stage: stage.dependsOn }))
        continue
      }
      const cost = effectiveQuota.get(stage.id) || 1
      if (running.size && usedQuota + cost > Math.max(2, os.cpus().length - 1)) continue
      const reason = stage.skipReason ? null
        : stageBlockReason(stage, prerequisiteError, [...settled.values()], npmAvailable)
      let record
      if (stage.skipReason) {
        record = recordSkippedStage(stage, directory, platform, commit)
      } else if (reason) {
        record = recordBlockedStage(stage, directory, platform, commit, reason)
      } else {
        let launch
        try {
          launch = stageLaunch(stage, directory)
        } catch (error) {
          // 同步抛出会穿透 async main 导致整个 run 静默消失；记录并停止本轮调度，
          // 由 scheduleStages 统一 reject，main 走既有错误路径输出可诊断信息。
          launchErrors.push({ stage: stage.id, message: error.message })
          break
        }
        const env = { ...launch.env, CI_STAGE_QUOTA: String(cost) }
        const started = Date.now()
        process.stderr.write(formatStageProgress(stage.id, 'starting'))
        const child = spawn(launch.command, launch.args, { cwd: stage.cwd, env, encoding: 'utf8',
          shell: launch.shell,
          timeout: stage.id === 'desktop-e2e' ? LIVE_TIMEOUT_MS : STAGE_TIMEOUT_MS })
        let stdout = ''
        let stderr = ''
        child.stdout?.on('data', chunk => { stdout += chunk })
        child.stderr?.on('data', chunk => { stderr += chunk })
        child.on('error', error => {
          running.delete(stage.id)
          finish(summarizeStageResult(stage, directory, platform, commit, launch,
            { stdout, stderr: String(error), error }, started))
        })
        child.on('close', (status, signal) => {
          running.delete(stage.id)
          finish(summarizeStageResult(stage, directory, platform, commit, launch,
            { stdout, stderr, status, error: signal === 'SIGTERM' ? { code: 'ETIMEDOUT' } : null }, started))
        })
        running.set(stage.id, child)
        usedQuota += cost
        continue
      }
      finish(record)
    }
  }
  pump()
  if (launchErrors.length) {
    const [first] = launchErrors
    return Promise.reject(new Error(`scheduled stage launch failed during planning: ${first.stage}: ${first.message}`))
  }
  return done
}

function qualityResultPath(argv, root = ROOT) {
  const resultIndex = argv.indexOf('--result')
  if (resultIndex >= 0 && !argv[resultIndex + 1]) throw new Error('--result requires a path')
  return resultIndex >= 0 ? path.resolve(argv[resultIndex + 1]) : path.join(root, 'tmp', 'ci-test', 'quality.json')
}

async function main(argv = process.argv.slice(2)) {
  const profile = argv.includes('--with-external') ? 'full' : 'offline'
  const quarantine = profile === 'offline' && !argv.includes('--strict')
  const resultPath = qualityResultPath(argv)
  fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true })
  const directory = fs.mkdtempSync(path.join(ROOT, 'tmp', 'ci-test-'))
  const source = gitSource()
  const commit = source.commit
  const platform = process.platform
  const stages = []
  let modelHome = null
  let officeCorpusVersion = null
  let prerequisiteError = null
  let skillHubEnvironment = process.env
  let skillHubError = null
  try {
    if (!SUPPORTED_PLATFORMS.includes(platform)) throw new Error(`unsupported platform: ${platform}`)
    if (!process.env.npm_execpath) throw new Error('quality workflow requires the package-manager context established by pnpm ops ci test --profile quality')
    if (!source.clean) throw new Error('ci:test requires a clean source checkout')
    process.env.SCHOLARSEED_CODEX_EXECUTABLE = reviewedCodex()
    if (profile === 'full') {
      modelHome = prepareModelHome(directory)
      process.env.SCHOLARSEED_REAL_HOME = modelHome.home
    } else {
      officeCorpusVersion = validateOfficeCorpus(process.env)
    }
  } catch (error) {
    prerequisiteError = error
  }
  if (platform === 'darwin' && profile === 'full') {
    try {
      skillHubEnvironment = prepareSkillHub(directory)
    } catch (error) {
      skillHubError = error
    }
  }
  try {
    const prerequisiteReport = path.join(directory, 'ci-prerequisites.json')
    atomicJSON(prerequisiteReport, { status: prerequisiteError ? 'failed' : 'passed',
      reason: prerequisiteError?.message || null,
      models: modelHome ? { action: process.env.SCHOLARSEED_ACTION_MODEL,
        alternate: process.env.SCHOLARSEED_ALTERNATE_MODEL } : null,
      officeCorpusVersion: modelHome?.officeCorpusVersion || officeCorpusVersion })
    stages.push({ id: 'ci-prerequisites', platform, commit, exitCode: prerequisiteError ? 1 : 0,
      timedOut: false, report: prerequisiteReport, reportSha256: reportSha256(prerequisiteReport),
      cases: [{ id: 'ci-prerequisites', status: prerequisiteError ? 'failed' : 'passed', retries: 0 }] })
    if (platform === 'darwin') {
      if (profile === 'offline') {
        stages.push(recordSkippedStage({ id: 'ci-skillhub-prerequisites',
          skipReason: 'skillhub_config' }, directory, platform, commit))
      } else {
        const skillHubReport = path.join(directory, 'ci-skillhub-prerequisites.json')
        atomicJSON(skillHubReport, { status: skillHubError ? 'failed' : 'passed',
          reason: skillHubError?.message || null,
          namespace: skillHubError ? null : skillHubEnvironment.SCHOLARSEED_CI_SKILLHUB_NAMESPACE,
          version: skillHubError ? null : skillHubEnvironment.SCHOLARSEED_CI_SKILLHUB_VERSION })
        stages.push({ id: 'ci-skillhub-prerequisites', platform, commit, exitCode: skillHubError ? 1 : 0,
          timedOut: false, report: skillHubReport, reportSha256: reportSha256(skillHubReport),
          cases: [{ id: 'ci-skillhub-prerequisites', status: skillHubError ? 'failed' : 'passed', retries: 0 }] })
      }
    }
    const planned = SUPPORTED_PLATFORMS.includes(platform)
      ? planStages(platform, skillHubEnvironment, { profile, quarantine }) : []
    const parallel = process.env[PARALLEL_ENV_FLAG] === '1' && PARALLEL_PROFILES.includes(profile)
    if (parallel) {
      await scheduleStages({ planned, directory, platform, commit, prerequisiteError,
        npmAvailable: Boolean(process.env.npm_execpath),
        onSettled: record => stages.push(record) })
    } else {
      for (const stage of planned) {
        process.stderr.write(formatStageProgress(stage.id, 'starting'))
        const reason = stage.skipReason ? null :
          stageBlockReason(stage, prerequisiteError, stages, Boolean(process.env.npm_execpath))
        if (stage.skipReason) {
          stages.push(recordSkippedStage(stage, directory, platform, commit))
        } else if (reason) {
          stages.push(recordBlockedStage(stage, directory, platform, commit, reason))
        } else {
          stages.push(runStage(stage, directory, platform, commit))
        }
        const completed = stages.at(-1)
        logStageResult(completed)
      }
    }
    let sourceAtEnd
    try {
      sourceAtEnd = gitSource()
    } catch (error) {
      sourceAtEnd = { commit: null, clean: false, error: error.message }
    }
    const sourceClean = sourceStayedClean(source, sourceAtEnd)
    const reportEvidenceIntact = reportsIntact(stages, directory)
    const plannedStages = ['ci-prerequisites',
      ...(platform === 'darwin' ? ['ci-skillhub-prerequisites'] : []),
      ...planned.map(stage => stage.id)]
    const expected = stages.flatMap(stage => stage.cases.map(item => item.id))
    const verdict = judgeRun({ platform, commit, profile, quarantine, sourceClean, reportsIntact: reportEvidenceIntact,
      plannedStages, expected, stages })
    const skips = skipEvidence(stages)
    const quality = { schemaVersion: 1, platform, commit, profile, quarantine,
      quarantinePolicy: quarantine ? QUARANTINE : null,
      validationScope: quarantine ? 'deterministic_with_declared_quarantine' :
        profile === 'offline' ? 'deterministic_without_external_model_and_skillhub' : 'full',
      skips, plannedStages, sourceClean, sourceAtEnd,
      reportsIntact: reportEvidenceIntact, runDirectory: directory,
      stages, ...verdict }
    atomicJSON(resultPath, quality)
    process.stdout.write(`${JSON.stringify({ result: resultPath, platform, commit, verdict: verdict.verdict })}\n`)
    return verdict.verdict === 'pass' ? 0 : 1
  } finally {
    cleanupModelHome(modelHome)
  }
}

module.exports = { atomicJSON, reportSha256, gitSource, sourceStayedClean, reportsIntact, reviewedCodex, recordSkippedStage, recordBlockedStage, nodeOmissionPattern, validateNodeOmissions, expandTestGlob, planStages, stageBlockReason, summarizePlaywright, summarizeRunAll,
  summarizeAcceptance, summarizePytest, summarizeNodeTests, validateSkillHub, validatePlaywrightOmissions, skipEvidence, runStage,
  stageLaunch, summarizeStageResult, planQuotas, scheduleStages, formatStageProgress, qualityResultPath, main }

if (require.main === module) {
  main().then(code => { process.exitCode = code }, error => {
    console.error(`[ci:test] ${error.message}`)
    process.exitCode = 1
  })
}
