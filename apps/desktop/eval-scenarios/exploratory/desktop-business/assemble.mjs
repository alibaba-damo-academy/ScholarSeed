import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const aggregatePath = join(directory, 'cases.json');
const suitePath = join(directory, 'suite.json');
const shards = [
  { file: 'library.json', domain: '资料库' },
  { file: 'literature.json', domain: '文献' },
  { file: 'conversation.json', domain: 'AI对话' },
  { file: 'skills.json', domain: '技能中心' },
  { file: 'project.json', domain: '项目' },
  { file: 'settings.json', domain: '模型与账户设置' },
];

export function assembleCases() {
  const suite = JSON.parse(readFileSync(suitePath, 'utf8'));
  if (!suite || Array.isArray(suite) || Object.hasOwn(suite, 'cases')) {
    throw new Error('suite.json must contain suite metadata without case rows');
  }

  const cases = [];
  const ids = new Set();
  for (const shard of shards) {
    const records = JSON.parse(readFileSync(join(directory, 'cases', shard.file), 'utf8'));
    if (!Array.isArray(records) || records.length === 0) {
      throw new Error(`${shard.file} must contain nonempty case rows`);
    }
    if (suite.scope?.domain_case_counts?.[shard.domain] !== records.length) {
      throw new Error(`${shard.file} count differs from suite scope`);
    }
    for (const record of records) {
      if (!record.folder?.split('/').includes(shard.domain)) {
        throw new Error(`${record.id ?? shard.file} belongs to another domain`);
      }
      if (!record.id || ids.has(record.id)) {
        throw new Error(`missing or duplicate case ID: ${record.id}`);
      }
      ids.add(record.id);
      cases.push(record);
    }
  }
  if (suite.case_count !== cases.length || suite.scope?.case_rows !== cases.length) {
    throw new Error('suite case counts differ from source rows');
  }

  const aggregate = {};
  for (const [key, value] of Object.entries(suite)) {
    aggregate[key] = value;
    if (key === 'scope') aggregate.cases = cases;
  }
  if (!Object.hasOwn(aggregate, 'cases')) {
    throw new Error('suite scope is missing the case insertion point');
  }
  return aggregate;
}

export function renderCases() {
  return `${JSON.stringify(assembleCases(), null, 2)}\n`;
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  const mode = process.argv[2];
  if (mode === '--check') {
    if (readFileSync(aggregatePath, 'utf8') !== renderCases()) {
      process.stderr.write('cases.json is stale; run node assemble.mjs --write\n');
      process.exitCode = 1;
    }
  } else if (mode === '--write') {
    writeFileSync(aggregatePath, renderCases());
  } else {
    process.stderr.write('Usage: node assemble.mjs --check|--write\n');
    process.exitCode = 2;
  }
}
