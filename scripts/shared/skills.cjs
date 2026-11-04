#!/usr/bin/env node
// 只读校验已审核源码库存和依赖政策。发布清单由 Serve 从这些输入生成。
// 零第三方依赖（只用 node 内置模块），因此 git 钩子无需 node_modules 即可运行。
// 消费方：apps/desktop/scripts/cd/__tests__/build.test.cjs 的同名门禁、.husky/pre-push。
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const PACKAGE_MANIFEST = '.scholarseed-package.json'
const SKILL_MANIFEST = 'SKILL.md'
const LOCK_FILE = 'skills.lock.json'
const REGISTRY_FILE = 'registry.json'
const COMMUNITY_DIR = 'community'
const DEFAULTS_DIR = 'apps/serve/service/capabilities/defaults'
const LOCK_PROTOCOL_VERSION = 3
const EXCLUDED_NAMES = new Set(['__pycache__', '.DS_Store', '.git', '.pytest_cache'])
const EXCLUDED_SUFFIXES = ['.pyc', '.pyo']
const REGENERATE_HINT =
  '按 skills/ADAPTATION.md §3 生成并审核受影响的 lock 行'

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function canonical(value) {
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    )
  }
  return value
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// 源码根下带 SKILL.md 的技能目录名（稳定排序）。
function sourceSkillNames(sourceRoot) {
  if (!fs.existsSync(sourceRoot)) {
    return []
  }
  return fs
    .readdirSync(sourceRoot)
    .filter((name) => fs.existsSync(path.join(sourceRoot, name, SKILL_MANIFEST)))
    .sort()
}

function inventory(root, prefix = '') {
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (EXCLUDED_NAMES.has(entry.name) || EXCLUDED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) return []
    const relative = prefix + entry.name
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) return inventory(absolute, relative + '/')
    if (!prefix && entry.name === '.scholarseed.json' && entry.isFile()) return []
    return [[relative, entry.isFile() ? absolute : null]]
  })
}

/**
 * 返回全部一致性违规；空数组代表一致。
 * @param {string} repoRoot 仓库根目录
 * @returns {string[]} 违规描述列表
 */
function skillLockProblems(repoRoot) {
  const skillsRoot = path.join(repoRoot, 'skills')
  const sourceRoot = path.join(skillsRoot, COMMUNITY_DIR)
  const problems = []

  const lockFile = path.join(skillsRoot, LOCK_FILE)
  const registryFile = path.join(skillsRoot, REGISTRY_FILE)
  if (!fs.existsSync(lockFile) || !fs.existsSync(registryFile)) {
    return [`缺少 ${LOCK_FILE} 或 ${REGISTRY_FILE}，无法校验技能清单一致性`]
  }
  const lock = readJson(lockFile)
  if (lock.protocol_version !== LOCK_PROTOCOL_VERSION || lock.source !== 'repository') {
    return [`${LOCK_FILE}: 不支持的源码 lock 格式；${REGENERATE_HINT}`]
  }
  const registry = readJson(registryFile)
  const declared = (registry.dependencies && registry.dependencies) || {}

  const locked = Array.isArray(lock.skills) ? lock.skills : []
  const sourceNames = sourceSkillNames(sourceRoot)
  const lockedNames = locked.map((skill) => skill.slug).sort()
  for (const missing of sourceNames.filter((name) => !lockedNames.includes(name))) {
    problems.push(`${missing}: 源码存在但 ${LOCK_FILE} 缺少该技能行`)
  }
  for (const extra of lockedNames.filter((name) => !sourceNames.includes(name))) {
    problems.push(`${extra}: ${LOCK_FILE} 有该技能行但源码根下不存在`)
  }

  for (const skill of locked) {
    const slug = skill.slug
    if (!Object.hasOwn(declared, slug)) {
      problems.push(
        `${slug}: ${REGISTRY_FILE} 的 dependencies 缺少该技能条目；依赖政策以 ${REGISTRY_FILE} ` +
          `为单一来源，请由技能 owner 确认应声明什么后补上`
      )
    } else if (
      JSON.stringify(canonical(skill.dependencies)) !== JSON.stringify(canonical(declared[slug]))
    ) {
      problems.push(`${slug}: lock 的 dependencies 与 ${REGISTRY_FILE} 不一致；${REGENERATE_HINT}`)
    }

    const expected = new Map((skill.files || []).map((file) => [file.path, file]))
    const actual = new Map()
    for (const root of [path.join(sourceRoot, slug), path.join(repoRoot, DEFAULTS_DIR, slug)]) {
      for (const [relative, absolute] of inventory(root)) {
        if (actual.has(relative)) problems.push(`${slug}/${relative}: 默认文件覆盖源码`)
        actual.set(relative, absolute)
      }
    }
    if (actual.has(PACKAGE_MANIFEST) || expected.has(PACKAGE_MANIFEST)) {
      problems.push(`${slug}: ${PACKAGE_MANIFEST} 只允许由构建生成`)
    }
    for (const relative of new Set([...expected.keys(), ...actual.keys()])) {
      const file = expected.get(relative)
      const location = actual.get(relative)
      if (!file || !location) {
        problems.push(`${slug}/${relative}: 源码或 lock 条目缺失；${REGENERATE_HINT}`)
        continue
      }
      const payload = fs.readFileSync(location)
      if (payload.length !== file.size || sha256(payload) !== file.sha256) {
        problems.push(`${slug}/${relative}: 源码大小或哈希与 lock 不一致；${REGENERATE_HINT}`)
      }
    }
  }

  return problems
}

module.exports = { PACKAGE_MANIFEST, SKILL_MANIFEST, skillLockProblems }

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '../..')
  const problems = skillLockProblems(repoRoot)
  if (problems.length === 0) {
    console.log(`[skills] 源码和 ${REGISTRY_FILE} 与 ${LOCK_FILE} 一致`)
    process.exit(0)
  }
  for (const problem of problems) {
    console.error(`[skills] FAILED: ${problem}`)
  }
  console.error(`[skills] ${problems.length} 处技能清单不一致`)
  process.exit(1)
}
