import React from 'react'
import { useTranslation } from 'react-i18next'
import { AppWindow, Folder } from 'lucide-react'
import type { SessionArtifact } from '../../model'
import { uniqueApplications, type ApplicationCandidate } from '../../applications'
import { FileFormatIcon, hasFileFormatAsset } from '../primitive/FileIcon'
import { Receipt } from '../primitive/Receipt'
import { Images, type ConversationImage } from '../primitive/Images'
import { PRODUCT_MENU_CONTENT_CLASS } from '../primitive/menu'
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '../ui'

export const MENU_CLASS_NAME = `${PRODUCT_MENU_CONTENT_CLASS} text-[length:var(--vds-font-body-lv2)]`
const SUBMENU_CLASS_NAME = `${PRODUCT_MENU_CONTENT_CLASS} max-w-[var(--vds-model-menu-max-width)] overflow-y-auto text-[length:var(--vds-font-body-lv2)]`
const MENU_HINT_CLASS_NAME =
  'px-[var(--vds-space-2)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]'
export const ARTIFACT_ROWS_CLASS =
  'my-[var(--vds-space-3)] grid min-w-0 items-start gap-[var(--vds-space-2)] grid-cols-[repeat(auto-fill,minmax(min(100%,max(var(--vds-artifact-card-min-width),calc((100%_-_var(--vds-space-2))_/_2))),1fr))]'
export const ARTIFACT_ROW_ITEM_CLASS = 'min-w-0'

type OpenWithApp = ApplicationCandidate & { icon?: string }
type ArtifactMenuKind = 'context' | 'dropdown'

export interface FileMenuItemsProps {
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
  onSaveAs?: () => void
  revealLabel: string
  revealIcon?: React.ReactNode
  overview?: boolean
  onImport?: () => void
  canImport?: boolean
  directory?: boolean
  onOpen?: () => void
  showSaveAs?: boolean
  showOpenWith?: boolean
  emptyApps?: React.ReactNode
  imagePreview?: boolean
}

export type ArtifactMenuItemsProps = FileMenuItemsProps

export function OpenWithApplications({
  apps,
  appsLoading,
  emptyApps,
  kind,
  onOpenWith,
}: Pick<
  FileMenuItemsProps,
  'apps' | 'appsLoading' | 'emptyApps' | 'kind' | 'onOpenWith'
>): React.JSX.Element {
  const { t: assistantText } = useTranslation('assistant')
  const Item = kind === 'context' ? ContextMenuItem : DropdownMenuItem
  const applications = uniqueApplications(apps ?? [])
  return (
    <>
      {appsLoading && (
        <div className={MENU_HINT_CLASS_NAME}>{assistantText('artifactEntry.loadingApps')}</div>
      )}
      {!appsLoading &&
        apps !== null &&
        apps.length === 0 &&
        (emptyApps ?? (
          <div className={MENU_HINT_CLASS_NAME}>{assistantText('artifactEntry.noApps')}</div>
        ))}
      {!appsLoading &&
        applications.map((app) => (
          <Item
            key={app.path}
            className="!h-auto max-w-[var(--vds-model-menu-max-width)] py-[var(--vds-space-2)]"
            onSelect={() => onOpenWith(app)}
          >
            {app.icon ? (
              <img src={app.icon} alt="" className="size-[var(--vds-icon-8)] shrink-0" />
            ) : (
              <AppWindow aria-hidden />
            )}
            <span className="min-w-0 flex-1">
              <span className="block">{app.name}</span>
              {applications.some(
                (candidate) =>
                  candidate.path !== app.path &&
                  candidate.name.trim().toLocaleLowerCase() === app.name.trim().toLocaleLowerCase()
              ) && (
                <span className="block whitespace-normal break-all text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                  {app.path}
                </span>
              )}
            </span>
            {app.isDefault && (
              <span className="ml-auto text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-tertiary)]">
                {assistantText('artifactEntry.defaultApp')}
              </span>
            )}
          </Item>
        ))}
    </>
  )
}

export function FileMenuItems({
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
  directory = false,
  onOpen,
  showSaveAs = true,
  showOpenWith = true,
  emptyApps,
  imagePreview = false,
}: FileMenuItemsProps): React.JSX.Element {
  const { t: assistantText } = useTranslation('assistant')
  const Item = kind === 'context' ? ContextMenuItem : DropdownMenuItem
  const Separator = kind === 'context' ? ContextMenuSeparator : DropdownMenuSeparator
  const Sub = kind === 'context' ? ContextMenuSub : DropdownMenuSub
  const SubContent = kind === 'context' ? ContextMenuSubContent : DropdownMenuSubContent
  const SubTrigger = kind === 'context' ? ContextMenuSubTrigger : DropdownMenuSubTrigger

  if (directory)
    return (
      <>
        {onOpen && <Item onSelect={onOpen}>{assistantText('artifactEntry.open')}</Item>}
        {canUsePath && (
          <>
            <Item data-testid={`artifact-${kind}-copy-path`} onSelect={onCopyPath}>
              {assistantText('artifactEntry.copyPath')}
            </Item>
            <Item data-testid={`artifact-${kind}-reveal`} onSelect={onReveal}>
              {revealLabel}
            </Item>
          </>
        )}
      </>
    )

  return (
    <>
      {onOpen && <Item onSelect={onOpen}>{assistantText('artifactEntry.open')}</Item>}
      {!overview && canImport && onImport && (
        <Item onSelect={onImport}>{assistantText('artifactEntry.import')}</Item>
      )}
      {overview && (
        <>
          {canImport && onImport && (
            <Item onSelect={onImport}>{assistantText('artifactEntry.import')}</Item>
          )}
          <Item disabled={!canUsePath} onSelect={onCopyPath}>
            {assistantText('artifactEntry.copyPath')}
          </Item>
          <Separator />
        </>
      )}
      {showOpenWith && (
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
            className={`${SUBMENU_CLASS_NAME} ${imagePreview ? '!z-[var(--vds-z-modal-nested-flyout)]' : overview ? '!z-[var(--vds-z-inline-flyout)]' : ''}`}
            side={overview || imagePreview ? 'left' : undefined}
          >
            <OpenWithApplications {...{ apps, appsLoading, emptyApps, kind, onOpenWith }} />
            {overview && (
              <Item disabled={!canUsePath} onSelect={onReveal}>
                {revealIcon ?? <Folder aria-hidden />}
                {revealLabel}
              </Item>
            )}
          </SubContent>
        </Sub>
      )}
      {!overview && (
        <>
          {showOpenWith && <Separator />}
          {showSaveAs && (
            <Item
              data-testid={`artifact-${kind}-save-as`}
              disabled={!canSaveAs || downloading || !onSaveAs}
              onSelect={onSaveAs}
            >
              {assistantText('artifactEntry.saveAs')}
            </Item>
          )}
          {!imagePreview && (
            <Item
              data-testid={`artifact-${kind}-copy-path`}
              disabled={!canUsePath}
              onSelect={onCopyPath}
            >
              {assistantText('artifactEntry.copyPath')}
            </Item>
          )}
          <Item data-testid={`artifact-${kind}-reveal`} disabled={!canUsePath} onSelect={onReveal}>
            {revealLabel}
          </Item>
        </>
      )}
    </>
  )
}

