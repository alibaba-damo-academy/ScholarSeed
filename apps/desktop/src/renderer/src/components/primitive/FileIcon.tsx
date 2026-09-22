import {
  File,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  type LucideIcon
} from 'lucide-react'

const FILE_ICON_BY_EXTENSION: Record<string, LucideIcon> = {
  csv: FileSpreadsheet, xls: FileSpreadsheet, xlsx: FileSpreadsheet,
  doc: FileText, docx: FileText, pdf: FileText, md: FileText, txt: FileText,
  png: FileImage, jpg: FileImage, jpeg: FileImage, gif: FileImage, webp: FileImage, svg: FileImage,
  py: FileCode2, js: FileCode2, ts: FileCode2, tsx: FileCode2, json: FileCode2
}

function fileExtension(name: string): string {
  const clean = name.split(/[?#]/)[0] || ''
  const dot = clean.lastIndexOf('.')
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : ''
}

export function fileIconForName(name: string): LucideIcon {
  return FILE_ICON_BY_EXTENSION[fileExtension(name)] ?? File
}
