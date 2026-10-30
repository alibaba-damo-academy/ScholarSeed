#!/usr/bin/env node
// 只读校验：skills/community/<slug>/.scholarseed-package.json 必须与 skills/skills.lock.json
// 的对应行、以及 skills/registry.json 的依赖政策三方一致。
//
// 为什么收集全部违规再一次性报告，而不是循环内逐条 assert：本检查过去用 fail-fast 断言，
// 第一个坏技能就中止循环，把它之后的技能全部遮蔽——pdf-evidence 缺 registry 条目时，
// research-idea-partner 的 manifest/lock 版本不一致（1.1.0 vs 1.2.0）永远走不到断言，
// 直到打包机 dependencies._inputs 抛 PackageError 才暴露，两批三平台构建全挂。
// 门禁红着的时候，必须能一次看见每一个违规。
//
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
const REGENERATE_HINT =
  '按 skills/ADAPTATION.md §3 用仓库模块重新生成该技能包清单，' +
  '再用 python -m service.cli.prebundle --build --source skills/community ' +
  '--lock <tmp>/skills.lock.json 重生并回写该技能的 lock 行'

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
    const files = Array.isArray(skill.files) ? skill.files : []
    const inventory = files.find((file) => file.path === PACKAGE_MANIFEST)
    const manifestPath = path.join(sourceRoot, slug, PACKAGE_MANIFEST)
    const hasSourceManifest = fs.existsSync(manifestPath)

    // 三类「缺失」彼此独立，必须全部报出，任何一个都不得遮蔽另外两个。
    if (!inventory) {
      problems.push(
        `${slug}: ${LOCK_FILE} 的文件清单缺少 ${PACKAGE_MANIFEST}；${REGENERATE_HINT}`
      )
    }
    if (!hasSourceManifest) {
      problems.push(
        `${slug}: 源码树缺少 ${PACKAGE_MANIFEST}，validate_source_lock 会判该技能行 ` +
          `"invalid repository skill file inventory"，打包期 --verify-installed 直接失败；` +
          `${REGENERATE_HINT}`
      )
    }
    if (!Object.hasOwn(declared, slug)) {
      problems.push(
        `${slug}: ${REGISTRY_FILE} 的 dependencies 缺少该技能条目；依赖政策以 ${REGISTRY_FILE} ` +
          `为单一来源，请由技能 owner 确认应声明什么后补上`
      )
    }

    // 内容级比对要求 lock 行与源码清单同时在场，否则上面已报出缺失原因。
    if (!inventory || !hasSourceManifest) {
      continue
    }
    const payload = fs.readFileSync(manifestPath)
    const digest = sha256(payload)
    if (digest !== inventory.sha256) {
      problems.push(
        `${slug}: ${PACKAGE_MANIFEST} 内容已变但 ${LOCK_FILE} 未重生 ` +
          `(源码 sha256=${digest.slice(0, 12)} lock=${String(inventory.sha256).slice(0, 12)})；${REGENERATE_HINT}`
      )
    }
    if (payload.length !== inventory.size) {
      problems.push(
        `${slug}: ${PACKAGE_MANIFEST} 大小与 ${LOCK_FILE} 不一致 ` +
          `(源码=${payload.length} lock=${inventory.size})；${REGENERATE_HINT}`
      )
    }

    let manifest
    try {
      manifest = JSON.parse(payload.toString('utf8'))
    } catch {
      problems.push(`${slug}: ${PACKAGE_MANIFEST} 不是合法 JSON`)
      continue
    }
    if (manifest.name !== slug) {
      problems.push(`${slug}: 包清单 name=${JSON.stringify(manifest.name)} 与技能 slug 不一致`)
    }
    if (manifest.version !== skill.version) {
      problems.push(
        `${slug}: 版本不一致（${PACKAGE_MANIFEST}=${manifest.version} ${LOCK_FILE}=${skill.version}），` +
          `打包期 dependencies._inputs 会抛 "source package manifest differs: ${slug}"；${REGENERATE_HINT}`
      )
    }
    if (
      Object.hasOwn(declared, slug) &&
      JSON.stringify(canonical(manifest.dependencies)) !== JSON.stringify(canonical(declared[slug]))
    ) {
      problems.push(
        `${slug}: ${PACKAGE_MANIFEST} 的 dependencies 与 ${REGISTRY_FILE} 不一致 ` +
          `(清单=${JSON.stringify(canonical(manifest.dependencies))} ` +
          `registry=${JSON.stringify(canonical(declared[slug]))})`
      )
    }
  }

  return problems
}

module.exports = { PACKAGE_MANIFEST, SKILL_MANIFEST, skillLockProblems }

if (require.main === module) {
  const repoRoot = path.resolve(__dirname, '../..')
  const problems = skillLockProblems(repoRoot)
  if (problems.length === 0) {
    console.log(`[skills] ${PACKAGE_MANIFEST} 与 ${LOCK_FILE}、${REGISTRY_FILE} 一致`)
    process.exit(0)
  }
  for (const problem of problems) {
    console.error(`[skills] FAILED: ${problem}`)
  }
  console.error(`[skills] ${problems.length} 处技能清单不一致`)
  process.exit(1)
}
