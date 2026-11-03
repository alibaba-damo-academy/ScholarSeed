import React from 'react'

// Mono line-icons (stroke = currentColor) matching the comp's chrome. 24×24 grid.

export type IconName =
  | 'panel-left'
  | 'panel-right'
  | 'list'
  | 'lodestar'
  | 'gear'
  | 'coin'
  | 'folder'
  | 'git-branch'
  | 'bell'
  | 'send'
  | 'stop'
  | 'plus'
  | 'graph'
  | 'memory'
  | 'artifacts'
  | 'skills'
  | 'schedule'
  | 'agents'
  | 'workflow'
  | 'user'
  | 'agent'
  | 'expand'
  | 'collapse'
  | 'close'
  | 'link'
  | 'wayfinder'
  | 'search'
  | 'globe'
  | 'pin'
  | 'edit-square'
  | 'slash'
  | 'minus'
  | 'doc'
  | 'clip'
  | 'quote'
  | 'chart-line'
  | 'play'
  | 'plug'
  | 'plug-simple'
  | 'grid'
  | 'settings'
  | 'more-horizontal'
  | 'talk'
  | 'hand'
  | 'shield'
  | 'chevron-down'
  | 'chevron-right'
  | 'rewind'
  | 'eye'
  | 'eye-off'
  | 'copy'
  | 'highlighter'
  | 'underline'
  | 'strikethrough'
  | 'annotation'
  // MVP 0.2 活动栏三视图 (资料库 / 文献库 / 写作)
  | 'inbox'
  | 'books'
  | 'pen'
  // 工作台首页空间 (原型 home space 的房子图标)
  | 'home'
  | 'panel-fold'
  | 'panel-open'
  | 'filter'
  | 'tag'
  | 'sparkle'
  | 'trash'
  | 'upload'
  // 资料库文件树: 头部工具 (带加号的新建, 环形刷新)
  | 'file-plus'
  | 'folder-plus'
  | 'refresh'
  // 资料库文件树: 按扩展名区分的文件类型 (generic 仍走 doc)
  | 'pdf'
  | 'word'
  | 'table'
  | 'code'
  | 'image'
  | 'text'
  // 头像菜单 (PRD「账号入口与快捷设置」) 的行图标
  | 'palette'
  | 'cap'
  | 'help'
  | 'external'
  | 'logout'

