import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPdf } from '../p1-assets/fixtures.mjs';

const directory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const sizes = [1023, 1024, 1025];

export function outlinePdf() {
  const pdf = renderPdf([
    ['P2-OUTLINE-FIRST', 'First section', 'This is the first page of a synthetic document.'],
    ['P2-OUTLINE-SECOND', 'Second section', 'P2-ANNOTATE-TARGET belongs only to page two.'],
  ]).toString('ascii');
  const objects = [...pdf.matchAll(/\d+ 0 obj\n([\s\S]*?)\nendobj/g)].map((match) => match[1]);
  objects[0] = '<< /Type /Catalog /Pages 2 0 R /Outlines 8 0 R /PageMode /UseOutlines >>';
  objects.push('<< /Type /Outlines /First 9 0 R /Last 10 0 R /Count 2 >>');
  objects.push('<< /Title (First section) /Parent 8 0 R /Next 10 0 R /Dest [4 0 R /Fit] >>');
  objects.push('<< /Title (Second section) /Parent 8 0 R /Prev 9 0 R /Dest [6 0 R /Fit] >>');
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const start = Buffer.byteLength(output);
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(output);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (!['--check', '--write'].includes(mode)) throw new Error('use --check or --write');
  const files = new Map([['outline.pdf', outlinePdf()], ...sizes.map((size) => [`threshold/${size}.txt`, Buffer.alloc(size, 'X')])]);
  for (const [name, bytes] of files) {
    const path = join(directory, name);
    if (mode === '--write') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    } else if (!readFileSync(path).equals(bytes)) throw new Error(`synthetic fixture differs: ${name}`);
  }
}
