import path from 'node:path';
import { checkDocuments } from './structure-core.mjs';

const SCHEMA_VERSION = 1;
try {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input);
  if (request.schemaVersion !== SCHEMA_VERSION || typeof request.root !== 'string' || !path.isAbsolute(request.root) || !Array.isArray(request.paths) || !request.paths.length || request.paths.some(filename => typeof filename !== 'string' || !filename || path.isAbsolute(filename) || filename.split('/').includes('..') || filename.includes('\\')) || new Set(request.paths).size !== request.paths.length) throw new Error('invalid structure request');
  const errors = request.paths.flatMap(filename => checkDocuments(request.root, [filename]));
  process.stdout.write(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, paths: request.paths, errors })}\n`);
  process.exitCode = errors.length ? 1 : 0;
} catch (error) {
  process.stderr.write(`docs structure: ${error.message}\n`);
  process.exitCode = 1;
}
