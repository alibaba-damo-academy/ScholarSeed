export const OFFICE_FONT_CATALOG_CHANNEL = 'scholarseed:office-font-catalog'
export const OFFICE_FONT_READ_CHANNEL = 'scholarseed:office-font-read'
export const OFFICE_FONT_CACHE_READ_CHANNEL = 'scholarseed:office-font-cache-read'
export const OFFICE_FONT_CACHE_WRITE_CHANNEL = 'scholarseed:office-font-cache-write'
export const OFFICE_FONT_CACHE_SCHEMA = 1
export const OFFICE_FONT_CACHE_MAX_BYTES = 16 * 1024 * 1024
export const OFFICE_FONT_CACHE_DIRECTORY = 'office-fontconfig'
export const OFFICE_FONT_CACHE_ENTRIES = [
  {
    path: '/instdir/program/resource/common/fonts',
    name: '6f0ff02bc2af6c1cfe5f61160c18e703-le32d8.cache-8',
  },
  {
    path: '/instdir/share/fonts/truetype',
    name: 'e65f04da2b8603a708a0cb31c8488b7c-le32d8.cache-8',
  },
] as const

export interface OfficeFontCache {
  files: Array<{ name: string; bytes: Uint8Array }>
  directories: Array<{ path: string; mtime: number }>
}

export interface OfficeFontFile {
  id: string
  filename: string
  postscriptNames: string[]
}

export interface OfficeFontCatalog {
  fingerprint: string
  faceCount: number
  fonts: OfficeFontFile[]
}

export interface NativeFontFace {
  path: string
  postscriptName: string
  /** DirectWrite's face index within the original font file. */
  faceIndex?: number
  /** CoreText's name table; identifies the source face even for synthesized instance names. */
  nameTable?: Uint8Array
}
