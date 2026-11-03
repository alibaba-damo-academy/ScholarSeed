import type { ReactElement } from 'react'
import { FileDown, Hash, Info, MonitorDown } from 'lucide-react'

import { IconFont } from '../../components/primitive'
import { DropdownMenuItem, Tooltip, type TooltipSide } from '../../components/ui'
import type { ImportSourceIcon } from './imports'

/** 入口图标只在这里映射一次；此前每个菜单入口都抄同一份三元表达式。 */
const IMPORT_SOURCE_ICONS: Record<ImportSourceIcon, ReactElement> = {
  // 「#」读作编号: arXiv ID 与 DOI 都是标识符, 不是文件也不是外部账号。
  identifier: <Hash />,
  'local-pdf': <MonitorDown />,
  'bib-ris': <FileDown />,
  zotero: <IconFont type="icon-zotero" />,
}

const HINT_ICON_SIZE = 14
const HINT_TRIGGER_CLASS_NAME = 'shrink-0 text-[var(--vds-text-tertiary)]'
const HINT_ICON_CLASS_NAME = 'inline-flex shrink-0 items-center'
/**
 * 菜单宽度由 --vds-library-import-menu-width 固定，长西文文案不得挤占提示图标空间；
 * 让文案自己收缩截断，图标才不会被挤到菜单气泡外面。
 */
const LABEL_CLASS_NAME = 'min-w-0 flex-1 truncate'

export interface ImportSourceItemProps {
  /** 悬停提示文案；只有需要提前说明副作用的入口才传（本地 PDF 会抽取元数据）。 */
  hint?: string
  /**
   * 气泡展开方向。Tooltip 非 portal 模式按 CSS 静态定位、不做视口收敛，因此菜单
   * 贴近视口右缘时必须传 left，否则气泡会被裁到窗口外；侧边栏菜单向右展开更自然。
   * 气泡压住菜单也不影响点击：未滚动的 Tooltip 内容是 pointer-events-none。
   */
  hintSide?: TooltipSide
  icon: ImportSourceIcon
  label: string
  onSelect: () => void
}

/** 导入菜单项：入口图标 + 文案 + 可选的信息提示，全部导入入口共用同一份结构。 */
export function ImportSourceItem({
  hint,
  hintSide = 'right',
  icon,
  label,
  onSelect,
}: ImportSourceItemProps): ReactElement {
  return (
    <DropdownMenuItem onSelect={onSelect}>
      {IMPORT_SOURCE_ICONS[icon]}
      <span className={LABEL_CLASS_NAME}>{label}</span>
      {hint ? (
        <Tooltip className={HINT_TRIGGER_CLASS_NAME} content={hint} side={hintSide}>
          <span className={HINT_ICON_CLASS_NAME}>
            <Info aria-hidden="true" size={HINT_ICON_SIZE} />
          </span>
        </Tooltip>
      ) : null}
    </DropdownMenuItem>
  )
}
