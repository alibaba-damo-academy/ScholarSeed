import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const LINK = /\[[^\]\n]+\]\(([^)\n]+)\)/g;
const EXTERNAL = /^[a-z][a-z\d+.-]*:/i;
const HEADING = /^#{1,6}\s+(.+?)\s*#*$/gm;
const CODE_REFS = /^code_refs[ \t]*:(.*)$/;
const CODE_REF_ITEM = /^[ \t]+-[ \t]+(?:"([^"]+)"|'([^']+)'|([^"']+))[ \t]*$/;
const ID = /^id:\s*["']?([^\n"']+)["']?\s*$/m;
const FENCE = /^\s*(`{3,}|~{3,})/;
const MARKDOWN_EXTENSION = '.md';
const HTML_TOKEN = /<!--[\s\S]*?(?:-->|$)|`+|<([a-z][a-z\d-]*)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
const HTML_ATTRIBUTE = /([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
const RAW_HTML_ELEMENTS = new Set(['script', 'style']);

function htmlAnchors(content) {
  const anchors = new Set();
  const body = prose(content.replace(FRONTMATTER, ''));
  const tokens = new RegExp(HTML_TOKEN);
  for (let token; (token = tokens.exec(body));) {
    if (token[0].startsWith('<!--')) continue;
    if (token[0].startsWith('`')) {
      const runs = /`+/g;
      runs.lastIndex = tokens.lastIndex;
      for (let closing; (closing = runs.exec(body));) {
        if (closing[0].length === token[0].length) {
          tokens.lastIndex = runs.lastIndex;
          break;
        }
      }
      continue;
    }
    const element = token[1].toLowerCase();
    if (RAW_HTML_ELEMENTS.has(element)) {
      const closing = new RegExp(`</${element}\\s*>`, 'gi');
      closing.lastIndex = tokens.lastIndex;
      tokens.lastIndex = closing.exec(body) ? closing.lastIndex : body.length;
      continue;
    }
    if (element !== 'a') continue;
    for (const attribute of token[2].matchAll(HTML_ATTRIBUTE)) {
      const name = attribute[1].toLowerCase();
      const value = attribute[2] ?? attribute[3];
      if ((name === 'id' || name === 'name') && value) anchors.add(value);
    }
  }
  return anchors;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function prose(content) {
  let fence = null;
  return content.split(/\r?\n/).map(line => {
    const marker = line.match(FENCE)?.[1];
    if (marker && !fence) fence = marker;
    else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
    else if (!fence) return line;
    return '';
  }).join('\n');
}

function linkProse(content) {
  const body = prose(content);
  const runs = [...body.matchAll(/`+/g)];
  let cursor = 0;
  let result = '';
  for (let index = 0; index < runs.length; index++) {
    const opening = runs[index];
    const closingIndex = runs.findIndex((run, candidate) => candidate > index && run[0].length === opening[0].length);
    if (closingIndex < 0) continue;
    const end = runs[closingIndex].index + runs[closingIndex][0].length;
    result += body.slice(cursor, opening.index);
    result += body.slice(opening.index, end).replace(/[^\r\n]/g, ' ');
    cursor = end;
    index = closingIndex;
  }
  return result + body.slice(cursor);
}

function headings(content) {
  const counts = new Map();
  const anchors = new Set();
  for (const match of prose(content).matchAll(HEADING)) {
    const slug = match[1].toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = counts.get(slug) ?? 0;
    counts.set(slug, count + 1);
    anchors.add(count ? `${slug}-${count}` : slug);
  }
  return new Set([...anchors, ...htmlAnchors(content)]);
}

function safeTarget(root, target) {
  return inside(root, target) && (!existsSync(target) || inside(root, realpathSync(target)));
}

function codeReferences(metadata) {
  const lines = metadata.split(/\r?\n/);
  const declarations = lines.flatMap((line, index) => CODE_REFS.test(line) ? [index] : []);
  const references = [];
  const errors = [];
  if (!declarations.length) return { references, errors };
  if (declarations.length !== 1) return { references, errors: ['duplicate code_refs declaration'] };
  const declaration = declarations[0];
  if (lines[declaration].match(CODE_REFS)[1].trim()) {
    return { references, errors: ['code_refs requires an indented block list of paths'] };
  }
  for (const line of lines.slice(declaration + 1)) {
    if (!line.trim()) continue;
    if (!/^[ \t]/.test(line)) break;
    const item = line.match(CODE_REF_ITEM);
    const reference = item && (item[1] ?? item[2] ?? item[3]).trim();
    if (!reference) errors.push('invalid code_refs item; expected a nonempty path');
    else references.push(reference);
  }
  if (!references.length) errors.push('code_refs requires at least one path');
  return { references, errors };
}

export function checkDocuments(rootDirectory, paths) {
  const root = realpathSync(rootDirectory);
  const errors = [];
  const ids = new Map();
  for (const filename of paths) {
    const source = path.resolve(root, filename);
    if (!safeTarget(root, source)) {
      errors.push(`${filename}: outside root`);
      continue;
    }
    if (!existsSync(source)) {
      errors.push(`${filename}: missing document`);
      continue;
    }
    const content = readFileSync(source, 'utf8');
    const metadata = content.match(FRONTMATTER)?.[1] ?? '';
    const id = metadata.match(ID)?.[1]?.trim();
    if (id) {
      if (ids.has(id)) errors.push(`${filename}: duplicate id ${id} with ${ids.get(id)}`);
      ids.set(id, filename);
    }
    const referenceMetadata = codeReferences(metadata);
    errors.push(...referenceMetadata.errors.map(error => `${filename}: ${error}`));
    for (const reference of referenceMetadata.references) {
      const target = path.resolve(root, reference);
      if (!safeTarget(root, target) || !existsSync(target)) errors.push(`${filename}: missing or outside root code_ref ${reference}`);
    }
    for (const match of linkProse(content.replace(FRONTMATTER, '')).matchAll(LINK)) {
      const destination = match[1].trim().replace(/^<|>$/g, '');
      if (EXTERNAL.test(destination) || destination.startsWith('//')) continue;
      let decoded;
      try { decoded = decodeURIComponent(destination); }
      catch { errors.push(`${filename}: invalid encoded link ${destination}`); continue; }
      const [location, anchor] = decoded.split('#');
      const target = location ? path.resolve(path.dirname(source), location) : source;
      if (!safeTarget(root, target)) errors.push(`${filename}: link outside root ${destination}`);
      else if (!existsSync(target)) errors.push(`${filename}: missing link ${destination}`);
      else if (anchor && path.extname(target) === MARKDOWN_EXTENSION && !headings(readFileSync(target, 'utf8')).has(anchor)) errors.push(`${filename}: missing anchor ${destination}`);
    }
  }
  return errors;
}
