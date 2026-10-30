import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDirectionRows } from '../../../../../.agents/skills/llm-evaluation-scenarios/scripts/preflight.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const atObservation = (record, field) => record.assetPreparation?.previous?.[field] ?? record.directionPreparation?.previous?.[field] ?? record[field];
const casesPath = join(directory, 'cases.json');
const coveragePath = join(directory, 'coverage.md');
const suitePath = join(directory, 'suite.json');
const assemblePath = join(directory, 'assemble.mjs');
const shardDirectory = join(directory, 'cases');
const scenariosRoot = join(directory, '../..');
const catalogPath = join(directory, '../../../docs/scenarios/catalog.json');
const priorities = ['P0', 'P1', 'P2', 'P3'];
const domains = ['资料库', '文献', 'AI对话', '技能中心', '项目', '模型与账户设置'];
const shards = [
  { file: 'library.json', domain: '资料库', count: 23 },
  { file: 'literature.json', domain: '文献', count: 25 },
  { file: 'conversation.json', domain: 'AI对话', count: 23 },
  { file: 'skills.json', domain: '技能中心', count: 13 },
  { file: 'project.json', domain: '项目', count: 10 },
  { file: 'settings.json', domain: '模型与账户设置', count: 11 },
];
const requiredTextFields = ['id', 'name', 'folder', 'author', 'priority', 'precondition', 'tag', 'description'];
const trackingTextFields = ['sourceKind', 'sourceLocator', 'priorityReason'];
const observationStates = ['not_observed', 'entry_observed', 'observed'];
const baselineP0Points = [
  'RES-DOCX-01', 'RES-XLSX-01', 'RES-MD-01', 'RES-PDF-01',
  'LIT-PDF-OPEN-01', 'LIT-PDF-EXPLAIN-01', 'LIT-PDF-TRANSLATE-01',
  'CHAT-TURN-01', 'DISC-NEW-PAPER-01', 'SKILL-INVOKE-01',
];
const baselineRequiredDirections = ['RES-01', 'LIT-01', 'CHAT-01', 'DISC-01', 'SKILL-01'];

test('incremental intake reuses identities and keeps candidate observations distinct from executable Checks', () => {
  const descriptor = JSON.parse(readFileSync(casesPath, 'utf8'));
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const points = new Map(catalog.points.map((point) => [point.id, point]));
  const cases = new Map(descriptor.cases.map((record) => [record.id, record]));
  const incremental = descriptor.cases.filter((record) => record.candidateLocalId?.startsWith('INC-'));
  assert.equal(incremental.length, 15);
  assert.equal(new Set(incremental.map((record) => record.candidateLocalId)).size, 15);
  assert.equal(incremental.filter((record) => (record.priorityReview?.previousPriority ?? record.priority) === 'P1').length, 10);
  assert.equal(incremental.filter((record) => (record.priorityReview?.previousPriority ?? record.priority) === 'P2').length, 5);
  assert.deepEqual(Object.fromEntries(priorities.map((priority) => [priority,
    descriptor.cases.filter((record) => record.priority === priority).length,
  ])), descriptor.scope.priority_case_counts);
  for (const record of incremental) {
    assert.equal(atObservation(record, 'readiness'), 'partial', record.id);
    assert.equal(record.expectedStatus, 'candidate_unapproved', record.id);
    assert.deepEqual(atObservation(record, 'checkIds'), [], `${record.id} must not borrow existing P0 Checks`);
    assert.ok(atObservation(record, 'assetGaps').length, record.id);
    assert.equal(record.sourceBuild, '202610241139', record.id);
    assert.ok(record.evidenceRefs.some((reference) => reference.includes('/screenshots/')), record.id);
    if (record.variantOf) {
      assert.equal(record.businessPointId, cases.get(record.variantOf).businessPointId, record.id);
      requireText(record.variantScope, `${record.id}.variantScope`);
    }
  }
  assert.equal(incremental.filter((record) => record.variantOf).length, 3);
  assert.equal(cases.get('D6-CHAT-004').businessPointId, 'SEARCH-GLOBAL-01');
  assert.equal(cases.get('D4-SKILL-007').businessPointId, 'SKILL-ENABLE-01');
  assert.equal(cases.get('D4-SKILL-007').priority, 'P1');
  assert.ok(cases.get('D4-SKILL-007').observationScope.includes('内置技能前提未验证'));
  for (const [id, revision] of [['D4-SKILL-007', 3], ['D4-LIT-007', 3], ['D4-LIT-011', 3], ['D4-RES-010', 3]]) {
    assert.equal(atObservation(cases.get(id), 'caseRevision'), revision, id);
    assert.equal(atObservation(cases.get(id), 'readiness'), 'partial', id);
    assert.equal(cases.get(id).observationSources.at(-1).sourceBuild, '202610241139', id);
  }
  assert.equal(catalog.points.length, 88);
  assert.equal(new Set(descriptor.cases.map((record) => record.businessPointId)).size, 88);
  for (const point of catalog.points.slice(54, 86)) {
    assert.equal(atObservation(point, 'revision'), ['PROJ-EDIT-01', 'CONNECTOR-VALIDATE-01', 'SKILL-ENABLE-01'].includes(point.id) ? 2 : 1, point.id);
    assert.equal(point.status, 'active', point.id);
    assert.equal(point.reviewState, 'pending', point.id);
    assert.equal(point.coverageEligibility, 'exploratory', point.id);
    assert.equal(atObservation(point, 'readiness'), 'partial', point.id);
  }
  const tableDirections = parseDirectionRows(readFileSync(join(scenariosRoot, 'README.md'), 'utf8'));
  const outside = catalog.points.filter((point) => point.directionIds.some((id) => !tableDirections.has(id)));
  assert.deepEqual(outside.map((point) => point.id).sort(), [
    'BROWSER-HISTORY-01', 'CONNECTOR-AUTH-01', 'CONNECTOR-PREVIEW-01', 'CONNECTOR-VALIDATE-01',
    'MODEL-PROMPTS-01', 'NOTIFICATION-01', 'SKILL-ENABLE-01', 'SKILL-INSTALL-LOCAL-01', 'STORAGE-CONFIG-01',
  ]);
  assert.equal(atObservation(points.get('SKILL-INVOKE-01'), 'revision'), 1, 'local P1 variant must not revise the builtin P0 point');
});

