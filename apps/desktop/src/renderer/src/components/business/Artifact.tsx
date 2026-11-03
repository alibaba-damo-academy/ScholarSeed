import React from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, Ellipsis } from 'lucide-react'
import type { SessionArtifact } from '../../model'
import { uniqueApplications, type ApplicationCandidate } from '../../applications'
import { FileFormatIcon } from '../primitive/FileIcon'
import { PRODUCT_MENU_CONTENT_CLASS } from '../primitive/menu'
import {
  Button,
  Card,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  EllipsisText,
  IconButton,
} from '../ui'

export const MENU_CLASS_NAME = `${PRODUCT_MENU_CONTENT_CLASS} text-[length:var(--vds-font-body-lv2)]`
const SUBMENU_CLASS_NAME = `${PRODUCT_MENU_CONTENT_CLASS} max-w-[var(--vds-model-menu-max-width)] overflow-y-auto text-[length:var(--vds-font-body-lv2)]`
const MENU_HINT_CLASS_NAME =
  'px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]'

type OpenWithApp = ApplicationCandidate & { icon?: string }
type ArtifactMenuKind = 'context' | 'dropdown'

export interface ArtifactMenuItemsProps {
  apps: OpenWithApp[] | null
  appsLoading: boolean
  canSaveAs: boolean
  canUsePath: boolean
  downloading: boolean
  kind: ArtifactMenuKind
  loadApps: () => void
  onCopyPath: () => void
  onOpenWith: (app: OpenWithApp) => void
  onReveal: () => void
  onSaveAs: () => void
  revealLabel: string
  revealIcon?: React.ReactNode
  overview?: boolean
  onImport?: () => void
  canImport?: boolean
}

