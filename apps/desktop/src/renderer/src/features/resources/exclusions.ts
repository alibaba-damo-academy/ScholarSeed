/** Semantic display metadata only; the server remains the policy owner. */
const EXCLUSION_GROUPS = [
  { kind: 'logs', titleKey: 'fileSettings.exclusionLogs', helpKey: 'fileSettings.exclusionLogsHelp', patterns: ['*.log', '*.log.*', 'log/', 'logs/'] },
  { kind: 'process', titleKey: 'fileSettings.exclusionProcess', helpKey: 'fileSettings.exclusionProcessHelp', patterns: ['*.pid', '*.pid.lock', '*.seed'] },
  { kind: 'crashes', titleKey: 'fileSettings.exclusionCrashes', helpKey: 'fileSettings.exclusionCrashesHelp', patterns: ['core', 'core.*', '*.core', '*.dmp', '*.dump', '*.stackdump', 'hs_err_pid*'] },
  { kind: 'temporary', titleKey: 'fileSettings.exclusionTemporary', helpKey: 'fileSettings.exclusionTemporaryHelp', patterns: ['*.tmp', '*.temp', '*.swp', '*.swo', '*~'] },
  { kind: 'system', titleKey: 'fileSettings.exclusionSystem', helpKey: 'fileSettings.exclusionSystemHelp', patterns: ['.DS_Store', 'Thumbs.db'] },
  { kind: 'cache', titleKey: 'fileSettings.exclusionCache', helpKey: 'fileSettings.exclusionCacheHelp', patterns: ['.cache/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '__pycache__/'] },
  { kind: 'testing', titleKey: 'fileSettings.exclusionTesting', helpKey: 'fileSettings.exclusionTestingHelp', patterns: ['.tox/', '.nox/'] },
  { kind: 'coverage', titleKey: 'fileSettings.exclusionCoverage', helpKey: 'fileSettings.exclusionCoverageHelp', patterns: ['.coverage', '.coverage.*', 'coverage/', 'htmlcov/'] },
  { kind: 'dependencies', titleKey: 'fileSettings.exclusionDependencies', helpKey: 'fileSettings.exclusionDependenciesHelp', patterns: ['node_modules/'] },
  { kind: 'environments', titleKey: 'fileSettings.exclusionEnvironments', helpKey: 'fileSettings.exclusionEnvironmentsHelp', patterns: ['.venv/', 'venv/', 'env/'] },
  { kind: 'builds', titleKey: 'fileSettings.exclusionBuilds', helpKey: 'fileSettings.exclusionBuildsHelp', patterns: ['dist/', 'build/', 'out/', 'target/'] },
  { kind: 'frameworks', titleKey: 'fileSettings.exclusionFrameworks', helpKey: 'fileSettings.exclusionFrameworksHelp', patterns: ['.next/', '.nuxt/', '.svelte-kit/', '.parcel-cache/', '.turbo/'] }
] as const
const GROUP_KEY_PREFIX = 'group:'
const PATTERN_KEY_PREFIX = 'pattern:'
const EXCEPTION_PREFIX = '!'
const FOLDER_SUFFIX = '/'
const CUSTOM_EXPLANATION = { kind: 'custom', titleKey: 'fileSettings.exclusionCustom', helpKey: 'fileSettings.exclusionCustomHelp' } as const
const FOLDER_EXPLANATION = { kind: 'folder', titleKey: 'fileSettings.exclusionFolder', helpKey: 'fileSettings.exclusionFolderHelp' } as const
const EXCEPTION_EXPLANATION = { kind: 'exception', titleKey: 'fileSettings.exclusionException', helpKey: 'fileSettings.exclusionExceptionHelp' } as const
export function exclusionExplanation(pattern: string) {
  return EXCLUSION_GROUPS.find(group => group.patterns.some(value => value === pattern))
    ?? (pattern.startsWith(EXCEPTION_PREFIX) ? EXCEPTION_EXPLANATION : pattern.endsWith(FOLDER_SUFFIX) ? FOLDER_EXPLANATION : CUSTOM_EXPLANATION)
}
export function groupedExclusions(patterns: readonly string[]) {
  const groups = new Map<string, { explanation: ReturnType<typeof exclusionExplanation>; patterns: string[] }>()
  for (const pattern of patterns) {
    const explanation = exclusionExplanation(pattern)
    const key = ['custom', 'folder', 'exception'].includes(explanation.kind) ? `${PATTERN_KEY_PREFIX}${pattern}` : `${GROUP_KEY_PREFIX}${explanation.kind}`
    const existing = groups.get(key)
    if (existing) existing.patterns.push(pattern)
    else groups.set(key, { explanation, patterns: [pattern] })
  }
  return [...groups.values()]
}
