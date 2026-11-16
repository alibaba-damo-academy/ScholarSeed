export const CARD_HEADER =
  'flex h-[var(--vds-control-height-lg)] min-w-0 items-center justify-between gap-[var(--vds-space-2)] border-b-[length:var(--vds-code-divider-width)] border-solid border-[var(--vds-divider-default)] bg-[var(--vds-fill-4)] px-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]'
export const CARD_ACTIONS =
  'ml-auto flex shrink-0 items-center gap-[var(--vds-space-2)] opacity-0 pointer-events-none group-hover/conversation-card:opacity-[var(--vds-opacity-full)] group-hover/conversation-card:pointer-events-auto group-focus-within/conversation-card:opacity-[var(--vds-opacity-full)] group-focus-within/conversation-card:pointer-events-auto [@media(hover:none)]:opacity-[var(--vds-opacity-full)] [@media(hover:none)]:pointer-events-auto'
export const CARD_TABS = '!h-[var(--vds-control-height-sm)] !py-0'
export const CARD_TAB =
  '!h-[var(--vds-control-height-sm)] min-h-0 py-0 !text-[length:var(--vds-font-body-lv1)] !leading-[var(--vds-lh-body-lv1)] !font-[var(--vds-fw-regular)] data-[state=active]:!font-[var(--vds-fw-medium)] aria-pressed:!font-[var(--vds-fw-medium)]'

export type FileIconKind =
  'pdf' | 'ppt' | 'word' | 'excel' | 'image' | 'text' | 'html' | 'tsx' | 'mov' | 'zip' | 'music'

const FILE_ICON_EXTENSIONS: Record<FileIconKind, readonly string[]> = {
  pdf: ['pdf'],
  ppt: ['ppt', 'pptx', 'pps', 'ppsx', 'odp'],
  word: ['doc', 'docx', 'rtf', 'odt'],
  excel: ['xls', 'xlsx', 'xlsm', 'csv', 'tsv', 'ods'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tif', 'tiff', 'ico', 'avif', 'heic'],
  text: ['txt', 'text', 'md', 'markdown', 'log'],
  html: [
    'html',
    'htm',
    'py',
    'js',
    'jsx',
    'ts',
    'json',
    'sh',
    'c',
    'h',
    'cpp',
    'java',
    'go',
    'rs',
    'rb',
    'yaml',
    'yml',
    'toml',
    'xml',
    'css',
    'sql',
  ],
  tsx: ['tsx'],
  mov: ['mov', 'mp4', 'avi', 'mkv', 'webm', 'm4v'],
  music: ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'aiff', 'wma', 'opus'],
  zip: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz'],
}

const FILE_ICON_BY_EXTENSION = new Map(
  Object.entries(FILE_ICON_EXTENSIONS).flatMap(([kind, extensions]) =>
    extensions.map((extension) => [extension, kind as FileIconKind] as const)
  )
)

// `?` / `#` 只有出现在 URL 里才是查询与片段分隔符。文献附件显示名直接取自论文标题,
// 标题里的问号是正文字符, 一律截断会把后缀一起丢掉, 因此只对带 scheme 的 URL 截断。
const URL_REFERENCE = /^[a-z][a-z0-9+.-]*:\/\//i

export function fileIconKind(name: string): FileIconKind | undefined {
  const reference = URL_REFERENCE.test(name) ? name.split(/[?#]/)[0] : name
  const basename = reference.split(/[\\/]/).pop() ?? ''
  const dot = basename.lastIndexOf('.')
  return dot > 0 ? FILE_ICON_BY_EXTENSION.get(basename.slice(dot + 1).toLowerCase()) : undefined
}
