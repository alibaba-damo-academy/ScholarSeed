import React, { type HTMLAttributes, type ComponentType } from 'react'
import {
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
import excel from '../../assets/fileIcon/fill-file-excel.webp'
import pdf from '../../assets/fileIcon/fill-file-pdf.webp'
import zip from '../../assets/fileIcon/fill-file-zip.webp'
import text from '../../assets/fileIcon/fill-file-text.webp'
import html from '../../assets/fileIcon/fill-file-html.webp'
import image from '../../assets/fileIcon/fill-file-image.webp'
import tsx from '../../assets/fileIcon/fill-file-tsx.webp'
import ppt from '../../assets/fileIcon/fill-file-ppt.webp'
import word from '../../assets/fileIcon/fill-file-word.webp'
import mov from '../../assets/fileIcon/fill-file-mov.webp'
import music from '../../assets/fileIcon/fill-file-music.webp'
import folder from '../../assets/fileIcon/fill-file-folder.webp'
import { fileIconKind, type FileIconKind } from './utils'

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

export function fileIconForName(
  name: string,
  kind: 'file' | 'dir' = 'file'
): ComponentType<FileIconProps> {
  if (kind === 'dir') return FILE_ICON_COMPONENTS.folder
  const matched = fileIconKind(name)
  return matched ? FILE_ICON_COMPONENTS[matched] : DocumentIcon
}

export function FileFormatIcon({
  name,
  kind,
  appearance = 'asset',
  ...props
}: FileIconProps & {
  name: string
  kind?: 'file' | 'dir'
  appearance?: 'asset' | 'outline'
}): React.JSX.Element {
  if (appearance === 'outline') {
    const matched = kind === 'dir' ? 'folder' : fileIconKind(name)
    const Icon = matched ? FILE_OUTLINE_ICONS[matched] : File
    return <DocumentIcon {...props} icon={Icon} />
  }
  const Icon = fileIconForName(name, kind)
  return <Icon {...props} />
}
