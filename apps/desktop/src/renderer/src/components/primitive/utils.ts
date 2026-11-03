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

export function fileIconKind(name: string): FileIconKind | undefined {
  const basename = name.split(/[?#]/)[0].split(/[\\/]/).pop() ?? ''
  const dot = basename.lastIndexOf('.')
  return dot > 0 ? FILE_ICON_BY_EXTENSION.get(basename.slice(dot + 1).toLowerCase()) : undefined
}
