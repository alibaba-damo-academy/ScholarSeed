import highlight from 'highlight.js'

export interface CodeToken {
  text: string
  className?: string
}

const TOKEN_CLASSES: Record<string, string> = {
  'hljs-keyword': 'text-[var(--vds-code-keyword)]',
  'hljs-built_in': 'text-[var(--vds-code-string)]',
  'hljs-title': 'text-[var(--vds-code-identifier)]',
  'hljs-string': 'text-[var(--vds-code-string)]',
  'hljs-number': 'text-[var(--vds-code-identifier)]',
  'hljs-literal': 'text-[var(--vds-code-keyword)]',
  'hljs-comment': 'text-[var(--vds-code-comment)]',
  'hljs-meta': 'text-[var(--vds-code-comment)]',
  'hljs-attr': 'text-[var(--vds-text-primary)]',
}

export function codeTokens(code: string, language?: string): CodeToken[][] {
  const lines: CodeToken[][] = [[]]
  const append = (text: string, className?: string): void => {
    text.split('\n').forEach((part, index) => {
      if (index) lines.push([])
      if (part) lines[lines.length - 1].push({ text: part, className })
    })
  }
  if (!language || !highlight.getLanguage(language)) {
    append(code)
    return lines
  }
  const markup = highlight.highlight(code, { language, ignoreIllegals: true }).value
  const parsed = new DOMParser().parseFromString(markup, 'text/html')
  const visit = (node: Node, inherited?: string): void => {
    if (node.nodeType === Node.TEXT_NODE) append(node.textContent ?? '', inherited)
    else if (node instanceof Element) {
      const className =
        Array.from(node.classList)
          .map((name) => TOKEN_CLASSES[name])
          .find(Boolean) ?? inherited
      node.childNodes.forEach((child) => visit(child, className))
    }
  }
  parsed.body.childNodes.forEach((node) => visit(node))
  return lines
}
