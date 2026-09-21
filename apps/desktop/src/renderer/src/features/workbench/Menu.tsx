import { documentDisplayTitle } from '../../delivery'
import React from 'react'
import { useTranslation } from 'react-i18next'
import { MessageCirclePlus } from 'lucide-react'

import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '../../components/ui'
import { PRODUCT_MENU_CONTENT_CLASS } from '../../components/primitive/menu'
import { useApp } from '../../store'
import { revealLabelKey } from '../../fileOpen'
import type { AdjacentPosition } from './layout'
import {
  tabIdsForClose,
  useDocumentWorkspace,
  useWorkspaceController,
  type TabCloseScope
} from './workspace'

const TAB_CLOSE_ITEMS: ReadonlyArray<{
  labelKey: 'navigation.close'|'navigation.closeOthers'|'navigation.closeLeft'|'navigation.closeRight'|'navigation.closeAll'
  scope: TabCloseScope
  testId: string
}> = [
  { labelKey: 'navigation.close', scope: 'current', testId: 'tab-close' },
  { labelKey: 'navigation.closeOthers', scope: 'others', testId: 'tab-close-others' },
  { labelKey: 'navigation.closeLeft', scope: 'left', testId: 'tab-close-left' },
  { labelKey: 'navigation.closeRight', scope: 'right', testId: 'tab-close-right' },
  { labelKey: 'navigation.closeAll', scope: 'all', testId: 'tab-close-all' }
]

const MOVE_LABELS = {
  left: 'navigation.moveLeft',
  right: 'navigation.moveRight',
  top: 'navigation.moveUp',
  bottom: 'navigation.moveDown',
  leftTop: 'navigation.moveLeftTop',
  leftBottom: 'navigation.moveLeftBottom',
  rightTop: 'navigation.moveRightTop',
  rightBottom: 'navigation.moveRightBottom',
  topLeft: 'navigation.moveTopLeft',
  topRight: 'navigation.moveTopRight',
  bottomLeft: 'navigation.moveBottomLeft',
  bottomRight: 'navigation.moveBottomRight'
} as const satisfies Record<AdjacentPosition, string>

const MOVE_TEST_IDS: Record<AdjacentPosition, string> = {
  left: 'tab-move-left',
  right: 'tab-move-right',
  top: 'tab-move-up',
  bottom: 'tab-move-down',
  leftTop: 'tab-move-left-top',
  leftBottom: 'tab-move-left-bottom',
  rightTop: 'tab-move-right-top',
  rightBottom: 'tab-move-right-bottom',
  topLeft: 'tab-move-top-left',
  topRight: 'tab-move-top-right',
  bottomLeft: 'tab-move-bottom-left',
  bottomRight: 'tab-move-bottom-right'
}

export function DocumentTabMenu({
  tabId,
  tabIds
}: {
  tabId: string
  tabIds: readonly string[]
}): React.JSX.Element | null {
  const { act } = useApp()
  const { t } = useTranslation('ui')
  const { t: conversation } = useTranslation('conversation')
  const { t: workbench } = useTranslation('workbench')
  const { t: resourceText } = useTranslation('resources')
  const state = useDocumentWorkspace()
  const workspace = useWorkspaceController()
  const tab = state.tabs[tabId]
  const session = tab ? state.sessions[tab.sessionId] : null
  if (!tab || !session) return null
  const fileLocation = session.source.kind === 'project' || session.source.kind === 'literature'
  const split = (direction: 'right' | 'bottom'): void => {
    void workspace.splitTab(tab.id, direction, false)
  }
  const splitActions = (['right', 'bottom'] as const).filter(
    (direction) => workspace.canSplitTab(tab.id, direction, false)
  )
  const moveTargets = workspace.moveTargetsForTab(tab.id)
  const hasLayoutActions = splitActions.length > 0 || moveTargets.length > 0

  return (
    <ContextMenuContent className={PRODUCT_MENU_CONTENT_CLASS} data-testid="document-tab-menu">
      <ContextMenuItem
        data-testid="tab-add-to-conversation"
        disabled={!fileLocation}
        onSelect={() => void act.attachActiveFileToAi()}
      >
        <MessageCirclePlus />
        {resourceText('menu.addToConversation')}
      </ContextMenuItem>
      <ContextMenuItem data-testid="tab-copy-name" onSelect={() => void act.copyResourceName(documentDisplayTitle(tab, conversation, workbench))}>
        {resourceText('menu.copyName')}
      </ContextMenuItem>
      <ContextMenuItem
        data-testid="tab-copy-absolute-path"
        disabled={!fileLocation}
        onSelect={() => void act.copyActiveDocumentPath()}
      >
        {resourceText('menu.copyAbsolutePath')}
      </ContextMenuItem>
      <ContextMenuItem
        data-testid="tab-reveal-in-finder"
        disabled={!fileLocation}
        onSelect={() => void act.revealActiveDocument()}
      >
        {resourceText(revealLabelKey())}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {TAB_CLOSE_ITEMS.map((item) => (
        <ContextMenuItem
          key={item.scope}
          data-testid={item.testId}
          disabled={tabIdsForClose(tabIds, tab.id, item.scope).length === 0}
          onSelect={() => workspace.requestCloseTabs(
            tabIdsForClose(tabIds, tab.id, item.scope)
          )}
        >
          {t(item.labelKey)}
        </ContextMenuItem>
      ))}
      {hasLayoutActions && <ContextMenuSeparator />}
      {splitActions.map((direction) => (
        <ContextMenuItem
          key={direction}
          data-testid={direction === 'right' ? 'tab-split-right' : 'tab-split-down'}
          onSelect={() => split(direction)}
        >
          {t(direction === 'right' ? 'navigation.splitRight' : 'navigation.splitDown')}
        </ContextMenuItem>
      ))}
      {moveTargets.map((target) => (
        <ContextMenuItem
          key={`${target.area}:${target.leaf.id}`}
          data-testid={MOVE_TEST_IDS[target.position]}
          onSelect={() => void workspace.moveTab(tab.id, target.area, target.leaf.id, 'center')}
        >
          {t(MOVE_LABELS[target.position])}
        </ContextMenuItem>
      ))}
    </ContextMenuContent>
  )
}
