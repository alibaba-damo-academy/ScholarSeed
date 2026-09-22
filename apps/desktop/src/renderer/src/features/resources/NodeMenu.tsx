import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  CopyPlus,
  History,
  ExternalLink,
  Link,
  Pencil,
  MessageCirclePlus,
  Trash2,
  Unlink,
  type LucideIcon
} from 'lucide-react'

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '../../components/ui'
import { useApp } from '../../store'
import { revealLabelKey } from '../../fileOpen'
import { findResourceNode } from './state'

/**
 * 资料树右键菜单（PRD「资料管理」）。
 *
 * 每一项都对应一个真实落盘动作，没有装饰项：重命名、复制、
 * 在访达中打开、复制路径、删除（走系统废纸篓）。
 */
export function NodeMenu(): React.JSX.Element | null {
  const { state, act } = useApp()
  const { t } = useTranslation('resources')
  const menu = state.resource.nodeMenu
  if (!menu) return null

  const linkRoot = menu.linkRoot
  const isLinkRoot = linkRoot?.mountPath === menu.path

  const node = findResourceNode(state.resource.tree, menu.path)
  const versionState = node?.version
  const admissionPending = state.resource.admissionPending?.[`${state.homeSelectedProjectId}:${menu.path}`] ?? false
  const canAdmit = menu.kind === 'file' && !versionState?.manualAdmitted
    && (versionState?.managementState === 'unsupported' || versionState?.managementState === 'ignored' || versionState?.managementState === 'migration_required')
  const canShowVersionHistory = menu.kind === 'file'
    && Boolean(versionState?.snapshotState || versionState?.managementState === 'managed')

  const items: {
    key: string
    label: string
    Icon: LucideIcon
    danger?: boolean
    disabled?: boolean
    separatorAfter?: boolean
    run: () => void
  }[] = [
    // 资料树已经持有项目内相对 path，直接交给统一队列即可；不要在前端解析
    // 绝对路径或把文件正文拼进用户问题。
    {
      key: 'ai-context',
      separatorAfter: true,
      label: t('menu.addToConversation'),
      Icon: MessageCirclePlus,
      run: () => void act.addAiContextRef({
        kind: menu.kind,
        sourceId: menu.path,
        label: menu.name
      })
    },
    ...(canAdmit ? [{ key: 'version-admission', label: t(admissionPending ? 'menu.admittingVersion' : 'menu.admitVersion'), Icon: History, disabled: admissionPending, run: () => void act.admitResourceVersion(menu.path) }] : []),
    ...(!isLinkRoot ? [{
      key: 'rename',
      label: t('menu.rename'),
      Icon: Pencil,
      run: () => act.startResourceDraft(menu.path, 'rename')
    }] : []),
    {
      key: 'reveal',
      label: t(revealLabelKey()),
      Icon: ExternalLink,
      run: () => void act.revealResourceNode(menu.path)
    },
    ...(!isLinkRoot ? [{
      key: 'copy',
      label: t('menu.duplicate'),
      Icon: CopyPlus,
      run: () => void act.copyResourceNode(menu.path)
    }] : []),
    {
      key: 'copy-path',
      separatorAfter: !canShowVersionHistory,
      label: t('menu.copyPath'),
      Icon: Link,
      run: () => void act.copyResourcePath(menu.path)
    },
    ...(canShowVersionHistory ? [{
      key: 'version-history',
      separatorAfter: true,
      label: t('menu.versionHistory'),
      Icon: History,
      run: () => void act.openResourceHistory(menu.path)
    }] : []),
    ...(linkRoot ? [{
      key: 'unlink',
      label: t('menu.unlink'),
      Icon: Unlink,
      danger: true,
      run: () => act.confirmResourceUnlink({
        ...linkRoot,
        name: linkRoot.mountPath.split('/').pop() ?? menu.name
      })
    }] : [{
      key: 'delete',
      label: t('menu.delete'),
      Icon: Trash2,
      danger: true,
      run: () => act.confirmResourceDelete(menu)
    }])
  ]

  return (
    <DropdownMenu open={true} onOpenChange={(open) => {
      if (!open) {
        act.closeResourceMenu()
      }
    }}>
      <DropdownMenuContent
        className="vds-node-menu max-h-[calc(100vh-16px)] overflow-y-auto"
        position={menu.anchor ? { kind: 'anchor', ...menu.anchor } : { kind: 'point', x: menu.x, y: menu.y }}
        data-testid="resource-node-menu"
      >
        {items.map((item) => {
          const MenuItemIcon = item.Icon
          return (
            <React.Fragment key={item.key}>
              <DropdownMenuItem
                disabled={item.disabled}
                destructive={item.danger}
                data-testid={`menu-${item.key}`}
                onSelect={() => {
                  act.closeResourceMenu()
                  item.run()
                }}
              >
                <MenuItemIcon />
                <span>{item.label}</span>
              </DropdownMenuItem>
              {item.separatorAfter && <DropdownMenuSeparator />}
            </React.Fragment>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
