import {
  File,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  type LucideIcon
} from 'lucide-react'

const RESOURCE_FILE_ICON_BY_EXTENSION: Record<string, LucideIcon> = {
  pdf: FileText,
  doc: FileText,
  docx: FileText,
  md: FileText,
  txt: FileText,
  log: FileText,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  svg: FileImage,
  bmp: FileImage,
  py: FileCode2,
  js: FileCode2,
  ts: FileCode2,
  tsx: FileCode2,
  jsx: FileCode2,
  json: FileCode2,
  sh: FileCode2,
  c: FileCode2,
  h: FileCode2,
  cpp: FileCode2,
  java: FileCode2,
  go: FileCode2,
  rs: FileCode2,
  rb: FileCode2,
  yaml: FileCode2,
  yml: FileCode2,
  toml: FileCode2
}

export function resourceFileIcon(fileName: string): LucideIcon {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0) return File
  return RESOURCE_FILE_ICON_BY_EXTENSION[fileName.slice(dot + 1).toLowerCase()] ?? File
}
