import remarkGfm, { type Options as RemarkGfmOptions } from 'remark-gfm'

export const GFM_OPTIONS: RemarkGfmOptions = { singleTilde: false }
export const GFM_PLUGIN: [typeof remarkGfm, RemarkGfmOptions] = [
  remarkGfm,
  GFM_OPTIONS
]