const PATHS: Record<IconName, React.ReactNode> = {
  // 聊天气泡 (proposal 13: 资源卡「使用这个资源对话」图形按钮)
  talk: <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.6 0-3.1-.4-4.4-1.2L3 20l1.2-5.1A8.5 8.5 0 1 1 21 11.5z" />,
  // 权限模式图标控件 (Composer 对话框下方模式选择器)
  search: (
    <>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <line x1="15.5" y1="15.5" x2="20" y2="20" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.8 12h16.4M12 3.5c2.1 2.3 3.2 5.1 3.2 8.5S14.1 18.2 12 20.5M12 3.5C9.9 5.8 8.8 8.6 8.8 12s1.1 6.2 3.2 8.5" />
    </>
  ),
  hand: (
    <>
      <path d="M8.5 11.5V6.8a1.3 1.3 0 0 1 2.6 0v4.4" />
      <path d="M11.1 11V5.6a1.3 1.3 0 0 1 2.6 0v5.6" />
      <path d="M13.7 11.4V7a1.25 1.25 0 0 1 2.5 0v5.8" />
      <path d="M8.5 12.8 7.3 11.4a1.35 1.35 0 0 0-2 .1 1.45 1.45 0 0 0 0 1.9l4.1 5.1A5.3 5.3 0 0 0 13.5 21h.8a4.9 4.9 0 0 0 4.9-4.9v-5a1.25 1.25 0 0 0-2.5 0v2" />
    </>
  ),
  shield: <path d="M12 3.2 5.4 5.8v5.5c0 4.2 2.8 7.4 6.6 9.5 3.8-2.1 6.6-5.3 6.6-9.5V5.8z" />,
  'chevron-down': <path d="M6.6 9.5l5.4 5.3 5.4-5.3" />,
  'chevron-right': <path d="m9 7 5 5-5 5" />,
  rewind: (
    <>
      <path d="M5 8.5A8 8 0 1 1 4.6 14" />
      <path d="M5 4.5v4h4" />
      <path d="M12 8v4l2.8 1.8" />
    </>
  ),
  eye: (
    <>
      <path d="M2.8 12s3.2-5.2 9.2-5.2 9.2 5.2 9.2 5.2-3.2 5.2-9.2 5.2S2.8 12 2.8 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  'eye-off': (
    <>
      <path d="M3 3l18 18" />
      <path d="M9.9 6.9A9.9 9.9 0 0 1 12 6.7c6 0 9.2 5.3 9.2 5.3a16.5 16.5 0 0 1-3.1 3.7M6.3 6.2C4 7.7 2.8 10.1 2.8 12c0 0 3.2 5.2 9.2 5.2 1.1 0 2.1-.2 3-.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="10" height="10" rx="1.8" />
      <path d="M6 15.5H5.8A1.8 1.8 0 0 1 4 13.7V5.8A1.8 1.8 0 0 1 5.8 4h7.9A1.8 1.8 0 0 1 15.5 5.8V6" />
    </>
  ),
  highlighter: (
    <>
      <path d="m15.2 4.2 4.6 4.6-8.9 8.9H6.3v-4.6z" />
      <path d="m13.6 5.8 4.6 4.6M4 20h11" />
    </>
  ),
  underline: (
    <>
      <path d="M7 4v6.2a5 5 0 0 0 10 0V4" />
      <path d="M5 20h14" />
    </>
  ),
  strikethrough: (
    <>
      <path d="M16 4H9a3 3 0 0 0-2.83 4" />
      <path d="M14 12a4 4 0 0 1 0 8H6" />
      <path d="M4 12h16" />
    </>
  ),
  annotation: (
    <>
      <path d="M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z" />
      <path d="M13 3v5h5M9 12h6M9 16h4" />
    </>
  ),
  // 资料库: 收纳盒 (原型 data-ic="inbox")
  inbox: (
    <>
      <path d="M3.5 12.5 5.6 5.2A1.6 1.6 0 0 1 7.1 4h9.8a1.6 1.6 0 0 1 1.5 1.2l2.1 7.3" />
      <path d="M3.5 12.5h4l1 2.2h7l1-2.2h4v5.9A1.6 1.6 0 0 1 18.9 20H5.1a1.6 1.6 0 0 1-1.6-1.6z" />
    </>
  ),
  // 文献库: 摊开的书 (原型 data-ic="books")
  books: (
    <>
      <path d="M12 6.4v13" />
      <path d="M12 6.4C10.4 5.1 8.3 4.4 5.6 4.4A1.1 1.1 0 0 0 4.5 5.5v11a1.1 1.1 0 0 0 1.1 1.1c2.7 0 4.8.7 6.4 2" />
      <path d="M12 6.4c1.6-1.3 3.7-2 6.4-2a1.1 1.1 0 0 1 1.1 1.1v11a1.1 1.1 0 0 1-1.1 1.1c-2.7 0-4.8.7-6.4 2" />
    </>
  ),
  // 首页空间: 房子 (原型 data-ic="home")
  home: (
    <>
      <path d="M4.6 10.6 12 4.4l7.4 6.2" />
      <path d="M6.4 9.1v9.3a1.4 1.4 0 0 0 1.4 1.4h8.4a1.4 1.4 0 0 0 1.4-1.4V9.1" />
      <path d="M10.3 19.8v-5.1h3.4v5.1" />
    </>
  ),
  // 写作: 钢笔 (原型 data-ic="pen")
  pen: (
    <>
      <path d="M16.4 3.9a1.9 1.9 0 0 1 2.7 0l1 1a1.9 1.9 0 0 1 0 2.7L8.6 18.2l-4.1 1.3 1.3-4.1z" />
      <path d="M15 5.3 18.7 9" />
    </>
  ),
  // 侧栏收起 / 展开 (原型 panel-fold / panel-open)
  'panel-fold': (
    <>
      <rect x="3.6" y="4.4" width="16.8" height="15.2" rx="2" />
      <path d="M14.4 4.4v15.2" />
      <path d="m10.6 9.6-2.4 2.8 2.4 2.8" />
    </>
  ),
  'panel-open': (
    <>
      <rect x="3.6" y="4.4" width="16.8" height="15.2" rx="2" />
      <path d="M9.6 4.4v15.2" />
      <path d="m13.4 9.6 2.4 2.8-2.4 2.8" />
    </>
  ),
  filter: <path d="M4 5.5h16l-6.2 7.3v5.4l-3.6 1.8v-7.2z" />,
  tag: (
    <>
      <path d="M11.2 4.2H19a.8.8 0 0 1 .8.8v7.8a1.6 1.6 0 0 1-.5 1.1l-6 6a1.1 1.1 0 0 1-1.6 0l-7.4-7.4a1.1 1.1 0 0 1 0-1.6l6-6a1.6 1.6 0 0 1 1.1-.5z" />
      <circle cx="15.8" cy="8.2" r="1.3" />
    </>
  ),
  // AI 检索 / AI 助手的四角星 (原型 data-ic="spark")
  sparkle: (
    <>
      <path d="M11 3.6l1.7 4.5 4.5 1.7-4.5 1.7-1.7 4.5-1.7-4.5-4.5-1.7 4.5-1.7z" />
      <path d="M17.9 15.1l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z" />
    </>
  ),
  trash: (
    <>
      <path d="M4.8 7.2h14.4" />
      <path d="M9.4 7.2V5.4a1.2 1.2 0 0 1 1.2-1.2h2.8a1.2 1.2 0 0 1 1.2 1.2v1.8" />
      <path d="M6.6 7.2l.9 11a1.4 1.4 0 0 0 1.4 1.3h6.2a1.4 1.4 0 0 0 1.4-1.3l.9-11" />
      <path d="M10.2 10.4v5.8M13.8 10.4v5.8" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4.6" />
      <path d="m7.6 9 4.4-4.4L16.4 9" />
      <path d="M4.6 15.4v2.6A1.8 1.8 0 0 0 6.4 19.8h11.2a1.8 1.8 0 0 0 1.8-1.8v-2.6" />
    </>
  ),
  'panel-left': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9.5" y1="4" x2="9.5" y2="20" />
    </>
  ),
  'panel-right': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="14.5" y1="4" x2="14.5" y2="20" />
    </>
  ),
  list: (
    <>
      <circle cx="5.5" cy="6.5" r=".8" fill="currentColor" stroke="none" />
      <circle cx="5.5" cy="12" r=".8" fill="currentColor" stroke="none" />
      <circle cx="5.5" cy="17.5" r=".8" fill="currentColor" stroke="none" />
      <path d="M9 6.5h10M9 12h10M9 17.5h10" />
    </>
  ),
  lodestar: (
    <>
      <line x1="12" y1="3" x2="12" y2="16" />
      <line x1="12" y1="9" x2="7" y2="12" />
      <line x1="12" y1="9" x2="17" y2="12" />
      <circle cx="7" cy="12" r="1.1" />
      <circle cx="17" cy="12" r="1.1" />
      <circle cx="12" cy="18.6" r="2.8" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
    </>
  ),
  coin: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M14.5 9.2c-.6-.8-1.6-1.1-2.6-1-1.1.1-1.9.8-1.9 1.7 0 1 1 1.4 2.3 1.7 1.4.3 2.5.8 2.5 2s-1.1 1.9-2.4 1.9c-1.1 0-2.1-.4-2.6-1.2" />
      <line x1="12" y1="6.5" x2="12" y2="8" />
      <line x1="12" y1="16" x2="12" y2="17.5" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  'git-branch': (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="8" r="2.2" />
      <path d="M6 8.2v7.6M6 12h6a4 4 0 0 0 4-4" />
    </>
  ),
  bell: <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 20a2 2 0 0 1-3.4 0" />,
  send: <path d="M12 19V5M5 12l7-7 7 7" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.5" />,
  plus: <path d="M12 5.1v13.8M5.1 12h13.8" />,
  graph: (
    <>
      <circle cx="6" cy="7" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="13" cy="17" r="2" />
      <path d="M7.7 8.2 11.3 15M8 7.2 16 6.3M16.6 7.6 13.8 15.2" />
    </>
  ),
  memory: (
    <>
      <path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" />
      <path d="M5 16h13M9 8h6" />
    </>
  ),
  artifacts: (
    <>
      <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z" />
      <path d="M4 7.5 12 12l8-4.5M12 12v9" />
    </>
  ),
  skills: (
    <>
      <path d="M12 3l1.8 4.6L18.5 9l-3.7 3 1.3 4.8L12 14.4 7.9 16.8 9.2 12 5.5 9l4.7-1.4z" />
    </>
  ),
  schedule: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  agents: (
    <>
      <circle cx="9" cy="8" r="2.6" />
      <circle cx="16.5" cy="9.5" r="2.1" />
      <path d="M4 19c0-2.8 2.2-5 5-5s5 2.2 5 5M14.5 19c0-1.8.8-3.2 2-4" />
    </>
  ),
  workflow: (
    <>
      <rect x="3" y="4" width="6" height="4" rx="1" />
      <rect x="15" y="9" width="6" height="4" rx="1" />
      <rect x="3" y="16" width="6" height="4" rx="1" />
      <path d="M9 6h3a2 2 0 0 1 2 2v1M9 18h3a2 2 0 0 0 2-2v-3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.2" />
      <path d="M5.5 19c0-3.4 2.9-6 6.5-6s6.5 2.6 6.5 6" />
    </>
  ),
  agent: (
    <>
      <rect x="5" y="7" width="14" height="11" rx="3" />
      <circle cx="9.5" cy="12.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="12.5" r="1.1" fill="currentColor" stroke="none" />
      <path d="M12 4v3M9 18v2M15 18v2" />
    </>
  ),
  expand: <path d="M14.2 4.4h5.4v5.4M9.8 19.6H4.4v-5.4M19.6 4.4l-6.2 6.2M4.4 19.6l6.2-6.2" />,
  collapse: <path d="M14.4 4.4v5.2h5.2M9.6 19.6v-5.2H4.4M19.6 4.4l-5.2 5.2M4.4 19.6l5.2-5.2" />,
  close: <path d="M6.3 6.3l11.4 11.4M17.7 6.3 6.3 17.7" />,
  link: <path d="M9 13a4 4 0 0 0 5.7.6l2.5-2.5a4 4 0 0 0-5.7-5.7l-1.3 1.3M15 11a4 4 0 0 0-5.7-.6L6.8 12.9a4 4 0 0 0 5.7 5.7l1.3-1.3" />,
  // 关联研究方向：起点 → 探索路径 → 带箭头的目标，不是普通的前进箭头。
  wayfinder: (
    <>
      <circle cx="5.5" cy="18" r="1.7" />
      <path d="M7.2 17.7c2.2-.4 3.3-1.9 3.3-4.3 0-2.6 1.8-4.4 4.1-4.4H18" />
      <path d="m15.3 5.7 3.2 3.2-3.2 3.2" />
      <circle cx="18.2" cy="8.9" r="3.2" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21v-7.2" />
      <path d="M8.2 3.8h7.6l-1.3 5.4a3.4 3.4 0 1 1-5 0z" />
    </>
  ),
  'edit-square': (
    <>
      <path d="M14.5 4.5H6a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2h11.5a2 2 0 0 0 2-2v-8.5" />
      <path d="M13 11 19.2 4.8a1.7 1.7 0 0 1 2.4 2.4L15.4 13.4 12 14z" />
    </>
  ),
  slash: <path d="M9 19 15 5" />,
  minus: <path d="M5 12h14" />,
  // 文档页 (带右上折角) — 加号菜单「添加文件」
  doc: (
    <>
      <path d="M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z" />
      <path d="M13 3v5h5" />
    </>
  ),
  clip: <path d="m21 11.5-8.6 8.6a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />,
  quote: <path d="M10 11H6a4 4 0 0 1 4-4v10H6v-4h4M18 11h-4a4 4 0 0 1 4-4v10h-4v-4h4" />,
  'chart-line': (
    <>
      <path d="M5 19V5" />
      <path d="M5 19h14" />
      <path d="m8 14 3-3 2.5 2 4.5-5" />
    </>
  ),
  play: <path d="M8 5.5v13l11-6.5z" />,
  // 插头/插件 — 加号菜单「技能」
  plug: (
    <>
      <path d="M9 2v4M15 2v4" />
      <path d="M7 6h10v3a5 5 0 0 1-10 0z" />
      <path d="M12 14v6" />
    </>
  ),
  'plug-simple': (
    <>
      <path d="M9 4v5M15 4v5" />
      <path d="M7 9h10v2a5 5 0 0 1-10 0z" />
      <path d="M12 16v4" />
    </>
  ),
  // 2x2 网格 (技能库入口) — 技能面板搜索框右侧
  grid: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  // 带齿的标准齿轮 (feather settings) — 「管理技能」
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  'more-horizontal': (
    <>
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  // 文件树头部「新建文档 / 新建文件夹」: 复用 doc / folder 轮廓叠加号,
  // 否则按钮和普通文档、普通文件夹长得一样, 分不出是「新建」。
  'file-plus': (
    <>
      <path d="M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z" />
      <path d="M13 3v5h5" />
      <path d="M12 12.4v5.2M9.4 15h5.2" />
    </>
  ),
  'folder-plus': (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 10v6M9 13h6" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-8-8c2.24 0 4.38.94 5.93 2.51L20 8.6" />
      <path d="M20 4v4.6h-4.6" />
    </>
  ),
  // PDF 用实心标签条而不是细线, 这样在 13px 的树行里能和通用 doc 一眼区分开。
  pdf: (
    <>
      <path d="M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z" />
      <path d="M13 3v5h5" />
      <rect x="8.6" y="12.2" width="6.8" height="2.8" rx=".9" fill="currentColor" stroke="none" />
      <path d="M9 18.2h5" />
    </>
  ),
  word: (
    <>
      <path d="M13 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V8z" />
      <path d="M13 3v5h5" />
      <path d="M8.5 12.4l1.6 5.2 1.9-3.7 1.9 3.7 1.6-5.2" />
    </>
  ),
  table: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 10h16M10 10v9" />
    </>
  ),
  code: <path d="M9.2 8.4 5 12l4.2 3.6M14.8 8.4 19 12l-4.2 3.6M13.4 5.6l-2.8 12.8" />,
  image: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.4" />
      <path d="m5.5 17.2 4.4-4.4 3 2.8 2.2-2.1 3.4 4" />
    </>
  ),
  text: <path d="M5.5 7.2h13M5.5 11.2h13M5.5 15.2h9M5.5 19.2h6.5" />,
  // 外观: 调色板 (带三个色点)
  palette: (
    <>
      <path d="M12 21a9 9 0 1 1 9-9c0 2.2-1.6 3.4-3.4 3.4h-1.9a2 2 0 0 0-1.5 3.3c.5.6.1 2.3-2.2 2.3z" />
      <path d="M7.6 10.2h.01M11 7.4h.01M15 9h.01" />
    </>
  ),
  // 新手引导: 学位帽
  cap: (
    <>
      <path d="M2.5 9.4 12 5l9.5 4.4L12 13.8z" />
      <path d="M6.2 11.6v3.9c0 1.4 2.6 2.6 5.8 2.6s5.8-1.2 5.8-2.6v-3.9" />
      <path d="M21.5 9.4v4.8" />
    </>
  ),
  // 问题反馈: 圆圈问号
  help: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M9.7 9.5a2.4 2.4 0 1 1 3.5 2.1c-.8.5-1.2 1-1.2 1.9" />
      <path d="M12 16.6h.01" />
    </>
  ),
  // 跳转云端页: 方框出箭头
  external: (
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5 11 13" />
      <path d="M18 13.6V18a1.6 1.6 0 0 1-1.6 1.6H6A1.6 1.6 0 0 1 4.4 18V7.6A1.6 1.6 0 0 1 6 6h4.4" />
    </>
  ),
  // 退出登录: 门框 + 右向箭头
  logout: (
    <>
      <path d="M9.5 4.5H6A1.5 1.5 0 0 0 4.5 6v12A1.5 1.5 0 0 0 6 19.5h3.5" />
      <path d="M15 8.5 18.5 12 15 15.5" />
      <path d="M18.5 12h-9" />
    </>
  )
}

