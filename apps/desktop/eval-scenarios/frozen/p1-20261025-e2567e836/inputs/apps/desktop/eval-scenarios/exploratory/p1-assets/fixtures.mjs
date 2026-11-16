import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const documents = {
  'document.pdf': [
    ['Synthetic Two-Page Research Note', 'Page 1 - Alpha pilot', 'Twelve people used a prototype for four weeks.', 'Nine completed the retrieval task.', 'There was no control group.', 'This observation does not establish causal improvement.'],
    ['Synthetic Two-Page Research Note', 'Page 2 - Independent review', 'Five reviewers inspected the report over two weeks.', 'Three rated the instructions as clear.', 'This small review does not represent all users.'],
  ],
  'supplement.pdf': [['Synthetic Attachment', 'ATTACHMENT-ONLY', 'This supplementary page belongs only to the selected task literature.']],
};

export function renderPdf(pages) {
  const objects = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(`<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((pageId) => `${pageId} 0 R`).join(' ')}] >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const [index, lines] of pages.entries()) {
    const contentId = pageIds[index] + 1;
    const content = `BT /F1 14 Tf 50 760 Td 24 TL ${lines.map((line, lineIndex) => `${lineIndex ? 'T* ' : ''}(${line.replace(/[\\()]/g, '\\$&')}) Tj`).join('\n')} ET\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`);
  }
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
  if (!['--write', '--check'].includes(mode)) throw new Error('use --write or --check');
  for (const [name, pages] of Object.entries(documents)) {
    const path = join(directory, name);
    const bytes = renderPdf(pages);
    if (mode === '--write') writeFileSync(path, bytes);
    else if (!readFileSync(path).equals(bytes)) throw new Error(`${name} differs from its frozen synthetic text`);
  }
}
