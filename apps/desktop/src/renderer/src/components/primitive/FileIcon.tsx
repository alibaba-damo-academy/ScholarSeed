import React, { type HTMLAttributes, type ComponentType } from 'react'
import {
  BookOpenText,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Presentation,
  type LucideIcon,
} from 'lucide-react'
import excel from '../../assets/fileIcon/fill-file-excel-l.svg'
import pdf from '../../assets/fileIcon/fill-file-pdf-l.svg'
import zip from '../../assets/fileIcon/fill-file-zip-l.svg'
import text from '../../assets/fileIcon/fill-file-text-l.svg'
import html from '../../assets/fileIcon/fill-file-html-l.svg'
import image from '../../assets/fileIcon/fill-file-image-l.svg'
import tsx from '../../assets/fileIcon/fill-file-tsx-l.svg'
import ppt from '../../assets/fileIcon/fill-file-ppt-l.svg'
import word from '../../assets/fileIcon/fill-file-word-l.svg'
import mov from '../../assets/fileIcon/fill-file-mov-l.svg'
import music from '../../assets/fileIcon/fill-file-music-l.svg'
import folder from '../../assets/fileIcon/fill-file-folder-l.svg'
import { fileIconKind, type FileIconKind } from './utils'

export const FILE_FALLBACK_ICON_CLASS_NAME = '!size-3/4 text-[var(--vds-icon-outline-default)]'

interface FileIconProps extends HTMLAttributes<HTMLSpanElement> {
  size?: number | string
  strokeWidth?: number | string
}

const FILE_ICON_ASSETS: Record<FileIconKind | 'folder', string> = {
  excel,
  pdf,
  zip,
  text,
  html,
  image,
  tsx,
  ppt,
  word,
  mov,
  music,
  folder,
}

const FILE_OUTLINE_ICONS = {
  excel: FileSpreadsheet,
  pdf: FileText,
  zip: FileArchive,
  text: FileText,
  html: FileCode,
  image: FileImage,
  tsx: FileCode,
  ppt: Presentation,
  word: FileText,
  mov: FileVideo,
  music: FileAudio,
  folder: Folder,
}

function assetIcon(kind: keyof typeof FILE_ICON_ASSETS): ComponentType<FileIconProps> {
  return function FileAssetIcon({
    size,
    strokeWidth: _strokeWidth,
    className = '',
    style,
    ...props
  }) {
    return (
      <span
        aria-hidden="true"
        {...props}
        className={`inline-flex size-[var(--vds-icon-8)] shrink-0 items-center justify-center align-middle ${className}`}
        style={size === undefined ? style : { width: size, height: size, ...style }}
      >
        <img alt="" className="size-full object-contain" src={FILE_ICON_ASSETS[kind]} />
      </span>
    )
  }
}

const FILE_ICON_COMPONENTS = Object.fromEntries(
  (Object.keys(FILE_ICON_ASSETS) as Array<keyof typeof FILE_ICON_ASSETS>).map((kind) => [
    kind,
    assetIcon(kind),
  ])
) as Record<keyof typeof FILE_ICON_ASSETS, ComponentType<FileIconProps>>

function DocumentIcon({
  icon: Icon = File,
  size,
  strokeWidth,
  className = '',
  style,
  ...props
}: FileIconProps & { icon?: LucideIcon }): React.JSX.Element {
  return (
    <span
      {...props}
      aria-hidden="true"
      className={`inline-flex size-[var(--vds-icon-8)] shrink-0 items-center justify-center align-middle ${className}`}
      style={size === undefined ? style : { width: size, height: size, ...style }}
    >
      <Icon className="size-full" strokeWidth={strokeWidth} />
    </span>
  )
}

export function hasFileFormatAsset(name: string, kind: 'file' | 'dir' = 'file'): boolean {
  return kind === 'dir' || Boolean(fileIconKind(name))
}

function LiteratureIcon(props: FileIconProps): React.JSX.Element {
  return <DocumentIcon {...props} icon={BookOpenText} strokeWidth={1.5} />
}

export function fileIconForName(
  name: string,
  kind: 'file' | 'dir' = 'file',
  source?: 'literature'
): ComponentType<FileIconProps> {
  if (kind === 'dir') return FILE_ICON_COMPONENTS.folder
  const matched = fileIconKind(name)
  if (matched) return FILE_ICON_COMPONENTS[matched]
  return source === 'literature' ? LiteratureIcon : DocumentIcon
}

export function FileFormatIcon({
  name,
  kind,
  source,
  appearance = 'asset',
  ...props
}: FileIconProps & {
  name: string
  kind?: 'file' | 'dir'
  source?: 'literature'
  appearance?: 'asset' | 'outline'
}): React.JSX.Element {
  if (appearance === 'outline') {
    const matched = kind === 'dir' ? 'folder' : fileIconKind(name)
    if (!matched && source === 'literature') return <LiteratureIcon {...props} />
    const Icon = matched ? FILE_OUTLINE_ICONS[matched] : File
    return <DocumentIcon {...props} icon={Icon} />
  }
  const Icon = fileIconForName(name, kind, source)
  return <Icon {...props} />
}