function requireText(value, label) {
  assert.equal(typeof value, 'string', `${label} must be text`);
  assert.ok(value.trim(), `${label} must not be empty`);
}

function requireMultiline(value, label) {
  if (Array.isArray(value)) {
    assert.ok(value.length, `${label} must contain at least one item`);
    for (const item of value) requireText(item, label);
  } else {
    requireText(value, label);
  }
}

function readCheckMappings() {
  const mappings = new Map();
  for (const category of ['exploratory', 'regression']) {
    const categoryPath = join(scenariosRoot, category);
    for (const entry of readdirSync(categoryPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mappingPath = join(categoryPath, entry.name, 'checks.json');
      if (!existsSync(mappingPath)) continue;
      const mapping = JSON.parse(readFileSync(mappingPath, 'utf8'));
      assert.equal(mapping.schemaVersion, 1, mappingPath);
      requireText(mapping.directionId, `${mappingPath}.directionId`);
      assert.ok(Array.isArray(mapping.checks), `${mappingPath}.checks must be a list`);
      for (const check of mapping.checks) {
        requireText(check.id, `${mappingPath}.check.id`);
        assert.ok(!mappings.has(check.id), `duplicate Check ID: ${check.id}`);
        mappings.set(check.id, { ...check, directionId: mapping.directionId });
      }
    }
  }
  return mappings;
}

test('desktop cases.json is a checked aggregate of six nonempty sources', () => {
  assert.ok(existsSync(suitePath), 'suite.json must own the editable suite metadata');
  const suite = JSON.parse(readFileSync(suitePath, 'utf8'));
  assert.ok(suite && !Array.isArray(suite) && !Object.hasOwn(suite, 'cases'), 'suite.json must not duplicate case rows');

  assert.ok(existsSync(shardDirectory), 'cases/ must contain source shards');
  assert.deepEqual(
    readdirSync(shardDirectory).filter((file) => file.endsWith('.json')).sort(),
    shards.map(({ file }) => file).sort(),
    'all source shards must be declared, nonempty and aggregated',
  );
  const sourceCases = [];
  for (const shard of shards) {
    const shardPath = join(shardDirectory, shard.file);
    assert.ok(existsSync(shardPath), `${shard.file} must exist as a source shard`);
    const shardCases = JSON.parse(readFileSync(shardPath, 'utf8'));
    assert.ok(Array.isArray(shardCases) && shardCases.length > 0, `${shard.file} must be a nonempty case list`);
    assert.equal(shardCases.length, shard.count, `${shard.file} must match the maintained case count`);
    for (const caseRecord of shardCases) {
      assert.ok(caseRecord.folder.split('/').includes(shard.domain), `${caseRecord.id} is in the wrong source shard`);
    }
    sourceCases.push(...shardCases);
  }

  assert.equal(sourceCases.length, 105, 'six source shards must retain 103 cases and add two PDF quality cases');
  assert.equal(sourceCases.filter(({ id }) => id.startsWith('D4-')).length, 60, 'source shards must retain all sixty earlier case IDs');
  assert.equal(new Set(sourceCases.map(({ id }) => id)).size, sourceCases.length, 'source case IDs must be globally unique');
  const aggregate = JSON.parse(readFileSync(casesPath, 'utf8'));
  assert.deepEqual(aggregate, { ...suite, cases: sourceCases }, 'aggregate must preserve suite metadata, case order and every row field');
  assert.equal(readFileSync(casesPath, 'utf8'), `${JSON.stringify(aggregate, null, 2)}\n`, 'aggregate formatting must be deterministic');
  assert.ok(existsSync(assemblePath), 'the aggregate must have a regeneration command');
  execFileSync(process.execPath, [assemblePath, '--check'], { cwd: directory, stdio: 'pipe' });
});

test('aggregate generator rejects stale output and rebuilds it deterministically', () => {
  assert.ok(existsSync(assemblePath), 'assemble.mjs must exist before checking stale detection');
  const tempDirectory = mkdtempSync(join(tmpdir(), 'scholarseed-desktop-cases-'));
  try {
    copyFileSync(assemblePath, join(tempDirectory, 'assemble.mjs'));
    copyFileSync(suitePath, join(tempDirectory, 'suite.json'));
    copyFileSync(casesPath, join(tempDirectory, 'cases.json'));
    mkdirSync(join(tempDirectory, 'cases'));
    for (const shard of shards) {
      copyFileSync(join(shardDirectory, shard.file), join(tempDirectory, 'cases', shard.file));
    }

    const aggregateCopy = join(tempDirectory, 'cases.json');
    writeFileSync(aggregateCopy, '{}\n');
    const stale = spawnSync(process.execPath, [join(tempDirectory, 'assemble.mjs'), '--check'], { encoding: 'utf8' });
    assert.notEqual(stale.status, 0, 'the generator must reject a stale aggregate');

    const regenerate = spawnSync(process.execPath, [join(tempDirectory, 'assemble.mjs'), '--write'], { encoding: 'utf8' });
    assert.equal(regenerate.status, 0, `${regenerate.stdout}${regenerate.stderr}`);
    assert.equal(readFileSync(aggregateCopy, 'utf8'), readFileSync(casesPath, 'utf8'), 'regeneration must reproduce the aggregate byte for byte');
    const fresh = spawnSync(process.execPath, [join(tempDirectory, 'assemble.mjs'), '--check'], { encoding: 'utf8' });
    assert.equal(fresh.status, 0, `${fresh.stdout}${fresh.stderr}`);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('coverage matrix maps every stable point to current cases and Checks', () => {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const cases = JSON.parse(readFileSync(casesPath, 'utf8')).cases;
  const mappings = readCheckMappings();
  const rows = readFileSync(coveragePath, 'utf8').split('## 全用例分级索引')[0].split('\n').filter((line) =>
    line.startsWith('| ') && /`[A-Z][A-Z0-9-]+@\d+`/.test(line));
  assert.equal(rows.length, catalog.points.length, 'matrix must contain every stable point exactly once');

  for (const point of catalog.points) {
    const matching = rows.filter((row) => row.includes(`\`${point.id}@${point.revision}\``));
    assert.equal(matching.length, 1, `${point.id} must have exactly one matrix row`);
    const columns = matching[0].split('|').map((column) => column.trim());
    assert.equal(columns[2], point.entry, `${point.id} has a stale page entry`);
    assert.ok(columns[6].includes(point.evaluationType), `${point.id} has a stale A/B type`);
    assert.ok(columns[7].includes(point.readiness), `${point.id} has a stale asset state`);

    const caseIds = cases.filter((entry) => entry.businessPointId === point.id).map((entry) => entry.id).sort();
    const listedCaseIds = [...columns[4].matchAll(/`(D[46]-[A-Z]+-\d+)`/g)].map((match) => match[1]).sort();
    assert.deepEqual(listedCaseIds, caseIds, `${point.id} has stale case references`);
    const mappedChecks = [...mappings.values()].filter((check) =>
      check.pointIds.includes(point.id) && point.directionIds.includes(check.directionId));
    const checkIds = mappedChecks.map((check) => check.id).sort();
    const listedCheckIds = [...columns[5].matchAll(/`([A-Z][A-Z0-9-]+)`/g)].map((match) => match[1]).sort();
    assert.deepEqual(listedCheckIds, checkIds, `${point.id} has stale Check references`);
    for (const check of mappedChecks) {
      assert.ok(columns[5].includes(`\`${check.id}\`（${check.evaluationType}`), `${point.id}/${check.id} has a stale A/B type`);
    }
  }
});

test('desktop six-domain cases preserve executable asset boundaries', async (context) => {
  assert.ok(existsSync(casesPath), 'cases.json must exist before the execution asset can be validated');
  const descriptor = JSON.parse(readFileSync(casesPath, 'utf8'));
  assert.ok(descriptor && !Array.isArray(descriptor), 'cases.json must contain an object with cases and build identities');
  assert.ok(Array.isArray(descriptor.cases), 'cases must be a list');
  const cases = descriptor.cases;
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const points = new Map(catalog.points.map((point) => [point.id, point]));

  await context.test('retains earlier cases and adds twenty breadth candidates across six domains', () => {
    assert.equal(cases.length, 105);
    assert.equal(cases.filter(({ id }) => id.startsWith('D4-')).length, 60);
    if (descriptor.case_count !== undefined) assert.equal(descriptor.case_count, 105);
    assert.equal(new Set(cases.map((caseRecord) => caseRecord.id)).size, 105);
    const coveredDomains = new Set();
    for (const caseRecord of cases) {
      for (const field of requiredTextFields) requireText(caseRecord[field], `${caseRecord.id}.${field}`);
      requireMultiline(caseRecord.steps, `${caseRecord.id}.steps`);
      requireMultiline(caseRecord.expected, `${caseRecord.id}.expected`);
      assert.equal(caseRecord.author, '评测维护', caseRecord.id);
      assert.ok(priorities.includes(caseRecord.priority), `${caseRecord.id}.priority`);
      const matchingDomains = domains.filter((domain) => caseRecord.folder.split('/').includes(domain));
      assert.equal(matchingDomains.length, 1, `${caseRecord.id} must belong to exactly one selected business domain`);
      coveredDomains.add(matchingDomains[0]);
    }
    assert.deepEqual([...coveredDomains].sort(), [...domains].sort());
  });

  await context.test('records source and target builds with explicit candidate observation states', () => {
    requireText(descriptor.sourceBuild, 'sourceBuild');
    requireText(descriptor.targetBuild, 'targetBuild');
    for (const caseRecord of cases) {
      for (const field of trackingTextFields) requireText(caseRecord[field], `${caseRecord.id}.${field}`);
      assert.ok(observationStates.includes(caseRecord.observationStatus), `${caseRecord.id}.observationStatus must be explicit`);
      assert.equal(caseRecord.expectedStatus, 'candidate_unapproved', `${caseRecord.id} must not claim approved expectations`);
      assert.ok(Object.hasOwn(caseRecord, 'businessPointId'), `${caseRecord.id}.businessPointId must be explicit`);
      assert.ok(Object.hasOwn(caseRecord, 'revision'), `${caseRecord.id}.revision must be explicit`);
      assert.ok(Array.isArray(caseRecord.directionIds), `${caseRecord.id}.directionIds must be a list`);
      if (caseRecord.checkIds !== undefined) {
        assert.ok(Array.isArray(caseRecord.checkIds), `${caseRecord.id}.checkIds must be a list`);
        for (const checkId of caseRecord.checkIds) requireText(checkId, `${caseRecord.id}.checkIds`);
        assert.equal(new Set(caseRecord.checkIds).size, caseRecord.checkIds.length, `${caseRecord.id} has duplicate Check references`);
      }
    }
  });

  await context.test('binds current point revisions without promoting case variants above point risk', () => {
    for (const caseRecord of cases.filter((entry) => entry.businessPointId)) {
      const point = points.get(caseRecord.businessPointId);
      assert.ok(point, `${caseRecord.id} references an unknown business point`);
      assert.equal(caseRecord.revision, point.revision, `${caseRecord.id} has a stale business point revision`);
      assert.deepEqual([...caseRecord.directionIds].sort(), [...point.directionIds].sort(), `${caseRecord.id} has mismatched directions`);
      const caseRank = priorities.indexOf(caseRecord.priority);
      const pointRank = priorities.indexOf(point.priority);
      assert.ok(caseRank >= 0 && pointRank >= 0 && caseRank >= pointRank, `${caseRecord.id} must not have a higher-risk priority than its business point`);
    }
  });

  await context.test('keeps unbound capability candidates partial and outside P0', () => {
    for (const caseRecord of cases.filter((entry) => !entry.businessPointId)) {
      assert.ok(caseRecord.businessPointId === null || caseRecord.businessPointId === '', `${caseRecord.id} must explicitly leave its point unbound`);
      assert.equal(caseRecord.revision, null, `${caseRecord.id} must not invent a point revision`);
      assert.equal(caseRecord.expectedStatus, 'candidate_unapproved', caseRecord.id);
      assert.equal(caseRecord.readiness, 'partial', `${caseRecord.id} must expose its asset gap`);
      assert.notEqual(caseRecord.priority, 'P0', `${caseRecord.id} cannot join the default P0 denominator`);
    }
  });

  await context.test('matches case P0 point identities to the current default baseline scope', () => {
    const table = readFileSync(join(scenariosRoot, 'README.md'), 'utf8');
    const defaultDirections = new Set([...parseDirectionRows(table).values()].filter(({ mode }) => mode === 'required').map(({ id }) => id));
    assert.deepEqual([...defaultDirections].sort(), [...baselineRequiredDirections].sort(), 'the five required directions must remain unchanged');
    const casePointIds = cases.filter((caseRecord) => caseRecord.priority === 'P0').map(({ businessPointId }) => businessPointId).sort();
    assert.deepEqual(casePointIds, [...baselineP0Points].sort(), 'the ten default P0 point identities must remain unchanged');
    for (const platform of ['macos', 'windows']) {
      const defaultPointIds = catalog.points.filter((point) => point.status === 'active' && point.priority === 'P0' && point.platforms.includes(platform) && point.directionIds.some((directionId) => defaultDirections.has(directionId))).map(({ id }) => id).sort();
      assert.deepEqual(casePointIds, defaultPointIds, `${platform}: cases must not omit or add default P0 business points`);
    }
  });

  await context.test('preserves the default P0 Check denominator and binds every P0 case to required Checks', () => {
    const p0Cases = cases.filter((caseRecord) => caseRecord.priority === 'P0');
    const p0PointIds = new Set(p0Cases.map((caseRecord) => caseRecord.businessPointId));
    assert.equal(p0PointIds.size, p0Cases.length, 'P0 variants must not duplicate a main business point');
    const mappings = readCheckMappings();
    const baselineChecks = [...mappings.values()].filter((check) => baselineRequiredDirections.includes(check.directionId) && check.pointIds.some((pointId) => p0PointIds.has(pointId)));
    assert.equal(baselineChecks.filter((check) => check.required).length, 18, 'default P0 must retain eighteen required Checks');
    assert.equal(baselineChecks.filter((check) => !check.required).length, 1, 'default P0 must retain one optional Check');
    for (const caseRecord of p0Cases) {
      const point = points.get(caseRecord.businessPointId);
      assert.ok(point, `${caseRecord.id} must bind a catalog point`);
      assert.equal(point.priority, 'P0', `${caseRecord.id} must bind a P0 point`);
      assert.equal(point.status, 'active', `${caseRecord.id} must bind an active point`);
      assert.equal(point.readiness, 'manual_ready', `${caseRecord.id} must bind an asset-ready point`);
      assert.ok(Array.isArray(caseRecord.checkIds) && caseRecord.checkIds.length, `${caseRecord.id} must map explicit required Check IDs`);
      for (const checkId of caseRecord.checkIds) {
        const check = mappings.get(checkId);
        assert.ok(check, `${caseRecord.id} references an unknown Check: ${checkId}`);
        assert.equal(check.required, true, `${caseRecord.id} cannot silently make an optional Check part of default P0`);
        assert.ok(caseRecord.directionIds.includes(check.directionId), `${caseRecord.id}/${checkId} has a mismatched direction`);
        assert.ok(Array.isArray(check.pointIds) && check.pointIds.includes(point.id), `${caseRecord.id}/${checkId} must map its business point`);
        for (const dependencyId of check.pointIds) assert.ok(p0PointIds.has(dependencyId), `${caseRecord.id}/${checkId} depends on a point outside P0`);
      }
      const requiredChecks = [...mappings.values()].filter((check) =>
        check.required && check.pointIds.includes(point.id) && caseRecord.directionIds.includes(check.directionId));
      assert.ok(requiredChecks.length, `${caseRecord.id} has no required Check mapping`);
      for (const check of requiredChecks) assert.ok(caseRecord.checkIds.includes(check.id), `${caseRecord.id} omits required Check: ${check.id}`);
    }
  });
});