// 扩展名 → 图标。加新类型是往这张表加一行, 不是改分支逻辑。
// ResourceNode 只有 kind: 'file' | 'dir', 没有 mime/类型字段, 只能从文件名解扩展名。
const FILE_ICONS: Record<string, IconName> = {
  pdf: 'pdf',
  doc: 'word',
  docx: 'word',
  xls: 'table',
  xlsx: 'table',
  csv: 'table',
  tsv: 'table',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  bmp: 'image',
  py: 'code',
  js: 'code',
  ts: 'code',
  tsx: 'code',
  jsx: 'code',
  json: 'code',
  sh: 'code',
  c: 'code',
  h: 'code',
  cpp: 'code',
  java: 'code',
  go: 'code',
  rs: 'code',
  rb: 'code',
  yaml: 'code',
  yml: 'code',
  toml: 'code',
  txt: 'text',
  log: 'text'
}

// 认不出的扩展名, 以及 .md 这类主力笔记格式, 都落到通用文档页。
export function fileIcon(fileName: string): IconName {
  const dot = fileName.lastIndexOf('.')
  // dot === 0 是 .gitignore 这种全名点开头的文件, 没有扩展名可言。
  if (dot <= 0) return 'doc'
  return FILE_ICONS[fileName.slice(dot + 1).toLowerCase()] ?? 'doc'
}

export function Icon({ name, size = 16, sw = 1.6, fill, color, className }: { name: IconName; size?: number; sw?: number; fill?: string; color?: string; className?: string }): React.JSX.Element {
  return (
    // 不传 color 时不写内联 style: 内联样式优先级高于任何外部 CSS,
    // 无条件写死会让父元素/类名上的 color 永久失效 (深色底图标改不动)。
    // 默认色改由 .vds-icon 类在 styles.css 里兜底, 外观不变但可被覆盖。
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill ?? 'none'} stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={className ? `vds-icon ${className}` : 'vds-icon'} style={color ? { color } : undefined}>
      {PATHS[name]}
    </svg>
  )
}
