import { useTranslation } from 'react-i18next'
import { type ReactNode, useEffect, useLayoutEffect, useState } from 'react'
import { Copy, File } from 'lucide-react'

import componentsPageSource from './ComponentsPage.tsx?raw'
import aiThinking from '../../assets/ai-thinking.gif'
import { accountBase, setAccountBase } from '../../account'
import type { ConvItem, SessionNode, Theme, Thread } from '../../model'
import { FILE_REF_KIND } from '../../reference'
import {
  StoreProvider,
  useApp,
  type AccountSettingsPage,
  type ComposerReference,
} from '../../store'
import { applyTheme } from '../../theme'
import { AccountPanel } from '../business/AccountPanel'
import { Chrome } from '../business/Chrome'
import { Composer } from '../business/Composer'
import { Feedback } from '../business/Feedback'
import { FileContextMenu } from '../business/FileContextMenu'
import { ModelMenu } from '../business/ModelMenu'
import { ProjectForm } from '../business/ProjectForm'
import { ResearchContext } from '../business/ResearchContext'
import { SessionArtifacts } from '../business/SessionArtifacts'
import { SessionContextMenu } from '../business/SessionContextMenu'
import { SessionTitleEditor } from '../business/SessionTitle'
import { Sidebar } from '../business/Sidebar'
import { ComposerSkillRefs } from '../business/SkillRefs'
import { StatusStrip } from '../business/StatusStrip'
import { Stream } from '../business/Stream'
import { TaskMonitor } from '../business/TaskMonitor'
import { TodoPanel } from '../business/TodoPanel'
import { WorkspaceFiles } from '../business/WorkspaceFiles'
import { ComposerAttachments } from '../primitive/Attachments'
import { IconFont, Markdown, Progress as TransitionProgress } from '../primitive'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  AspectRatio,
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  BadgeDot,
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  NavigationButton,
  Calendar,
  Page,
  PageHeader,
  PageBody,
  PageSection,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Carousel,
  CarouselContent,
  CarouselIndicators,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  ChartContainer,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Divider,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerTitle,
  DrawerTrigger,
  EllipsisText,
  EmptyState,
  FormControl,
  FormDescription,
  FormField,
  FormLabel,
  FormMessage,
  FloatingToolbar,
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
  IconButton,
  Input,
  PasswordInput,
  SearchBox,
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
  Label,
  LoadingOverlay,
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  NavigationTabs,
  NavigationTabsMenu,
  navigationMenuTriggerStyle,
  Pagination,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
  ProgressBar,
  Radio,
  RadioGroup,
  ResizableHandle,
  ResizablePanel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetTitle,
  SheetTrigger,
  ScrollArea,
  Separator,
  Slider,
  Skeleton,
  Spinner,
  Switch,
  Tag,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Toaster,
  ToastProvider,
  Toggle,
  ToggleGroup,
  ToggleGroupItem,
  useToast,
} from '../ui'

const examplesPageClassName =
  'box-border grid h-screen min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-[var(--vds-bg-page)] p-[var(--vds-space-6)] font-[var(--vds-font-main)] text-[var(--vds-text-primary)] max-[860px]:p-[var(--vds-space-4)] [&_*]:scroll-mt-[var(--vds-space-6)]'

const refreshIcon = '↻'

const commandIconPaths = {
  bell: (
    <path d="M12 4a4 4 0 0 0-4 4v3.2L6.6 14h10.8L16 11.2V8a4 4 0 0 0-4-4Zm-1.7 12a1.8 1.8 0 0 0 3.4 0" />
  ),
  archive: <path d="M5 8h14M7 8v11h10V8M9 5h6l1 3H8zM10 12h4" />,
  alignCenter: <path d="M7 6h10M5 10h14M7 14h10M5 18h14" />,
  alignJustify: <path d="M5 6h14M5 10h14M5 14h14M5 18h14" />,
  alignLeft: <path d="M5 6h14M5 10h10M5 14h14M5 18h10" />,
  alignRight: <path d="M5 6h14M9 10h10M5 14h14M9 18h10" />,
  bookmark: <path d="M7 5h10v15l-5-3-5 3z" />,
  bold: <path d="M8 5h5.5a3 3 0 0 1 0 6H8zM8 11h6.2a3.5 3.5 0 0 1 0 7H8zM8 5v13" />,
  calculator: (
    <path d="M7 4h10v16H7zM9 7h6M9 11h1M12 11h1M15 11h1M9 14h1M12 14h1M15 14h1M9 17h1M12 17h4" />
  ),
  calendar: <path d="M7 4v3M17 4v3M5 9h14M6 6h12v14H6z" />,
  card: <path d="M5 7h14v10H5zM5 10h14M8 14h3" />,
  clipboard: <path d="M9 5h6M9 5a3 3 0 0 1 6 0M8 7H6v13h12V7h-2" />,
  copy: <path d="M8 8h10v10H8zM6 16H5V5h11v1" />,
  download: <path d="M12 4v10M8 10l4 4 4-4M5 19h14" />,
  edit: <path d="m5 16-.8 3.8L8 19l10-10-3-3L5 16ZM14 6l3 3" />,
  eye: <path d="M3 12s3.2-6 9-6 9 6 9 6-3.2 6-9 6-9-6-9-6ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />,
  file: <path d="M8 4h6l4 4v12H8zM14 4v5h5" />,
  folder: <path d="M4 7h7l2 2h7v10H4z" />,
  home: <path d="M4 11 12 5l8 6v8h-5v-5H9v5H4z" />,
  help: (
    <path d="M9.1 9a3 3 0 1 1 4.8 2.4c-1.2.8-1.9 1.4-1.9 2.6M12 18h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z" />
  ),
  italic: <path d="M11 5h7M6 19h7M14 5l-4 14" />,
  mail: <path d="M4 7h16v11H4zM5 8l7 5 7-5" />,
  mapPin: (
    <path d="M12 21s7-5.3 7-11a7 7 0 0 0-14 0c0 5.7 7 11 7 11ZM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
  ),
  package: <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3ZM4.5 7.7 12 12l7.5-4.3M12 12v8.5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  search: <path d="m16 16 4 4M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z" />,
  settings: (
    <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM5 12h2M17 12h2M12 5v2M12 17v2M7.8 7.8l1.4 1.4M14.8 14.8l1.4 1.4M16.2 7.8l-1.4 1.4M9.2 14.8l-1.4 1.4" />
  ),
  scissors: (
    <path d="M4 7a2 2 0 1 0 4 0 2 2 0 0 0-4 0ZM4 17a2 2 0 1 0 4 0 2 2 0 0 0-4 0ZM8 8l12 8M8 16 20 8" />
  ),
  share: <path d="M8 12h8M16 8l4 4-4 4M4 5v14" />,
  star: <path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4-3.9-3.8 5.4-.8z" />,
  trash: <path d="M5 7h14M10 11v6M14 11v6M8 7l1-3h6l1 3M7 7l1 13h8l1-13" />,
  type: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  underline: <path d="M7 5v6a5 5 0 0 0 10 0V5M5 20h14" />,
  user: <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM5 20a7 7 0 0 1 14 0" />,
  users: (
    <path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3.5 20a5.5 5.5 0 0 1 11 0M17 11a3 3 0 1 0-1.5-5.6M15.5 14.2A5 5 0 0 1 20.5 19" />
  ),
  link: (
    <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" />
  ),
  zap: <path d="m13 2-8 12h6l-1 8 9-13h-6z" />,
} as const

type CommandIconName = keyof typeof commandIconPaths

function CommandDemoIcon({ name }: { name: CommandIconName }): ReactNode {
  return (
    <svg
      aria-hidden="true"
      className="flex-none [height:16px] [width:16px] text-[var(--vds-text-tertiary)]"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      {commandIconPaths[name]}
    </svg>
  )
}

function NavigationListItem({
  children,
  href,
  title,
}: {
  children: ReactNode
  href: string
  title: string
}): JSX.Element {
  return (
    <NavigationMenuLink asChild>
      <a
        className="block min-h-0 rounded-[var(--vds-radius-3)] p-[var(--vds-space-3)] text-[var(--vds-text-primary)] no-underline hover:bg-[var(--vds-bg-white-hover)] hover:outline-none focus-visible:bg-[var(--vds-bg-white-hover)] focus-visible:outline-none"
        href={href}
      >
        <div className="mb-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv1)]">
          {title}
        </div>
        <p className="m-0 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
          {children}
        </p>
      </a>
    </NavigationMenuLink>
  )
}

const navigationTabSeedItems = [
  { id: 'plan', labelKey: 'business.seed.tabs.plan' },
  { id: 'library', labelKey: 'business.seed.tabs.library' },
  { id: 'experiment', labelKey: 'business.seed.tabs.experiment' },
  { id: 'review', labelKey: 'business.seed.tabs.review' },
  { id: 'notes', labelKey: 'business.seed.tabs.notes' },
]

const alertExampleItems = [
  { id: 'info', titleKey: 'alert.info', tone: 'info' },
  { id: 'warning', titleKey: 'alert.warning', tone: 'warning' },
  { id: 'error', titleKey: 'alert.error', tone: 'error' },
  { id: 'success', titleKey: 'alert.success', tone: 'success' },
] as const

const carouselContentItems = [
  {
    contentKey: 'carousel.slide1.content',
    tone: 'info',
    titleKey: 'carousel.slide1.title',
  },
  {
    contentKey: 'carousel.slide2.content',
    tone: 'success',
    titleKey: 'carousel.slide2.title',
  },
  {
    contentKey: 'carousel.slide3.content',
    tone: 'help',
    titleKey: 'carousel.slide3.title',
  },
  {
    contentKey: 'carousel.slide4.content',
    tone: 'warning',
    titleKey: 'carousel.slide4.title',
  },
] as const

const monthlyChartData = [
  { expenses: 2400, month: 'Jan', profit: 1800, revenue: 4200 },
  { expenses: 2800, month: 'Feb', profit: 3000, revenue: 5800 },
  { expenses: 3200, month: 'Mar', profit: 2000, revenue: 5200 },
  { expenses: 3500, month: 'Apr', profit: 3600, revenue: 7100 },
  { expenses: 3100, month: 'May', profit: 3300, revenue: 6400 },
  { expenses: 3800, month: 'Jun', profit: 4400, revenue: 8200 },
] as const

const chartTicks = [0, 2500, 5000, 7500, 10000] as const
const areaChartTicks = [0, 3000, 6000, 9000, 12000] as const
const chartViewBoxWidth = 430
const chartBaselineY = 212
const chartTopY = 24
const chartPlotLeftX = 92
const chartPlotRightX = 404
const chartAxisLabelX = 76
const chartPointStep = (chartPlotRightX - chartPlotLeftX) / (monthlyChartData.length - 1)

const collapsibleSettingsItems = [
  { contentKey: 'disclosure.accountBody', titleKey: 'disclosure.account' },
  { contentKey: 'disclosure.privacyBody', titleKey: 'disclosure.privacy' },
  { contentKey: 'disclosure.notificationsBody', titleKey: 'disclosure.notifications' },
] as const

const exampleMenuItems = [
  { id: 'label-form', labelKey: 'menu.label-form' },
  { id: 'alert', labelKey: 'menu.alert' },
  { id: 'alert-dialog', labelKey: 'menu.alert-dialog' },
  { id: 'progress-avatar', labelKey: 'menu.progress-avatar' },
  { id: 'calendar', labelKey: 'menu.calendar' },
  { id: 'carousel', labelKey: 'menu.carousel' },
  { id: 'chart', labelKey: 'menu.chart' },
  { id: 'empty-copy', labelKey: 'menu.empty-copy' },
  { id: 'ellipsis-text', labelKey: 'menu.ellipsis-text' },
  { id: 'floating-toolbar', labelKey: 'menu.floating-toolbar' },
  { id: 'loading-overlay', labelKey: 'menu.loading-overlay' },
  { id: 'table-pagination', labelKey: 'menu.table-pagination' },
  { id: 'aspect-breadcrumb', labelKey: 'menu.aspect-breadcrumb' },
  { id: 'collapsible', labelKey: 'menu.collapsible' },
  { id: 'tabs', labelKey: 'menu.tabs' },
  { id: 'accordion', labelKey: 'menu.accordion' },
  { id: 'scroll-area', labelKey: 'menu.scroll-area' },
  { id: 'slider', labelKey: 'menu.slider' },
  { id: 'input-otp', labelKey: 'menu.input-otp' },
  { id: 'command', labelKey: 'menu.command' },
  { id: 'context-menu', labelKey: 'menu.context-menu' },
  { id: 'dialog', labelKey: 'menu.dialog' },
  { id: 'dropdown-menu', labelKey: 'menu.dropdown-menu' },
  { id: 'hover-card', labelKey: 'menu.hover-card' },
  { id: 'menubar', labelKey: 'menu.menubar' },
  { id: 'navigation-menu', labelKey: 'menu.navigation-menu' },
  { id: 'navigation-tabs', labelKey: 'menu.navigation-tabs' },
  { id: 'popover', labelKey: 'menu.popover' },
  { id: 'resizable', labelKey: 'menu.resizable' },
  { id: 'toggle-group', labelKey: 'menu.toggle-group' },
  { id: 'tooltip', labelKey: 'menu.tooltip' },
  { id: 'toast', labelKey: 'menu.toast' },
  { id: 'sheet-drawer', labelKey: 'menu.sheet-drawer' },
  { id: 'button', labelKey: 'menu.button' },
  { id: 'icon-button', labelKey: 'menu.icon-button' },
  { id: 'input', labelKey: 'menu.input' },
  { id: 'badge', labelKey: 'menu.badge' },
  { id: 'tag', labelKey: 'menu.tag' },
  { id: 'page', labelKey: 'menu.page' },
  { id: 'card', labelKey: 'menu.card' },
  { id: 'divider', labelKey: 'menu.divider' },
  { id: 'switch', labelKey: 'menu.switch' },
  { id: 'checkbox', labelKey: 'menu.checkbox' },
  { id: 'radio', labelKey: 'menu.radio' },
  { id: 'textarea', labelKey: 'menu.textarea' },
  { id: 'select', labelKey: 'menu.select' },
  { id: 'loading', labelKey: 'menu.loading' },
  { id: 'theme', labelKey: 'menu.theme' },
  { id: 'token-swatches', labelKey: 'menu.token-swatches' },
] as const

const primitiveMenuItems = [
  { id: 'attachments', labelKey: 'menu.attachments' },
  { id: 'icon-font', labelKey: 'menu.icon-font' },
  { id: 'markdown', labelKey: 'menu.markdown' },
  { id: 'transition-progress', labelKey: 'menu.transition-progress' },
] as const

const businessMenuItems = [
  { id: 'account-panel', labelKey: 'menu.account-panel' },
  { id: 'chrome', labelKey: 'menu.chrome' },
  { id: 'composer', labelKey: 'menu.composer' },
  { id: 'feedback', labelKey: 'menu.feedback' },
  { id: 'file-context-menu', labelKey: 'menu.file-context-menu' },
  { id: 'model-menu', labelKey: 'menu.model-menu' },
  { id: 'project-form', labelKey: 'menu.project-form' },
  { id: 'research-context', labelKey: 'menu.research-context' },
  { id: 'session-artifacts', labelKey: 'menu.session-artifacts' },
  { id: 'session-context-menu', labelKey: 'menu.session-context-menu' },
  { id: 'session-title', labelKey: 'menu.session-title' },
  { id: 'sidebar', labelKey: 'menu.sidebar' },
  { id: 'skill-refs', labelKey: 'menu.skill-refs' },
  { id: 'status-strip', labelKey: 'menu.status-strip' },
  { id: 'stream', labelKey: 'menu.stream' },
  { id: 'task-monitor', labelKey: 'menu.task-monitor' },
  { id: 'todo-panel', labelKey: 'menu.todo-panel' },
  { id: 'workspace-files', labelKey: 'menu.workspace-files' },
] as const

const componentMenuGroups = [
  {
    id: 'ui',
    items: exampleMenuItems,
    titleKey: 'groups.ui',
    subtitle: 'components/ui',
  },
  {
    id: 'primitive',
    items: primitiveMenuItems,
    titleKey: 'groups.primitive',
    subtitle: 'components/primitive',
  },
  {
    id: 'business',
    items: businessMenuItems,
    titleKey: 'groups.business',
    subtitle: 'components/business',
  },
] as const
type ComponentMenuGroupId = (typeof componentMenuGroups)[number]['id']

function exampleSectionClass(id: string, activeId: string): string {
  const baseClassName =
    'min-h-0 content-start gap-[var(--vds-space-4)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-4)] shadow-[var(--vds-shadow-1-center)]'
  return id === activeId ? `grid ${baseClassName}` : `hidden ${baseClassName}`
}

function renderActiveExample(id: string, activeId: string, example: ReactNode): ReactNode {
  return id === activeId ? example : null
}

function exampleMenuItemClass(id: string, activeId: string): string {
  const baseClassName =
    'block w-full min-w-0 cursor-pointer rounded-[var(--vds-radius-3)] border-0 bg-transparent p-[var(--vds-space-2)] text-left font-[inherit] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)] no-underline [overflow-wrap:anywhere] hover:bg-[var(--vds-surface-muted)] hover:text-[var(--vds-text-primary)] focus-visible:bg-[var(--vds-surface-muted)] focus-visible:text-[var(--vds-text-primary)] focus-visible:outline-none max-[860px]:w-auto max-[860px]:flex-none'
  const activeClassName =
    '[background:var(--vds-surface-muted)] font-[var(--vds-fw-medium)] text-[var(--vds-text-primary)] shadow-[inset_3px_0_0_var(--vds-brand-6)] max-[860px]:shadow-[inset_0_-3px_0_var(--vds-brand-6)]'
  return id === activeId ? `${baseClassName} ${activeClassName}` : baseClassName
}

