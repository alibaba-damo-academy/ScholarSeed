import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  EllipsisText,
} from '../../components/ui'
import type { JoinDestination, JoinNode } from './hierarchy'

// 目录树菜单的公共边界: 限制最大宽度让超长名称触发省略。
// 菜单基类是 `grid w-max`(按最宽项撑开), 单加 max-w 收不窄 grid 轨道: 超长名称会把唯一轨道顶到
// max-content 并横向溢出, 名称被菜单边缘裁切而非省略, 且 scrollWidth==clientWidth 让 EllipsisText
// 判定「未溢出」从而禁用 tooltip。用 minmax(0,1fr) 把轨道钉到容器宽度, 名称才会真正 truncate 并可 hover。
const MENU_TRACK = '[grid-template-columns:minmax(0,1fr)]'
// 内容层只限宽并钉住轨道, 不自身滚动: 纵向滚动交给内部 TREE_SCROLL_CLASS_NAME,
// 这样「新建分类」能作为内容的独立 grid 行固定在菜单底部, 不随分类列表滚走。
export const MENU_BOUNDS = `max-w-[var(--vds-popover-width-md)] ${MENU_TRACK}`
// 分类树滚动区: 限高(比整菜单滚动时更矮, 避免菜单顶满视口) + 纵向滚动; 轨道同样钉住以保证省略生效。
const TREE_SCROLL_CLASS_NAME = `grid ${MENU_TRACK} max-h-[var(--vds-library-destination-tree-max-height)] overflow-y-auto`

/**
 * 文献库检索结果与 AI 助手参考文献卡片共用的「加入分类」目录树行。
 * 叶子分类直接选中加入; 含子分类的节点展开下一级 (openOnHover); 每层末尾在传入 parent 时给出「新建分类」。
 * 名称统一走 EllipsisText: 溢出才省略, 且只在真实溢出时 hover 展示完整内容。菜单本身 portal 到 body,
 * tooltip 必须同样 portal (tooltipPortalled) 才不会被菜单的 overflow 裁切。
 */
export function DestinationRows({
  nodes,
  parent,
  choose,
  create,
}: {
  nodes: JoinNode[]
  parent?: JoinDestination
  choose: (node: JoinDestination) => void
  create: (node: JoinDestination) => void
}): React.JSX.Element {
  const { t } = useTranslation('literature')
  const [active, setActive] = useState('')
  return (
    <>
      <div className={TREE_SCROLL_CLASS_NAME}>
        {nodes.map((node) =>
          !node.children.length && node.collectionId ? (
            <DropdownMenuItem
              key={node.key}
              onPointerEnter={() => setActive('')}
              onSelect={() => choose(node)}
            >
              <EllipsisText tooltipPortalled wrapperClassName="min-w-0 flex-1 text-left">
                {node.name}
              </EllipsisText>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuSub
              key={node.key}
              open={active === node.key}
              onOpenChange={(open) => setActive(open ? node.key : '')}
            >
              <DropdownMenuSubTrigger
                openOnHover
                onClick={(event) => {
                  event.preventDefault()
                  choose(node)
                }}
              >
                <EllipsisText tooltipPortalled wrapperClassName="min-w-0 flex-1 text-left">
                  {node.name}
                </EllipsisText>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent
                className={MENU_BOUNDS}
                side="left"
                autoFocus={false}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowLeft') {
                    event.preventDefault()
                    setActive('')
                  }
                }}
              >
                <DestinationRows
                  nodes={node.children}
                  parent={node.collectionId ? undefined : node}
                  choose={choose}
                  create={create}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )
        )}
      </div>
      {parent && (
        <>
          {nodes.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onPointerEnter={() => setActive('')} onSelect={() => create(parent)}>
            {t('join.newCollection')}
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}