export { FileMenuItems as ArtifactMenuItems }

export function ArtifactGroup({
  children,
  images,
  renderImageActions,
}: {
  children?: React.ReactNode
  /** @deprecated File cards use the same layout in every group. */
  fileLayout?: boolean
  images?: readonly ConversationImage[]
  renderImageActions?: (
    image: ConversationImage,
    preview?: boolean,
    onClose?: () => void
  ) => React.ReactNode
}): React.JSX.Element | null {
  if (images?.length)
    return (
      <div data-testid="artifact-image-group">
        <Images
          items={images}
          captions={false}
          hoverActions
          renderActions={renderImageActions}
          renderPreviewActions={(image, onClose) => renderImageActions?.(image, true, onClose)}
        />
      </div>
    )
  const cards = React.Children.toArray(children)
  if (!cards.length) return null
  return (
    <div
      data-artifact-list
      data-testid="artifact-group"
      className={`${ARTIFACT_ROWS_CLASS} [&>:only-child]:col-span-full`}
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
  menuProps: Omit<ArtifactMenuItemsProps, 'kind'> & { onSaveAs: () => void }
  onMenuOpen?: () => void
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
  onMenuOpen,
  preview,
  previewVersion,
  openImport,
  children,
}: ArtifactProps): React.JSX.Element {
  const { t: assistantText } = useTranslation('assistant')
  const [contextMenuOpen, setContextMenuOpen] = React.useState(false)
  const selectAction = (action: () => void): void => {
    setContextMenuOpen(false)
    action()
  }
  const menuProps = {
    ...suppliedMenuProps,
    canImport,
    onImport: () => selectAction(openImport),
    onOpen: () => selectAction(() => preview(primary)),
    onCopyPath: () => selectAction(suppliedMenuProps.onCopyPath),
    onReveal: () => selectAction(suppliedMenuProps.onReveal),
    onSaveAs: () => selectAction(suppliedMenuProps.onSaveAs),
    onOpenWith: (app: OpenWithApp) => selectAction(() => suppliedMenuProps.onOpenWith(app)),
  }
  const kind = menuProps.directory ? 'dir' : 'file'
  const coloredIcon = hasFileFormatAsset(primary.name, kind)
  return (
    <ContextMenu
      open={contextMenuOpen}
      onOpenChange={(open) => {
        setContextMenuOpen(open)
        if (open) onMenuOpen?.()
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          data-artifact-card
          className={ARTIFACT_ROW_ITEM_CLASS}
          data-artifact-kind={menuProps.directory ? 'directory' : 'file'}
          data-artifact-role={primary.role}
          data-testid={`turn-artifact-${primary.artifact_id}`}
        >
          <Receipt
            className="!border-[var(--vds-divider-default)]"
            title={primary.title || primary.name}
            description={primaryMeta}
            titleTooltip={primary.name}
            iconAppearance={coloredIcon ? 'asset' : menuProps.directory ? 'outline' : 'bordered'}
            icon={
              <FileFormatIcon
                name={primary.name}
                kind={kind}
                size={coloredIcon ? 'var(--vds-artifact-card-icon-size)' : 'var(--vds-icon-10)'}
              />
            }
            onOpen={() => preview(primary)}
            openLabel={primary.name}
            showOpenButton={false}
            action={
              !menuProps.directory &&
              canImport && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="artifact-import-resources"
                  onClick={() => selectAction(openImport)}
                >
                  {assistantText('artifactEntry.importShort')}
                </Button>
              )
            }
          />
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className={MENU_CLASS_NAME} data-testid="artifact-context-menu">
        <FileMenuItems {...menuProps} kind="context" />
        {versions.length > 1 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger data-testid="artifact-versions">
              {assistantText('artifactEntry.versions', { count: versions.length })}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className={SUBMENU_CLASS_NAME}>
              {versions.map((version, index) => (
                <ContextMenuItem
                  key={version.artifact_id}
                  data-testid={`artifact-version-${version.artifact_id}`}
                  onSelect={() => previewVersion(version)}
                >
                  {assistantText(
                    index === 0 ? 'artifactEntry.latestVersion' : 'artifactEntry.previousVersion',
                    { version: versions.length - index }
                  )}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
