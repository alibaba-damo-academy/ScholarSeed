export type PreviewBrowsingRead = 'normal' | 'delayed' | 'failed'

export interface PreviewBrowsingPolicy {
  seed: 'sample' | 'empty' | 'paged'
  listingRead?: PreviewBrowsingRead
  explorerRead?: PreviewBrowsingRead
  explorerMore?: 'normal' | 'delayed' | 'fail-once'
}

export const PREVIEW_BROWSING = {
  pageSize: 100,
  delayMs: 2_000,
  recoveryPath: '/__preview/browsing/recover',
  invalid: 'preview_browsing_invalid',
  disposed: 'preview_browsing_disposed',
  listingFailure: 'preview_listing_unavailable',
  explorerFailure: 'preview_explorer_unavailable',
  moreFailure: 'preview_explorer_more_unavailable',
  recoveryUnavailable: 'preview_browsing_recovery_unavailable',
  seed: {
    count: 120,
    prefix: 'generated-',
    digits: 3,
    extension: '.md',
    text: '# 模拟分页资料\n\n仅用于设计预览的合成 Markdown 文件。\n',
    nested: [
      { path: 'preview-docs/overview.md', text: '# 模拟目录概览\n\n用于真实目录展开和文件打开。\n' },
      { path: 'preview-docs/nested/guide.md', text: '# 模拟嵌套资料\n\n用于真实多层目录浏览。\n' },
    ],
  },
} as const