function ComponentMenuGroup({
  activeExample,
  open,
  group,
  onOpenChange,
  onSelect,
}: {
  activeExample: string
  open: boolean
  group: (typeof componentMenuGroups)[number]
  onOpenChange: (open: boolean) => void
  onSelect: (id: string) => void
}): JSX.Element {
  const { t } = useTranslation('examples')
  return (
    <Collapsible className="grid gap-[var(--vds-space-1)]" onOpenChange={onOpenChange} open={open}>
      <CollapsibleTrigger className="group flex min-h-0 w-full items-center justify-between gap-[var(--vds-space-2)] rounded-[var(--vds-radius-3)] border-0 bg-transparent !px-[var(--vds-space-3)] !py-[var(--vds-space-2)] text-left shadow-none hover:bg-[var(--vds-surface-muted)] focus-visible:bg-[var(--vds-surface-muted)] focus-visible:outline-none">
        <span className="grid min-w-0 gap-0.5">
          <span className="text-[13px] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-primary)]">
            {t(group.titleKey)}
          </span>
          <span className="truncate text-[11px] leading-[1.3] text-[var(--vds-text-tertiary)]">
            {group.subtitle}
          </span>
        </span>
        <span
          className="shrink-0 text-[12px] text-[var(--vds-text-tertiary)] transition-transform group-data-[state=open]:rotate-90"
          aria-hidden
        >
          ›
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="grid min-h-0 gap-[var(--vds-space-1)] border-0 bg-transparent p-0 pl-[var(--vds-space-1)] shadow-none">
        {group.items.map((item) => (
          <button
            aria-current={item.id === activeExample ? 'page' : undefined}
            className={exampleMenuItemClass(item.id, activeExample)}
            key={item.id}
            onClick={() => onSelect(item.id)}
            type="button"
          >
            {t(item.labelKey)}
          </button>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

const carouselContentCardClassNames = {
  help: 'bg-[var(--vds-help-light-bg-default)]',
  info: 'bg-[var(--vds-notice-light-bg-default)]',
  success: 'bg-[var(--vds-success-light-bg-default)]',
  warning: 'bg-[var(--vds-warning-light-bg-default)]',
} as const

function carouselContentCardClass(tone: keyof typeof carouselContentCardClassNames): string {
  return `h-full min-h-[180px] w-full ${carouselContentCardClassNames[tone]}`
}

function trimSectionIndent(source: string): string {
  const lines = source.replace(/\n\s*<CodePreview[^>]*\/>/g, '').split('\n')
  const nonEmptyLines = lines.filter((line) => line.trim())
  const minIndent = nonEmptyLines.reduce((minimum, line) => {
    const indent = line.match(/^\s*/)?.[0].length ?? 0
    return Math.min(minimum, indent)
  }, Number.POSITIVE_INFINITY)

  return lines
    .map((line) => line.slice(Number.isFinite(minIndent) ? minIndent : 0))
    .join('\n')
    .trim()
}

function extractSectionCode(source: string, id: string): string {
  const sectionStart = source.indexOf(
    `<section className={exampleSectionClass('${id}', activeExample)} id="${id}">`
  )
  if (sectionStart < 0) return ''

  const afterStart = source.indexOf('\n', sectionStart)
  const sectionEnd = source.indexOf('\n        </section>', sectionStart)
  if (afterStart < 0 || sectionEnd < 0) return ''

  const sectionBody = source.slice(afterStart + 1, sectionEnd)
  const titleEnd = sectionBody.indexOf('\n')
  return trimSectionIndent(titleEnd < 0 ? sectionBody : sectionBody.slice(titleEnd + 1))
}

function CodePreview({ code }: { code: string }): JSX.Element {
  const { t } = useTranslation('examples')
  return (
    <details className="min-w-0 pt-[var(--vds-space-1)]" open>
      <summary className="w-max max-w-full cursor-pointer list-outside text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)] hover:text-[var(--vds-text-primary)] focus-visible:text-[var(--vds-text-primary)] focus-visible:outline-none">
        {t('shell.code')}
      </summary>
      <pre className="m-0 mt-5 max-h-[420px] max-w-full overflow-auto whitespace-pre rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] p-[var(--vds-space-3)] font-[var(--vds-font-mono)] text-[13px] leading-[1.7] text-[var(--vds-text-primary)] [tab-size:2] [&_code]:text-[13px]">
        <code>{code}</code>
      </pre>
    </details>
  )
}

const attachmentExampleRefs: ComposerReference[] = [
  {
    type: FILE_REF_KIND,
    id: 'literature-pdf',
    title: 'protein-folding-survey.pdf',
    path: '/tmp/scholarseed-preview/protein-folding-survey.pdf',
    mediaType: 'application/pdf',
    size: 2_480_128,
  },
  {
    type: FILE_REF_KIND,
    id: 'experiment-sheet',
    title: '实验数据.xlsx',
    path: '/tmp/scholarseed-preview/实验数据.xlsx',
    mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 842_240,
  },
  {
    type: FILE_REF_KIND,
    id: 'figure-image',
    title: 'figure-3.png',
    path: '/tmp/scholarseed-preview/figure-3.png',
    mediaType: 'image/png',
    size: 318_920,
  },
  {
    type: FILE_REF_KIND,
    id: 'notes-md',
    title: '研究笔记.md',
    path: '/tmp/scholarseed-preview/研究笔记.md',
    mediaType: 'text/markdown',
    size: 12_864,
  },
]

function AttachmentsExample(): JSX.Element {
  const [refs, setRefs] = useState<ComposerReference[]>(attachmentExampleRefs)
  const { t } = useTranslation('examples')
  const [message, setMessage] = useState<{
    kind: 'initial' | 'opened' | 'removed' | 'reset'
    title?: string
  }>({ kind: 'initial' })
  const messageText =
    message.kind === 'opened'
      ? t('attachments.opened', { title: message.title ?? '' })
      : message.kind === 'removed'
        ? t('attachments.removed', { title: message.title ?? t('attachments.file') })
        : t(message.kind === 'reset' ? 'attachments.resetDone' : 'attachments.help')

  return (
    <div className="grid min-w-0 gap-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-4)]">
      <div className="mb-[9px] flex flex-nowrap gap-[2px] overflow-x-auto overflow-y-hidden py-[6px] pl-0 pr-[2px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <ComposerAttachments
          refs={refs}
          onOpen={(target) => setMessage({ kind: 'opened', title: target.title })}
          onRemove={(index) => {
            const removed = refs[index]
            setRefs((current) => current.filter((_, itemIndex) => itemIndex !== index))
            setMessage({ kind: 'removed', title: removed?.title })
          }}
        />
      </div>
      <div className="flex min-w-0 items-center justify-between gap-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)]">
        <span className="min-w-0 truncate">{messageText}</span>
        <Button
          size="sm"
          type="button"
          variant="outline"
          onClick={() => {
            setRefs(attachmentExampleRefs)
            setMessage({ kind: 'reset' })
          }}
        >
          {t('attachments.reset')}
        </Button>
      </div>
    </div>
  )
}

function AccountPanelExample(): JSX.Element {
  const { t, i18n } = useTranslation('examples')
  const [page, setPage] = useState<AccountSettingsPage>('account')

  useEffect(() => {
    const previousBaseUrl = accountBase()
    const previousFetch = window.fetch
    const baseUrl = 'https://account-preview.local'
    setAccountBase(baseUrl)
    // AccountPanel loads its profile on mount. Notify it after installing the
    // preview endpoint so the first no-base result does not remain visible.
    window.dispatchEvent(new Event('scholarseed:auth-restored'))

    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const pathname = url.startsWith(baseUrl) ? new URL(url).pathname : url
      const json = (payload: unknown, status = 200): Response =>
        new Response(JSON.stringify(payload), {
          headers: { 'content-type': 'application/json' },
          status,
        })

      if (pathname === '/api/account/me') {
        return json({
          nickname: t('business.seed.account.nickname'),
          phone: '13800008001',
          user_id: 'u-preview',
        })
      }
      if (pathname === '/api/account/api-keys') {
        return json({
          keys: [
            {
              created_at: 1_788_000_000,
              key_id: 'managed-preview',
              last_used_at: 1_788_086_400,
              managed: true,
              name: t('business.seed.account.managedKey'),
              prefix: 'ssk-managed',
            },
            {
              created_at: 1_787_500_000,
              key_id: 'user-preview',
              last_used_at: null,
              managed: false,
              name: t('business.seed.account.localScriptKey'),
              prefix: 'ssk-local8',
            },
          ],
        })
      }
      if (
        pathname === '/api/serve/skill-credential' ||
        pathname === '/api/serve/skill-credential/refresh'
      ) {
        return json({ ok: true })
      }
      if (pathname.includes('/rotate')) return json({ rotated: true })
      if (init?.method === 'DELETE') return json({ revoked: true })
      if (init?.method === 'POST' && pathname === '/api/account/api-keys') {
        return json({
          created_at: 1_788_100_000,
          key_id: 'fresh-preview',
          last_used_at: null,
          managed: false,
          name: t('business.seed.account.previewKey'),
          prefix: 'ssk-fresh8',
          token: 'ssk-fresh8_preview_only_abcdefghijklmnopqrstuvwxyz',
        })
      }
      return previousFetch(input, init)
    }

    return () => {
      window.fetch = previousFetch
      setAccountBase(previousBaseUrl)
    }
  }, [i18n.language, t])

  return (
    <div className="h-[620px] min-w-0 overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)]">
      <AccountPanel
        page={page}
        onClose={() => undefined}
        onLogin={() => undefined}
        onLogout={async () => ({ ok: true, data: { local_cleared: true } })}
        onPage={(nextPage) => setPage(nextPage)}
      />
    </div>
  )
}

function ChromeExample(): JSX.Element {
  return (
    <div className="grid min-w-0 gap-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-4)]">
      <div className="mt-[var(--vds-space-6)] flex min-h-[480px] w-[260px] min-w-0 flex-col justify-end rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)]">
        <Chrome />
      </div>
    </div>
  )
}

const conversationPreviewItems: ConvItem[] = [
  { kind: 'day', text: '今天', turnId: 'preview-day' },
  {
    kind: 'user',
    text: '帮我整理蛋白质折叠领域最近三年的研究进展，并把关键论文按方法分类。',
    turnId: 'preview-turn-1',
    itemId: 'preview-user-1',
  },
  {
    kind: 'thinking',
    text: '我会先拆成三条线：结构预测模型、实验验证数据、下游药物发现应用。',
    turnId: 'preview-turn-1',
    itemId: 'preview-thinking-1',
  },
  {
    kind: 'agent',
    text: '可以。当前建议先建立一个“方法演进”的框架：AlphaFold 系列作为基线，随后对比扩散模型、多序列比对弱依赖方案，以及复合物预测方向。下一步我会补充代表论文和实验指标。',
    turnId: 'preview-turn-1',
    itemId: 'preview-agent-1',
  },
  {
    kind: 'tool',
    toolId: 'preview-search',
    name: 'paper_search',
    status: 'running',
    input: { query: 'protein folding structure prediction 2024 survey' },
    turnId: 'preview-turn-1',
    itemId: 'preview-tool-1',
  },
]

function ComposerPreviewSeed(): JSX.Element {
  const { t, i18n } = useTranslation('examples')
  const { set } = useApp()

  useEffect(() => {
    set({
      activeSession: 'composer-preview',
      backendReady: true,
      mainView: 'home',
      model: 'gpt-5.6-sol',
      runtimeReadiness: {
        action: 'retry',
        code: 'ready',
        message: 'preview ready',
        ready: true,
      },
      sessions: [
        {
          id: 'composer-preview',
          title: '论文阅读助手',
          status: 'dormant',
          meta: 'Codex',
          timeLabel: '刚刚',
          current: true,
          activityAt: 1_788_100_000,
          createdAt: 1_788_100_000,
          projectPath: '/tmp/scholarseed-preview',
        },
      ],
      threads: {
        'composer-preview': {
          id: 'composer-preview',
          title: '论文阅读助手',
          conversation: [],
          sessionId: 'composer-preview',
          lastSeq: 0,
          running: false,
          status: 'dormant',
          projectPath: '/tmp/scholarseed-preview',
          transportState: 'live',
        },
      },
      workspacePath: '/tmp/scholarseed-preview',
      defaultWorkspacePath: '/tmp/scholarseed-preview',
      composerText: '请基于这些附件总结研究问题、方法和主要结论',
      composerRefs: attachmentExampleRefs.slice(0, 2),
    })
  }, [set])

  useEffect(() => {
    set({
      sessions: [
        {
          id: 'composer-preview',
          title: t('business.seed.composerTitle'),
          status: 'dormant',
          meta: 'Codex',
          timeLabel: t('business.seed.now'),
          current: true,
          activityAt: 1_788_100_000,
          createdAt: 1_788_100_000,
          projectPath: '/tmp/scholarseed-preview',
        },
      ],
      threads: {
        'composer-preview': {
          id: 'composer-preview',
          title: t('business.seed.composerTitle'),
          conversation: [],
          sessionId: 'composer-preview',
          lastSeq: 0,
          running: false,
          status: 'dormant',
          projectPath: '/tmp/scholarseed-preview',
          transportState: 'live',
        },
      },
    })
  }, [i18n.language, set, t])

  return <Composer />
}

function ComposerExample(): JSX.Element {
  return (
    <div className="grid min-w-0 gap-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-4)]">
      <div className="flex min-h-[520px] min-w-0 flex-col justify-end rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--paper)]">
        <StoreProvider assistantSources={[]}>
          <ComposerPreviewSeed />
        </StoreProvider>
      </div>
    </div>
  )
}

const businessPreviewProject = {
  id: 'project-preview',
  name: '蛋白质折叠综述',
  path: '/tmp/scholarseed-preview',
  added_at: 1_788_000_000,
  file_count: 8,
  updated_at: 1_788_086_400,
  available: true,
}

function localizedBusinessPreviewProject(
  t: ReturnType<typeof useTranslation<'examples'>>['t']
): typeof businessPreviewProject {
  return { ...businessPreviewProject, name: t('business.seed.projectName') }
}

function localizedBusinessPreviewContentProject(
  t: ReturnType<typeof useTranslation<'examples'>>['t']
): {
  id: string
  name: string
  root: string
  layout: 'managed'
  available: boolean
} {
  const project = localizedBusinessPreviewProject(t)
  return {
    id: project.id,
    name: project.name,
    root: project.path,
    layout: 'managed',
    available: project.available,
  }
}

function navigationTabLabel(
  id: (typeof navigationTabSeedItems)[number]['id'],
  t: ReturnType<typeof useTranslation<'examples'>>['t']
): string {
  if (id === 'plan') return t('business.seed.tabs.plan')
  if (id === 'library') return t('business.seed.tabs.library')
  if (id === 'experiment') return t('business.seed.tabs.experiment')
  if (id === 'review') return t('business.seed.tabs.review')
  return t('business.seed.tabs.notes')
}

const businessPreviewAssistantContext = {
  session_id: 'business-preview',
  revision: 1,
  project_policy: 'explicit_only',
  search_scope: 'academic',
  refs: [
    {
      ref_id: 'preview-ref-summary',
      kind: 'file',
      source_id: 'outputs/protein-folding-summary.md',
      source_revision: null,
      label: 'protein-folding-summary.md',
      retention: 'session',
      origin: 'explicit',
    },
  ],
  updated_at: 1_788_100_000,
  capabilities: [
    { name: 'project_context', available: true, reason: '' },
    { name: 'academic_search', available: true, reason: '' },
    { name: 'web_search', available: true, reason: '' },
  ],
}

const businessPreviewSessionNode: SessionNode = {
  id: 'business-preview',
  title: '蛋白质折叠研究综述',
  status: 'running',
  meta: 'Codex',
  timeLabel: '刚刚',
  current: true,
  activityAt: 1_788_100_000,
  createdAt: 1_788_100_000,
  projectPath: businessPreviewProject.path,
  workdir: businessPreviewProject.path,
}

const businessPreviewThread: Thread = {
  id: 'business-preview',
  title: '蛋白质折叠研究综述',
  conversation: conversationPreviewItems,
  sessionId: 'business-preview',
  lastSeq: 5,
  running: true,
  status: 'running',
  projectPath: businessPreviewProject.path,
  workdir: businessPreviewProject.path,
  transportState: 'live',
  todos: [
    { id: 'scope', content: '确认综述范围与分类维度', status: 'completed' },
    {
      id: 'search',
      content: '检索 2024-2026 代表论文',
      activeForm: '正在检索代表论文',
      status: 'in_progress',
    },
    {
      id: 'compare',
      content: '提取模型指标并做方法对比',
      status: 'pending',
      dependsOn: ['search'],
    },
    { id: 'write', content: '输出结构化研究摘要', status: 'pending', dependsOn: ['compare'] },
  ],
  backgroundTasks: {
    'preview-search': {
      id: 'preview-search',
      kind: 'web_search',
      label: '检索代表论文',
      status: 'running',
      event: 'started',
      terminal: false,
      ts: Date.now(),
    },
    'preview-draft': {
      id: 'preview-draft',
      kind: 'subagent',
      label: '整理方法分类',
      status: 'succeeded',
      event: 'done',
      terminal: true,
      ts: Date.now() - 12_000,
    },
  },
  artifacts: [
    {
      artifact_id: 'summary-md',
      path: 'outputs/protein-folding-summary.md',
      absolute_path: '/tmp/scholarseed-preview/outputs/protein-folding-summary.md',
      name: 'protein-folding-summary.md',
      media_type: 'text/markdown',
      size: 18_432,
      role: 'final',
      change: 'add',
      status: 'available',
    },
    {
      artifact_id: 'papers-csv',
      path: 'data/papers.csv',
      absolute_path: '/tmp/scholarseed-preview/data/papers.csv',
      name: 'papers.csv',
      media_type: 'text/csv',
      size: 6_912,
      role: 'intermediate',
      change: 'update',
      status: 'available',
    },
  ],
  contextChannels: {
    research: {
      name: 'research',
      surface: {
        kind: 'list',
        label: '研究方向',
        editable: false,
        command: 'research',
        render_hint: 'research',
        priority: 1,
      },
      entries: [
        {
          id: 'research-1',
          text: '## Research context\n\n**Session research directions:**\n- 结构预测模型的误差来源\n- 扩散模型与 MSA 弱依赖方法对比\n- 复合物预测在药物发现中的应用边界',
          cls: 'fact',
          confidence: 0.92,
          provenance: 'preview',
          why: '预览研究方向折叠条。',
          entities: [],
          status: 'active',
        },
      ],
      lastDelta: null,
      changedAt: Date.now(),
    },
    memory: {
      name: 'memory',
      surface: {
        kind: 'list',
        label: '记忆',
        editable: false,
        command: 'recall',
        render_hint: 'memory',
        priority: 2,
      },
      entries: [
        {
          id: 'memory-1',
          text: '用户偏好先输出中文结构化摘要，再给英文术语对照。',
          cls: 'fact',
          confidence: 0.86,
          provenance: 'preview',
          why: '展示 StatusStrip 的记忆命中。',
          entities: [],
          status: 'active',
        },
      ],
      lastDelta: { added: ['memory-1'], superseded: [], evicted: [] },
      changedAt: Date.now(),
    },
    constraints: {
      name: 'constraints',
      surface: {
        kind: 'list',
        label: '约束',
        editable: false,
        command: 'constraints',
        render_hint: 'constraints',
        priority: 3,
      },
      entries: [
        {
          id: 'constraint-1',
          text: '优先覆盖近三年公开论文，避免只复述单一模型结论。',
          cls: 'fact',
          confidence: 0.9,
          provenance: 'preview',
          why: '展示约束计数。',
          entities: [],
          status: 'active',
        },
      ],
      lastDelta: null,
      changedAt: Date.now(),
    },
  },
}

function useBusinessPreviewFetch(): void {
  const { t, i18n } = useTranslation('examples')
  useLayoutEffect(() => {
    const previousFetch = window.fetch
    const json = (payload: unknown): Response =>
      new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })

    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const parsedUrl = new URL(url, window.location.origin)
      const { pathname, searchParams } = parsedUrl
      const method = (init?.method ?? 'GET').toUpperCase()
      if (
        pathname === '/api/serve/skills' &&
        (!searchParams.has('force_reload') || searchParams.get('force_reload') === 'true')
      ) {
        return json({
          skills: [
            {
              name: 'literature-review',
              version: '1.2.0',
              description: t('business.seed.skills.literatureDescription'),
              blurb: t('business.seed.skills.literatureBlurb'),
              enabled: true,
              active: true,
              source: 'builtin',
              builtin: true,
              group: 'scholarseed',
              category: t('business.seed.skills.literatureCategory'),
              icon: 'search',
              updated_at: Date.now() / 1000 - 3600,
              removable: false,
              toggleable: false,
              dependency_status: 'ready',
            },
            {
              name: 'chart-maker',
              version: '0.4.1',
              description: t('business.seed.skills.chartDescription'),
              enabled: false,
              active: false,
              source: 'user',
              imported: true,
              group: 'user',
              category: t('business.seed.skills.chartCategory'),
              icon: 'doc',
              updated_at: Date.now() / 1000 - 172800,
              removable: true,
              toggleable: true,
              dependency_status: 'missing',
              unavailable_reason: t('business.seed.skills.missingMatplotlib'),
            },
          ],
        })
      }
      if (pathname.startsWith('/api/serve/skills/') && pathname.endsWith('/document')) {
        return json({
          body: t('business.seed.skills.literatureDocument'),
        })
      }
      if (
        pathname === '/api/research/workspace/files' ||
        pathname === '/api/session/business-preview/files'
      ) {
        return json({
          root: '/tmp/scholarseed-preview',
          path: '',
          crumbs: [],
          items: [
            { name: 'papers', dir: true, size: 0 },
            { name: 'protein-folding-summary.md', dir: false, size: 18432 },
            { name: 'experiment-data.csv', dir: false, size: 6912 },
          ],
        })
      }
      if (pathname === '/api/projects') {
        return json({
          default: '/tmp/scholarseed-preview',
          projects: [localizedBusinessPreviewProject(t)],
        })
      }
      if (method === 'GET' && pathname === '/api/content/projects') {
        const contentProject = localizedBusinessPreviewContentProject(t)
        return json({
          projects: [contentProject],
          current: contentProject.id,
          workspaceRoot: contentProject.root,
        })
      }
      if (method === 'GET' && pathname === '/api/assistant/sessions/business-preview/context') {
        return json(businessPreviewAssistantContext)
      }
      if (method === 'GET' && pathname === '/api/assistant/sessions/business-preview/annotations') {
        return json({ annotations: [] })
      }
      if (method === 'GET' && pathname === '/api/serve/sessions/business-preview/mode') {
        return json({
          mode: 'ask',
          modes: ['ask', 'agent'],
          active_mode: 'ask',
          deferred: false,
          backend: 'codex',
          pre_plan_mode: null,
        })
      }
      if (pathname === '/api/auth/me')
        return json({ auth: true, nickname: t('business.seed.account.nickname') })
      if (pathname === '/api/account/me')
        return json({
          nickname: t('business.seed.account.nickname'),
          phone: '13800008001',
          user_id: 'u-preview',
        })
      if (method === 'POST' && pathname === '/api/projects')
        return json({ ok: true, project: localizedBusinessPreviewProject(t) })
      if (method === 'POST' && pathname.startsWith('/api/serve/skills/')) return json({ ok: true })
      if (method === 'DELETE' && pathname.startsWith('/api/serve/skills/'))
        return json({ ok: true })
      return previousFetch(input, init)
    }

    return () => {
      window.fetch = previousFetch
    }
  }, [i18n.language, t])
}

function BusinessPreviewSeed({ children }: { children: ReactNode }): JSX.Element {
  const { t, i18n } = useTranslation('examples')
  const { set } = useApp()
  useBusinessPreviewFetch()

  useEffect(() => {
    set({
      activeSession: 'business-preview',
      backendReady: true,
      mainView: 'home',
      sidebarOpen: true,
      model: 'gpt-5.6-sol',
      catalog: {
        models: [
          {
            key: 'gpt-5.6-sol',
            label: 'gpt-5.6-sol',
            billing: 'subscription',
            image_input: true,
            reasoning_effort: 'medium',
            reasoning_efforts: ['minimal', 'low', 'medium', 'high'],
          },
          {
            key: 'gpt-5.6-luna',
            label: 'gpt-5.6-luna',
            billing: 'api',
            image_input: false,
          },
        ],
        hiddenModels: [],
        subscriptionGroups: [
          {
            provider: 'codex',
            label: 'Codex',
          },
        ],
        personalProfiles: null,
      },
      projects: [businessPreviewProject],
      homeSelectedProjectId: businessPreviewProject.id,
      collapsedProjects: { [businessPreviewProject.path]: false },
      sessions: [
        businessPreviewSessionNode,
        {
          id: 'recent-preview',
          title: '扩散模型资料整理',
          status: 'done',
          meta: 'Codex',
          timeLabel: '昨天',
          activityAt: 1_788_000_000,
          createdAt: 1_788_000_000,
          projectPath: null,
        },
      ],
      threads: {
        'business-preview': businessPreviewThread,
      },
      workspacePath: businessPreviewProject.path,
      defaultWorkspacePath: businessPreviewProject.path,
      workspaceFilesOpen: true,
      workspaceFilesSessionId: null,
      composerText: '继续补充扩散模型方向的代表论文',
      composerRefs: attachmentExampleRefs.slice(0, 2),
    })
  }, [set])

  useEffect(() => {
    const project = localizedBusinessPreviewProject(t)
    const conversation = businessPreviewThread.conversation.map((item) =>
      item.kind === 'day' ? { ...item, text: t('business.seed.today') } : item
    )
    set({
      projects: [project],
      sessions: [
        {
          ...businessPreviewSessionNode,
          title: t('business.seed.sessionTitle'),
          timeLabel: t('business.seed.now'),
        },
        {
          id: 'recent-preview',
          title: t('business.seed.recentTitle'),
          status: 'done',
          meta: 'Codex',
          timeLabel: t('business.seed.yesterday'),
          activityAt: 1_788_000_000,
          createdAt: 1_788_000_000,
          projectPath: null,
        },
      ],
      threads: {
        'business-preview': {
          ...businessPreviewThread,
          title: t('business.seed.sessionTitle'),
          conversation,
          todos: [
            { id: 'scope', content: t('business.seed.todo.scope'), status: 'completed' },
            {
              id: 'search',
              content: t('business.seed.todo.search'),
              activeForm: t('business.seed.todo.searchActive'),
              status: 'in_progress',
            },
            {
              id: 'compare',
              content: t('business.seed.todo.compare'),
              status: 'pending',
              dependsOn: ['search'],
            },
            {
              id: 'write',
              content: t('business.seed.todo.write'),
              status: 'pending',
              dependsOn: ['compare'],
            },
          ],
          backgroundTasks: {
            'preview-search': {
              id: 'preview-search',
              kind: 'web_search',
              label: t('business.seed.task.searchPapers'),
              status: 'running',
              event: 'started',
              terminal: false,
              ts: Date.now(),
            },
            'preview-draft': {
              id: 'preview-draft',
              kind: 'subagent',
              label: t('business.seed.task.methodCategories'),
              status: 'succeeded',
              event: 'done',
              terminal: true,
              ts: Date.now() - 12_000,
            },
          },
          contextChannels: {
            research: {
              ...businessPreviewThread.contextChannels?.research,
              name: 'research',
              surface: {
                kind: 'list',
                label: t('business.seed.context.research'),
                editable: false,
                command: 'research',
                render_hint: 'research',
                priority: 1,
              },
              entries: [
                {
                  id: 'research-1',
                  text: t('business.seed.context.researchText'),
                  cls: 'fact',
                  confidence: 0.92,
                  provenance: 'preview',
                  why: t('business.seed.context.researchWhy'),
                  entities: [],
                  status: 'active',
                },
              ],
              lastDelta: null,
              changedAt: Date.now(),
            },
            memory: {
              ...businessPreviewThread.contextChannels?.memory,
              name: 'memory',
              surface: {
                kind: 'list',
                label: t('business.seed.context.memory'),
                editable: false,
                command: 'recall',
                render_hint: 'memory',
                priority: 2,
              },
              entries: [
                {
                  id: 'memory-1',
                  text: t('business.seed.context.memoryText'),
                  cls: 'fact',
                  confidence: 0.86,
                  provenance: 'preview',
                  why: t('business.seed.context.memoryWhy'),
                  entities: [],
                  status: 'active',
                },
              ],
              lastDelta: { added: ['memory-1'], superseded: [], evicted: [] },
              changedAt: Date.now(),
            },
            constraints: {
              ...businessPreviewThread.contextChannels?.constraints,
              name: 'constraints',
              surface: {
                kind: 'list',
                label: t('business.seed.context.constraints'),
                editable: false,
                command: 'constraints',
                render_hint: 'constraints',
                priority: 3,
              },
              entries: [
                {
                  id: 'constraint-1',
                  text: t('business.seed.context.constraintText'),
                  cls: 'fact',
                  confidence: 0.9,
                  provenance: 'preview',
                  why: t('business.seed.context.constraintWhy'),
                  entities: [],
                  status: 'active',
                },
              ],
              lastDelta: null,
              changedAt: Date.now(),
            },
          },
        },
      },
    })
  }, [i18n.language, set, t])

  return <>{children}</>
}

function BusinessPreviewFrame({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div
      className={`relative min-h-[360px] min-w-0 overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--paper)] [&_.auth-legal-scrim]:absolute [&_.feedback-scrim]:absolute [&_.project-form-dialog]:absolute [&_.project-form-scrim]:absolute ${className}`}
    >
      <StoreProvider assistantSources={[]}>
        <BusinessPreviewSeed>{children}</BusinessPreviewSeed>
      </StoreProvider>
    </div>
  )
}

function FeedbackExample(): JSX.Element {
  return (
    <BusinessPreviewFrame className="min-h-[620px]">
      <Feedback phone="13800008001" sessionId="business-preview" onClose={() => undefined} />
    </BusinessPreviewFrame>
  )
}

function FileContextMenuExample(): JSX.Element {
  const { t } = useTranslation('examples')
  return (
    <BusinessPreviewFrame>
      <div className="absolute inset-0 p-[var(--vds-space-5)] text-[var(--text-2)]">
        <FileContextMenu
          target={{
            relative: 'protein-folding-summary.md',
            absolute: '/tmp/scholarseed-preview/protein-folding-summary.md',
            name: 'protein-folding-summary.md',
            isDir: false,
          }}
        >
          <div className="inline-flex cursor-context-menu items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)] shadow-[var(--vds-shadow-1-center)]">
            <span>protein-folding-summary.md</span>
            <span className="text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-secondary)]">
              {t('attachments.context')}
            </span>
          </div>
        </FileContextMenu>
      </div>
    </BusinessPreviewFrame>
  )
}

function ModelMenuExample(): JSX.Element {
  return (
    <BusinessPreviewFrame>
      <div className="absolute left-[var(--vds-space-5)] top-[var(--vds-space-5)]">
        <ModelMenu />
      </div>
    </BusinessPreviewFrame>
  )
}

function ProjectFormExample(): JSX.Element {
  const { t } = useTranslation('examples')
  return (
    <BusinessPreviewFrame className="min-h-[520px]">
      <ProjectForm
        target={{ mode: 'edit', project: localizedBusinessPreviewProject(t) }}
        onClose={() => undefined}
        onDone={async () => undefined}
      />
    </BusinessPreviewFrame>
  )
}

function ResearchContextExample(): JSX.Element {
  return (
    <BusinessPreviewFrame>
      <div className="w-[360px] p-[var(--vds-space-4)]">
        <ResearchContext />
      </div>
    </BusinessPreviewFrame>
  )
}

function SessionArtifactsExample(): JSX.Element {
  return (
    <BusinessPreviewFrame>
      <div className="w-[360px] p-[var(--vds-space-4)]">
        <SessionArtifacts />
      </div>
    </BusinessPreviewFrame>
  )
}

function SessionContextMenuExample(): JSX.Element {
  const { t } = useTranslation('examples')
  const title = t('business.seed.recentTitle')
  return (
    <BusinessPreviewFrame>
      <div className="absolute inset-0 p-[var(--vds-space-5)] text-[var(--text-2)]">
        <SessionContextMenu
          target={{
            inProject: false,
            sessionId: 'recent-preview',
            title,
          }}
        >
          <div className="inline-flex cursor-context-menu items-center gap-[var(--vds-space-2)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] px-[var(--vds-space-3)] py-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)] shadow-[var(--vds-shadow-1-center)]">
            <span>{title}</span>
            <span className="text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-secondary)]">
              {t('attachments.context')}
            </span>
          </div>
        </SessionContextMenu>
      </div>
    </BusinessPreviewFrame>
  )
}

function SessionTitleExample(): JSX.Element {
  const { t } = useTranslation('examples')
  return (
    <BusinessPreviewFrame>
      <div className="w-[360px] p-[var(--vds-space-4)]">
        <SessionTitleEditor
          node={{
            ...businessPreviewSessionNode,
            title: t('business.seed.sessionTitle'),
            timeLabel: t('business.seed.now'),
          }}
        />
      </div>
    </BusinessPreviewFrame>
  )
}

function SidebarExample(): JSX.Element {
  return (
    <BusinessPreviewFrame className="min-h-[640px]">
      <Sidebar />
    </BusinessPreviewFrame>
  )
}

function SkillRefsExample(): JSX.Element {
  return (
    <BusinessPreviewFrame>
      <div className="p-[var(--vds-space-4)]">
        <ComposerSkillRefs
          refs={[
            {
              type: 'skill',
              id: 'literature-review',
              title: 'literature-review',
              path: '/tmp/scholarseed-preview/skills/literature-review',
              status: 'ready',
              version: '1.2.0',
            },
          ]}
          onRemove={() => undefined}
        />
      </div>
    </BusinessPreviewFrame>
  )
}

function StatusStripExample(): JSX.Element {
  return (
    <BusinessPreviewFrame>
      <div className="flex min-h-[360px] flex-col justify-end p-[var(--vds-space-4)]">
        <StatusStrip />
      </div>
    </BusinessPreviewFrame>
  )
}

function StreamExample(): JSX.Element {
  return (
    <BusinessPreviewFrame className="min-h-[640px]">
      <Stream />
    </BusinessPreviewFrame>
  )
}

function TaskMonitorExample(): JSX.Element {
  return (
    <BusinessPreviewFrame>
      <div className="w-[380px] p-[var(--vds-space-4)]">
        <TaskMonitor onToggle={() => undefined} />
      </div>
    </BusinessPreviewFrame>
  )
}

function TodoPanelExample(): JSX.Element {
  return (
    <BusinessPreviewFrame>
      <div className="w-[380px] p-[var(--vds-space-4)]">
        <TodoPanel />
      </div>
    </BusinessPreviewFrame>
  )
}

function WorkspaceFilesExample(): JSX.Element {
  return (
    <BusinessPreviewFrame className="min-h-[620px]">
      <WorkspaceFiles />
    </BusinessPreviewFrame>
  )
}

function chartY(value: number, max: number): number {
  return chartBaselineY - (value / max) * (chartBaselineY - chartTopY)
}

function chartPoints(key: 'expenses' | 'profit' | 'revenue', max: number): string {
  return monthlyChartData
    .map((item, index) => `${chartPlotLeftX + index * chartPointStep},${chartY(item[key], max)}`)
    .join(' ')
}

function ChartGrid({ ticks, max }: { max: number; ticks: readonly number[] }): JSX.Element {
  return (
    <g>
      {ticks.map((tick) => {
        const y = chartY(tick, max)
        return (
          <g key={tick}>
            <line
              className="stroke-[#e5e7eb] [stroke-width:1]"
              x1={chartPlotLeftX}
              x2={chartPlotRightX}
              y1={y}
              y2={y}
            />
            <text className="fill-[#737373] text-xs" textAnchor="end" x={chartAxisLabelX} y={y + 4}>
              {tick}
            </text>
          </g>
        )
      })}
      {monthlyChartData.map((item, index) => (
        <text
          className="fill-[#737373] text-xs"
          key={item.month}
          textAnchor="middle"
          x={chartPlotLeftX + index * chartPointStep}
          y="232"
        >
          {item.month}
        </text>
      ))}
    </g>
  )
}

function ExampleChartLegend({
  items,
}: {
  items: ReadonlyArray<{ color: string; label: string }>
}): JSX.Element {
  return (
    <div className="mt-[var(--vds-space-3)] flex justify-center gap-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
      {items.map((item) => (
        <span className="inline-flex items-center gap-[var(--vds-space-2)]" key={item.label}>
          <span className="h-2 w-2 rounded-sm" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  )
}

function ExampleBarChart(): JSX.Element {
  const { t } = useTranslation('examples')
  return (
    <svg
      aria-label={t('chart.barLabel')}
      className="block h-full w-full"
      role="img"
      viewBox={`0 0 ${chartViewBoxWidth} 260`}
    >
      <ChartGrid max={10000} ticks={chartTicks} />
      {monthlyChartData.map((item, index) => {
        const groupX = chartPlotLeftX + index * chartPointStep
        const revenueHeight = chartBaselineY - chartY(item.revenue, 10000)
        const expensesHeight = chartBaselineY - chartY(item.expenses, 10000)
        return (
          <g key={item.month}>
            <rect
              className="fill-[var(--vds-chart-purple)]"
              height={revenueHeight}
              rx="4"
              width="22"
              x={groupX - 18}
              y={chartBaselineY - revenueHeight}
            />
            <rect
              className="fill-[var(--vds-chart-blue)]"
              height={expensesHeight}
              rx="4"
              width="22"
              x={groupX + 8}
              y={chartBaselineY - expensesHeight}
            />
          </g>
        )
      })}
    </svg>
  )
}

function ExampleLineChart(): JSX.Element {
  const { t } = useTranslation('examples')
  return (
    <svg
      aria-label={t('chart.lineLabel')}
      className="block h-full w-full"
      role="img"
      viewBox={`0 0 ${chartViewBoxWidth} 260`}
    >
      <ChartGrid max={10000} ticks={chartTicks} />
      <polyline
        className="fill-none stroke-2 [stroke-linecap:round] [stroke-linejoin:round] stroke-[var(--vds-chart-purple)]"
        points={chartPoints('revenue', 10000)}
      />
      <polyline
        className="fill-none stroke-2 [stroke-linecap:round] [stroke-linejoin:round] stroke-[var(--vds-chart-green)]"
        points={chartPoints('profit', 10000)}
      />
    </svg>
  )
}

function ExampleAreaChart(): JSX.Element {
  const { t } = useTranslation('examples')
  const expensesPoints = chartPoints('expenses', 12000)
  const revenuePoints = monthlyChartData
    .map(
      (item, index) =>
        `${chartPlotLeftX + index * chartPointStep},${chartY(item.revenue + item.expenses, 12000)}`
    )
    .join(' ')
  return (
    <svg
      aria-label={t('chart.areaLabel')}
      className="block h-full w-full"
      role="img"
      viewBox={`0 0 ${chartViewBoxWidth} 260`}
    >
      <defs>
        <linearGradient id="vds-example-chart-expenses" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--vds-chart-blue)" stopOpacity="0.42" />
          <stop offset="100%" stopColor="var(--vds-chart-blue)" stopOpacity="0.18" />
        </linearGradient>
        <linearGradient id="vds-example-chart-revenue" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--vds-chart-purple)" stopOpacity="0.46" />
          <stop offset="100%" stopColor="var(--vds-chart-purple)" stopOpacity="0.16" />
        </linearGradient>
      </defs>
      <ChartGrid max={12000} ticks={areaChartTicks} />
      <polygon
        className="stroke-0"
        points={`${chartPlotLeftX},${chartBaselineY} ${expensesPoints} ${chartPlotRightX},${chartBaselineY}`}
        style={{ fill: 'url(#vds-example-chart-expenses)' }}
      />
      <polygon
        className="stroke-0"
        points={`${chartPlotLeftX},${chartBaselineY} ${revenuePoints} ${chartPlotRightX},${chartBaselineY}`}
        style={{ fill: 'url(#vds-example-chart-revenue)' }}
      />
      <polyline
        className="fill-none stroke-2 [stroke-linecap:round] [stroke-linejoin:round] stroke-[var(--vds-chart-blue)]"
        points={expensesPoints}
      />
      <polyline
        className="fill-none stroke-2 [stroke-linecap:round] [stroke-linejoin:round] stroke-[var(--vds-chart-purple)]"
        points={revenuePoints}
      />
    </svg>
  )
}

function ToastExampleMessage({
  kind,
}: {
  kind: 'description' | 'longDescription' | 'title' | 'success' | 'error' | 'warning' | 'action'
}): JSX.Element {
  const { t } = useTranslation('examples')
  const messages = {
    description: { messageKey: 'toast.description' },
    longDescription: { messageKey: 'toast.longDescription' },
    title: { messageKey: 'toast.title' },
    success: { messageKey: 'alert.success' },
    error: { messageKey: 'alert.error' },
    warning: { messageKey: 'alert.warning' },
    action: { messageKey: 'toast.action' },
  } as const
  return <>{t(messages[kind].messageKey)}</>
}

function ToastExampleAction(): JSX.Element {
  const { t } = useTranslation('examples')
  return (
    <Button size="sm" variant="secondary">
      {t('toast.undo')}
    </Button>
  )
}

function ToastExampleControls(): JSX.Element {
  const { t } = useTranslation('examples')
  const { toast } = useToast()
  const showDefaultToast = (): void => {
    toast({
      description: <ToastExampleMessage kind="description" />,
      title: <ToastExampleMessage kind="title" />,
      tone: 'info',
    })
  }
  const showTitleOnlyToast = (): void => {
    toast({
      title: <ToastExampleMessage kind="title" />,
      tone: 'info',
    })
  }
  const showLongDescriptionToast = (): void => {
    toast({
      description: <ToastExampleMessage kind="longDescription" />,
      title: <ToastExampleMessage kind="title" />,
      tone: 'info',
    })
  }
  const showSuccessToast = (): void => {
    toast({
      description: <ToastExampleMessage kind="description" />,
      title: <ToastExampleMessage kind="success" />,
      tone: 'success',
    })
  }
  const showErrorToast = (): void => {
    toast({
      dedupeKey: 'example-error',
      description: <ToastExampleMessage kind="description" />,
      title: <ToastExampleMessage kind="error" />,
      tone: 'error',
    })
  }
  const showWarningToast = (): void => {
    toast({
      description: <ToastExampleMessage kind="description" />,
      title: <ToastExampleMessage kind="warning" />,
      tone: 'warning',
    })
  }
  const showActionToast = (): void => {
    toast({
      action: <ToastExampleAction />,
      description: <ToastExampleMessage kind="description" />,
      title: <ToastExampleMessage kind="action" />,
      tone: 'info',
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-[var(--vds-space-2)]">
      <Button variant="outline" onClick={showDefaultToast}>
        {t('toast.default')}
      </Button>
      <Button variant="outline" onClick={showTitleOnlyToast}>
        {t('toast.titleOnly')}
      </Button>
      <Button variant="outline" onClick={showLongDescriptionToast}>
        {t('toast.longDescriptionLabel')}
      </Button>
      <Button onClick={showSuccessToast}>{t('toast.success')}</Button>
      <Button variant="destructive" onClick={showErrorToast}>
        {t('toast.error')}
      </Button>
      <Button variant="warning" onClick={showWarningToast}>
        {t('toast.warning')}
      </Button>
      <Button variant="secondary" onClick={showActionToast}>
        {t('toast.action')}
      </Button>
    </div>
  )
}

function SheetDrawerExample(): JSX.Element {
  const { t } = useTranslation('examples')
  return (
    <div className="grid gap-[var(--vds-space-3)]">
      <Sheet>
        <SheetTrigger>{t('sheet.open')}</SheetTrigger>
        <SheetOverlay />
        <SheetContent modal side="right">
          <SheetHeader>
            <SheetTitle>{t('sheet.detail')}</SheetTitle>
            <SheetDescription>{t('sheet.description')}</SheetDescription>
          </SheetHeader>
          <div>{t('sheet.content')}</div>
          <SheetFooter>
            <SheetClose>{t('sheet.close')}</SheetClose>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <Drawer>
        <DrawerTrigger>{t('sheet.openDrawer')}</DrawerTrigger>
        <DrawerOverlay />
        <DrawerContent modal direction="bottom">
          <DrawerHeader>
            <DrawerTitle>{t('sheet.drawer')}</DrawerTitle>
            <DrawerDescription>{t('sheet.semantics')}</DrawerDescription>
          </DrawerHeader>
          <DrawerFooter>
            <DrawerClose>{t('sheet.close')}</DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

export function ComponentsPage(): JSX.Element {
  const [resizeOffset, setResizeOffset] = useState(0)
  const { state, act } = useApp()
  const { t } = useTranslation('examples')
  const chartExampleConfig = {
    expenses: {
      color: 'var(--vds-chart-blue)',
      label: t('chart.expenses'),
    },
    profit: {
      color: 'var(--vds-chart-green)',
      label: t('chart.profit'),
    },
    desktop: {
      color: 'var(--vds-brand-6)',
      label: t('chart.desktop'),
    },
    revenue: {
      color: 'var(--vds-chart-purple)',
      label: t('chart.revenue'),
    },
  }
  const [activeExample, setActiveExample] = useState<string>(exampleMenuItems[0].id)
  const [openMenuGroup, setOpenMenuGroup] = useState<ComponentMenuGroupId | null>('ui')
  const [closedAlertIds, setClosedAlertIds] = useState<ReadonlySet<string>>(new Set())
  const [badgeVisible, setBadgeVisible] = useState(true)
  const [tagVisible, setTagVisible] = useState(true)
  const [navigationTabsValue, setNavigationTabsValue] = useState('library')
  const [navigationTabsItems, setNavigationTabsItems] = useState(navigationTabSeedItems)
  const reorderNavigationTabs = (ids: string[]): void => {
    setNavigationTabsItems((items) => ids.flatMap((id) => items.filter((item) => item.id === id)))
  }
  const [basicCollapsibleOpen, setBasicCollapsibleOpen] = useState(false)
  const [contextBookmarked, setContextBookmarked] = useState(false)
  const [contextStarred, setContextStarred] = useState(true)
  const [commandDialogOpen, setCommandDialogOpen] = useState(false)
  const [showBookmarks, setShowBookmarks] = useState(true)
  const [showUrls, setShowUrls] = useState(false)
  const [menubarTheme, setMenubarTheme] = useState('auto')
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [togglePressed, setTogglePressed] = useState(false)
  const [textFormatting, setTextFormatting] = useState<string[]>([])
  const [alignment, setAlignment] = useState('left')
  const [otpValue, setOtpValue] = useState('135')
  const [sliderVolume, setSliderVolume] = useState([34])
  const [sliderPrice, setSliderPrice] = useState([21, 75])
  const [themePreview, setThemePreview] = useState<Exclude<Theme, 'system'>>('light')
  const activeExampleCode = extractSectionCode(componentsPageSource, activeExample)
  const closeNavigationTab = (id: string): void => {
    setNavigationTabsItems((items) => items.filter((item) => item.id !== id))
    if (navigationTabsValue === id) {
      setNavigationTabsValue('overview')
    }
  }
  const localizedNavigationTabsItems = navigationTabsItems.map((item) => ({
    id: item.id,
    label: navigationTabLabel(item.id, t),
  }))

  useEffect(() => {
    applyTheme(themePreview)
  }, [themePreview])

  return (
    <main className={examplesPageClassName}>
      <header className="mb-[var(--vds-space-6)] flex flex-wrap items-center justify-between gap-[var(--vds-space-4)]">
        <div className="grid gap-[var(--vds-space-2)]">
          <h1 className="m-0 text-[length:var(--vds-font-headline)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-headline)]">
            {t('title')}
          </h1>
          <p className="m-0 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)]">
            {t('subtitle')}
          </p>
          <ToggleGroup
            aria-label={t('language')}
            allowEmpty={false}
            type="single"
            value={state.lang}
            onValueChange={(value) => {
              if (value === 'zh' || value === 'en') act.setLang(value)
            }}
          >
            <ToggleGroupItem value="zh">{t('chinese')}</ToggleGroupItem>
            <ToggleGroupItem value="en">{t('english')}</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="grid w-full gap-[var(--vds-space-2)] sm:w-40">
          <Label htmlFor="theme-preview-mode">{t('theme.preview')}</Label>
          <Select
            value={themePreview}
            onValueChange={(value) => setThemePreview(value === 'dark' ? 'dark' : 'light')}
          >
            <SelectTrigger id="theme-preview-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">{t('theme.light')}</SelectItem>
              <SelectItem value="dark">{t('theme.dark')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </header>

      <div className="grid h-full min-h-0 grid-cols-[260px_minmax(0,1fr)] items-start gap-[var(--vds-space-5)] max-[860px]:grid-cols-[minmax(0,1fr)] max-[860px]:grid-rows-[auto_minmax(0,1fr)]">
        <aside
          className="sticky top-[var(--vds-space-6)] grid max-h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-[var(--vds-space-3)] self-stretch overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-3)] shadow-[var(--vds-shadow-1-center)] max-[860px]:top-[var(--vds-space-4)] max-[860px]:z-[2] max-[860px]:max-h-[min(40vh,320px)] max-[860px]:self-start"
          aria-label={t('shell.menu')}
        >
          <div className="px-[var(--vds-space-2)] text-[13px] font-[var(--vds-fw-medium)] uppercase leading-[var(--vds-lh-caption)] text-[var(--vds-text-secondary)]">
            Components
          </div>
          <nav className="grid min-h-0 content-start gap-[var(--vds-space-2)] overflow-auto pr-[var(--vds-space-1)] max-[860px]:flex max-[860px]:overflow-x-auto max-[860px]:overflow-y-hidden max-[860px]:pb-[var(--vds-space-1)] max-[860px]:pr-0">
            {componentMenuGroups.map((group) => (
              <ComponentMenuGroup
                activeExample={activeExample}
                group={group}
                key={group.id}
                onOpenChange={(open) => setOpenMenuGroup(open ? group.id : null)}
                onSelect={setActiveExample}
                open={openMenuGroup === group.id}
              />
            ))}
          </nav>
        </aside>

        <div
          className="h-full min-h-0 min-w-0 overflow-y-auto pr-[var(--vds-space-1)]"
          aria-label={t('shell.preview')}
        >
          <div className="mb-[var(--vds-space-4)] grid min-h-0 grid-cols-[minmax(0,1fr)] gap-[var(--vds-space-4)]">
            <section
              className={exampleSectionClass('account-panel', activeExample)}
              id="account-panel"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                AccountPanel
              </h2>
              <AccountPanelExample />
            </section>

            <section className={exampleSectionClass('chrome', activeExample)} id="chrome">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Chrome
              </h2>
              <ChromeExample />
            </section>

            <section className={exampleSectionClass('composer', activeExample)} id="composer">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Composer
              </h2>
              <ComposerExample />
            </section>

            <section className={exampleSectionClass('feedback', activeExample)} id="feedback">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Feedback
              </h2>
              {renderActiveExample('feedback', activeExample, <FeedbackExample />)}
            </section>

            <section
              className={exampleSectionClass('file-context-menu', activeExample)}
              id="file-context-menu"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                FileContextMenu
              </h2>
              {renderActiveExample('file-context-menu', activeExample, <FileContextMenuExample />)}
            </section>

            <section className={exampleSectionClass('model-menu', activeExample)} id="model-menu">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                ModelMenu
              </h2>
              {renderActiveExample('model-menu', activeExample, <ModelMenuExample />)}
            </section>

            <section
              className={exampleSectionClass('project-form', activeExample)}
              id="project-form"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                ProjectForm
              </h2>
              {renderActiveExample('project-form', activeExample, <ProjectFormExample />)}
            </section>

            <section
              className={exampleSectionClass('research-context', activeExample)}
              id="research-context"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                ResearchContext
              </h2>
              {renderActiveExample('research-context', activeExample, <ResearchContextExample />)}
            </section>

            <section
              className={exampleSectionClass('session-artifacts', activeExample)}
              id="session-artifacts"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                SessionArtifacts
              </h2>
              {renderActiveExample('session-artifacts', activeExample, <SessionArtifactsExample />)}
            </section>

            <section
              className={exampleSectionClass('session-context-menu', activeExample)}
              id="session-context-menu"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                SessionContextMenu
              </h2>
              {renderActiveExample(
                'session-context-menu',
                activeExample,
                <SessionContextMenuExample />
              )}
            </section>

            <section
              className={exampleSectionClass('session-title', activeExample)}
              id="session-title"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                SessionTitle
              </h2>
              {renderActiveExample('session-title', activeExample, <SessionTitleExample />)}
            </section>

            <section className={exampleSectionClass('sidebar', activeExample)} id="sidebar">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Sidebar
              </h2>
              {renderActiveExample('sidebar', activeExample, <SidebarExample />)}
            </section>

            <section className={exampleSectionClass('skill-refs', activeExample)} id="skill-refs">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                SkillRefs
              </h2>
              {renderActiveExample('skill-refs', activeExample, <SkillRefsExample />)}
            </section>

            <section
              className={exampleSectionClass('status-strip', activeExample)}
              id="status-strip"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                StatusStrip
              </h2>
              {renderActiveExample('status-strip', activeExample, <StatusStripExample />)}
            </section>

            <section className={exampleSectionClass('stream', activeExample)} id="stream">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Stream
              </h2>
              {renderActiveExample('stream', activeExample, <StreamExample />)}
            </section>

            <section
              className={exampleSectionClass('task-monitor', activeExample)}
              id="task-monitor"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                TaskMonitor
              </h2>
              {renderActiveExample('task-monitor', activeExample, <TaskMonitorExample />)}
            </section>

            <section className={exampleSectionClass('todo-panel', activeExample)} id="todo-panel">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                TodoPanel
              </h2>
              {renderActiveExample('todo-panel', activeExample, <TodoPanelExample />)}
            </section>

            <section
              className={exampleSectionClass('workspace-files', activeExample)}
              id="workspace-files"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                WorkspaceFiles
              </h2>
              {renderActiveExample('workspace-files', activeExample, <WorkspaceFilesExample />)}
            </section>

            <section className={exampleSectionClass('attachments', activeExample)} id="attachments">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Attachments
              </h2>
              <AttachmentsExample />
            </section>

            <section className={exampleSectionClass('icon-font', activeExample)} id="icon-font">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                IconFont
              </h2>
              <div className="grid gap-[var(--vds-space-5)]">
                <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-3)]">
                  <span className="grid size-[48px] place-items-center rounded-[var(--vds-radius-4)] bg-[var(--vds-surface-muted)] text-[var(--vds-text-primary)]">
                    <IconFont
                      className="leading-none"
                      style={{ fontSize: 24 }}
                      type="line-tool-setting"
                    />
                  </span>
                  <span className="grid size-[48px] place-items-center rounded-[var(--vds-radius-4)] bg-[var(--vds-help-light-bg-default)] text-[var(--vds-help-text-primary)]">
                    <IconFont
                      className="leading-none"
                      style={{ fontSize: 24 }}
                      type="a-line-status-help"
                    />
                  </span>
                  <span className="grid size-[48px] place-items-center rounded-[var(--vds-radius-4)] bg-[var(--vds-success-light-bg-default)] text-[var(--vds-success-text-primary)]">
                    <IconFont
                      className="leading-none"
                      style={{ fontSize: 24 }}
                      type="line-operation-select"
                    />
                  </span>
                  <span className="grid size-[48px] place-items-center rounded-[var(--vds-radius-4)] bg-[var(--vds-warning-light-bg-default)] text-[var(--vds-warning-text-primary)]">
                    <IconFont
                      className="leading-none"
                      style={{ fontSize: 24 }}
                      type="line-tool-flash"
                    />
                  </span>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                  <Button icon={<IconFont type="line-tool-appendix" />}>
                    {t('attachments.add')}
                  </Button>
                  <Button icon={<IconFont type="line-operation-filter-shape" />} variant="outline">
                    {t('attachments.filter')}
                  </Button>
                  <Button icon={<IconFont type="line-tool-setting" />} variant="secondary">
                    {t('attachments.settings')}
                  </Button>
                </div>
              </div>
            </section>

            <section className={exampleSectionClass('markdown', activeExample)} id="markdown">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Markdown
              </h2>
              <div className="grid gap-[var(--vds-space-3)]">
                <Markdown
                  className="rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] p-[var(--vds-space-4)]"
                  orderedLists
                  texMath
                  text={t('business.seed.markdown')}
                />
              </div>
            </section>

            <section
              className={exampleSectionClass('transition-progress', activeExample)}
              id="transition-progress"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Progress
              </h2>
              <div className="grid gap-[var(--vds-space-4)]">
                <div className="grid grid-cols-2 gap-[var(--vds-space-4)] max-[960px]:grid-cols-1">
                  <div className="grid min-h-[280px] min-w-0 overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)]">
                    <TransitionProgress
                      detail={t('transition.connecting')}
                      surface="conversation"
                      title={t('transition.restoring')}
                    />
                  </div>
                  <div className="grid min-h-[280px] min-w-0 overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)]">
                    <TransitionProgress
                      detail={t('transition.preparing')}
                      surface="workspace"
                      title={t('transition.creating')}
                    />
                  </div>
                </div>
                <div className="grid min-h-[280px] min-w-0 overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)]">
                  <TransitionProgress
                    actionLabel={t('transition.reload')}
                    detail={t('transition.errorDescription')}
                    error
                    onAction={() => undefined}
                    surface="conversation"
                    title={t('transition.errorTitle')}
                  />
                </div>
                <Button aria-busy="true" className="w-max" disabled loading size="sm">
                  {t('transition.sending')}
                </Button>
              </div>
            </section>

            <section className={exampleSectionClass('label-form', activeExample)} id="label-form">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Label and Form
              </h2>
              <div className="grid gap-[var(--vds-space-3)]">
                <Label htmlFor="components-label-required" required>
                  {t('form.required')}
                </Label>
                <Label disabled htmlFor="components-label-optional" optional>
                  {t('form.optionalDisabled')}
                </Label>
                <FormField>
                  <FormLabel required>{t('form.name')}</FormLabel>
                  <FormControl invalid>
                    <Input placeholder={t('form.placeholder')} />
                  </FormControl>
                  <FormDescription>{t('form.description')}</FormDescription>
                  <FormMessage>{t('form.error')}</FormMessage>
                </FormField>
              </div>
            </section>

            <section className={exampleSectionClass('alert', activeExample)} id="alert">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Alert
              </h2>
              <div className="grid gap-[var(--vds-space-3)]">
                {alertExampleItems.map((item) =>
                  closedAlertIds.has(item.id) ? null : (
                    <Alert
                      closable
                      description={t('alert.description')}
                      key={item.id}
                      onClose={() => setClosedAlertIds((current) => new Set(current).add(item.id))}
                      title={t(item.titleKey)}
                      tone={item.tone}
                    />
                  )
                )}
                <Alert
                  action={
                    <Button size="sm" variant="outline">
                      {t('alerts.continue')}
                    </Button>
                  }
                  description={t('alerts.interruptedDescription')}
                  layout="stacked"
                  title={t('alerts.interruptedTitle')}
                  tone="warning"
                />
                <Alert
                  action={
                    <div className="flex gap-[var(--vds-space-2)]">
                      <Button size="sm" variant="primary">
                        {t('alerts.restore')}
                      </Button>
                      <Button size="sm" variant="secondary">
                        {t('alerts.ignore')}
                      </Button>
                    </div>
                  }
                  description={t('alerts.recoverDescription')}
                  layout="stacked"
                  title={t('alerts.recoverTitle')}
                  tone="info"
                />
                <Alert
                  action={
                    <div className="flex gap-[var(--vds-space-2)]">
                      <Button size="sm" variant="primary">
                        {t('alerts.keepMine')}
                      </Button>
                      <Button size="sm" variant="secondary">
                        {t('alerts.reload')}
                      </Button>
                    </div>
                  }
                  description={t('alerts.conflictDescription')}
                  layout="stacked"
                  title={t('alerts.conflictTitle')}
                  tone="warning"
                />
                <Alert
                  action={
                    <div className="flex gap-[var(--vds-space-2)]">
                      <Button size="sm" variant="primary">
                        {t('alerts.approve')}
                      </Button>
                      <Button size="sm" variant="secondary">
                        {t('alerts.reject')}
                      </Button>
                    </div>
                  }
                  description={t('alerts.reviewDescription')}
                  layout="stacked"
                  title={t('alerts.reviewTitle')}
                  tone="info"
                />
                <Alert
                  action={
                    <div className="flex gap-[var(--vds-space-2)]">
                      <Button size="sm" variant="danger">
                        {t('alerts.overwrite')}
                      </Button>
                      <Button size="sm" variant="secondary">
                        {t('alerts.skip')}
                      </Button>
                    </div>
                  }
                  description={t('alerts.importDescription')}
                  layout="stacked"
                  title={t('alerts.importTitle')}
                  tone="error"
                />
                <Alert
                  action={
                    <Button disabled loading size="sm" variant="secondary">
                      {t('alerts.retrying')}
                    </Button>
                  }
                  description={t('alerts.retryDescription')}
                  layout="stacked"
                  title={t('alerts.retryTitle')}
                  tone="warning"
                />
              </div>
            </section>

            <section
              className={exampleSectionClass('alert-dialog', activeExample)}
              id="alert-dialog"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                AlertDialog
              </h2>
              <AlertDialog>
                <AlertDialogTrigger>{t('delete.title')}</AlertDialogTrigger>
                <AlertDialogContent aria-label={t('delete.title')} showCloseButton>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('delete.title')}</AlertDialogTitle>
                    <AlertDialogDescription>{t('delete.description')}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t('delete.cancel')}</AlertDialogCancel>
                    <AlertDialogAction>{t('delete.confirm')}</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </section>

            <section
              className={exampleSectionClass('progress-avatar', activeExample)}
              id="progress-avatar"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Progress and Avatar
              </h2>
              <div className="grid gap-[var(--vds-space-3)]">
                <ProgressBar label={t('progress.upload')} value={64} />
                <ProgressBar
                  shape="circle"
                  className="size-[var(--vds-icon-10)]"
                  label={t('progress.upload')}
                  value={64}
                />
                <ProgressBar indeterminate label={t('progress.processing')} />
                <Progress
                  color="success"
                  subtitle={t('progress.business')}
                  title={t('progress.intent')}
                  value={70}
                />
                <Progress
                  color="warning"
                  showPercentage={false}
                  subtitle={t('progress.hidden')}
                  title={t('progress.download')}
                  value={33}
                />
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                <Avatar fallback="书" size="sm" />
                <Avatar fallback="深" />
                <Avatar fallback="研" size="lg" />
              </div>
            </section>

            <section className={exampleSectionClass('calendar', activeExample)} id="calendar">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Calendar
              </h2>
              <Calendar selectedDay={15} />
            </section>

            <section className={exampleSectionClass('carousel', activeExample)} id="carousel">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Carousel
              </h2>
              <div className="grid gap-[var(--vds-space-8)] bg-[repeating-linear-gradient(45deg,transparent,transparent_7px,var(--vds-other-overlay-1)_7px,var(--vds-other-overlay-1)_14px)] py-[var(--vds-space-2)] pb-[var(--vds-space-4)]">
                <div className="mx-auto grid min-w-0 justify-items-center w-[min(320px,100%)]">
                  <h3 className="m-0 mb-[var(--vds-space-4)] text-center text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('carousel.basic')}
                  </h3>
                  <Carousel autoPlay className="w-full">
                    <CarouselContent>
                      {Array.from({ length: 5 }).map((_, index) => (
                        <CarouselItem key={index}>
                          <Card className="h-full w-full">
                            <CardContent className="grid min-h-[240px] place-items-center">
                              <span className="text-[length:var(--vds-font-display-lv4)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-display-lv4)] text-[var(--vds-text-primary)]">
                                {index + 1}
                              </span>
                            </CardContent>
                          </Card>
                        </CarouselItem>
                      ))}
                    </CarouselContent>
                    <CarouselIndicators />
                  </Carousel>
                </div>

                <div className="mx-auto grid min-w-0 justify-items-center w-[min(720px,100%)]">
                  <h3 className="m-0 mb-[var(--vds-space-4)] text-center text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('carousel.multiple')}
                  </h3>
                  <Carousel className="w-full" opts={{ align: 'start' }} visibleItems={3}>
                    <CarouselContent>
                      {Array.from({ length: 10 }).map((_, index) => (
                        <CarouselItem key={index}>
                          <Card className="h-full w-full">
                            <CardContent className="grid min-h-[180px] place-items-center text-center">
                              <div className="mb-[var(--vds-space-2)] text-[length:var(--vds-font-display-lv1)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-display-lv1)]">
                                {t('carousel.item', { position: index + 1 })}
                              </div>
                              <div className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
                                {t('carousel.description')}
                              </div>
                            </CardContent>
                          </Card>
                        </CarouselItem>
                      ))}
                    </CarouselContent>
                    <CarouselPrevious />
                    <CarouselNext />
                  </Carousel>
                </div>

                <div className="mx-auto grid min-w-0 justify-items-center w-[min(420px,100%)]">
                  <h3 className="m-0 mb-[var(--vds-space-4)] text-center text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('carousel.content')}
                  </h3>
                  <Carousel className="w-full">
                    <CarouselContent>
                      {carouselContentItems.map((item, index) => (
                        <CarouselItem key={index}>
                          <Card className={carouselContentCardClass(item.tone)}>
                            <CardContent>
                              <h4 className="m-0 mb-[var(--vds-space-3)] text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)]">
                                {t(item.titleKey)}
                              </h4>
                              <p className="m-0 text-[var(--vds-text-secondary)]">
                                {t(item.contentKey)}
                              </p>
                            </CardContent>
                          </Card>
                        </CarouselItem>
                      ))}
                    </CarouselContent>
                    <CarouselPrevious />
                    <CarouselNext />
                  </Carousel>
                </div>

                <div className="mx-auto grid min-w-0 justify-items-center w-[min(320px,100%)]">
                  <h3 className="m-0 mb-[var(--vds-space-4)] text-center text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('carousel.vertical')}
                  </h3>
                  <Carousel
                    className="w-full"
                    opts={{ align: 'start' }}
                    orientation="vertical"
                    visibleItems={3}
                  >
                    <CarouselContent>
                      {Array.from({ length: 5 }).map((_, index) => (
                        <CarouselItem key={index}>
                          <Card className="h-full w-full">
                            <CardContent className="grid min-h-[72px] place-items-center">
                              <span className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)]">
                                {t('carousel.verticalItem', { position: index + 1 })}
                              </span>
                            </CardContent>
                          </Card>
                        </CarouselItem>
                      ))}
                    </CarouselContent>
                    <CarouselPrevious />
                    <CarouselNext />
                  </Carousel>
                </div>
              </div>
            </section>

            <section className={exampleSectionClass('chart', activeExample)} id="chart">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Chart
              </h2>
              <div className="grid w-[min(520px,100%)] gap-[var(--vds-space-8)] [--vds-chart-blue:#3478b9] [--vds-chart-green:#2f7d3d] [--vds-chart-purple:#6f3df4]">
                <div className="grid min-w-0">
                  <h3 className="m-0 mb-[var(--vds-space-1)] text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                    {t('chart.bar')}
                  </h3>
                  <p className="m-0 mb-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[#64748b]">
                    {t('chart.compare')}
                  </p>
                  <ChartContainer
                    className="h-[260px] w-full [aspect-ratio:auto]"
                    config={chartExampleConfig}
                  >
                    <ExampleBarChart />
                  </ChartContainer>
                  <ExampleChartLegend
                    items={[
                      { color: 'var(--vds-chart-blue)', label: t('chart.expenses') },
                      { color: 'var(--vds-chart-purple)', label: t('chart.revenue') },
                    ]}
                  />
                </div>

                <div className="grid min-w-0">
                  <h3 className="m-0 mb-[var(--vds-space-1)] text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                    {t('chart.line')}
                  </h3>
                  <p className="m-0 mb-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[#64748b]">
                    {t('chart.trend')}
                  </p>
                  <ChartContainer
                    className="h-[260px] w-full [aspect-ratio:auto]"
                    config={chartExampleConfig}
                  >
                    <ExampleLineChart />
                  </ChartContainer>
                  <ExampleChartLegend
                    items={[
                      { color: 'var(--vds-chart-green)', label: t('chart.profit') },
                      { color: 'var(--vds-chart-purple)', label: t('chart.revenue') },
                    ]}
                  />
                </div>

                <div className="grid min-w-0">
                  <h3 className="m-0 mb-[var(--vds-space-1)] text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                    {t('chart.area')}
                  </h3>
                  <p className="m-0 mb-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[#64748b]">
                    {t('chart.stacked')}
                  </p>
                  <ChartContainer
                    className="h-[260px] w-full [aspect-ratio:auto]"
                    config={chartExampleConfig}
                  >
                    <ExampleAreaChart />
                  </ChartContainer>
                  <ExampleChartLegend
                    items={[
                      { color: 'var(--vds-chart-blue)', label: t('chart.expenses') },
                      { color: 'var(--vds-chart-purple)', label: t('chart.revenue') },
                    ]}
                  />
                </div>
              </div>
            </section>

            <section className={exampleSectionClass('empty-copy', activeExample)} id="empty-copy">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                EmptyState and CopyButton
              </h2>
              <EmptyState
                action={<Button variant="secondary">{t('empty.new')}</Button>}
                description={t('empty.description')}
                icon="∅"
                title={t('empty.title')}
              />
              <EmptyState variant="compact" icon={<Copy />} title={t('empty.title')} />
              <EmptyState
                variant="panel"
                icon={<File />}
                title={t('empty.openFile')}
                description={t('empty.chooseTreeFile')}
              />
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                <CopyButton value="DeepRD">{t('copy.name')}</CopyButton>
                <CopyButton
                  iconOnly
                  icon={<Copy size={14} />}
                  size="xs"
                  className="![--vds-icon-button-glyph:var(--vds-icon-7)]"
                  variant="ghost"
                  value="DeepRD"
                />
                <CopyButton disabled value="DeepRD">
                  {t('copy.disabled')}
                </CopyButton>
              </div>
            </section>

            <section
              className={exampleSectionClass('ellipsis-text', activeExample)}
              id="ellipsis-text"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                {t('ellipsis.title')}
              </h2>
              <div className="grid w-[260px] max-w-full gap-[var(--vds-space-3)]">
                <div className="grid min-w-0 gap-[var(--vds-space-1)]">
                  <span className="text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-tertiary)]">
                    {t('ellipsis.normal')}
                  </span>
                  <EllipsisText>{t('ellipsis.short')}</EllipsisText>
                </div>
                <div className="grid min-w-0 gap-[var(--vds-space-1)]">
                  <span className="text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-tertiary)]">
                    {t('ellipsis.overflow')}
                  </span>
                  <EllipsisText tooltipSide="bottom" wrapperClassName="w-[190px]">
                    {t('ellipsis.documentTitle')}
                  </EllipsisText>
                </div>
                <div className="grid min-w-0 gap-[var(--vds-space-1)]">
                  <span className="text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-tertiary)]">
                    {t('ellipsis.portalled')}
                  </span>
                  <EllipsisText
                    tooltipAlign="start"
                    tooltipOffset={10}
                    tooltipPortalled
                    tooltipSide="bottom"
                    wrapperClassName="w-[190px]"
                  >
                    {t('ellipsis.analysisTitle')}
                  </EllipsisText>
                </div>
              </div>
            </section>

            <section
              className={exampleSectionClass('loading-overlay', activeExample)}
              id="loading-overlay"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                LoadingOverlay
              </h2>
              <div className="relative grid min-h-[var(--vds-loading-overlay-preview-height)] place-items-center rounded-[var(--vds-radius-4)] border border-dashed border-[var(--vds-border-default)] bg-[var(--vds-surface-muted)] p-[var(--vds-space-4)] text-[var(--vds-text-secondary)]">
                <span>{t('loading.background')}</span>
                <LoadingOverlay visible label={t('loading.syncing')} />
              </div>
            </section>

            <section
              className={exampleSectionClass('table-pagination', activeExample)}
              id="table-pagination"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Table and Pagination
              </h2>
              <Table>
                <TableCaption>{t('table.recent')}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('table.name')}</TableHead>
                    <TableHead>{t('table.status')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell>DeepRD</TableCell>
                    <TableCell>{t('table.progress')}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell>Veda</TableCell>
                    <TableCell>{t('table.synced')}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              <Pagination page={4} pageCount={12} onPageChange={() => undefined} />
            </section>

            <section
              className={exampleSectionClass('aspect-breadcrumb', activeExample)}
              id="aspect-breadcrumb"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                AspectRatio and Breadcrumb
              </h2>
              <AspectRatio
                className="rounded-[var(--vds-radius-4)] bg-[var(--vds-brand-light-bg-default)]"
                ratio={16 / 9}
              >
                <div className="grid place-items-center text-[length:var(--vds-font-title)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-title)] text-[var(--vds-brand-text-primary)]">
                  16:9
                </div>
              </AspectRatio>
              <Breadcrumb label={t('breadcrumb.path')}>
                <BreadcrumbList>
                  <BreadcrumbItem>
                    <BreadcrumbLink href="#workspace">{t('breadcrumb.workspace')}</BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbEllipsis />
                  </BreadcrumbItem>
                  <BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbLink href="#projects">{t('breadcrumb.projects')}</BreadcrumbLink>
                  </BreadcrumbItem>
                  <BreadcrumbItem>
                    <BreadcrumbSeparator />
                    <BreadcrumbPage>DeepRD</BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </section>

            <section className={exampleSectionClass('collapsible', activeExample)} id="collapsible">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Collapsible
              </h2>
              <div className="grid w-[min(460px,100%)] gap-[var(--vds-space-4)]">
                <div className="w-[min(360px,100%)]">
                  <Collapsible open={basicCollapsibleOpen} onOpenChange={setBasicCollapsibleOpen}>
                    <CollapsibleTrigger asChild>
                      <Button className="w-full justify-start" variant="ghost">
                        <span
                          className="inline-grid h-4 w-4 flex-none place-items-center text-current transition-transform duration-150 before:h-[6px] before:w-[6px] before:rotate-45 before:border-b-[1.5px] before:border-r-[1.5px] before:border-current before:content-[''] data-[state=open]:rotate-180"
                          data-state={basicCollapsibleOpen ? 'open' : 'closed'}
                        />
                        {t('disclosure.expand')}
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-[var(--vds-space-2)] gap-[var(--vds-space-2)] bg-transparent p-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)] [&_p]:m-0">
                      <p>{t('disclosure.area')}</p>
                      <p>{t('disclosure.contents')}</p>
                      <div className="mt-[var(--vds-space-1)] flex flex-wrap gap-[var(--vds-space-2)]">
                        <Badge>{t('disclosure.badge1')}</Badge>
                        <Badge variant="secondary">{t('disclosure.badge2')}</Badge>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                </div>

                <div className="w-[min(420px,100%)]">
                  <Collapsible>
                    <CollapsibleTrigger asChild>
                      <Button className="w-full justify-between" variant="outline">
                        <span>{t('disclosure.faq')}</span>
                        <span className="inline-grid h-4 w-4 flex-none place-items-center text-current transition-transform duration-150 before:h-[6px] before:w-[6px] before:rotate-45 before:border-b-[1.5px] before:border-r-[1.5px] before:border-current before:content-[''] data-[state=open]:rotate-180" />
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-[var(--vds-space-2)] gap-[var(--vds-space-2)] bg-transparent p-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)] [&_p]:m-0">
                      <p className="font-[var(--vds-fw-medium)]">{t('disclosure.steps')}</p>
                      <ol className="m-0 grid gap-[var(--vds-space-1)] pl-[var(--vds-space-5)] text-[var(--vds-text-secondary)]">
                        <li>{t('disclosure.import')}</li>
                        <li>{t('disclosure.trigger')}</li>
                        <li>{t('disclosure.content')}</li>
                        <li>{t('disclosure.control')}</li>
                      </ol>
                    </CollapsibleContent>
                  </Collapsible>
                </div>

                <div className="grid w-[min(420px,100%)] gap-[var(--vds-space-2)]">
                  {collapsibleSettingsItems.map((item) => (
                    <Collapsible
                      animated
                      defaultOpen={item.titleKey === 'disclosure.account'}
                      key={item.titleKey}
                    >
                      <CollapsibleTrigger asChild>
                        <Button
                          className="h-auto w-full justify-between p-[var(--vds-space-3)]"
                          variant="ghost"
                        >
                          <span className="font-[var(--vds-fw-medium)]">{t(item.titleKey)}</span>
                          <span className="inline-grid h-4 w-4 flex-none place-items-center text-current transition-transform duration-150 before:h-[6px] before:w-[6px] before:rotate-45 before:border-b-[1.5px] before:border-r-[1.5px] before:border-current before:content-[''] data-[state=open]:rotate-180" />
                        </Button>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="mx-[var(--vds-space-3)] mb-[var(--vds-space-3)] mt-0 border-0 bg-transparent p-0 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
                        {t(item.contentKey)}
                      </CollapsibleContent>
                    </Collapsible>
                  ))}
                </div>
              </div>
            </section>

            <section className={exampleSectionClass('tabs', activeExample)} id="tabs">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Tabs
              </h2>
              <Tabs className="w-[min(448px,100%)]" defaultValue="account">
                <TabsList
                  aria-label={t('disclosure.tabLabel')}
                  className="w-full [&_.vds-tabs__trigger]:flex-1"
                >
                  <TabsTrigger value="account">{t('disclosure.accountTab')}</TabsTrigger>
                  <TabsTrigger value="password">{t('disclosure.passwordTab')}</TabsTrigger>
                  <TabsTrigger disabled value="disabled">
                    {t('disclosure.disabled')}
                  </TabsTrigger>
                </TabsList>
                <TabsContent className="mt-[var(--vds-space-4)]" value="account">
                  <div className="grid gap-[var(--vds-space-2)] [&_h4]:m-0 [&_h4]:text-[length:var(--vds-font-body-lv1)] [&_h4]:font-[var(--vds-fw-medium)] [&_h4]:leading-[var(--vds-lh-body-lv1)] [&_h4]:text-[var(--vds-text-primary)] [&_p]:m-0 [&_p]:text-[length:var(--vds-font-body-lv1)] [&_p]:leading-[var(--vds-lh-body-lv1)] [&_p]:text-[#64748b]">
                    <h4>{t('disclosure.account')}</h4>
                    <p>{t('disclosure.manage')}</p>
                  </div>
                </TabsContent>
                <TabsContent className="mt-[var(--vds-space-4)]" value="password">
                  <div className="grid gap-[var(--vds-space-2)] [&_h4]:m-0 [&_h4]:text-[length:var(--vds-font-body-lv1)] [&_h4]:font-[var(--vds-fw-medium)] [&_h4]:leading-[var(--vds-lh-body-lv1)] [&_h4]:text-[var(--vds-text-primary)] [&_p]:m-0 [&_p]:text-[length:var(--vds-font-body-lv1)] [&_p]:leading-[var(--vds-lh-body-lv1)] [&_p]:text-[#64748b]">
                    <h4>{t('disclosure.password')}</h4>
                    <p>{t('disclosure.security')}</p>
                  </div>
                </TabsContent>
                <TabsContent className="mt-[var(--vds-space-4)]" value="disabled">
                  <div className="grid gap-[var(--vds-space-2)] [&_h4]:m-0 [&_h4]:text-[length:var(--vds-font-body-lv1)] [&_h4]:font-[var(--vds-fw-medium)] [&_h4]:leading-[var(--vds-lh-body-lv1)] [&_h4]:text-[var(--vds-text-primary)] [&_p]:m-0 [&_p]:text-[length:var(--vds-font-body-lv1)] [&_p]:leading-[var(--vds-lh-body-lv1)] [&_p]:text-[#64748b]">
                    <h4>{t('disclosure.disabledTab')}</h4>
                    <p>{t('disclosure.disabledBody')}</p>
                  </div>
                </TabsContent>
              </Tabs>
            </section>

            <section className={exampleSectionClass('accordion', activeExample)} id="accordion">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Accordion
              </h2>
              <Accordion defaultValue="summary">
                <AccordionItem value="summary">
                  <AccordionTrigger>{t('controls.summary')}</AccordionTrigger>
                  <AccordionContent>{t('controls.summaryBody')}</AccordionContent>
                </AccordionItem>
                <AccordionItem value="detail">
                  <AccordionTrigger>{t('controls.details')}</AccordionTrigger>
                  <AccordionContent>{t('controls.single')}</AccordionContent>
                </AccordionItem>
                <AccordionItem disabled value="disabled">
                  <AccordionTrigger>{t('controls.disabled')}</AccordionTrigger>
                  <AccordionContent>{t('controls.disabledBody')}</AccordionContent>
                </AccordionItem>
              </Accordion>
              <Accordion defaultValue={['first']} mode="multiple">
                <AccordionItem value="first">
                  <AccordionTrigger>{t('controls.first')}</AccordionTrigger>
                  <AccordionContent>{t('controls.multiple')}</AccordionContent>
                </AccordionItem>
                <AccordionItem value="second">
                  <AccordionTrigger>{t('controls.second')}</AccordionTrigger>
                  <AccordionContent>{t('controls.collapse')}</AccordionContent>
                </AccordionItem>
              </Accordion>
            </section>

            <section className={exampleSectionClass('scroll-area', activeExample)} id="scroll-area">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                ScrollArea
              </h2>
              <ScrollArea
                className="max-h-[var(--vds-example-scroll-height)] max-w-[var(--vds-example-scroll-width)] border border-[var(--vds-border-default)] bg-[var(--vds-surface-raised)]"
                orientation="both"
                overlay
                shadow="auto"
              >
                <div className="w-[var(--vds-example-scroll-content-width)] p-[var(--vds-space-4)] text-[var(--vds-text-secondary)]">
                  {t('controls.scroll')}
                </div>
              </ScrollArea>
            </section>

            <section className={exampleSectionClass('slider', activeExample)} id="slider">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Slider
              </h2>
              <div className="grid w-[min(448px,100%)] gap-[var(--vds-space-6)]">
                <div className="grid gap-[var(--vds-space-3)]">
                  <Label>{t('controls.volume', { value: sliderVolume[0] })}</Label>
                  <Slider
                    className="w-full"
                    max={100}
                    step={1}
                    value={sliderVolume}
                    onValueChange={setSliderVolume}
                  />
                </div>

                <div className="grid gap-[var(--vds-space-3)]">
                  <Label>
                    {t('controls.price', { minimum: sliderPrice[0], maximum: sliderPrice[1] })}
                  </Label>
                  <Slider
                    className="w-full"
                    max={100}
                    step={1}
                    value={sliderPrice}
                    onValueChange={setSliderPrice}
                  />
                </div>

                <div className="grid gap-[var(--vds-space-3)]">
                  <Label>{t('controls.opacity')}</Label>
                  <Slider className="w-full" defaultValue={[80]} max={100} step={5} />
                </div>

                <div className="grid gap-[var(--vds-space-3)]">
                  <Label>{t('controls.disabledState')}</Label>
                  <Slider className="w-full" defaultValue={[30]} disabled max={100} step={1} />
                </div>
              </div>
            </section>

            <section className={exampleSectionClass('input-otp', activeExample)} id="input-otp">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                InputOTP
              </h2>
              <div className="grid gap-[var(--vds-space-3)]">
                <InputOTP
                  defaultValue="123"
                  description={t('controls.otpHelp')}
                  label={t('controls.otp')}
                />
                <InputOTP
                  defaultValue="AB"
                  inputMode="text"
                  label={t('controls.textCode')}
                  length={4}
                  separatorEvery={2}
                />
                <InputOTP error={t('controls.otpError')} invalid label={t('controls.errorState')} />
                <InputOTP
                  label={t('controls.controlled')}
                  maxLength={3}
                  value={otpValue}
                  onChange={setOtpValue}
                >
                  <InputOTPGroup>
                    <InputOTPSlot index={0} />
                    <InputOTPSlot index={1} />
                    <InputOTPSlot index={2} />
                  </InputOTPGroup>
                  <InputOTPSeparator />
                </InputOTP>
              </div>
            </section>

            <section className={exampleSectionClass('command', activeExample)} id="command">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Command
              </h2>
              <div className="grid gap-[var(--vds-space-8)]">
                <div className="grid gap-[var(--vds-space-4)] [&_.vds-examples__demo-title]:m-0 [&_.vds-examples__demo-title]:text-left">
                  <h3 className="m-0 mb-[var(--vds-space-4)] text-center text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('controls.commandBasic')}
                  </h3>
                  <Command
                    className="w-[min(448px,100%)] border border-[var(--vds-border-default)] shadow-[var(--vds-shadow-1-center)]"
                    defaultValue="calendar"
                  >
                    <CommandInput placeholder={t('controls.search')} />
                    <CommandList>
                      <CommandEmpty>{t('controls.noResults')}</CommandEmpty>
                      <CommandGroup heading={t('controls.suggestions')}>
                        <CommandItem keywords={['calendar']} value="calendar">
                          {CommandDemoIcon({ name: 'calendar' })}
                          <span>{t('controls.calendar')}</span>
                        </CommandItem>
                        <CommandItem keywords={['search emoji']} value="emoji">
                          {CommandDemoIcon({ name: 'search' })}
                          <span>{t('controls.emoji')}</span>
                        </CommandItem>
                        <CommandItem keywords={['calculator']} value="calculator">
                          {CommandDemoIcon({ name: 'calculator' })}
                          <span>{t('controls.calculator')}</span>
                        </CommandItem>
                      </CommandGroup>
                      <CommandSeparator />
                      <CommandGroup heading={t('controls.settings')}>
                        <CommandItem keywords={['profile']} value="profile">
                          {CommandDemoIcon({ name: 'user' })}
                          <span>{t('controls.profile')}</span>
                          <CommandShortcut>⌘P</CommandShortcut>
                        </CommandItem>
                        <CommandItem keywords={['billing']} value="billing">
                          {CommandDemoIcon({ name: 'card' })}
                          <span>{t('controls.billing')}</span>
                          <CommandShortcut>⌘B</CommandShortcut>
                        </CommandItem>
                        <CommandItem keywords={['settings']} value="settings">
                          {CommandDemoIcon({ name: 'settings' })}
                          <span>{t('controls.settings')}</span>
                          <CommandShortcut>⌘S</CommandShortcut>
                        </CommandItem>
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </div>

                <div className="grid gap-[var(--vds-space-4)] [&_.vds-examples__demo-title]:m-0 [&_.vds-examples__demo-title]:text-left">
                  <h3 className="m-0 mb-[var(--vds-space-4)] text-center text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('controls.commandDialog')}
                  </h3>
                  <Button
                    className="w-[min(256px,100%)] justify-start text-[var(--vds-text-tertiary)] [&_.vds-command__shortcut]:ml-auto"
                    variant="outline"
                    onClick={() => setCommandDialogOpen(true)}
                  >
                    {CommandDemoIcon({ name: 'search' })}
                    <span>{t('controls.searchCommands')}</span>
                    <CommandShortcut>⌘K</CommandShortcut>
                  </Button>
                  <CommandDialog open={commandDialogOpen} onOpenChange={setCommandDialogOpen}>
                    <CommandInput placeholder={t('controls.search')} />
                    <CommandList>
                      <CommandEmpty>{t('controls.noResults')}</CommandEmpty>
                      <CommandGroup heading={t('controls.quick')}>
                        <CommandItem keywords={['new document']} value="new-document">
                          {CommandDemoIcon({ name: 'plus' })}
                          <span>{t('controls.newDocument')}</span>
                          <CommandShortcut>⌘N</CommandShortcut>
                        </CommandItem>
                        <CommandItem keywords={['open file']} value="open-file">
                          {CommandDemoIcon({ name: 'file' })}
                          <span>{t('controls.openFile')}</span>
                          <CommandShortcut>⌘O</CommandShortcut>
                        </CommandItem>
                        <CommandItem keywords={['new folder']} value="new-folder">
                          {CommandDemoIcon({ name: 'folder' })}
                          <span>{t('controls.newFolder')}</span>
                          <CommandShortcut>⇧⌘N</CommandShortcut>
                        </CommandItem>
                      </CommandGroup>
                      <CommandSeparator />
                      <CommandGroup heading={t('controls.navigation')}>
                        <CommandItem keywords={['home']} value="home">
                          {CommandDemoIcon({ name: 'home' })}
                          <span>{t('controls.home')}</span>
                          <CommandShortcut>⌘H</CommandShortcut>
                        </CommandItem>
                        <CommandItem keywords={['profile']} value="profile-dialog">
                          {CommandDemoIcon({ name: 'user' })}
                          <span>{t('controls.profile')}</span>
                          <CommandShortcut>⌘P</CommandShortcut>
                        </CommandItem>
                        <CommandItem keywords={['messages']} value="messages">
                          {CommandDemoIcon({ name: 'mail' })}
                          <span>{t('controls.messages')}</span>
                          <CommandShortcut>⌘M</CommandShortcut>
                        </CommandItem>
                        <CommandItem keywords={['notifications']} value="notifications">
                          {CommandDemoIcon({ name: 'bell' })}
                          <span>{t('controls.notifications')}</span>
                        </CommandItem>
                      </CommandGroup>
                      <CommandSeparator />
                      <CommandGroup heading={t('controls.settings')}>
                        <CommandItem keywords={['preferences']} value="preferences">
                          {CommandDemoIcon({ name: 'settings' })}
                          <span>{t('controls.preferences')}</span>
                          <CommandShortcut>⌘,</CommandShortcut>
                        </CommandItem>
                        <CommandItem keywords={['billing payments']} value="billing-payments">
                          {CommandDemoIcon({ name: 'card' })}
                          <span>{t('controls.payments')}</span>
                        </CommandItem>
                      </CommandGroup>
                    </CommandList>
                  </CommandDialog>
                </div>
              </div>
            </section>

            <section
              className={exampleSectionClass('context-menu', activeExample)}
              id="context-menu"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                ContextMenu
              </h2>
              <div className="grid gap-[var(--vds-space-8)]">
                <div className="grid gap-[var(--vds-space-4)] [&_.vds-examples__demo-title]:m-0 [&_.vds-examples__demo-title]:text-left">
                  <h3 className="m-0 mb-[var(--vds-space-4)] text-center text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('menus.contextBasic')}
                  </h3>
                  <ContextMenu>
                    <ContextMenuTrigger className="flex h-32 w-full cursor-context-menu flex-col items-center justify-center border-dashed bg-[var(--vds-bg-white-default)]">
                      <span className="text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)]">
                        {t('menus.rightClick')}
                      </span>
                      <span className="mt-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
                        {t('menus.viewBasic')}
                      </span>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="![width:16rem]">
                      <ContextMenuItem>
                        {CommandDemoIcon({ name: 'copy' })}
                        <span>{t('menus.copy')}</span>
                        <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem>
                        {CommandDemoIcon({ name: 'scissors' })}
                        <span>{t('menus.cut')}</span>
                        <ContextMenuShortcut>⌘X</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuItem>
                        {CommandDemoIcon({ name: 'clipboard' })}
                        <span>{t('menus.paste')}</span>
                        <ContextMenuShortcut>⌘V</ContextMenuShortcut>
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem>
                        {CommandDemoIcon({ name: 'settings' })}
                        <span>{t('menus.settings')}</span>
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </div>

                <div className="grid gap-[var(--vds-space-4)] [&_.vds-examples__demo-title]:m-0 [&_.vds-examples__demo-title]:text-left">
                  <h3 className="m-0 mb-[var(--vds-space-4)] text-center text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('menus.fileMenu')}
                  </h3>
                  <div className="grid grid-cols-2 gap-[var(--vds-space-4)]">
                    <ContextMenu>
                      <ContextMenuTrigger className="grid min-h-[136px] cursor-context-menu justify-items-center gap-[var(--vds-space-1)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-4)] hover:bg-[var(--vds-bg-white-hover)]">
                        <span className="mb-[var(--vds-space-1)] inline-flex h-[42px] w-[42px] items-center justify-center rounded-[var(--vds-radius-3)] bg-[var(--vds-brand-light-bg-default)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-medium)] text-[var(--vds-brand-text-primary)]">
                          PDF
                        </span>
                        <span className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                          document.pdf
                        </span>
                        <span className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
                          245 KB
                        </span>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="![width:16rem]">
                        <ContextMenuItem>
                          {CommandDemoIcon({ name: 'eye' })}
                          <span>{t('menus.open')}</span>
                        </ContextMenuItem>
                        <ContextMenuItem>
                          {CommandDemoIcon({ name: 'edit' })}
                          <span>{t('menus.edit')}</span>
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem>
                          {CommandDemoIcon({ name: 'copy' })}
                          <span>{t('menus.copy')}</span>
                          <ContextMenuShortcut>⌘C</ContextMenuShortcut>
                        </ContextMenuItem>
                        <ContextMenuItem>
                          {CommandDemoIcon({ name: 'download' })}
                          <span>{t('menus.download')}</span>
                        </ContextMenuItem>
                        <ContextMenuItem>
                          {CommandDemoIcon({ name: 'share' })}
                          <span>{t('menus.share')}</span>
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuCheckboxItem
                          checked={contextBookmarked}
                          onCheckedChange={setContextBookmarked}
                        >
                          {CommandDemoIcon({ name: 'bookmark' })}
                          <span>{t('menus.bookmark')}</span>
                        </ContextMenuCheckboxItem>
                        <ContextMenuCheckboxItem
                          checked={contextStarred}
                          onCheckedChange={setContextStarred}
                        >
                          {CommandDemoIcon({ name: 'star' })}
                          <span>{t('menus.star')}</span>
                        </ContextMenuCheckboxItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem
                          destructive
                          className="[&_.vds-examples__command-icon]:text-current [&_.vds-menu__shortcut]:text-current"
                        >
                          {CommandDemoIcon({ name: 'trash' })}
                          <span>{t('delete.confirm')}</span>
                          <ContextMenuShortcut>⌦</ContextMenuShortcut>
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>

                    <ContextMenu>
                      <ContextMenuTrigger className="grid min-h-[136px] cursor-context-menu justify-items-center gap-[var(--vds-space-1)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-4)] hover:bg-[var(--vds-bg-white-hover)]">
                        <span className="mb-[var(--vds-space-1)] inline-flex h-[42px] w-[42px] items-center justify-center rounded-[var(--vds-radius-3)] bg-[var(--vds-brand-light-bg-default)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-medium)] text-[var(--vds-brand-text-primary)]">
                          IMG
                        </span>
                        <span className="text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                          photo.jpg
                        </span>
                        <span className="text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
                          1.2 MB
                        </span>
                      </ContextMenuTrigger>
                      <ContextMenuContent className="![width:16rem]">
                        <ContextMenuItem>
                          {CommandDemoIcon({ name: 'eye' })}
                          <span>{t('menus.preview')}</span>
                        </ContextMenuItem>
                        <ContextMenuItem>
                          {CommandDemoIcon({ name: 'edit' })}
                          <span>{t('menus.edit')}</span>
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem>
                          {CommandDemoIcon({ name: 'copy' })}
                          <span>{t('menus.copyImage')}</span>
                        </ContextMenuItem>
                        <ContextMenuItem>
                          {CommandDemoIcon({ name: 'download' })}
                          <span>{t('menus.saveLocal')}</span>
                        </ContextMenuItem>
                        <ContextMenuSub>
                          <ContextMenuSubTrigger>
                            {CommandDemoIcon({ name: 'share' })}
                            <span>{t('menus.shareTo')}</span>
                          </ContextMenuSubTrigger>
                          <ContextMenuSubContent className="![width:12rem]">
                            <ContextMenuItem>{t('menus.email')}</ContextMenuItem>
                            <ContextMenuItem>{t('menus.wechat')}</ContextMenuItem>
                            <ContextMenuItem>QQ</ContextMenuItem>
                            <ContextMenuItem>{t('menus.weibo')}</ContextMenuItem>
                          </ContextMenuSubContent>
                        </ContextMenuSub>
                        <ContextMenuSeparator />
                        <ContextMenuItem>
                          {CommandDemoIcon({ name: 'archive' })}
                          <span>{t('menus.trash')}</span>
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  </div>
                </div>
              </div>
            </section>

            <section className={exampleSectionClass('dialog', activeExample)} id="dialog">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Dialog
              </h2>
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                <Dialog>
                  <DialogTrigger asChild>
                    <Button>{t('menus.openDialog')}</Button>
                  </DialogTrigger>
                  <DialogContent
                    aria-label={t('menus.projectSettings')}
                    headerLayout="aligned"
                    portalClassName="z-[var(--vds-z-modal-interaction)]"
                  >
                    <DialogHeader>
                      <DialogTitle>{t('menus.projectSettings')}</DialogTitle>
                      <DialogDescription>{t('menus.dialogDescription')}</DialogDescription>
                    </DialogHeader>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="secondary">{t('menus.openDialog')}</Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem>{t('menus.confirm')}</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button variant="outline">{t('delete.cancel')}</Button>
                      </DialogClose>
                      <DialogClose asChild>
                        <Button>{t('menus.confirm')}</Button>
                      </DialogClose>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <Dialog>
                  <DialogTrigger asChild>
                    <Button variant="outline">{t('menus.hideClose')}</Button>
                  </DialogTrigger>
                  <DialogContent
                    hideCloseButton
                    overlayClassName="bg-black/40"
                    aria-label={t('menus.compatibility')}
                  >
                    <DialogHeader>
                      <DialogTitle>{t('menus.compatibilityTitle')}</DialogTitle>
                      <DialogDescription>{t('menus.compatibilityDescription')}</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <DialogClose asChild>
                        <Button variant="secondary">{t('menus.customClose')}</Button>
                      </DialogClose>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </section>

            <section
              className={exampleSectionClass('dropdown-menu', activeExample)}
              id="dropdown-menu"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                DropdownMenu
              </h2>
              <div className="flex flex-wrap items-center gap-[var(--vds-space-4)]">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline">{t('menus.openMenu')}</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="center" className="![width:14rem]">
                    <DropdownMenuLabel>{t('menus.myAccount')}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuItem>
                        <span>{t('menus.profile')}</span>
                        <DropdownMenuShortcut>⇧⌘P</DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuItem>
                        <span>{t('disclosure.account')}</span>
                        <DropdownMenuShortcut>⌘S</DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuItem>
                        <span>{t('menus.shortcuts')}</span>
                        <DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem>{t('menus.team')}</DropdownMenuItem>
                    <DropdownMenuItem>{t('menus.invite')}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem>
                      <span>{t('menus.signOut')}</span>
                      <DropdownMenuShortcut>⇧⌘Q</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button>{t('menus.actions')}</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="center" className="![width:12rem]">
                    <DropdownMenuItem>{t('menus.details')}</DropdownMenuItem>
                    <DropdownMenuItem>{t('menus.edit')}</DropdownMenuItem>
                    <DropdownMenuItem>{t('menus.copy')}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem destructive>{t('delete.confirm')}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost">
                      ⋮
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="center" className="![width:10rem]">
                    <DropdownMenuItem>{t('menus.share')}</DropdownMenuItem>
                    <DropdownMenuItem>{t('menus.bookmark')}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem>{t('menus.report')}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </section>

            <section className={exampleSectionClass('hover-card', activeExample)} id="hover-card">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                HoverCard
              </h2>
              <div className="grid gap-[var(--vds-space-8)]">
                <div>
                  <h3 className="m-0 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('menus.hoverBasic')}
                  </h3>
                  <HoverCard>
                    <HoverCardTrigger asChild>
                      <Button variant="link">@shadcn</Button>
                    </HoverCardTrigger>
                    <HoverCardContent className="w-80 p-[var(--vds-space-4)] block [&_.vds-examples__hover-card-row]:items-start [&_.vds-examples__hover-card-row]:justify-between">
                      <div className="flex items-center gap-[var(--vds-space-4)]">
                        <Avatar>
                          <AvatarImage alt="@shadcn" src="https://github.com/shadcn.png" />
                          <AvatarFallback>SC</AvatarFallback>
                        </Avatar>
                        <div className="grid min-w-0 gap-[var(--vds-space-1)]">
                          <h4 className="m-0 text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-semibold)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]">
                            @shadcn
                          </h4>
                          <p className="m-0 mt-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]">
                            The React framework - created and maintained by @vercel.
                          </p>
                          <div className="inline-flex min-w-0 items-center gap-[var(--vds-space-1)] pt-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-tertiary)] [&_.vds-examples__command-icon]:mr-0 [&_.vds-examples__command-icon]:h-4 [&_.vds-examples__command-icon]:w-4 [&_.vds-examples__command-icon]:opacity-70">
                            <CommandDemoIcon name="calendar" />
                            <span>Joined December 2021</span>
                          </div>
                        </div>
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                </div>

                <div>
                  <h3 className="m-0 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('menus.profileCard')}
                  </h3>
                  <div className="grid justify-items-center gap-[var(--vds-space-4)] text-center">
                    <p className="m-0 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
                      {t('menus.hoverHelp')}
                    </p>
                    <HoverCard>
                      <HoverCardTrigger asChild>
                        <Avatar className="cursor-pointer">
                          <AvatarImage alt="Vercel" src="https://github.com/vercel.png" />
                          <AvatarFallback>VL</AvatarFallback>
                        </Avatar>
                      </HoverCardTrigger>
                      <HoverCardContent className="w-80 p-[var(--vds-space-4)] block">
                        <div className="grid min-w-0 gap-[var(--vds-space-1)]">
                          <div className="flex items-center gap-[var(--vds-space-4)]">
                            <Avatar>
                              <AvatarImage alt="Vercel" src="https://github.com/vercel.png" />
                              <AvatarFallback>VL</AvatarFallback>
                            </Avatar>
                            <div>
                              <h4 className="m-0 text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-semibold)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]">
                                Vercel
                              </h4>
                              <p className="m-0 mt-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-tertiary)]">
                                @vercel
                              </p>
                            </div>
                          </div>
                          <p className="m-0 mt-[var(--vds-space-1)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]">
                            Vercel is the platform for frontend developers, providing the speed and
                            reliability innovators need to create at the moment of inspiration.
                          </p>
                          <div className="mt-[var(--vds-space-1)] flex flex-wrap items-center gap-[var(--vds-space-4)] [&_.vds-examples__hover-card-meta-row]:pt-0 [&_.vds-examples__hover-card-meta-row]:text-[length:var(--vds-font-body-lv1)] [&_.vds-examples__hover-card-meta-row]:leading-[var(--vds-lh-body-lv1)]">
                            <span className="inline-flex min-w-0 items-center gap-[var(--vds-space-1)] pt-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-tertiary)] [&_.vds-examples__command-icon]:mr-0 [&_.vds-examples__command-icon]:h-4 [&_.vds-examples__command-icon]:w-4 [&_.vds-examples__command-icon]:opacity-70">
                              <CommandDemoIcon name="users" />
                              2.3k followers
                            </span>
                            <span className="inline-flex min-w-0 items-center gap-[var(--vds-space-1)] pt-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-tertiary)] [&_.vds-examples__command-icon]:mr-0 [&_.vds-examples__command-icon]:h-4 [&_.vds-examples__command-icon]:w-4 [&_.vds-examples__command-icon]:opacity-70">
                              <CommandDemoIcon name="star" />
                              1.2k stars
                            </span>
                          </div>
                          <div className="inline-flex min-w-0 items-center gap-[var(--vds-space-1)] pt-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-tertiary)] [&_.vds-examples__command-icon]:mr-0 [&_.vds-examples__command-icon]:h-4 [&_.vds-examples__command-icon]:w-4 [&_.vds-examples__command-icon]:opacity-70">
                            <CommandDemoIcon name="mapPin" />
                            San Francisco, CA
                          </div>
                          <div className="inline-flex min-w-0 items-center gap-[var(--vds-space-1)] pt-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-text-tertiary)] [&_.vds-examples__command-icon]:mr-0 [&_.vds-examples__command-icon]:h-4 [&_.vds-examples__command-icon]:w-4 [&_.vds-examples__command-icon]:opacity-70">
                            <CommandDemoIcon name="link" />
                            <span className="underline underline-offset-2">vercel.com</span>
                          </div>
                        </div>
                      </HoverCardContent>
                    </HoverCard>
                  </div>
                </div>
              </div>
            </section>

            <section className={exampleSectionClass('menubar', activeExample)} id="menubar">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Menubar
              </h2>
              <div className="grid gap-[var(--vds-space-8)]">
                <div>
                  <h3 className="m-0 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('menus.menubar')}
                  </h3>
                  <Menubar>
                    <MenubarMenu>
                      <MenubarTrigger>{t('menus.file')}</MenubarTrigger>
                      <MenubarContent>
                        <MenubarItem>
                          {t('menus.new')} <MenubarShortcut>⌘T</MenubarShortcut>
                        </MenubarItem>
                        <MenubarItem>
                          {t('menus.open')} <MenubarShortcut>⌘O</MenubarShortcut>
                        </MenubarItem>
                        <MenubarSeparator />
                        <MenubarItem>{t('menus.save')}</MenubarItem>
                        <MenubarItem>{t('menus.saveAs')}</MenubarItem>
                        <MenubarSeparator />
                        <MenubarItem>{t('menus.quit')}</MenubarItem>
                      </MenubarContent>
                    </MenubarMenu>
                    <MenubarMenu>
                      <MenubarTrigger>{t('menus.edit')}</MenubarTrigger>
                      <MenubarContent>
                        <MenubarItem>
                          {t('menus.undo')} <MenubarShortcut>⌘Z</MenubarShortcut>
                        </MenubarItem>
                        <MenubarItem>
                          {t('menus.redo')} <MenubarShortcut>⇧⌘Z</MenubarShortcut>
                        </MenubarItem>
                        <MenubarSeparator />
                        <MenubarItem>
                          {t('menus.cut')} <MenubarShortcut>⌘X</MenubarShortcut>
                        </MenubarItem>
                        <MenubarItem>
                          {t('menus.copy')} <MenubarShortcut>⌘C</MenubarShortcut>
                        </MenubarItem>
                        <MenubarItem>
                          {t('menus.paste')} <MenubarShortcut>⌘V</MenubarShortcut>
                        </MenubarItem>
                      </MenubarContent>
                    </MenubarMenu>
                    <MenubarMenu>
                      <MenubarTrigger>{t('menus.view')}</MenubarTrigger>
                      <MenubarContent>
                        <MenubarCheckboxItem
                          checked={showBookmarks}
                          onCheckedChange={setShowBookmarks}
                        >
                          {t('menus.showBookmarks')}
                        </MenubarCheckboxItem>
                        <MenubarCheckboxItem checked={showUrls} onCheckedChange={setShowUrls}>
                          {t('menus.showUrls')}
                        </MenubarCheckboxItem>
                        <MenubarSeparator />
                        <MenubarRadioGroup value={menubarTheme} onValueChange={setMenubarTheme}>
                          <MenubarLabel>{t('menus.theme')}</MenubarLabel>
                          <MenubarRadioItem value="light">{t('menus.light')}</MenubarRadioItem>
                          <MenubarRadioItem value="dark">{t('menus.dark')}</MenubarRadioItem>
                          <MenubarRadioItem value="auto">{t('menus.system')}</MenubarRadioItem>
                        </MenubarRadioGroup>
                      </MenubarContent>
                    </MenubarMenu>
                  </Menubar>
                </div>
              </div>
            </section>

            <section
              className={exampleSectionClass('navigation-menu', activeExample)}
              id="navigation-menu"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                NavigationMenu
              </h2>
              <div className="min-h-80">
                <NavigationMenu>
                  <NavigationMenuList>
                    <NavigationMenuItem>
                      <NavigationMenuLink href="/" className={navigationMenuTriggerStyle()}>
                        {t('menus.home')}
                      </NavigationMenuLink>
                    </NavigationMenuItem>

                    <NavigationMenuItem>
                      <NavigationMenuTrigger>
                        <IconFont className="h-4 w-4 text-base leading-none" type="line-tool-box" />
                        {t('menus.products')}
                      </NavigationMenuTrigger>
                      <NavigationMenuContent>
                        <div className="grid w-[min(500px,calc(100vw-48px))] grid-cols-[0.75fr_1fr] gap-[var(--vds-space-3)] p-[var(--vds-space-6)]">
                          <div className="row-span-3">
                            <NavigationMenuLink asChild>
                              <a
                                className="flex h-full min-h-[180px] w-full flex-col justify-end rounded-[var(--vds-radius-3)] bg-[linear-gradient(180deg,var(--vds-bg-white-hover),var(--vds-bg-white-active))] p-[var(--vds-space-6)] text-[var(--vds-text-primary)] no-underline hover:shadow-[var(--vds-shadow-focus)] hover:outline-none focus-visible:shadow-[var(--vds-shadow-focus)] focus-visible:outline-none"
                                href="/"
                              >
                                <IconFont
                                  className="h-6 w-6 text-2xl leading-none"
                                  type="line-tool-flash"
                                />
                                <div className="mb-[var(--vds-space-2)] mt-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)]">
                                  DI-FEBase
                                </div>
                                <p className="m-0 text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
                                  {t('menus.template')}
                                </p>
                              </a>
                            </NavigationMenuLink>
                          </div>
                          <NavigationListItem href="/docs" title={t('menus.web')}>
                            {t('menus.webDescription')}
                          </NavigationListItem>
                          <NavigationListItem href="/docs/installation" title={t('menus.mobile')}>
                            {t('menus.mobileDescription')}
                          </NavigationListItem>
                          <NavigationListItem
                            href="/docs/primitives/typography"
                            title={t('menus.desktop')}
                          >
                            {t('menus.desktopDescription')}
                          </NavigationListItem>
                        </div>
                      </NavigationMenuContent>
                    </NavigationMenuItem>

                    <NavigationMenuItem>
                      <NavigationMenuLink href="/support" className={navigationMenuTriggerStyle()}>
                        <IconFont
                          className="h-4 w-4 text-base leading-none"
                          type="a-line-status-help"
                        />
                        {t('menus.support')}
                      </NavigationMenuLink>
                    </NavigationMenuItem>

                    <NavigationMenuItem>
                      <NavigationMenuLink href="/settings" className={navigationMenuTriggerStyle()}>
                        <IconFont
                          className="h-4 w-4 text-base leading-none"
                          type="line-tool-setting"
                        />
                        {t('menus.settings')}
                      </NavigationMenuLink>
                    </NavigationMenuItem>
                  </NavigationMenuList>
                </NavigationMenu>
              </div>
            </section>

            <section
              className={exampleSectionClass('navigation-tabs', activeExample)}
              id="navigation-tabs"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                NavigationTabs
              </h2>
              <div className="grid gap-[var(--vds-space-6)]">
                <NavigationTabs
                  className="w-full"
                  trailing={
                    <IconButton
                      icon={<IconFont type="line-operation-add" />}
                      label={t('elements.iconAction')}
                      variant="ghost"
                    />
                  }
                  defaultIcon={<IconFont type="line-operation-addfile" />}
                  onClose={closeNavigationTab}
                  onValueChange={setNavigationTabsValue}
                  onReorder={reorderNavigationTabs}
                  overviewIcon={<IconFont type="line-tool-QRcode" />}
                  tabs={localizedNavigationTabsItems}
                  value={navigationTabsValue}
                />
                <NavigationTabsMenu
                  tabs={localizedNavigationTabsItems}
                  value={navigationTabsValue}
                  onValueChange={setNavigationTabsValue}
                />
                <div className="w-[420px] max-w-full">
                  <NavigationTabs
                    appearance="underline"
                    defaultIcon={<IconFont type="line-operation-addfile" />}
                    onClose={closeNavigationTab}
                    onValueChange={setNavigationTabsValue}
                    onReorder={reorderNavigationTabs}
                    overviewIcon={<IconFont type="line-tool-QRcode" />}
                    tabs={localizedNavigationTabsItems}
                    value={navigationTabsValue}
                  />
                </div>
              </div>
            </section>

            <section className={exampleSectionClass('popover', activeExample)} id="popover">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Popover
              </h2>
              <div className="grid gap-[var(--vds-space-8)]">
                <div className="grid justify-items-center gap-[var(--vds-space-4)] text-center">
                  <h3 className="m-0 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('interaction.basic')}
                  </h3>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline">{t('interaction.open')}</Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-80 text-left">
                      <div className="grid gap-[var(--vds-space-4)]">
                        <div className="grid gap-[var(--vds-space-2)] [&_h4]:m-0 [&_h4]:text-[length:var(--vds-font-body-lv1)] [&_h4]:font-[var(--vds-fw-medium)] [&_h4]:leading-none [&_h4]:text-[var(--vds-text-primary)] [&_p]:m-0 [&_p]:text-[length:var(--vds-font-body-lv1)] [&_p]:leading-[var(--vds-lh-body-lv1)] [&_p]:text-[var(--vds-text-secondary)]">
                          <h4>{t('interaction.dimensions')}</h4>
                          <p>{t('interaction.dimensionsBody')}</p>
                        </div>
                        <div className="grid gap-[var(--vds-space-2)]">
                          <div className="grid grid-cols-[1fr_2fr] items-center gap-[var(--vds-space-4)]">
                            <Label htmlFor="popover-width">{t('interaction.width')}</Label>
                            <Input
                              id="popover-width"
                              className="min-w-0"
                              defaultValue="100%"
                              size="sm"
                            />
                          </div>
                          <div className="grid grid-cols-[1fr_2fr] items-center gap-[var(--vds-space-4)]">
                            <Label htmlFor="popover-height">{t('interaction.height')}</Label>
                            <Input
                              id="popover-height"
                              className="min-w-0"
                              defaultValue="25px"
                              size="sm"
                            />
                          </div>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="grid justify-items-center gap-[var(--vds-space-4)] text-center">
                  <h3 className="m-0 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('interaction.settingsPopover')}
                  </h3>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" icon={<IconFont type="line-tool-setting" />}>
                        {t('interaction.settings')}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-80 text-left">
                      <div className="grid gap-[var(--vds-space-4)]">
                        <div className="grid gap-[var(--vds-space-2)] [&_h4]:m-0 [&_h4]:text-[length:var(--vds-font-body-lv1)] [&_h4]:font-[var(--vds-fw-medium)] [&_h4]:leading-none [&_h4]:text-[var(--vds-text-primary)] [&_p]:m-0 [&_p]:text-[length:var(--vds-font-body-lv1)] [&_p]:leading-[var(--vds-lh-body-lv1)] [&_p]:text-[var(--vds-text-secondary)]">
                          <h4>{t('interaction.display')}</h4>
                          <p>{t('interaction.displayBody')}</p>
                        </div>
                        <div className="grid gap-[var(--vds-space-3)]">
                          <label
                            className="flex items-center justify-between gap-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)] [&_input[type=checkbox]]:h-4 [&_input[type=checkbox]]:w-4 [&_input[type=checkbox]]:accent-[var(--vds-brand-6)]"
                            htmlFor="dark-mode"
                          >
                            <span>{t('interaction.dark')}</span>
                            <input id="dark-mode" title={t('interaction.dark')} type="checkbox" />
                          </label>
                          <label
                            className="flex items-center justify-between gap-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)] [&_input[type=checkbox]]:h-4 [&_input[type=checkbox]]:w-4 [&_input[type=checkbox]]:accent-[var(--vds-brand-6)]"
                            htmlFor="notifications"
                          >
                            <span>{t('interaction.notifications')}</span>
                            <input
                              defaultChecked
                              id="notifications"
                              title={t('interaction.notifications')}
                              type="checkbox"
                            />
                          </label>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="grid justify-items-center gap-[var(--vds-space-4)] text-center">
                  <h3 className="m-0 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('interaction.controlled')}
                  </h3>
                  <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        icon={<IconFont type="line-operation-filter-shape" />}
                      >
                        {t('interaction.options')}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent trapFocus autoFocus className="w-80 text-left">
                      <div className="grid gap-[var(--vds-space-4)]">
                        <div className="grid gap-[var(--vds-space-2)] [&_h4]:m-0 [&_h4]:text-[length:var(--vds-font-body-lv1)] [&_h4]:font-[var(--vds-fw-medium)] [&_h4]:leading-none [&_h4]:text-[var(--vds-text-primary)] [&_p]:m-0 [&_p]:text-[length:var(--vds-font-body-lv1)] [&_p]:leading-[var(--vds-lh-body-lv1)] [&_p]:text-[var(--vds-text-secondary)]">
                          <h4>{t('interaction.advanced')}</h4>
                          <p>{t('interaction.controlledBody')}</p>
                        </div>
                        <div className="grid gap-[var(--vds-space-3)]">
                          <label
                            className="flex items-center justify-between gap-[var(--vds-space-4)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)] [&_input[type=checkbox]]:h-4 [&_input[type=checkbox]]:w-4 [&_input[type=checkbox]]:accent-[var(--vds-brand-6)]"
                            htmlFor="debug-mode"
                          >
                            <span>{t('interaction.debug')}</span>
                            <input id="debug-mode" title={t('interaction.debug')} type="checkbox" />
                          </label>
                          <div className="grid grid-cols-[1fr_2fr] items-center gap-[var(--vds-space-4)]">
                            <Label>{t('interaction.timeout')}</Label>
                            <Input
                              className="min-w-0"
                              defaultValue="5000"
                              placeholder={t('interaction.milliseconds')}
                              size="sm"
                            />
                          </div>
                        </div>
                        <div className="flex justify-end gap-[var(--vds-space-2)]">
                          <Button size="sm" variant="outline" onClick={() => setPopoverOpen(false)}>
                            {t('interaction.close')}
                          </Button>
                          <Button size="sm" onClick={() => setPopoverOpen(false)}>
                            {t('interaction.apply')}
                          </Button>
                        </div>
                      </div>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
            </section>

            <section className={exampleSectionClass('resizable', activeExample)} id="resizable">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Resizable
              </h2>
              <div className="grid gap-[var(--vds-space-8)]">
                <div className="relative h-[var(--vds-space-10)]">
                  <output>{resizeOffset}</output>
                  <ResizableHandle
                    aria-label={t('interaction.columns')}
                    appearance="invisible"
                    className="!absolute inset-y-0 left-1/2 !h-auto !w-[var(--vds-space-3)]"
                    onOffsetChange={setResizeOffset}
                  />
                </div>
                <div>
                  <h3 className="m-0 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('interaction.columns')}
                  </h3>
                  <div className="h-[300px] overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)]">
                    <ResizablePanel
                      animated
                      leftPanel={
                        <div className="flex h-full w-full items-center justify-center p-[var(--vds-space-6)] [&_span]:font-[var(--vds-fw-semibold)] [&_span]:text-[var(--vds-text-primary)] [&_div]:text-[length:var(--vds-font-body-lv1)] [&_div]:leading-[var(--vds-lh-body-lv1)] [&_div]:text-[var(--vds-text-secondary)] bg-[var(--vds-bg-white-hover)]">
                          <span>{t('interaction.leftPanel')}</span>
                        </div>
                      }
                      leftWidth="50%"
                      rightPanel={
                        <div className="flex h-full w-full items-center justify-center p-[var(--vds-space-6)] [&_span]:font-[var(--vds-fw-semibold)] [&_span]:text-[var(--vds-text-primary)] [&_div]:text-[length:var(--vds-font-body-lv1)] [&_div]:leading-[var(--vds-lh-body-lv1)] [&_div]:text-[var(--vds-text-secondary)]">
                          <span>{t('interaction.rightPanel')}</span>
                        </div>
                      }
                    />
                  </div>
                </div>

                <div>
                  <h3 className="m-0 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('interaction.fixedSidebar')}
                  </h3>
                  <div className="h-[300px] overflow-hidden rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)]">
                    <ResizablePanel
                      leftPanel={
                        <div className="flex h-full w-full items-center justify-center p-[var(--vds-space-6)] [&_span]:font-[var(--vds-fw-semibold)] [&_span]:text-[var(--vds-text-primary)] [&_div]:text-[length:var(--vds-font-body-lv1)] [&_div]:leading-[var(--vds-lh-body-lv1)] [&_div]:text-[var(--vds-text-secondary)] bg-[var(--vds-bg-white-hover)] flex-col gap-[var(--vds-space-2)] p-[var(--vds-space-4)] text-center">
                          <span>{t('interaction.sidebar')}</span>
                          <div>{t('interaction.initialWidth')}</div>
                        </div>
                      }
                      leftWidth="250px"
                      rightPanel={
                        <div className="flex h-full w-full items-center justify-center p-[var(--vds-space-6)] [&_span]:font-[var(--vds-fw-semibold)] [&_span]:text-[var(--vds-text-primary)] [&_div]:text-[length:var(--vds-font-body-lv1)] [&_div]:leading-[var(--vds-lh-body-lv1)] [&_div]:text-[var(--vds-text-secondary)]">
                          <span>{t('interaction.mainContent')}</span>
                        </div>
                      }
                    />
                  </div>
                </div>
              </div>
            </section>

            <section
              className={exampleSectionClass('toggle-group', activeExample)}
              id="toggle-group"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Toggle and ToggleGroup
              </h2>
              <div className="grid gap-[var(--vds-space-8)]">
                <div>
                  <h3 className="m-0 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('interaction.toggle')}
                  </h3>
                  <div className="flex flex-wrap items-center gap-[var(--vds-space-2)] [&_.vds-examples__command-icon]:mr-0 [&_.vds-examples__command-icon]:h-4 [&_.vds-examples__command-icon]:w-4">
                    <Toggle
                      aria-label={t('interaction.italic')}
                      pressed={togglePressed}
                      onPressedChange={setTogglePressed}
                    >
                      <CommandDemoIcon name="italic" />
                    </Toggle>
                    <span className="m-0 mt-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
                      {t(togglePressed ? 'interaction.active' : 'interaction.inactive')}
                    </span>
                  </div>
                </div>

                <div>
                  <h3 className="m-0 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('interaction.styles')}
                  </h3>
                  <div className="flex flex-wrap items-center gap-[var(--vds-space-2)] [&_.vds-examples__command-icon]:mr-0 [&_.vds-examples__command-icon]:h-4 [&_.vds-examples__command-icon]:w-4">
                    <Toggle aria-label={t('interaction.defaultToggle')} variant="secondary">
                      <CommandDemoIcon name="bold" />
                    </Toggle>
                    <Toggle aria-label={t('interaction.outlineToggle')} variant="outline">
                      <CommandDemoIcon name="italic" />
                    </Toggle>
                    <Toggle aria-label={t('interaction.smallToggle')} size="sm">
                      <CommandDemoIcon name="underline" />
                    </Toggle>
                    <Toggle aria-label={t('interaction.largeToggle')} size="lg">
                      <CommandDemoIcon name="type" />
                    </Toggle>
                  </div>
                </div>

                <div>
                  <h3 className="m-0 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('interaction.formatting')}
                  </h3>
                  <ToggleGroup
                    type="multiple"
                    value={textFormatting}
                    onValueChange={(value) =>
                      setTextFormatting(Array.isArray(value) ? value : [value])
                    }
                  >
                    <ToggleGroupItem aria-label={t('interaction.bold')} value="bold">
                      <CommandDemoIcon name="bold" />
                    </ToggleGroupItem>
                    <ToggleGroupItem aria-label={t('interaction.italic')} value="italic">
                      <CommandDemoIcon name="italic" />
                    </ToggleGroupItem>
                    <ToggleGroupItem aria-label={t('interaction.underline')} value="underline">
                      <CommandDemoIcon name="underline" />
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <p className="m-0 mt-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
                    {t('interaction.selected', {
                      value: textFormatting.join(', ') || t('interaction.none'),
                    })}
                  </p>
                </div>

                <div>
                  <h3 className="m-0 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('interaction.alignment')}
                  </h3>
                  <ToggleGroup
                    type="single"
                    value={alignment}
                    onValueChange={(value) =>
                      setAlignment(Array.isArray(value) ? (value[0] ?? '') : value)
                    }
                  >
                    <ToggleGroupItem aria-label={t('interaction.left')} value="left">
                      <CommandDemoIcon name="alignLeft" />
                    </ToggleGroupItem>
                    <ToggleGroupItem aria-label={t('interaction.center')} value="center">
                      <CommandDemoIcon name="alignCenter" />
                    </ToggleGroupItem>
                    <ToggleGroupItem aria-label={t('interaction.right')} value="right">
                      <CommandDemoIcon name="alignRight" />
                    </ToggleGroupItem>
                    <ToggleGroupItem aria-label={t('interaction.justify')} value="justify">
                      <CommandDemoIcon name="alignJustify" />
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <p className="m-0 mt-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)]">
                    {t('interaction.currentAlignment', {
                      value: alignment || t('interaction.none'),
                    })}
                  </p>
                </div>

                <div>
                  <h3 className="m-0 text-[length:var(--vds-font-body-lv2)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-primary)]">
                    {t('interaction.disabled')}
                  </h3>
                  <div className="flex flex-wrap items-center gap-[var(--vds-space-2)] [&_.vds-examples__command-icon]:mr-0 [&_.vds-examples__command-icon]:h-4 [&_.vds-examples__command-icon]:w-4">
                    <Toggle aria-label={t('interaction.disabledToggle')} disabled>
                      <CommandDemoIcon name="bold" />
                    </Toggle>
                    <Toggle aria-label={t('interaction.disabledPressed')} disabled pressed>
                      <CommandDemoIcon name="italic" />
                    </Toggle>
                    <span className="m-0 mt-[var(--vds-space-2)] text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)] text-[var(--vds-text-tertiary)]">
                      {t('interaction.disabledBody')}
                    </span>
                  </div>
                </div>
              </div>
            </section>

            <section className={exampleSectionClass('tooltip', activeExample)} id="tooltip">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Tooltip
              </h2>
              <TooltipProvider>
                <div className="flex flex-wrap items-center gap-[var(--vds-space-4)] [&_.vds-tooltip__content_p]:m-0 [&_.iconfont]:text-base [&_.iconfont]:leading-none">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline">{t('interaction.hover')}</Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('interaction.tooltip')}</p>
                    </TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button>{t('interaction.primary')}</Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('interaction.primaryHelp')}</p>
                    </TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="destructive">{t('delete.confirm')}</Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('interaction.irreversible')}</p>
                    </TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button aria-label={t('interaction.copy')} size="sm" variant="ghost">
                        <IconFont type="line-tool-appendix" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('interaction.copy')}</p>
                    </TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div
                        tabIndex={0}
                        className="inline-block cursor-help text-[length:var(--vds-font-body-lv1)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-secondary)] underline decoration-dotted underline-offset-[3px]"
                      >
                        {t('interaction.help')}
                      </div>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-xs">
                      <p>{t('interaction.helpBody')}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              </TooltipProvider>
            </section>

            <section className={exampleSectionClass('toast', activeExample)} id="toast">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Toast
              </h2>
              <ToastProvider>
                <ToastExampleControls />
                <Toaster closeLabel={t('interaction.closeToast')} placement="top-right" />
              </ToastProvider>
            </section>

            <section
              className={exampleSectionClass('sheet-drawer', activeExample)}
              id="sheet-drawer"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Sheet and Drawer
              </h2>
              <SheetDrawerExample />
            </section>

            <section className={exampleSectionClass('button', activeExample)} id="button">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Button
              </h2>
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                <Button size="content" variant="outline">
                  <span>
                    {t('elements.content')}
                    <br />
                    {t('elements.multiline')}
                  </span>
                </Button>
                <Button className="min-h-24 min-w-48 flex-col" size="content" variant="dropzone">
                  <span>{t('elements.dropzone')}</span>
                  <span className="text-[length:var(--vds-font-body-lv1)] text-[var(--vds-text-secondary)]">
                    {t('elements.dropHelp')}
                  </span>
                </Button>
                <Button size="standard">{t('elements.standard')}</Button>
                <Button>{t('elements.default')}</Button>
                <Button disabled>{t('elements.defaultDisabled')}</Button>
                <Button variant="secondary">{t('elements.secondary')}</Button>
                <Button disabled variant="secondary">
                  {t('elements.secondaryDisabled')}
                </Button>
                <Button variant="tertiary">{t('elements.tertiary')}</Button>
                <Button disabled variant="tertiary">
                  {t('elements.tertiaryDisabled')}
                </Button>
                <Button variant="destructive">{t('elements.destructive')}</Button>
                <Button disabled variant="destructive">
                  {t('elements.destructiveDisabled')}
                </Button>
                <Button variant="outline">{t('elements.outline')}</Button>
                <Button disabled variant="outline">
                  {t('elements.outlineDisabled')}
                </Button>
                <Button variant="ghost">{t('elements.ghost')}</Button>
                <Button disabled variant="ghost">
                  {t('elements.ghostDisabled')}
                </Button>
                <Button variant="warning">{t('elements.warning')}</Button>
                <Button disabled variant="warning">
                  {t('elements.warningDisabled')}
                </Button>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                <Button size="md">{t('elements.medium')}</Button>
                <Button size="sm">{t('elements.small')}</Button>
                <Button size="xs">{t('elements.extraSmall')}</Button>
                <Button size="lg">{t('elements.large')}</Button>
                <Button aria-label={t('elements.refresh')} icon={refreshIcon} variant="icon" />
                <Button aria-label={t('elements.add')} icon={refreshIcon} variant="ghostIcon" />
                <Button
                  aria-label={t('elements.smallGhost')}
                  icon={refreshIcon}
                  size="sm"
                  variant="ghostIcon"
                />
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                <Button loading>{t('elements.loading')}</Button>
                <Button className="max-w-[220px]">{t('elements.long')}</Button>
                <NavigationButton
                  className="w-[var(--vds-project-selector-width)]"
                  label={t('elements.long')}
                />
                <NavigationButton disabled label={t('elements.ghostDisabled')} />
              </div>
            </section>

            <section className={exampleSectionClass('icon-button', activeExample)} id="icon-button">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                IconButton
              </h2>
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                <IconButton
                  icon={<IconFont type="line-operation-add" />}
                  label={t('elements.iconAction')}
                  size="mini"
                  variant="tertiary"
                />
                <IconButton
                  icon={refreshIcon}
                  label={t('elements.refresh')}
                  size="xs"
                  variant="ghost"
                />
                <IconButton
                  icon={refreshIcon}
                  label={t('elements.refresh')}
                  size="sm"
                  variant="ghost"
                />
                <IconButton icon={refreshIcon} label={t('elements.refresh')} />
                <IconButton
                  icon={refreshIcon}
                  label={t('elements.refresh')}
                  size="lg"
                  variant="secondary"
                />
                <IconButton disabled icon={refreshIcon} label={t('elements.refresh')} />
                <IconButton
                  icon={<IconFont type="line-operation-add" />}
                  label={t('elements.iconAction')}
                  size="lg"
                  variant="ghost"
                />
                <IconButton
                  aria-pressed
                  icon={<IconFont type="line-operation-add" />}
                  label={t('elements.iconSelected')}
                  size="lg"
                  variant="ghost"
                />
                <IconButton
                  loading
                  icon={refreshIcon}
                  label={t('elements.iconLoading')}
                  size="lg"
                  variant="ghost"
                />
              </div>
            </section>

            <section className={exampleSectionClass('input', activeExample)} id="input">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Input
              </h2>
              <div className="grid gap-[var(--vds-space-3)]">
                <Input
                  size="standard"
                  label={t('elements.standardInput')}
                  placeholder={t('elements.designControl')}
                />
                <Input label={t('elements.input')} placeholder={t('elements.namePlaceholder')} />
                <Input defaultValue="已填写内容" label={t('elements.filled')} />
                <PasswordInput
                  label={t('elements.password')}
                  placeholder={t('elements.passwordPlaceholder')}
                />
                <Input
                  disabled
                  label={t('elements.disabledInput')}
                  placeholder={t('elements.readonly')}
                />
                <Input
                  error={t('elements.invalidName')}
                  label={t('elements.errorState')}
                  placeholder={t('elements.namePlaceholder')}
                />
                <SearchBox placeholder={t('elements.searchPlaceholder')} />
                <SearchBox
                  placeholder={t('elements.searchPlaceholder')}
                  trailing={
                    <IconButton
                      icon={refreshIcon}
                      label={t('elements.refresh')}
                      size="xs"
                      variant="ghost"
                    />
                  }
                />
              </div>
            </section>

            <section className={exampleSectionClass('badge', activeExample)} id="badge">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Badge
              </h2>
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                <Badge>{t('elements.badgeDefault')}</Badge>
                <Badge variant="secondary">{t('elements.badgeSecondary')}</Badge>
                <Badge variant="outline">{t('elements.badgeOutline')}</Badge>
                <Badge variant="destructive">{t('elements.important')}</Badge>
                <Badge tone="brand">{t('elements.brand')}</Badge>
                <Badge tone="success">{t('elements.success')}</Badge>
                <Badge tone="warning">{t('elements.caution')}</Badge>
                <Badge tone="danger">{t('elements.error')}</Badge>
                <BadgeDot role="img" aria-label={t('elements.error')} />
                <BadgeDot tone="neutral" role="img" aria-label={t('elements.badgeDefault')} />
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                <Badge size="sm">{t('elements.smallSize')}</Badge>
                <Badge className="max-w-[220px]" tone="brand">
                  {t('elements.longTag')}
                </Badge>
                {badgeVisible ? (
                  <Badge variant="outline" onRemove={() => setBadgeVisible(false)}>
                    {t('elements.removable')}
                  </Badge>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => setBadgeVisible(true)}>
                    {t('elements.restore')}
                  </Button>
                )}
              </div>
            </section>

            <section
              className={exampleSectionClass('tag', activeExample)}
              data-registry-family="Tag classes"
              id="tag"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Tag
              </h2>
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                <Tag>{t('elements.badgeDefault')}</Tag>
                <Tag variant="secondary">{t('elements.badgeSecondary')}</Tag>
                <Tag variant="outline">{t('elements.badgeOutline')}</Tag>
                <Tag variant="destructive">{t('elements.important')}</Tag>
                <Tag tone="brand">{t('elements.brand')}</Tag>
                <Tag tone="success">{t('elements.success')}</Tag>
                <Tag tone="warning">{t('elements.caution')}</Tag>
                <Tag tone="danger">{t('elements.error')}</Tag>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                {tagVisible ? (
                  <Tag onClose={() => setTagVisible(false)}>{t('elements.tagOne')}</Tag>
                ) : (
                  <Button size="sm" variant="secondary" onClick={() => setTagVisible(true)}>
                    {t('elements.restore')}
                  </Button>
                )}
                <Tag size="small">{t('elements.smallSize')}</Tag>
                <Tag size="small" tone="success" onClose={() => setTagVisible(false)}>
                  {t('elements.smallSize')}
                </Tag>
                <Tag className="max-w-[180px]">{t('elements.truncated')}</Tag>
              </div>
            </section>

            <section className={exampleSectionClass('page', activeExample)} id="page">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                {t('page.name')}
              </h2>
              <Page width="reading">
                <PageHeader
                  title={t('page.title')}
                  description={t('page.description')}
                  actions={
                    <Button size="standard" disabled>
                      {t('page.save')}
                    </Button>
                  }
                />
                <PageBody>
                  <PageSection title={t('page.section')} description={t('page.hint')}>
                    <Card>
                      <Input
                        label={t('page.name')}
                        placeholder={t('page.placeholder')}
                        size="standard"
                      />
                    </Card>
                  </PageSection>
                </PageBody>
              </Page>
            </section>

            <section className={exampleSectionClass('card', activeExample)} id="card">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Card
              </h2>
              <div className="grid gap-[var(--vds-space-3)]">
                <Card padding="sm">
                  <div>
                    <strong>Bordered</strong>
                  </div>
                  <div>{t('elements.container')}</div>
                </Card>
                <Card padding="md" variant="flat">
                  <div>
                    <strong>Flat</strong>
                  </div>
                  <div>{t('elements.muted')}</div>
                </Card>
                <Card padding="lg" variant="elevated">
                  <CardHeader>
                    <CardTitle>Elevated</CardTitle>
                    <CardDescription>CardHeader / Title / Description</CardDescription>
                  </CardHeader>
                  <CardContent>{t('elements.elevatedBody')}</CardContent>
                  <CardFooter>
                    <Button size="sm" variant="secondary">
                      {t('elements.details')}
                    </Button>
                  </CardFooter>
                </Card>
                <Card
                  aria-label={t('elements.designContainer')}
                  className="grid gap-[var(--vds-space-3)] [--vds-card-radius:var(--vds-radius-6)]"
                  padding="md"
                >
                  <CardTitle>{t('elements.designContainerTitle')}</CardTitle>
                  <CardContent>{t('elements.designContainerBody')}</CardContent>
                </Card>
              </div>
            </section>

            <section
              className={exampleSectionClass('floating-toolbar', activeExample)}
              id="floating-toolbar"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                FloatingToolbar
              </h2>
              <div className="grid min-h-32 place-items-center bg-[var(--vds-surface-muted)] p-[var(--vds-space-4)]">
                <FloatingToolbar
                  actions={
                    <>
                      <Button size="sm" variant="ghost">
                        {t('elements.interpret')}
                      </Button>
                      <Button size="sm" variant="ghost">
                        {t('elements.translate')}
                      </Button>
                      <Button size="sm" variant="ghost">
                        {t('elements.addToChat')}
                      </Button>
                    </>
                  }
                  label={t('elements.selectionActions')}
                />
              </div>
            </section>

            <section className={exampleSectionClass('divider', activeExample)} id="divider">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Divider
              </h2>
              <div className="grid gap-[var(--vds-space-3)]">
                <span>{t('elements.above')}</span>
                <Divider />
                <span>{t('elements.below')}</span>
                <Separator />
                <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                  <span>{t('elements.left')}</span>
                  <Divider orientation="vertical" />
                  <span>{t('elements.right')}</span>
                </div>
              </div>
            </section>

            <section className={exampleSectionClass('switch', activeExample)} id="switch">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Switch
              </h2>
              <div className="grid gap-[var(--vds-space-4)]">
                <div className="flex items-center gap-[var(--vds-space-2)]">
                  <Switch id="airplane-mode1" />
                  <Label htmlFor="airplane-mode1">{t('elements.airplane')}</Label>
                </div>

                <div className="flex items-center gap-[var(--vds-space-2)]">
                  <Switch defaultChecked id="notifications1" />
                  <Label htmlFor="notifications1">{t('elements.push')}</Label>
                </div>

                <div className="flex items-center gap-[var(--vds-space-2)]">
                  <Switch defaultChecked id="text-switch1" variant="text" />
                  <Label htmlFor="text-switch1">{t('elements.textSwitch')}</Label>
                </div>

                <div className="flex items-center gap-[var(--vds-space-2)]">
                  <Switch id="icon-switch1" variant="icon" />
                  <Label htmlFor="icon-switch1">{t('elements.iconSwitch')}</Label>
                </div>

                <div className="flex items-center gap-[var(--vds-space-2)]">
                  <Switch disabled id="disabled-switch1" />
                  <Label htmlFor="disabled-switch1">{t('elements.disabledSwitch')}</Label>
                </div>

                <div className="flex items-center gap-[var(--vds-space-2)]">
                  <Switch defaultChecked disabled id="disabled-checked1" />
                  <Label htmlFor="disabled-checked1">{t('elements.disabledChecked')}</Label>
                </div>
              </div>
            </section>

            <section className={exampleSectionClass('checkbox', activeExample)} id="checkbox">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Checkbox
              </h2>
              <div className="grid gap-[var(--vds-space-4)]">
                <div className="flex items-center gap-[var(--vds-space-2)]">
                  <Checkbox id="terms1" />
                  <label
                    className="text-[length:var(--vds-font-body-lv1)] leading-none text-[var(--vds-text-primary)] font-[var(--vds-fw-medium)]"
                    htmlFor="terms1"
                  >
                    {t('elements.terms')}
                  </label>
                </div>

                <div className="flex items-center gap-[var(--vds-space-2)]">
                  <Checkbox defaultChecked id="marketing1" />
                  <label
                    className="text-[length:var(--vds-font-body-lv1)] leading-none text-[var(--vds-text-primary)]"
                    htmlFor="marketing1"
                  >
                    {t('elements.marketing')}
                  </label>
                </div>

                <div className="flex items-center gap-[var(--vds-space-2)]">
                  <Checkbox disabled id="disabled1" />
                  <label
                    className="text-[length:var(--vds-font-body-lv1)] leading-none text-[var(--vds-text-primary)] text-[var(--vds-text-secondary)]"
                    htmlFor="disabled1"
                  >
                    {t('elements.disabledOption')}
                  </label>
                </div>
                <Checkbox align="first-line" checked="mixed" label="部分子项已选" />
              </div>
            </section>

            <section className={exampleSectionClass('radio', activeExample)} id="radio">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Radio
              </h2>
              <div className="grid gap-[var(--vds-space-3)]">
                <Radio
                  checked={false}
                  label={t('elements.compact')}
                  onCheckedChange={() => undefined}
                />
                <Radio
                  checked
                  label={t('elements.comfortable')}
                  onCheckedChange={() => undefined}
                />
                <Radio
                  align="first-line"
                  checked
                  label={t('elements.longRadio')}
                  onCheckedChange={() => undefined}
                />
                <Radio
                  checked={false}
                  disabled
                  label={t('elements.unselectedDisabled')}
                  onCheckedChange={() => undefined}
                />
                <Radio
                  checked
                  disabled
                  label={t('elements.selectedDisabled')}
                  onCheckedChange={() => undefined}
                />
                <RadioGroup
                  aria-label={t('elements.mode')}
                  defaultValue="manual"
                  name="example-mode"
                  orientation="horizontal"
                >
                  <Radio label={t('elements.manual')} value="manual" />
                  <Radio label={t('elements.auto')} value="auto" />
                  <Radio disabled label={t('disclosure.disabled')} value="disabled" />
                </RadioGroup>
              </div>
            </section>

            <section className={exampleSectionClass('textarea', activeExample)} id="textarea">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Textarea
              </h2>
              <div className="grid max-w-md gap-[var(--vds-space-6)]">
                <div>
                  <h4 className="m-0 mb-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]">
                    {t('elements.textarea')}
                  </h4>
                  <Textarea placeholder={t('elements.messagePlaceholder')} />
                </div>

                <div className="grid gap-[var(--vds-space-2)]">
                  <Label htmlFor="message1">{t('elements.feedback')}</Label>
                  <Textarea
                    className="min-h-20"
                    id="message1"
                    placeholder={t('elements.feedbackPlaceholder')}
                  />
                </div>

                <div className="grid gap-[var(--vds-space-2)]">
                  <Label htmlFor="bio1">{t('elements.bio')}</Label>
                  <Textarea
                    className="min-h-[120px]"
                    defaultValue="我是一名前端开发者，热爱创建用户友好的界面和体验。专注于 React、TypeScript 和现代前端技术栈。"
                    id="bio1"
                    placeholder={t('elements.bioPlaceholder')}
                  />
                </div>

                <div className="grid gap-[var(--vds-space-2)]">
                  <Label htmlFor="disabled1">{t('elements.disabledState')}</Label>
                  <Textarea
                    defaultValue="这是一个禁用状态的文本框示例。"
                    disabled
                    id="disabled1"
                    placeholder={t('elements.disabledPlaceholder')}
                  />
                </div>
              </div>
            </section>

            <section className={exampleSectionClass('select', activeExample)} id="select">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Select
              </h2>
              <div className="grid max-w-sm gap-[var(--vds-space-6)]">
                <div>
                  <Select size="standard" label={t('elements.standardSelect')} defaultValue="first">
                    <option value="first">{t('elements.firstOption')}</option>
                    <option value="second">{t('elements.secondOption')}</option>
                  </Select>
                  <h4 className="m-0 mb-[var(--vds-space-3)] text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]">
                    {t('elements.select')}
                  </h4>
                  <Select>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t('elements.themePlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="light">{t('elements.light')}</SelectItem>
                      <SelectItem value="dark">{t('elements.dark')}</SelectItem>
                      <SelectItem value="system">{t('elements.system')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-[var(--vds-space-2)]">
                  <Label htmlFor="framework1">{t('elements.framework')}</Label>
                  <Select>
                    <SelectTrigger id="framework1">
                      <SelectValue placeholder={t('elements.frameworkPlaceholder')} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="react">React</SelectItem>
                      <SelectItem value="vue">Vue.js</SelectItem>
                      <SelectItem value="angular">Angular</SelectItem>
                      <SelectItem value="svelte">Svelte</SelectItem>
                      <SelectItem value="nextjs">Next.js</SelectItem>
                      <SelectItem value="nuxtjs">Nuxt.js</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-[var(--vds-space-2)]">
                  <Label htmlFor="language1">{t('elements.language')}</Label>
                  <Select defaultValue="typescript">
                    <SelectTrigger id="language1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="javascript">JavaScript</SelectItem>
                      <SelectItem value="typescript">TypeScript</SelectItem>
                      <SelectItem value="python">Python</SelectItem>
                      <SelectItem value="java">Java</SelectItem>
                      <SelectItem value="go">Go</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </section>

            <section className={exampleSectionClass('loading', activeExample)} id="loading">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Loading
              </h2>
              <div className="flex min-w-0 flex-wrap items-center gap-[var(--vds-space-2)]">
                <Spinner size="sm" />
                <Spinner />
                <Spinner size="lg" />
                <Spinner imageSrc={aiThinking} size="sm" />
              </div>
              <div className="grid gap-[var(--vds-space-3)]">
                <Skeleton width="80%" />
                <Skeleton height={24} />
                <Skeleton height={48} width="60%" />
              </div>
            </section>

            <section className={exampleSectionClass('theme', activeExample)} id="theme">
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Theme
              </h2>
              <div className="grid gap-[var(--vds-space-4)]">
                <div
                  className="grid gap-[var(--vds-space-5)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-page)] p-[var(--vds-space-5)] text-[var(--vds-text-primary)] shadow-[var(--vds-shadow-1-center)]"
                  data-theme={themePreview}
                >
                  <div className="grid gap-[var(--vds-space-2)]">
                    <Badge variant="brand">
                      {t(themePreview === 'dark' ? 'theme.dark' : 'theme.light')}
                    </Badge>
                    <h3 className="m-0 text-[length:var(--vds-font-title)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-title)] text-[var(--vds-text-primary)]">
                      {t('theme.title')}
                    </h3>
                    <p className="m-0 max-w-2xl text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)] text-[var(--vds-text-secondary)]">
                      {t('theme.description')}
                    </p>
                  </div>

                  <div className="grid grid-cols-3 gap-[var(--vds-space-3)] max-[960px]:grid-cols-1">
                    <Card>
                      <CardHeader>
                        <CardTitle>{t('theme.workspace')}</CardTitle>
                        <CardDescription>{t('theme.colors')}</CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="grid gap-[var(--vds-space-2)]">
                          <ProgressBar label={t('theme.sync')} value={68} />
                          <Alert
                            description={t('theme.applied')}
                            title={t('theme.healthy')}
                            tone="success"
                          />
                        </div>
                      </CardContent>
                      <CardFooter>
                        <Button size="sm">{t('theme.primary')}</Button>
                        <Button size="sm" variant="secondary">
                          {t('theme.secondary')}
                        </Button>
                      </CardFooter>
                    </Card>

                    <div className="grid content-start gap-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-4)]">
                      <h4 className="m-0 text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]">
                        {t('theme.semantic')}
                      </h4>
                      <div className="flex min-w-0 flex-wrap gap-[var(--vds-space-2)]">
                        <Badge variant="brand">Brand</Badge>
                        <Badge variant="success">Success</Badge>
                        <Badge variant="warning">Warning</Badge>
                        <Badge variant="danger">Danger</Badge>
                      </div>
                    </div>

                    <div className="grid content-start gap-[var(--vds-space-3)] rounded-[var(--vds-radius-4)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)] p-[var(--vds-space-4)]">
                      <h4 className="m-0 text-[length:var(--vds-font-body-lv1)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-body-lv1)] text-[var(--vds-text-primary)]">
                        {t('theme.palette')}
                      </h4>
                      <div className="grid grid-cols-4 gap-[var(--vds-space-2)]">
                        <span className="min-h-10 rounded-[var(--vds-radius-3)] border border-[var(--vds-border-default)] bg-[var(--vds-bg-white-default)]" />
                        <span className="min-h-10 rounded-[var(--vds-radius-3)] bg-[var(--vds-bg-gray-default)]" />
                        <span className="min-h-10 rounded-[var(--vds-radius-3)] bg-[var(--vds-brand-bg-default)]" />
                        <span className="min-h-10 rounded-[var(--vds-radius-3)] bg-[var(--vds-brand-light-bg-default)]" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section
              className={exampleSectionClass('token-swatches', activeExample)}
              id="token-swatches"
            >
              <h2 className="m-0 text-[length:var(--vds-font-subhead)] font-[var(--vds-fw-medium)] leading-[var(--vds-lh-subhead)] text-[var(--vds-text-primary)]">
                Token Swatches
              </h2>
              <div className="grid grid-cols-5 gap-[var(--vds-space-2)] max-[860px]:grid-cols-2">
                <span
                  className="grid min-h-14 place-items-end rounded-[var(--vds-radius-3)] p-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-static-white)]"
                  style={{ background: 'var(--vds-brand-6)' }}
                >
                  brand
                </span>
                <span
                  className="grid min-h-14 place-items-end rounded-[var(--vds-radius-3)] p-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-static-white)]"
                  style={{ background: 'var(--vds-success-6)' }}
                >
                  success
                </span>
                <span
                  className="grid min-h-14 place-items-end rounded-[var(--vds-radius-3)] p-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-static-white)]"
                  style={{ background: 'var(--vds-warning-6)' }}
                >
                  warning
                </span>
                <span
                  className="grid min-h-14 place-items-end rounded-[var(--vds-radius-3)] p-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-static-white)]"
                  style={{ background: 'var(--vds-error-6)' }}
                >
                  error
                </span>
                <span
                  className="grid min-h-14 place-items-end rounded-[var(--vds-radius-3)] p-[var(--vds-space-2)] text-[length:var(--vds-font-caption)] leading-[var(--vds-lh-caption)] text-[var(--vds-static-white)]"
                  style={{ background: 'var(--vds-help-6)' }}
                >
                  help
                </span>
              </div>
            </section>
          </div>
          <CodePreview code={activeExampleCode} />
        </div>
      </div>
    </main>
  )
}