export function ArtifactMenuItems({
  apps,
  appsLoading,
  canSaveAs,
  canUsePath,
  downloading,
  kind,
  loadApps,
  onCopyPath,
  onOpenWith,
  onReveal,
  onSaveAs,
  revealLabel,
  revealIcon,
  overview = false,
  onImport,
  canImport,
}: ArtifactMenuItemsProps): React.JSX.Element {
  const { t: assistantText } = useTranslation('assistant')
  const Item = kind === 'context' ? ContextMenuItem : DropdownMenuItem
  const Separator = kind === 'context' ? ContextMenuSeparator : DropdownMenuSeparator
  const Sub = kind === 'context' ? ContextMenuSub : DropdownMenuSub
  const SubContent = kind === 'context' ? ContextMenuSubContent : DropdownMenuSubContent
  const SubTrigger = kind === 'context' ? ContextMenuSubTrigger : DropdownMenuSubTrigger

  return (
    <>
      {overview && (
        <>
          <Item disabled={!canImport} onSelect={onImport}>
            {assistantText('artifactEntry.import')}
          </Item>
          <Item disabled={!canUsePath} onSelect={onCopyPath}>
            {assistantText('artifactEntry.copyPath')}
          </Item>
          <Separator />
        </>
      )}
      <Sub>
        <SubTrigger
          openOnHover={overview}
          data-testid={`artifact-${kind}-open-with`}
          disabled={!canUsePath}
          onClick={loadApps}
          onMouseEnter={loadApps}
          onFocus={loadApps}
        >
          {assistantText('artifactEntry.openWith')}
        </SubTrigger>
        <SubContent
          className={`${SUBMENU_CLASS_NAME} ${overview ? '!z-[var(--vds-z-inline-flyout)]' : ''}`}
          side={overview ? 'left' : undefined}
        >
          {appsLoading && (
            <div className={MENU_HINT_CLASS_NAME}>{assistantText('artifactEntry.loadingApps')}</div>
          )}
          {!appsLoading && apps !== null && apps.length === 0 && (
            <div className={MENU_HINT_CLASS_NAME}>{assistantText('artifactEntry.noApps')}</div>
          )}
          {!appsLoading &&
            uniqueApplications(apps ?? []).map((app) => (
              <Item key={app.path} onSelect={() => onOpenWith(app)}>
                {app.icon ? (
                  <img src={app.icon} alt="" className="size-[var(--vds-icon-8)] shrink-0" />
                ) : (
                  <AppWindow aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate">{app.name}</span>
                {app.isDefault && (
                  <span className="ml-auto text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                    {assistantText('artifactEntry.defaultApp')}
                  </span>
                )}
              </Item>
            ))}
          {overview && (
            <Item disabled={!canUsePath} onSelect={onReveal}>
              {revealIcon}
              {revealLabel}
            </Item>
          )}
        </SubContent>
      </Sub>
      {!overview && (
        <>
          <Separator />
          <Item
            data-testid={`artifact-${kind}-save-as`}
            disabled={!canSaveAs || downloading}
            onSelect={onSaveAs}
          >
            {assistantText('artifactEntry.saveAs')}
          </Item>
          <Item
            data-testid={`artifact-${kind}-copy-path`}
            disabled={!canUsePath}
            onSelect={onCopyPath}
          >
            {assistantText('artifactEntry.copyPath')}
          </Item>
          <Item data-testid={`artifact-${kind}-reveal`} disabled={!canUsePath} onSelect={onReveal}>
            {revealLabel}
          </Item>
        </>
      )}
    </>
  )
}

export function ArtifactGroup({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element | null {
  const cards = React.Children.toArray(children)
  if (!cards.length) return null
  return (
    <div
      data-testid="artifact-group"
      className={`grid items-start gap-[var(--vds-space-2)] [&>[data-artifact-card]]:mt-0 ${cards.length === 1 ? 'max-w-[var(--vds-artifact-card-max-width)] grid-cols-1' : 'grid-cols-[repeat(auto-fill,minmax(min(100%,var(--vds-artifact-card-min-width)),1fr))]'}`}
    >
      {cards}
    </div>
  )
}

export interface ArtifactProps {
  primary: SessionArtifact
  versions: SessionArtifact[]
  primaryMeta: string
  canImport: boolean
  menuProps: Omit<ArtifactMenuItemsProps, 'kind'>
  preview: (artifact: SessionArtifact) => void
  previewVersion: (artifact: SessionArtifact) => void
  openImport: () => void
  children?: React.ReactNode
}

export function Artifact({
  primary,
  versions,
  primaryMeta,
  canImport,
  menuProps: suppliedMenuProps,
  preview,
  previewVersion,
  openImport,
  children,
}: ArtifactProps): React.JSX.Element {
  const { t: assistantText } = useTranslation('assistant')
  const [contextMenuOpen, setContextMenuOpen] = React.useState(false)
  const [dropdownMenuOpen, setDropdownMenuOpen] = React.useState(false)
  const selectAction = (action: () => void): void => {
    setContextMenuOpen(false)
    setDropdownMenuOpen(false)
    action()
  }
  const menuProps = {
    ...suppliedMenuProps,
    onCopyPath: () => selectAction(suppliedMenuProps.onCopyPath),
    onReveal: () => selectAction(suppliedMenuProps.onReveal),
    onSaveAs: () => selectAction(suppliedMenuProps.onSaveAs),
    onOpenWith: (app: OpenWithApp) => selectAction(() => suppliedMenuProps.onOpenWith(app)),
  }
  return (
    <ContextMenu open={contextMenuOpen} onOpenChange={setContextMenuOpen}>
      <ContextMenuTrigger asChild>
        <Card
          data-artifact-card
          className="@container/artifact mt-[var(--vds-space-3)] grid min-w-0 grid-cols-1 gap-[var(--vds-space-3)] !shadow-none [--vds-card-radius:var(--vds-radius-6)]"
          padding="sm"
          data-artifact-role={primary.role}
        >
          <div
            className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-[var(--vds-space-2)] @max-[16.5rem]/artifact:grid-cols-[auto_minmax(0,1fr)]"
            data-testid={`turn-artifact-${primary.artifact_id}`}
          >
            <span className="grid size-[var(--vds-space-8)] shrink-0 place-items-center rounded-[var(--vds-radius-3)] bg-[var(--vds-surface-muted)] text-[var(--vds-text-secondary)]">
              <FileFormatIcon name={primary.name} size={20} />
            </span>
            <span className="flex min-w-0 flex-col gap-[var(--vds-space-half)]">
              <EllipsisText
                className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]"
                tooltip={primary.name}
                tooltipContentClassName="whitespace-pre-wrap"
                tooltipPortalled
              >
                {primary.title || primary.name}
              </EllipsisText>
              <span className="flex flex-wrap items-center gap-[var(--vds-space-1)]">
                <EllipsisText
                  className="text-[length:var(--vds-font-body-lv3)] font-[var(--vds-fw-regular)] text-[var(--vds-text-secondary)]"
                  tooltipPortalled
                >
                  {primaryMeta}
                </EllipsisText>
                {versions.length > 1 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid="artifact-versions"
                        aria-label={assistantText('artifactEntry.versionsFor', {
                          name: primary.name,
                          count: versions.length,
                        })}
                      >
                        {assistantText('artifactEntry.versions', { count: versions.length })}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className={SUBMENU_CLASS_NAME}
                      data-testid="artifact-versions-menu"
                    >
                      {versions.map((version, index) => (
                        <DropdownMenuItem
                          key={version.artifact_id}
                          data-testid={`artifact-version-${version.artifact_id}`}
                          onSelect={() => previewVersion(version)}
                        >
                          {assistantText(
                            index === 0
                              ? 'artifactEntry.latestVersion'
                              : 'artifactEntry.previousVersion',
                            { version: versions.length - index }
                          )}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </span>
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-[var(--vds-space-1)] @max-[16.5rem]/artifact:col-span-2 @max-[16.5rem]/artifact:ml-0 @max-[16.5rem]/artifact:w-full @max-[16.5rem]/artifact:border-t @max-[16.5rem]/artifact:border-[var(--vds-divider-default)] @max-[16.5rem]/artifact:pt-[var(--vds-space-2)]">
              <div>
                <DropdownMenu open={dropdownMenuOpen} onOpenChange={setDropdownMenuOpen}>
                  <DropdownMenuTrigger asChild>
                    <IconButton
                      data-testid="artifact-more-actions"
                      icon={<Ellipsis size={16} />}
                      label={assistantText('artifactEntry.moreActions', {
                        name: primary.title || primary.name,
                      })}
                      size="sm"
                      variant="ghostIcon"
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className={MENU_CLASS_NAME}
                    data-testid="artifact-dropdown-menu"
                  >
                    <ArtifactMenuItems {...menuProps} kind="dropdown" />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <Button
                aria-label={assistantText('artifactEntry.import')}
                data-testid="artifact-import-resources"
                disabled={!canImport}
                onClick={openImport}
                title={assistantText('artifactEntry.import')}
                size="sm"
                variant="outline"
              >
                <span className="@max-[20rem]/artifact:hidden">
                  {assistantText('artifactEntry.import')}
                </span>
                <span className="hidden @max-[20rem]/artifact:inline">
                  {assistantText('artifactEntry.importShort')}
                </span>
              </Button>
              <Button
                aria-label={assistantText('artifactEntry.openName', { name: primary.name })}
                data-testid="artifact-open"
                onClick={() => void preview(primary)}
                title={assistantText('artifactEntry.openName', { name: primary.name })}
                size="sm"
                variant="outline"
              >
                {assistantText('artifactEntry.open')}
              </Button>
            </div>
          </div>
          {children}
        </Card>
      </ContextMenuTrigger>
      <ContextMenuContent className={MENU_CLASS_NAME} data-testid="artifact-context-menu">
        <ArtifactMenuItems {...menuProps} kind="context" />
      </ContextMenuContent>
    </ContextMenu>
  )
}
