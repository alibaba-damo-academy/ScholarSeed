import React from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Eye, Info, Paperclip, PenLine, Trash } from 'lucide-react'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../components/ui'
import { isAttachmentAvailable, type LiteratureSummary } from '../../contracts/literature'

/**
 * 行右键菜单的动作出口。
 *
 * 菜单只负责「摆出哪些动作、哪些此刻不可用」，动作本身全部由列表实现：它同时握着
 * store（打开全文）、catalogue（打开详情）、项目作用域和删除确认弹框，把这些搬进
 * 菜单组件只会让一个纯展示层反过来依赖业务状态。
 */
export interface RowMenuActions {
  /** 打开主附件全文。只在有可用主附件时可达。 */
  viewPdf: (attachmentId: string) => void
  /** 把这一条的标题写进系统剪贴板。标题为空时不可达。 */
  copyTitle: () => void
  /** 打开文献详情（基本信息）。 */
  viewInfo: () => void
  /** 打开详情并直接进入新建笔记。 */
  addNote: () => void
  /** 打开详情并直接唤起附件选择器。 */
  addAttachment: () => void
  /** 项目内 = 移出项目；文献中心 = 删除文献。由列表弹出确认。 */
  remove: () => void
}

const MENU_ICON_SIZE = 14

/**
 * 文献列表行的右键菜单（设计系统 ContextMenu，与左侧分类/标签行同源）。
 *
 * 用 `asChild` 把触发器合到行自己的 div 上：行是 CSS Grid 的直接子元素，中间多一层
 * 包裹节点会破坏网格布局，所以菜单不引入额外 DOM。
 */
export function LiteratureRowMenu({
  actions,
  children,
  item,
  projectId,
}: {
  actions: RowMenuActions
  children: React.ReactElement
  item: LiteratureSummary
  projectId?: string
}): React.JSX.Element {
  const { t: literature } = useTranslation('literature')
  // 「没有主附件」的判定与行的双击一致：文件已丢失的主附件同样按没有处理，
  // 否则点进去只会拿到一句「附件当前不可用」。
  const primaryAttachment = isAttachmentAvailable(item.primary_attachment)
    ? item.primary_attachment
    : null
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent data-testid={`literature-row-menu-${item.id}`}>
        <ContextMenuItem
          disabled={primaryAttachment === null}
          onSelect={() => {
            if (primaryAttachment) actions.viewPdf(primaryAttachment.id)
          }}
        >
          <Eye aria-hidden="true" size={MENU_ICON_SIZE} />
          {literature('list.rowMenu.viewPdf')}
        </ContextMenuItem>
        <ContextMenuItem disabled={item.title.trim() === ''} onSelect={actions.copyTitle}>
          <Copy aria-hidden="true" size={MENU_ICON_SIZE} />
          {literature('list.rowMenu.copyTitle')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={actions.viewInfo}>
          <Info aria-hidden="true" size={MENU_ICON_SIZE} />
          {literature('list.rowMenu.viewInfo')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={actions.addNote}>
          <PenLine aria-hidden="true" size={MENU_ICON_SIZE} />
          {literature('list.rowMenu.addNote')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={actions.addAttachment}>
          <Paperclip aria-hidden="true" size={MENU_ICON_SIZE} />
          {literature('list.rowMenu.addAttachment')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem destructive onSelect={actions.remove}>
          <Trash aria-hidden="true" size={MENU_ICON_SIZE} />
          {projectId ? literature('batch.removeProject') : literature('batch.deleteTitle')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
