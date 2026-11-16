import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDocuments } from './structure-core.mjs';

const args = process.argv.slice(2);
const externalRoot = args[0] === '--root';
const root = externalRoot && args[1] ? path.resolve(args[1]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const paths = externalRoot ? args.slice(2) : args;

if (!paths.length || paths.some(filename => !filename || filename.startsWith('--') || path.isAbsolute(filename) || filename.split(/[\\/]/).includes('..'))) {
  process.stderr.write('Usage: node scripts/ci/docs/structure-check.mjs [--root repository] <explicit markdown paths...>\n');
  process.exitCode = 1;
} else {
  try {
    const errors = paths.flatMap(filename => checkDocuments(root, [filename]));
    process.stdout.write(`${JSON.stringify({ paths, errors }, null, 2)}\n`);
    process.exitCode = errors.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`docs structure: ${error.message}\n`);
    process.exitCode = 1;
  }
}
