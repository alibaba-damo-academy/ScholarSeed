import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { Check, Copy } from 'lucide-react'
import { IconFont } from './primitive'
import { createLocalization } from '../../../localization/engine'
import { resources } from '../../../localization/resources'
import aiThinking from '../assets/ai-thinking.gif'
import { AnnotationSummary } from '../features/assistant/Notes'
import { Motion } from '../shell/Motion'

import '../styles.css'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogTrigger,
  AspectRatio,
  Avatar,
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  NavigationButton,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  ContextMenuContent,
  ContextMenuItem,
  CopyButton,
  Divider,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerOverlay,
  DrawerTitle,
  EmptyState,
  EllipsisText,
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
  InputOTP,
  LoadingOverlay,
  NavigationTabs,
  Pagination,
  ProgressBar,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Radio,
  RadioGroup,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
  ScrollArea,
  SegmentedControl,
  Separator,
  Slider,
  Switch,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  Spinner,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Toaster,
  ToastProvider,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Toggle,
  ToggleGroup,
  ToggleGroupItem,
  useToast,
  type ToastData,
} from './ui'

function AnnotationSummaryDemo(): JSX.Element {
  const [annotations, setAnnotations] = useState([
    { id: 'first', previewText: '第一段原文', comment: '第一条注释' },
    { id: 'second', previewText: '第二段原文', comment: '第二条注释' },
  ])
  return (
    <section
      className="grid bg-[var(--vds-surface-raised)]"
      data-testid="render-annotation-workspace"
    >
      <AnnotationSummary
        annotations={annotations}
        onClear={() => setAnnotations([])}
        onEdit={async (annotationId, comment) => {
          setAnnotations((items) =>
            items.map((item) => (item.id === annotationId ? { ...item, comment } : item))
          )
          return true
        }}
        onRemove={(annotationId) =>
          setAnnotations((items) => items.filter((item) => item.id !== annotationId))
        }
      />
      <div className="bg-[var(--vds-other-overlay-2)]" data-testid="render-annotation-message">
        <AnnotationSummary annotations={annotations} testId="render-sent-annotation-summary" />
      </div>
    </section>
  )
}

function ToastQueueDemo(): JSX.Element {
  const { toast } = useToast()

  return (
    <Button
      data-testid="render-toast-add"
      onClick={() =>
        toast({
          action: (
            <Button size="sm" variant="secondary">
              查看
            </Button>
          ),
          description: '非受控队列会追加通知。',
          duration: false,
          id: 'queued-toast',
          title: '队列通知',
          tone: 'success',
        })
      }
    >
      添加通知
    </Button>
  )
}

function NavigationTabsScrollDemo(): JSX.Element {
  const [activeTab, setActiveTab] = useState('tab-1')
  const [, setRenderVersion] = useState(0)

  return (
    <section>
      <NavigationTabs
        className="max-w-[320px]"
        data-testid="render-navigation-tabs-scroll"
        onValueChange={setActiveTab}
        showOverview={false}
        tabs={Array.from({ length: 12 }, (_, index) => ({
          id: `tab-${index + 1}`,
          label: `Document ${index + 1}.md`,
        }))}
        value={activeTab}
      />
      <Button
        data-testid="render-navigation-tabs-rerender"
        onClick={() => setRenderVersion((version) => version + 1)}
      >
        重新渲染
      </Button>
      <Button
        data-testid="render-navigation-tabs-activate-last"
        onClick={() => setActiveTab('tab-12')}
      >
        激活末尾页签
      </Button>
    </section>
  )
}

function NavigationTabsReorderDemo(): JSX.Element {
  const [tabs, setTabs] = useState([
    { id: 'first', label: 'First.md' },
    { id: 'second', label: 'Second.md', dirty: true },
    { id: 'third', label: 'Third.md' },
    { id: 'locked', label: 'Locked.md' },
  ])
  const [value, setValue] = useState('second')
  const [activations, setActivations] = useState(0)
  const [callbacks, setCallbacks] = useState(0)
  const [dragEvents, setDragEvents] = useState(0)
  const [dropEvents, setDropEvents] = useState(0)
  return (
    <section>
      <NavigationTabs
        data-testid="render-navigation-tabs-reorder"
        tabs={tabs}
        value={value}
        onValueChange={(id) => {
          setValue(id)
          setActivations((count) => count + 1)
        }}
        onClose={(id) => setTabs((current) => current.filter((tab) => tab.id !== id))}
        onReorder={(ids) => {
          setTabs((current) => ids.flatMap((id) => current.filter((tab) => tab.id === id)))
          setCallbacks((count) => count + 1)
        }}
        getTabProps={(tab) => ({
          draggable: tab.id === 'locked' ? false : undefined,
          onDragStart: () => setDragEvents((count) => count + 1),
          onDrop: () => setDropEvents((count) => count + 1),
        })}
      />
      <output data-testid="render-navigation-reorders">{callbacks}</output>
      <output data-testid="render-navigation-activations">{activations}</output>
      <output data-testid="render-navigation-drag-events">{dragEvents}</output>
      <output data-testid="render-navigation-drop-events">{dropEvents}</output>
      <NavigationTabs
        data-testid="render-navigation-tabs-reorder-other"
        tabs={tabs}
        showOverview={false}
        onReorder={() => setCallbacks((count) => count + 1)}
      />
    </section>
  )
}

function Fixture(): JSX.Element {
  const [conversationWidth, setConversationWidth] = useState('360px')
  const [morph, setMorph] = useState(false)
  const [morphEntry, setMorphEntry] = useState(false)
  const [morphOffset, setMorphOffset] = useState(0)
  const [draggingMorph, setDraggingMorph] = useState(false)
  const [motionClosed, setMotionClosed] = useState(false)
  const [navigationClosed, setNavigationClosed] = useState(false)
  const [conversationHostWidth, setConversationHostWidth] = useState(800)
  const [buttonClicks, setButtonClicks] = useState(0)
  const [accepted, setAccepted] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [mode, setMode] = useState('manual')
  const [radioGroupValue, setRadioGroupValue] = useState('manual')
  const [disabledRadioGroupValue, setDisabledRadioGroupValue] = useState('safe')
  const [page, setPage] = useState(4)
  const [disabledPage, setDisabledPage] = useState(2)
  const [scope, setScope] = useState('')
  const [controlledOpen, setControlledOpen] = useState(false)
  const [tabValue, setTabValue] = useState('overview')
  const [navigationValue, setNavigationValue] = useState('overview')
  const [accordionValue, setAccordionValue] = useState<string | string[]>('summary')
  const [accordionMultiValue, setAccordionMultiValue] = useState<string | string[]>(['first'])
  const [togglePressed, setTogglePressed] = useState(false)
  const [uncontrolledToggleChanges, setUncontrolledToggleChanges] = useState(0)
  const [disabledToggleChanges, setDisabledToggleChanges] = useState(0)
  const [toggleGroupValue, setToggleGroupValue] = useState<string | string[]>('list')
  const [toggleMultiValue, setToggleMultiValue] = useState<string | string[]>(['tag'])
  const [segmentValue, setSegmentValue] = useState<string | string[]>('day')
  const [accordionKeyEvents, setAccordionKeyEvents] = useState(0)
  const [blockedAccordionKeyEvents, setBlockedAccordionKeyEvents] = useState(0)
  const [defaultToggleGroupValue, setDefaultToggleGroupValue] = useState<string | string[]>('')
  const [invalidToggleGroupValue, setInvalidToggleGroupValue] = useState<string | string[]>(
    'missing'
  )
  const [disabledToggleGroupValue, setDisabledToggleGroupValue] = useState<string | string[]>('')
  const [verticalToggleGroupValue, setVerticalToggleGroupValue] = useState<string | string[]>('top')
  const [sliderValue, setSliderValue] = useState(20)
  const [uncontrolledSliderChanges, setUncontrolledSliderChanges] = useState(0)
  const [disabledSliderValue, setDisabledSliderValue] = useState(30)
  const [otpValue, setOtpValue] = useState('')
  const [otpCompleteValue, setOtpCompleteValue] = useState('')
  const [textOtpValue, setTextOtpValue] = useState('AZ')
  const [compositionOtpValue, setCompositionOtpValue] = useState('')
  const [compositionOtpChanges, setCompositionOtpChanges] = useState(0)
  const [stableOtpValue, setStableOtpValue] = useState('')
  const [controlledOtpSlots, setControlledOtpSlots] = useState(['1', '2', '3', '4'])
  const [disabledOtpValue, setDisabledOtpValue] = useState('12')
  const [commandValue, setCommandValue] = useState('open')
  const [commandSearch, setCommandSearch] = useState('')
  const [commandSelects, setCommandSelects] = useState('')
  const [disabledCommandValue, setDisabledCommandValue] = useState('locked')
  const [resizableSizes, setResizableSizes] = useState([30, 70])
  const [clampedResizableSizes, setClampedResizableSizes] = useState([5, 95])
  const [disabledResizableSizes, setDisabledResizableSizes] = useState([45, 55])
  const [resizeOffset, setResizeOffset] = useState(0)
  const [rightSplitWidth, setRightSplitWidth] = useState('403px')
  const [controlledToasts, setControlledToasts] = useState<ToastData[]>([
    {
      action: (
        <Button size="sm" variant="secondary">
          撤销
        </Button>
      ),
      description: '受控列表由调用方维护。',
      duration: false,
      id: 'controlled-toast',
      title: '已保存',
      tone: 'info',
    },
    {
      description: '错误通知使用 alert 语义。',
      duration: false,
      id: 'error-toast',
      title: '同步失败',
      tone: 'error',
    },
  ])
  const [autoToasts, setAutoToasts] = useState<ToastData[]>([])
  const [nestedControlledToasts, setNestedControlledToasts] = useState<ToastData[]>([
    {
      description: '关闭它不应影响 provider 队列。',
      duration: false,
      id: 'shared-toast',
      title: '受控同 id',
      tone: 'info',
    },
  ])
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetCloseCount, setSheetCloseCount] = useState(0)
  const [sheetOpenChanges, setSheetOpenChanges] = useState(0)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogActionDisabled, setDialogActionDisabled] = useState(false)
  const [dialogActionRemoved, setDialogActionRemoved] = useState(false)
  const [dialogChildClicks, setDialogChildClicks] = useState(0)
  const [modalSheetOpen, setModalSheetOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerCloseCount, setDrawerCloseCount] = useState(0)
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const [tooltipOpenChangeCount, setTooltipOpenChangeCount] = useState(0)
  const [tooltipUncontrolledOpenChanges, setTooltipUncontrolledOpenChanges] = useState(0)
  const [tooltipTemporarilyDisabled, setTooltipTemporarilyDisabled] = useState(false)
  const [navigationContextTab, setNavigationContextTab] = useState('')
  const scrollViewportRef = useRef<HTMLDivElement | null>(null)
  const hoverBoundaryRef = useRef<HTMLDivElement | null>(null)

  return (
    <main>
      <NavigationButton
        className="w-[var(--vds-project-selector-width)]"
        data-testid="render-navigation-button"
        label="一个很长的项目名称用于验证省略与完整名称"
        onClick={() => setButtonClicks((value) => value + 1)}
      />
      <NavigationButton disabled label="不可用项目" data-testid="render-navigation-disabled" />
      <NavigationButton
        label="蛋白质设计开放问题与真实长项目标题"
        backLabel="返回项目中心"
        onBack={() => setButtonClicks((value) => value + 1)}
        onClick={() => setButtonClicks((value) => value + 10)}
        data-testid="render-navigation-split"
      />
      <Spinner size="sm" data-testid="render-spinner-default" />
      <Spinner imageSrc={aiThinking} size="sm" data-testid="render-spinner-image" />
      <Button loading data-testid="render-button-loading-default" />
      <Button
        loading
        loadingIcon={<Spinner imageSrc={aiThinking} size="sm" />}
        data-testid="render-button-loading-image"
      />
      <Button
        data-testid="render-button"
        loading={buttonClicks > 0}
        onClick={() => setButtonClicks((value) => value + 1)}
      >
        保存
      </Button>
      <output data-testid="render-button-clicks">{buttonClicks}</output>
      <EllipsisText className="max-w-[360px]" data-testid="render-ellipsis-short">
        短标题
      </EllipsisText>
      <EllipsisText className="max-w-[120px]" data-testid="render-ellipsis-long">
        这是一段一定会超过容器宽度并被省略的长标题
      </EllipsisText>
      <EllipsisText
        className="max-w-[120px]"
        data-testid="render-ellipsis-scrollable"
        tooltipPortalled
      >
        {'作者一, 作者二, 作者三, 作者四, 作者五, '.repeat(40)}
      </EllipsisText>

      <NavigationTabs
        data-testid="render-navigation-tabs"
        onValueChange={setNavigationValue}
        onContextMenuOpen={setNavigationContextTab}
        onClose={setNavigationContextTab}
        renderContextMenu={(tab) =>
          tab.id === 'beta' ? (
            <ContextMenuContent data-testid="render-navigation-context-menu">
              <ContextMenuItem>{tab.label}</ContextMenuItem>
            </ContextMenuContent>
          ) : null
        }
        tabs={[
          { id: 'alpha', label: 'Alpha.md' },
          { dirty: true, id: 'beta', label: 'Beta.md' },
          { id: 'gamma', label: 'Gamma.md' },
        ]}
        value={navigationValue}
      />
      <output data-testid="render-navigation-context-tab">{navigationContextTab}</output>
      <NavigationTabs
        data-testid="render-navigation-tabs-without-overview"
        showOverview={false}
        tabs={[{ id: 'split', label: '右侧文件.md' }]}
        value="split"
      />
      <NavigationTabs
        data-testid="render-navigation-tabs-long-label"
        showOverview={false}
        tabs={[
          {
            id: 'long',
            label: 'Multimodal Fusion and Vision-Language Models for Robot Learning.md',
          },
        ]}
        value="long"
      />
      <NavigationTabsScrollDemo />
      <NavigationTabsReorderDemo />

      <Card data-testid="render-card" variant="flat">
        原子卡片
      </Card>
      <Card data-testid="render-card-structure">
        <CardHeader data-testid="render-card-header">
          <CardTitle>研究项目</CardTitle>
          <CardDescription>用于验证 Card 子组件语义。</CardDescription>
        </CardHeader>
        <CardContent data-testid="render-card-content">核心内容</CardContent>
        <CardFooter data-testid="render-card-footer">
          <Button variant="secondary">查看</Button>
        </CardFooter>
      </Card>
      <FloatingToolbar
        actions={
          <>
            <Button size="sm" variant="ghost">
              解读
            </Button>
            <Button size="sm" variant="ghost">
              翻译
            </Button>
          </>
        }
        data-testid="render-floating-toolbar"
        label="选区操作"
      />
      <Divider data-testid="render-divider" />
      <Separator data-testid="render-separator" />
      <Divider data-testid="render-divider-vertical" orientation="vertical" />

      <Input
        data-i18n-error="examples:input.error"
        data-i18n-label="examples:input.label"
        data-i18n-placeholder="examples:input.placeholder"
        error="请输入有效名称"
        label="名称"
        labelClassName="text-[length:var(--vds-font-body-lv2)]"
        placeholder="请输入名称"
        data-testid="render-input"
      />
      <Input
        helperText="请输入项目公开名称。"
        label="辅助说明"
        placeholder="请输入项目公开名称"
        data-testid="render-input-helper"
      />
      <Input
        helperText="名称将展示给团队成员。"
        invalid
        label="辅助错误"
        placeholder="请输入团队名称"
        data-testid="render-input-invalid-helper"
      />
      <Input
        error="错误文案优先。"
        helperText="辅助文案不应展示。"
        label="错误优先"
        placeholder="请输入内容"
        data-testid="render-input-error-priority"
      />

      <Textarea
        error="请输入至少 10 个字"
        label="说明"
        placeholder="请输入说明"
        data-testid="render-textarea"
      />
      <Textarea
        helperText="支持 Markdown 简述。"
        label="辅助说明"
        placeholder="请输入说明"
        data-testid="render-textarea-helper"
      />
      <Textarea
        helperText="说明暂不可为空。"
        invalid
        label="辅助错误"
        placeholder="请输入说明"
        data-testid="render-textarea-invalid-helper"
      />
      <Textarea
        error="错误说明优先。"
        helperText="辅助说明不应展示。"
        label="错误优先"
        placeholder="请输入说明"
        data-testid="render-textarea-error-priority"
      />

      <Switch
        checked={enabled}
        data-testid="render-switch"
        label="启用通知"
        onCheckedChange={setEnabled}
      />
      <output data-testid="render-switch-value">{enabled ? 'on' : 'off'}</output>

      <Checkbox
        checked={accepted}
        data-testid="render-checkbox"
        label="同意条款"
        onCheckedChange={setAccepted}
      />
      <output data-testid="render-checkbox-value">{accepted ? 'yes' : 'no'}</output>
      <Checkbox checked="mixed" data-testid="render-checkbox-mixed" label="部分选择" />
      <Checkbox
        checked={accepted}
        data-testid="render-checkbox-content"
        onCheckedChange={setAccepted}
      >
        <span>选项标题</span>
        <span>选项描述</span>
      </Checkbox>
      <section
        className="grid w-[var(--vds-conversation-content-width)] gap-[var(--vds-space-3)]"
        data-testid="render-question-options"
      >
        <Radio
          align="first-line"
          checked
          className="flex w-full gap-[var(--vds-space-2)]"
          data-testid="render-question-option-radio"
        >
          <span className="min-w-0 flex-1 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)]">
            <span className="mr-[var(--vds-space-2)] font-medium">外置持久记忆系统</span>
            跨会话、跨任务的外部记忆库：写入/压缩/检索/更新与遗忘机制（如 MemGPT、记忆增强 Agent
            一类工作）
          </span>
        </Radio>
        <Checkbox
          align="first-line"
          className="flex w-full gap-[var(--vds-space-2)]"
          data-testid="render-question-option-checkbox"
        >
          <span className="min-w-0 flex-1 text-[length:var(--vds-font-body-lv2)] leading-[var(--vds-lh-body-lv2)]">
            <span className="mr-[var(--vds-space-2)] font-medium">外置持久记忆系统</span>
            跨会话、跨任务的外部记忆库：写入/压缩/检索/更新与遗忘机制（如 MemGPT、记忆增强 Agent
            一类工作）
          </span>
        </Checkbox>
      </section>

      <Radio
        checked={mode === 'auto'}
        data-testid="render-radio"
        label="自动模式"
        onCheckedChange={() => setMode('auto')}
      />
      <output data-testid="render-radio-value">{mode}</output>

      <RadioGroup
        aria-label="运行模式"
        data-testid="render-radio-group"
        name="run-mode"
        value={radioGroupValue}
        onValueChange={setRadioGroupValue}
      >
        <Radio label="手动模式" value="manual" />
        <Radio label="自动模式" value="auto" />
        <Radio disabled label="禁用模式" value="disabled" />
      </RadioGroup>
      <output data-testid="render-radio-group-value">{radioGroupValue}</output>

      <RadioGroup
        aria-label="禁用分组"
        data-testid="render-radio-group-disabled"
        disabled
        value={disabledRadioGroupValue}
        onValueChange={setDisabledRadioGroupValue}
      >
        <Radio label="安全模式" value="safe" />
        <Radio label="极速模式" value="fast" />
      </RadioGroup>
      <output data-testid="render-radio-group-disabled-value">{disabledRadioGroupValue}</output>

      <Select
        error={scope ? undefined : '请选择范围'}
        label="范围"
        value={scope}
        data-testid="render-select"
        onChange={(event) => setScope(event.target.value)}
      >
        <option value="">请选择范围</option>
        <option value="all">全部</option>
        <option value="current">当前</option>
      </Select>
      <output data-testid="render-select-value">{scope || 'empty'}</output>

      <Alert
        data-i18n-description="examples:alert.description"
        data-i18n-title="examples:alert.title"
        data-testid="render-alert"
        description="请检查填写内容后重试。"
        title="保存失败"
        tone="error"
      />
      <Alert>
        <AlertDescription data-testid="render-alert-full" truncate={false}>
          完整处置说明不能因提示区宽度不足而丢失。
        </AlertDescription>
        <AlertDescription data-testid="render-alert-default">
          普通摘要保持默认两行。
        </AlertDescription>
      </Alert>

      <Alert data-testid="render-alert-align-single" tone="warning">
        <AlertDescription truncate={false}>文件将移到废纸篓。</AlertDescription>
      </Alert>
      <Alert data-testid="render-alert-align-multiple" tone="warning" style={{ width: 220 }}>
        <AlertDescription truncate={false}>
          这会同步影响你的本地文件：文件将被移到系统废纸篓，可以从废纸篓恢复。
        </AlertDescription>
      </Alert>
      <ProgressBar
        data-testid="render-progress"
        label="上传进度"
        style={{ color: 'rgb(1, 2, 3)' }}
        value={60}
      />
      <ProgressBar data-testid="render-progress-indeterminate" indeterminate label="正在处理" />

      <Avatar
        data-testid="render-avatar"
        fallback="书"
        image="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
        size="lg"
      />

      <FormField data-testid="render-form-field">
        <FormLabel required>项目名称</FormLabel>
        <FormControl invalid>
          <input data-testid="render-form-control" />
        </FormControl>
        <FormDescription>用于展示在项目列表中。</FormDescription>
        <FormMessage>项目名称不能为空。</FormMessage>
      </FormField>

      <FormField>
        <FormLabel>仅标签字段</FormLabel>
        <FormControl>
          <input data-testid="render-form-control-without-help" />
        </FormControl>
      </FormField>

      <EmptyState
        action={<Button>创建项目</Button>}
        data-i18n-description="examples:empty.description"
        data-i18n-title="examples:empty.title"
        data-testid="render-empty-state"
        description="当前没有项目。"
        icon="∅"
        image={{ src: '/assets/empty-test.webp', alt: '' }}
        title="暂无项目"
      />

      <EmptyState
        variant="compact"
        data-testid="render-empty-compact"
        icon={<Copy size={24} />}
        title="暂无内容"
        description="没有匹配的结果"
      />
      <EmptyState
        variant="compact"
        data-testid="render-empty-compact-font"
        icon={<IconFont type="line-operation-search" />}
        title="暂无内容"
      />
      <EmptyState
        variant="panel"
        data-testid="render-empty-panel"
        icon={<Copy />}
        title="打开文件"
        description="从左侧文件树中选择文件打开"
      />

      <CopyButton data-testid="render-copy-button" feedbackDuration={50} value="copy-value">
        复制
      </CopyButton>
      <CopyButton
        data-testid="render-copy-icon"
        iconOnly
        icon={<Copy size={14} />}
        copiedIcon={<Check size={14} />}
        feedbackDuration={3000}
        size="xs"
        className="![--vds-icon-button-glyph:var(--vds-icon-7)]"
        variant="ghost"
        value="icon-copy-value"
      />
      <CopyButton data-testid="render-copy-reject" value="reject-value">
        复制失败
      </CopyButton>
      <CopyButton data-testid="render-copy-missing" value="missing-value">
        无剪贴板复制
      </CopyButton>
      <CopyButton data-testid="render-copy-disabled" disabled value="disabled-value">
        禁用复制
      </CopyButton>
      <CopyButton
        data-testid="render-copy-prevented"
        onClick={(event) => event.preventDefault()}
        value="prevented-value"
      >
        阻止复制
      </CopyButton>

      <div data-testid="render-loading-host" style={{ position: 'relative' }}>
        <span>资料库</span>
        <LoadingOverlay data-testid="render-loading-overlay" label="同步中" visible />
      </div>
      <LoadingOverlay data-testid="render-loading-hidden" label="隐藏" visible={false} />

      <Table data-testid="render-table">
        <TableCaption>项目列表</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>名称</TableHead>
            <TableHead>状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>DeepRD</TableCell>
            <TableCell>进行中</TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <Pagination
        data-testid="render-pagination"
        page={page}
        pageCount={12}
        onPageChange={setPage}
      />
      <output data-testid="render-pagination-value">{page}</output>
      <Pagination
        data-testid="render-pagination-disabled"
        disabled
        page={disabledPage}
        pageCount={4}
        onPageChange={setDisabledPage}
      />
      <output data-testid="render-pagination-disabled-value">{disabledPage}</output>
      <Pagination
        data-testid="render-pagination-first"
        page={1}
        pageCount={3}
        onPageChange={() => undefined}
      />
      <Pagination
        data-testid="render-pagination-last"
        page={3}
        pageCount={3}
        onPageChange={() => undefined}
      />
      <Pagination
        data-testid="render-pagination-overflow"
        page={99}
        pageCount={3}
        onPageChange={() => undefined}
      />
      <Pagination
        data-testid="render-pagination-underflow"
        page={-5}
        pageCount={3}
        onPageChange={() => undefined}
      />

      <AspectRatio
        data-testid="render-aspect-ratio"
        ratio={4 / 3}
        style={{ color: 'rgb(4, 5, 6)' }}
      >
        <div data-testid="render-aspect-content">比例内容</div>
      </AspectRatio>

      <Breadcrumb data-testid="render-breadcrumb" label="项目路径">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="#home">首页</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbEllipsis />
          </BreadcrumbItem>
          <BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbLink href="#projects">项目</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbPage>DeepRD</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <Breadcrumb data-testid="render-breadcrumb-custom-ellipsis" label="自定义路径">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="#root">根路径</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbEllipsis label="展开隐藏路径" />
          </BreadcrumbItem>
          <BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbPage>当前节点</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <Collapsible data-testid="render-collapsible" defaultOpen={false}>
        <CollapsibleTrigger data-testid="render-collapsible-trigger">展开详情</CollapsibleTrigger>
        <CollapsibleContent data-testid="render-collapsible-content">折叠内容</CollapsibleContent>
      </Collapsible>

      <Collapsible open={controlledOpen} onOpenChange={setControlledOpen}>
        <CollapsibleTrigger data-testid="render-collapsible-keyboard">键盘展开</CollapsibleTrigger>
        <CollapsibleContent data-testid="render-collapsible-keyboard-content">
          键盘内容
        </CollapsibleContent>
      </Collapsible>

      <Collapsible disabled defaultOpen={false}>
        <CollapsibleTrigger data-testid="render-collapsible-disabled-trigger">
          禁用展开
        </CollapsibleTrigger>
        <CollapsibleContent data-testid="render-collapsible-disabled-content">
          禁用内容
        </CollapsibleContent>
      </Collapsible>
      <output data-testid="render-collapsible-controlled-value">
        {controlledOpen ? 'open' : 'closed'}
      </output>

      <Collapsible animated>
        <CollapsibleTrigger data-testid="render-motion-trigger">展开过程</CollapsibleTrigger>
        <CollapsibleContent data-testid="render-motion-content">
          <p>第一步：检查资料</p>
          <p>第二步：分析结果</p>
          <Button data-testid="render-motion-action">查看详情</Button>
        </CollapsibleContent>
      </Collapsible>

      <Tabs data-testid="render-tabs" value={tabValue} onValueChange={setTabValue}>
        <TabsList aria-label="项目视图">
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="tasks">任务</TabsTrigger>
          <TabsTrigger disabled value="disabled">
            禁用
          </TabsTrigger>
          <TabsTrigger value="settings">设置</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">概览面板</TabsContent>
        <TabsContent value="tasks">任务面板</TabsContent>
        <TabsContent value="disabled">禁用面板</TabsContent>
        <TabsContent value="settings">设置面板</TabsContent>
      </Tabs>
      <output data-testid="render-tabs-value">{tabValue}</output>

      <Tabs data-testid="render-tabs-default">
        <TabsList aria-label="默认页签">
          <TabsTrigger value="alpha">甲</TabsTrigger>
          <TabsTrigger value="beta">乙</TabsTrigger>
        </TabsList>
        <TabsContent value="alpha">甲面板</TabsContent>
        <TabsContent value="beta">乙面板</TabsContent>
      </Tabs>

      <Tabs data-testid="render-tabs-invalid" value="missing" onValueChange={() => undefined}>
        <TabsList aria-label="无效值页签">
          <TabsTrigger value="valid">有效</TabsTrigger>
          <TabsTrigger value="other">其他</TabsTrigger>
        </TabsList>
        <TabsContent value="valid">有效面板</TabsContent>
        <TabsContent value="other">其他面板</TabsContent>
      </Tabs>

      <Tabs data-testid="render-tabs-all-disabled">
        <TabsList aria-label="全禁用页签">
          <TabsTrigger disabled value="first-disabled">
            禁用一
          </TabsTrigger>
          <TabsTrigger disabled value="second-disabled">
            禁用二
          </TabsTrigger>
        </TabsList>
        <TabsContent value="first-disabled">禁用一面板</TabsContent>
        <TabsContent value="second-disabled">禁用二面板</TabsContent>
      </Tabs>

      <Accordion
        data-testid="render-accordion"
        value={accordionValue}
        onValueChange={setAccordionValue}
      >
        <AccordionItem value="summary">
          <AccordionTrigger>摘要</AccordionTrigger>
          <AccordionContent>摘要内容</AccordionContent>
        </AccordionItem>
        <AccordionItem value="detail">
          <AccordionTrigger>详情</AccordionTrigger>
          <AccordionContent>详情内容</AccordionContent>
        </AccordionItem>
        <AccordionItem disabled value="disabled">
          <AccordionTrigger>禁用项</AccordionTrigger>
          <AccordionContent>禁用内容</AccordionContent>
        </AccordionItem>
      </Accordion>
      <output data-testid="render-accordion-value">{accordionValue}</output>

      <Accordion
        data-testid="render-accordion-multiple"
        defaultValue={['first']}
        mode="multiple"
        onValueChange={setAccordionMultiValue}
      >
        <AccordionItem value="first">
          <AccordionTrigger>第一项</AccordionTrigger>
          <AccordionContent>第一项内容</AccordionContent>
        </AccordionItem>
        <AccordionItem value="second">
          <AccordionTrigger>第二项</AccordionTrigger>
          <AccordionContent>第二项内容</AccordionContent>
        </AccordionItem>
      </Accordion>
      <output data-testid="render-accordion-multiple-value">
        {Array.isArray(accordionMultiValue) ? accordionMultiValue.join(',') : accordionMultiValue}
      </output>

      <Accordion
        data-testid="render-accordion-keydown"
        defaultValue="first"
        onKeyDown={() => setAccordionKeyEvents((value) => value + 1)}
      >
        <AccordionItem value="first">
          <AccordionTrigger>键盘一</AccordionTrigger>
          <AccordionContent>键盘一内容</AccordionContent>
        </AccordionItem>
        <AccordionItem value="second">
          <AccordionTrigger>键盘二</AccordionTrigger>
          <AccordionContent>键盘二内容</AccordionContent>
        </AccordionItem>
      </Accordion>
      <output data-testid="render-accordion-keydown-events">{accordionKeyEvents}</output>

      <Accordion
        data-testid="render-accordion-keydown-prevented"
        defaultValue="first"
        onKeyDown={(event) => {
          setBlockedAccordionKeyEvents((value) => value + 1)
          event.preventDefault()
        }}
      >
        <AccordionItem value="first">
          <AccordionTrigger>阻止一</AccordionTrigger>
          <AccordionContent>阻止一内容</AccordionContent>
        </AccordionItem>
        <AccordionItem value="second">
          <AccordionTrigger>阻止二</AccordionTrigger>
          <AccordionContent>阻止二内容</AccordionContent>
        </AccordionItem>
      </Accordion>
      <output data-testid="render-accordion-keydown-prevented-events">
        {blockedAccordionKeyEvents}
      </output>

      <ScrollArea
        data-testid="render-scroll-area"
        orientation="both"
        shadow
        style={{ maxHeight: '80px', maxWidth: '160px' }}
        viewportClassName="render-scroll-area-viewport max-h-10 min-h-0"
        viewportProps={{
          'aria-label': '滚动视口',
          'data-testid': 'render-scroll-area-viewport',
          role: 'region',
          tabIndex: 0,
        }}
        viewportRef={scrollViewportRef}
      >
        <div style={{ width: '320px', height: '160px' }}>
          滚动内容滚动内容滚动内容滚动内容滚动内容滚动内容滚动内容滚动内容
        </div>
      </ScrollArea>

      <ScrollArea
        overlay
        shadow="auto"
        orientation="both"
        data-testid="render-overlay-scroll"
        style={{ height: '80px', width: '160px' }}
        viewportClassName="h-full"
        viewportProps={{ 'aria-label': '覆盖式滚动视口', 'data-testid': 'render-overlay-viewport' }}
      >
        <div style={{ width: '320px', height: '240px' }}>覆盖式滚动内容</div>
      </ScrollArea>

      <Slider
        data-testid="render-slider"
        label="阈值"
        max={100}
        min={0}
        step={5}
        value={sliderValue}
        onValueChange={setSliderValue}
      />
      <output data-testid="render-slider-value">{sliderValue}</output>
      <Slider
        data-testid="render-slider-uncontrolled"
        defaultValue={10}
        max={50}
        min={0}
        step={5}
        onValueChange={() => setUncontrolledSliderChanges((value) => value + 1)}
      />
      <output data-testid="render-slider-uncontrolled-changes">{uncontrolledSliderChanges}</output>
      <Slider
        data-testid="render-slider-vertical"
        defaultValue={50}
        label="纵向阈值"
        max={100}
        min={0}
        orientation="vertical"
        step={10}
      />
      <Slider
        data-testid="render-slider-disabled"
        disabled
        label="禁用阈值"
        value={disabledSliderValue}
        onValueChange={setDisabledSliderValue}
      />
      <output data-testid="render-slider-disabled-value">{disabledSliderValue}</output>

      <InputOTP
        data-testid="render-input-otp"
        description="输入收到的 6 位验证码。"
        label="验证码"
        value={otpValue}
        onComplete={setOtpCompleteValue}
        onValueChange={setOtpValue}
      />
      <output data-testid="render-input-otp-value">{otpValue}</output>
      <output data-testid="render-input-otp-complete">{otpCompleteValue}</output>
      <InputOTP
        data-testid="render-input-otp-text"
        inputMode="text"
        label="文本代码"
        length={4}
        separatorEvery={2}
        value={textOtpValue}
        onValueChange={setTextOtpValue}
      />
      <output data-testid="render-input-otp-text-value">{textOtpValue}</output>
      <InputOTP
        data-testid="render-input-otp-composition"
        inputMode="text"
        label="组合输入"
        length={4}
        value={compositionOtpValue}
        onValueChange={(nextValue) => {
          setCompositionOtpChanges((value) => value + 1)
          setCompositionOtpValue(nextValue)
        }}
      />
      <output data-testid="render-input-otp-composition-value">{compositionOtpValue}</output>
      <output data-testid="render-input-otp-composition-changes">{compositionOtpChanges}</output>
      <InputOTP
        data-testid="render-input-otp-stable"
        inputMode="text"
        label="稳定槽位"
        length={4}
        defaultValue="1234"
        onValueChange={setStableOtpValue}
      />
      <output data-testid="render-input-otp-stable-value">{stableOtpValue}</output>
      <InputOTP
        data-testid="render-input-otp-controlled-slots"
        inputMode="text"
        label="受控槽位"
        length={4}
        slots={controlledOtpSlots}
        onSlotsChange={setControlledOtpSlots}
      />
      <output data-testid="render-input-otp-controlled-slots-value">
        {controlledOtpSlots.map((slot) => slot || '_').join('')}
      </output>
      <InputOTP
        data-testid="render-input-otp-slot-class"
        label="自定义槽位"
        length={4}
        slotProps={{ className: 'custom-otp-slot' }}
      />
      <InputOTP
        data-testid="render-input-otp-invalid"
        error="验证码错误。"
        invalid
        label="错误验证码"
      />
      <InputOTP
        data-testid="render-input-otp-disabled"
        disabled
        label="禁用验证码"
        value={disabledOtpValue}
        onValueChange={setDisabledOtpValue}
      />
      <output data-testid="render-input-otp-disabled-value">{disabledOtpValue}</output>

      <Command
        data-testid="render-command"
        searchValue={commandSearch}
        value={commandValue}
        onSearchValueChange={setCommandSearch}
        onValueChange={setCommandValue}
      >
        <CommandInput data-testid="render-command-input" placeholder="搜索命令" />
        <CommandList data-testid="render-command-list">
          <CommandGroup heading="项目">
            <CommandItem value="open" onSelect={setCommandSelects}>
              打开项目
            </CommandItem>
            <CommandItem keywords={['create']} value="new" onSelect={setCommandSelects}>
              新建项目
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="视图">
            <CommandItem value="list" onSelect={setCommandSelects}>
              切换列表
            </CommandItem>
            <CommandItem disabled value="archive" onSelect={setCommandSelects}>
              归档视图
            </CommandItem>
          </CommandGroup>
          <CommandEmpty>没有匹配命令</CommandEmpty>
        </CommandList>
      </Command>
      <output data-testid="render-command-value">{commandValue}</output>
      <output data-testid="render-command-search">{commandSearch}</output>
      <output data-testid="render-command-selects">{commandSelects}</output>

      <Command data-testid="render-command-default" defaultSearchValue="create" defaultValue="new">
        <CommandInput data-testid="render-command-default-input" placeholder="搜索默认" />
        <CommandList>
          <CommandItem keywords={['create']} value="new">
            新建项目
          </CommandItem>
          <CommandItem value="open">打开项目</CommandItem>
          <CommandEmpty>空</CommandEmpty>
        </CommandList>
      </Command>

      <Command
        data-testid="render-command-disabled"
        disabled
        value={disabledCommandValue}
        onValueChange={setDisabledCommandValue}
      >
        <CommandInput data-testid="render-command-disabled-input" />
        <CommandList>
          <CommandItem value="locked">锁定</CommandItem>
          <CommandItem value="other">其他</CommandItem>
        </CommandList>
      </Command>
      <output data-testid="render-command-disabled-value">{disabledCommandValue}</output>

      <ResizablePanelGroup
        data-testid="render-resizable"
        sizes={resizableSizes}
        onSizesChange={setResizableSizes}
      >
        <ResizablePanel aria-label="左侧" minSize={20}>
          左侧内容
        </ResizablePanel>
        <ResizableHandle aria-label="调整左右面板" data-testid="render-resizable-handle" />
        <ResizablePanel aria-label="右侧" minSize={20}>
          右侧内容
        </ResizablePanel>
      </ResizablePanelGroup>
      <output data-testid="render-resizable-sizes">
        {resizableSizes.map((size) => Math.round(size)).join(',')}
      </output>

      <ResizablePanelGroup data-testid="render-resizable-default" defaultSizes={[25, 75]}>
        <ResizablePanel aria-label="默认左侧" minSize={15}>
          默认左侧
        </ResizablePanel>
        <ResizableHandle aria-label="调整默认面板" data-testid="render-resizable-default-handle" />
        <ResizablePanel aria-label="默认右侧" minSize={15}>
          默认右侧
        </ResizablePanel>
      </ResizablePanelGroup>

      <ResizablePanelGroup data-testid="render-resizable-panel-default">
        <ResizablePanel aria-label="面板默认左侧" defaultSize={35} minSize={20}>
          面板默认左侧
        </ResizablePanel>
        <ResizableHandle
          aria-label="调整面板默认尺寸"
          data-testid="render-resizable-panel-default-handle"
        />
        <ResizablePanel aria-label="面板默认右侧" defaultSize={65} minSize={20}>
          面板默认右侧
        </ResizablePanel>
      </ResizablePanelGroup>

      <ResizablePanelGroup data-testid="render-resizable-default-clamped" defaultSizes={[5, 95]}>
        <ResizablePanel aria-label="约束默认左侧" minSize={20}>
          约束默认左侧
        </ResizablePanel>
        <ResizableHandle
          aria-label="调整约束默认尺寸"
          data-testid="render-resizable-default-clamped-handle"
        />
        <ResizablePanel aria-label="约束默认右侧" maxSize={80} minSize={20}>
          约束默认右侧
        </ResizablePanel>
      </ResizablePanelGroup>

      <ResizablePanelGroup
        data-testid="render-resizable-controlled-clamped"
        sizes={clampedResizableSizes}
        onSizesChange={setClampedResizableSizes}
      >
        <ResizablePanel aria-label="受控约束左侧" maxSize={70} minSize={20}>
          受控约束左侧
        </ResizablePanel>
        <ResizableHandle
          aria-label="调整受控约束尺寸"
          data-testid="render-resizable-controlled-clamped-handle"
        />
        <ResizablePanel aria-label="受控约束右侧" minSize={20}>
          受控约束右侧
        </ResizablePanel>
      </ResizablePanelGroup>
      <output data-testid="render-resizable-controlled-clamped-sizes">
        {clampedResizableSizes.map((size) => Math.round(size)).join(',')}
      </output>

      <ResizablePanelGroup
        data-testid="render-resizable-vertical"
        defaultSizes={[60, 40]}
        direction="vertical"
      >
        <ResizablePanel aria-label="上方面板">上方内容</ResizablePanel>
        <ResizableHandle aria-label="调整上下区域" data-testid="render-resizable-vertical-handle" />
        <ResizablePanel aria-label="下方面板">下方内容</ResizablePanel>
      </ResizablePanelGroup>

      <div className="relative h-[var(--vds-space-10)] w-[var(--vds-floating-conversation-width)]">
        <ResizableHandle
          aria-label="独立调整宽度"
          appearance="invisible"
          className="!absolute inset-y-0 left-1/2 !h-auto !w-[var(--vds-space-3)]"
          data-testid="render-resizable-standalone"
          onOffsetChange={setResizeOffset}
        />
      </div>
      <output data-testid="render-resizable-offset">{resizeOffset}</output>
      <ResizablePanelGroup
        data-testid="render-resizable-disabled"
        disabled
        sizes={disabledResizableSizes}
        onSizesChange={setDisabledResizableSizes}
      >
        <ResizablePanel aria-label="禁用左侧">
          <Button data-testid="render-resizable-disabled-action">面板操作</Button>
        </ResizablePanel>
        <ResizableHandle aria-label="禁用调整" data-testid="render-resizable-disabled-handle" />
        <ResizablePanel aria-label="禁用右侧">禁用右侧</ResizablePanel>
      </ResizablePanelGroup>
      <output data-testid="render-resizable-disabled-sizes">
        {disabledResizableSizes.map((size) => Math.round(size)).join(',')}
      </output>

      <div style={{ height: '200px', width: '900px' }}>
        <ResizablePanel
          data-testid="render-resizable-right-split"
          defaultRightWidth="403px"
          leftPanel={<div data-testid="render-resizable-right-split-left">主工作区</div>}
          maxRightWidth={100}
          minLeftWidth={300}
          minRightWidth={403}
          onRightWidthChangeEnd={setRightSplitWidth}
          rightPanel={<div data-testid="render-resizable-right-split-right">AI 面板</div>}
        />
      </div>
      <output data-testid="render-resizable-right-width">{rightSplitWidth}</output>
      <Button
        data-testid="render-conversation-restore"
        onClick={() => setConversationWidth('420px')}
      >
        Restore conversation width
      </Button>
      <Button data-testid="render-conversation-grow" onClick={() => setConversationHostWidth(1100)}>
        Collapse navigation
      </Button>
      <Button data-testid="render-morph-toggle" onClick={() => setMorph((value) => !value)}>
        Morph conversation
      </Button>
      <Button
        data-testid="render-morph-drag"
        onClick={() => {
          setDraggingMorph((value) => !value)
          setMorph((value) => !value)
        }}
      >
        Drag conversation
      </Button>
      <Button
        data-testid="render-morph-entry"
        onClick={() => {
          setMorphEntry((value) => !value)
          setMorph((value) => !value)
        }}
      >
        Minimize conversation
      </Button>
      <Button
        data-testid="render-morph-position"
        onClick={() => setMorphOffset((value) => (value <= 0 ? 100 : -100))}
      >
        Recalculate dock position
      </Button>
      <Button
        data-testid="render-morph-drop"
        onClick={() => {
          setDraggingMorph(false)
          setMorphOffset((value) => value + 100)
        }}
      >
        Release at same dock
      </Button>
      <Motion
        project="fixture"
        revision={`${morph}:${morphEntry}`}
        dragging={draggingMorph}
        style={{ position: 'relative', width: 800, height: 180 }}
      >
        <div
          data-workbench-motion="conversation"
          data-testid="render-morph-surface"
          data-workbench-motion-kind={morphEntry ? 'entry' : undefined}
          style={{
            position: 'absolute',
            left: (morph ? 500 : 0) + morphOffset,
            top: 0,
            width: morph ? 64 : 300,
            height: morph ? 64 : 160,
          }}
        >
          <Input data-testid="render-morph-draft" aria-label="Conversation draft" />
        </div>
      </Motion>
      <Button data-testid="render-split-toggle" onClick={() => setMotionClosed((value) => !value)}>
        Toggle documents
      </Button>
      <Button
        data-testid="render-navigation-toggle"
        onClick={() => setNavigationClosed((value) => !value)}
      >
        Toggle navigation
      </Button>
      <div style={{ height: '200px', width: '800px' }}>
        <ResizablePanel
          animated
          isLeftCollapsed={navigationClosed}
          leftWidth="260px"
          minLeftWidth={260}
          minRightWidth={260}
          data-testid="render-animated-navigation"
          leftPanel={<Input data-testid="render-navigation-draft" aria-label="Navigation draft" />}
          rightPanel={<div>Workspace</div>}
        />
      </div>
      <div style={{ height: '200px', width: conversationHostWidth }}>
        <ResizablePanel
          animated
          isCollapsed={motionClosed}
          data-testid="render-conversation-split"
          leftWidth={conversationWidth}
          onWidthChangeEnd={setConversationWidth}
          minLeftWidth={260}
          minRightWidth={260}
          maxLeftWidth={75}
          leftPanel={<div>Conversation</div>}
          rightPanel={<div>Documents</div>}
        />
      </div>
      {(['left', 'right'] as const).flatMap((sizedPanel) =>
        [false, true].map((reversed) => (
          <div key={`${sizedPanel}-${reversed}`} style={{ height: '200px', width: '900px' }}>
            <ResizablePanel
              data-testid={`render-split-${sizedPanel}-${reversed}`}
              reversed={reversed}
              leftWidth="350px"
              defaultRightWidth={sizedPanel === 'right' ? '350px' : undefined}
              minLeftWidth={260}
              minRightWidth={260}
              maxLeftWidth={640}
              maxRightWidth={75}
              leftPanel={<div>逻辑左面板</div>}
              rightPanel={<div>逻辑右面板</div>}
            />
          </div>
        ))
      )}
      <div style={{ height: '200px', width: '900px' }}>
        <ResizablePanel
          data-testid="render-resizable-mixed-units"
          defaultRightWidth="50%"
          minLeftWidth={260}
          minRightWidth={260}
          maxRightWidth={75}
          leftPanel={<div>Chat</div>}
          rightPanel={<div data-testid="render-resizable-mixed-right">Workspace</div>}
        />
      </div>

      <Toggle
        data-testid="render-toggle"
        pressed={togglePressed}
        onPressedChange={setTogglePressed}
      >
        筛选
      </Toggle>
      <output data-testid="render-toggle-value">{togglePressed ? 'on' : 'off'}</output>
      <Toggle
        data-testid="render-toggle-uncontrolled"
        defaultPressed
        onPressedChange={() => setUncontrolledToggleChanges((value) => value + 1)}
      >
        默认开启
      </Toggle>
      <output data-testid="render-toggle-uncontrolled-changes">{uncontrolledToggleChanges}</output>
      <Toggle
        data-testid="render-toggle-prevented"
        defaultPressed={false}
        onClick={(event) => event.preventDefault()}
        onPressedChange={() => setUncontrolledToggleChanges((value) => value + 1)}
      >
        阻止切换
      </Toggle>
      <Toggle data-testid="render-toggle-disabled" disabled defaultPressed>
        禁用筛选
      </Toggle>
      <Toggle
        data-testid="render-toggle-disabled-callback"
        disabled
        onPressedChange={() => setDisabledToggleChanges((value) => value + 1)}
      >
        禁用回调
      </Toggle>
      <output data-testid="render-toggle-disabled-changes">{disabledToggleChanges}</output>

      <ToggleGroup
        aria-label="视图切换"
        data-testid="render-toggle-group"
        value={toggleGroupValue}
        onValueChange={setToggleGroupValue}
      >
        <ToggleGroupItem value="list">列表</ToggleGroupItem>
        <ToggleGroupItem value="grid">网格</ToggleGroupItem>
        <ToggleGroupItem disabled value="disabled">
          禁用视图
        </ToggleGroupItem>
        <ToggleGroupItem value="chart">图表</ToggleGroupItem>
      </ToggleGroup>
      <output data-testid="render-toggle-group-value">{toggleGroupValue}</output>

      <ToggleGroup
        aria-label="多选标签"
        data-testid="render-toggle-group-multiple"
        defaultValue={['tag']}
        mode="multiple"
        onValueChange={setToggleMultiValue}
      >
        <ToggleGroupItem value="tag">标签</ToggleGroupItem>
        <ToggleGroupItem value="owner">负责人</ToggleGroupItem>
      </ToggleGroup>
      <output data-testid="render-toggle-group-multiple-value">
        {Array.isArray(toggleMultiValue) ? toggleMultiValue.join(',') : toggleMultiValue}
      </output>

      <SegmentedControl
        aria-label="时间范围"
        data-testid="render-segmented-control"
        value={segmentValue}
        onValueChange={setSegmentValue}
      >
        <ToggleGroupItem value="day">日</ToggleGroupItem>
        <ToggleGroupItem value="week">周</ToggleGroupItem>
      </SegmentedControl>
      <output data-testid="render-segmented-control-value">{segmentValue}</output>

      <ToggleGroup
        aria-label="默认焦点"
        data-testid="render-toggle-group-default"
        onValueChange={setDefaultToggleGroupValue}
      >
        <ToggleGroupItem value="alpha">甲视图</ToggleGroupItem>
        <ToggleGroupItem value="beta">乙视图</ToggleGroupItem>
      </ToggleGroup>
      <output data-testid="render-toggle-group-default-value">{defaultToggleGroupValue}</output>

      <ToggleGroup
        aria-label="无效受控"
        data-testid="render-toggle-group-invalid"
        value={invalidToggleGroupValue}
        onValueChange={setInvalidToggleGroupValue}
      >
        <ToggleGroupItem value="valid">有效视图</ToggleGroupItem>
        <ToggleGroupItem value="other">其他视图</ToggleGroupItem>
      </ToggleGroup>
      <output data-testid="render-toggle-group-invalid-value">{invalidToggleGroupValue}</output>

      <ToggleGroup
        aria-label="全禁用切换"
        data-testid="render-toggle-group-all-disabled"
        value={disabledToggleGroupValue}
        onValueChange={setDisabledToggleGroupValue}
      >
        <ToggleGroupItem disabled value="disabled-a">
          禁用甲
        </ToggleGroupItem>
        <ToggleGroupItem disabled value="disabled-b">
          禁用乙
        </ToggleGroupItem>
      </ToggleGroup>
      <output data-testid="render-toggle-group-all-disabled-value">
        {disabledToggleGroupValue}
      </output>

      <ToggleGroup
        aria-label="垂直切换"
        data-testid="render-toggle-group-vertical"
        orientation="vertical"
        value={verticalToggleGroupValue}
        onValueChange={setVerticalToggleGroupValue}
      >
        <ToggleGroupItem value="top">上方</ToggleGroupItem>
        <ToggleGroupItem value="middle">中间</ToggleGroupItem>
        <ToggleGroupItem value="bottom">下方</ToggleGroupItem>
      </ToggleGroup>
      <output data-testid="render-toggle-group-vertical-value">{verticalToggleGroupValue}</output>

      <Toaster
        aria-label="受控通知"
        data-testid="render-toaster-controlled"
        placement="top-left"
        style={{ position: 'static' }}
        toasts={controlledToasts}
        onDismiss={(id) =>
          setControlledToasts((toasts) => toasts.filter((toast) => toast.id !== id))
        }
      />
      <output data-testid="render-toaster-controlled-count">{controlledToasts.length}</output>

      <div
        data-vds-toast-viewport
        style={{ position: 'relative', width: 320, transform: 'translateX(20px)' }}
      >
        <Toaster
          aria-label="位置通知"
          data-testid="render-toaster-position"
          placement="top-right"
        />
      </div>

      <Toaster
        aria-label="自动通知"
        data-testid="render-toaster-auto"
        placement="bottom-left"
        style={{ position: 'static' }}
        toasts={autoToasts}
        onDismiss={(id) => setAutoToasts((toasts) => toasts.filter((toast) => toast.id !== id))}
      />
      <Button
        data-testid="render-toast-auto-add"
        onClick={() =>
          setAutoToasts([
            {
              description: '短时间后自动消失。',
              duration: 40,
              id: 'auto-toast',
              title: '自动关闭',
              tone: 'warning',
            },
          ])
        }
      >
        添加自动关闭通知
      </Button>
      <output data-testid="render-toaster-auto-count">{autoToasts.length}</output>

      <ToastProvider>
        <ToastQueueDemo />
        <AnnotationSummaryDemo />
        <Toaster
          aria-label="队列通知"
          closeLabel="关闭队列通知"
          data-testid="render-toaster-queue"
          placement="top-right"
          style={{ position: 'static' }}
        />
      </ToastProvider>

      <ToastProvider
        defaultToasts={[
          {
            description: 'provider 队列保留同 id 通知。',
            duration: false,
            id: 'shared-toast',
            title: 'Provider 同 id',
            tone: 'success',
          },
        ]}
      >
        <Toaster
          aria-label="嵌套 provider 队列"
          data-testid="render-toaster-nested-provider"
          placement="bottom-left"
          style={{ position: 'static' }}
        />
        <Toaster
          aria-label="嵌套受控通知"
          data-testid="render-toaster-nested-controlled"
          placement="bottom-right"
          style={{ position: 'static' }}
          toasts={nestedControlledToasts}
          onDismiss={(id) =>
            setNestedControlledToasts((toasts) => toasts.filter((toast) => toast.id !== id))
          }
        />
      </ToastProvider>
      <output data-testid="render-toaster-nested-controlled-count">
        {nestedControlledToasts.length}
      </output>

      <Toaster
        aria-label="无关闭受控通知"
        data-testid="render-toaster-controlled-readonly"
        placement="top-right"
        style={{ position: 'static' }}
        toasts={[
          {
            description: '没有 onDismiss 时不显示关闭，也不自动消失。',
            duration: 40,
            id: 'readonly-toast',
            title: '只读通知',
            tone: 'warning',
          },
        ]}
      />

      <Button data-testid="render-sheet-open" onClick={() => setSheetOpen(true)}>
        打开面板
      </Button>
      <Sheet
        open={sheetOpen}
        onOpenChange={(nextOpen) => {
          setSheetOpenChanges((value) => value + 1)
          setSheetOpen(nextOpen)
        }}
      >
        <SheetPortal>
          <SheetOverlay data-testid="render-sheet-overlay" />
          <SheetContent aria-label="项目详情" data-testid="render-sheet-content" side="right">
            <SheetHeader>
              <SheetTitle>项目详情</SheetTitle>
              <SheetDescription>展示右侧详情 UI 壳层。</SheetDescription>
            </SheetHeader>
            <div>右侧面板内容</div>
            <SheetFooter>
              <SheetClose
                data-testid="render-sheet-close"
                onClick={() => setSheetCloseCount((value) => value + 1)}
              >
                关闭面板
              </SheetClose>
            </SheetFooter>
          </SheetContent>
        </SheetPortal>
      </Sheet>
      <output data-testid="render-sheet-open-value">{sheetOpen ? 'open' : 'closed'}</output>
      <output data-testid="render-sheet-close-count">{sheetCloseCount}</output>
      <output data-testid="render-sheet-open-changes">{sheetOpenChanges}</output>

      <Sheet>
        <SheetTrigger data-testid="render-sheet-trigger">打开可恢复面板</SheetTrigger>
        <SheetPortal>
          <SheetOverlay data-testid="render-sheet-trigger-overlay" />
          <SheetContent data-testid="render-sheet-trigger-content" modal>
            <SheetTitle>可恢复面板</SheetTitle>
            <SheetClose>关闭可恢复面板</SheetClose>
            <Sheet>
              <SheetTrigger data-testid="nested-sheet-trigger">打开子面板</SheetTrigger>
              <SheetContent data-testid="nested-sheet-content">
                <SheetTitle>子面板</SheetTitle>
                <SheetClose data-testid="nested-sheet-close">关闭子面板</SheetClose>
              </SheetContent>
            </Sheet>
          </SheetContent>
        </SheetPortal>
      </Sheet>

      {[false, true].map((showCloseButton) => (
        <AlertDialog key={String(showCloseButton)}>
          <AlertDialogTrigger data-testid={`render-alert-open-${showCloseButton}`}>
            打开确认
          </AlertDialogTrigger>
          <AlertDialogContent showCloseButton={showCloseButton || undefined} aria-label="确认操作">
            <AlertDialogCancel>取消</AlertDialogCancel>
          </AlertDialogContent>
        </AlertDialog>
      ))}

      <Button data-testid="render-dialog-open" onClick={() => setDialogOpen(true)}>
        打开弹窗
      </Button>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          aria-label="属性合并弹窗"
          data-testid="render-dialog-content"
          hideCloseButton
        >
          <DialogClose asChild>
            <Button
              className="absolute right-3 top-3"
              data-testid="render-dialog-close-child"
              variant="ghostIcon"
              onClick={() => setDialogChildClicks((value) => value + 1)}
            >
              ×
            </Button>
          </DialogClose>
          <p>验证 asChild 合并属性。</p>
          <DialogClose data-testid="render-dialog-cancel">取消</DialogClose>
          <Button
            data-testid="dialog-disable-focused-action"
            disabled={dialogActionDisabled}
            onClick={() => setDialogActionDisabled(true)}
          >
            禁用当前操作
          </Button>
          {!dialogActionRemoved && (
            <Button
              data-testid="dialog-remove-focused-action"
              onClick={() => setDialogActionRemoved(true)}
            >
              移除当前操作
            </Button>
          )}
          <Dialog>
            <DialogTrigger asChild>
              <Button data-testid="nested-dialog-open">嵌套弹窗</Button>
            </DialogTrigger>
            <DialogContent aria-label="嵌套弹窗" data-testid="nested-dialog-content">
              <Button>嵌套操作</Button>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>
      <Dialog modal={false}>
        <DialogTrigger asChild>
          <Button data-testid="nonmodal-dialog-open">非模态弹窗</Button>
        </DialogTrigger>
        <DialogContent
          data-testid="nonmodal-dialog-content"
          aria-label="非模态弹窗"
          hideCloseButton
        >
          <Button data-testid="nonmodal-dialog-action">操作</Button>
        </DialogContent>
      </Dialog>
      <Button data-testid="nonmodal-after">后续操作</Button>
      {(['sm', 'md', 'lg'] as const).map((size) => (
        <IconButton
          key={size}
          size={size}
          data-testid={`square-icon-${size}`}
          label={`${size}图标操作`}
          icon="+"
          variant="ghost"
        />
      ))}
      <IconButton
        size="lg"
        data-testid="square-icon-loading"
        label="加载图标操作"
        icon="+"
        loading
      />
      <Select defaultValue="first" size="standard">
        <SelectTrigger data-testid="keyboard-select" aria-label="键盘选择器">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end" data-testid="keyboard-options">
          <SelectItem value="first">第一项</SelectItem>
          <SelectItem value="disabled" disabled>
            禁用项
          </SelectItem>
          <SelectItem value="last">最后项</SelectItem>
        </SelectContent>
      </Select>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button data-testid="focus-menu-trigger">键盘菜单</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent data-testid="focus-menu">
          <DropdownMenuItem data-testid="focus-menu-first">首项</DropdownMenuItem>
          <DropdownMenuItem disabled>禁用项</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="focus-menu-subtrigger">
              子菜单
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent data-testid="focus-menu-sub">
              <DropdownMenuItem>子菜单操作</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem data-testid="focus-menu-last">末项</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button data-testid="trapped-menu-trigger">Trapped menu</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent trapFocus data-testid="trapped-menu">
          <DropdownMenuItem data-testid="trapped-menu-first">First trapped action</DropdownMenuItem>
          <DropdownMenuItem disabled>Disabled trapped action</DropdownMenuItem>
          <DropdownMenuItem data-testid="trapped-menu-last">Last trapped action</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover>
        <PopoverTrigger asChild>
          <Button data-testid="focus-popover-trigger">焦点弹出层</Button>
        </PopoverTrigger>
        <PopoverContent data-testid="focus-popover-content">
          <Checkbox data-testid="focus-popover-checkbox" label="启用选项" />
          <HoverCard>
            <HoverCardTrigger asChild>
              <Button data-testid="nested-hover-trigger">来源明细</Button>
            </HoverCardTrigger>
            <HoverCardContent data-testid="nested-hover-content">
              <Button>打开来源</Button>
            </HoverCardContent>
          </HoverCard>
          <Button data-testid="focus-popover-last">末项</Button>
        </PopoverContent>
      </Popover>
      <Button data-testid="focus-popover-outside">外部操作</Button>
      <div className="fixed left-1/2 top-1/2">
        <HoverCard>
          <HoverCardTrigger asChild>
            <Button data-testid="viewport-hover-card-trigger">查看来源</Button>
          </HoverCardTrigger>
          <HoverCardContent
            className="h-[70vh] w-80 overflow-y-auto"
            data-testid="viewport-hover-card-content"
          >
            <div className="h-[100vh]">原文预览</div>
            <Button data-testid="viewport-hover-card-action">查看原文</Button>
          </HoverCardContent>
        </HoverCard>
      </div>
      <div
        ref={hoverBoundaryRef}
        data-testid="side-hover-boundary"
        className="fixed right-2 top-1/2 w-80"
      >
        <HoverCard>
          <HoverCardTrigger asChild>
            <Button data-testid="side-hover-trigger">来源分类</Button>
          </HoverCardTrigger>
          <HoverCardContent
            side="left"
            sideBoundaryRef={hoverBoundaryRef}
            data-testid="side-hover-content"
            className="w-80"
          >
            <Button data-testid="side-hover-action">打开来源</Button>
          </HoverCardContent>
        </HoverCard>
      </div>
      <output data-testid="render-dialog-child-clicks">{dialogChildClicks}</output>

      <Button data-testid="render-sheet-modal-open" onClick={() => setModalSheetOpen(true)}>
        打开模态面板
      </Button>
      <Sheet open={modalSheetOpen} onOpenChange={setModalSheetOpen}>
        <SheetOverlay data-testid="render-sheet-modal-overlay" />
        <SheetContent data-testid="render-sheet-modal-content" modal side="left">
          <SheetHeader>
            <SheetTitle>模态 opt-in 面板</SheetTitle>
            <SheetDescription>只有显式 modal 时才暴露 aria-modal。</SheetDescription>
          </SheetHeader>
          <SheetFooter>
            <SheetClose data-testid="render-sheet-modal-close">关闭模态面板</SheetClose>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Button data-testid="render-drawer-open" onClick={() => setDrawerOpen(true)}>
        打开抽屉
      </Button>
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
        <DrawerOverlay data-testid="render-drawer-overlay" />
        <DrawerContent data-testid="render-drawer-content" direction="bottom">
          <DrawerHeader>
            <DrawerTitle>移动抽屉</DrawerTitle>
            <DrawerDescription>底部抽屉 UI 壳层。</DrawerDescription>
          </DrawerHeader>
          <div>抽屉内容</div>
          <DrawerFooter>
            <DrawerClose
              data-testid="render-drawer-close"
              onClick={() => setDrawerCloseCount((value) => value + 1)}
            >
              关闭抽屉
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
      <output data-testid="render-drawer-open-value">{drawerOpen ? 'open' : 'closed'}</output>
      <output data-testid="render-drawer-close-count">{drawerCloseCount}</output>

      <Tooltip
        data-i18n-content="examples:tooltip.content"
        data-testid="render-tooltip"
        content="保存当前配置"
        side="top"
      >
        <Button>保存配置</Button>
      </Tooltip>

      <Tooltip data-testid="render-tooltip-focus" defaultOpen={false} side="right">
        <TooltipTrigger asChild>
          <Button>聚焦说明</Button>
        </TooltipTrigger>
        <TooltipContent>聚焦时显示提示</TooltipContent>
      </Tooltip>

      <Tooltip
        data-testid="render-tooltip-controlled"
        open={tooltipOpen}
        onOpenChange={(nextOpen) => {
          setTooltipOpenChangeCount((value) => value + 1)
          setTooltipOpen(nextOpen)
        }}
        side="bottom"
      >
        <TooltipTrigger asChild>
          <Button>受控说明</Button>
        </TooltipTrigger>
        <TooltipContent>受控提示内容</TooltipContent>
      </Tooltip>
      <output data-testid="render-tooltip-controlled-value">
        {tooltipOpen ? 'open' : 'closed'}
      </output>
      <output data-testid="render-tooltip-controlled-changes">{tooltipOpenChangeCount}</output>

      <span id="tooltip-existing-help">已有说明</span>
      <Tooltip data-testid="render-tooltip-custom-id" side="bottom">
        <TooltipTrigger asChild>
          <Button aria-describedby="tooltip-existing-help">自定义 ID 说明</Button>
        </TooltipTrigger>
        <TooltipContent id="tooltip-custom-content">自定义 ID 提示</TooltipContent>
      </Tooltip>

      <span id="tooltip-trigger-wrapper-help">触发器外层说明</span>
      <Tooltip data-testid="render-tooltip-trigger-wrapper-description" side="top">
        <TooltipTrigger asChild aria-describedby="tooltip-trigger-wrapper-help">
          <Button>外层描述说明</Button>
        </TooltipTrigger>
        <TooltipContent>外层描述提示</TooltipContent>
      </Tooltip>

      <Tooltip data-testid="render-tooltip-default-open" defaultOpen side="left">
        <TooltipTrigger asChild>
          <Button>默认打开</Button>
        </TooltipTrigger>
        <TooltipContent>默认提示内容</TooltipContent>
      </Tooltip>

      <Tooltip data-testid="render-tooltip-default-open-custom-id" defaultOpen side="top">
        <TooltipTrigger asChild>
          <Button>默认自定义 ID</Button>
        </TooltipTrigger>
        <TooltipContent id="tooltip-default-open-custom-content">默认自定义 ID 提示</TooltipContent>
      </Tooltip>

      <Tooltip
        data-testid="render-tooltip-uncontrolled-events"
        onOpenChange={() => setTooltipUncontrolledOpenChanges((value) => value + 1)}
        side="top"
      >
        <TooltipTrigger asChild>
          <Button>非受控事件说明</Button>
        </TooltipTrigger>
        <TooltipContent>非受控事件提示</TooltipContent>
      </Tooltip>
      <output data-testid="render-tooltip-uncontrolled-changes">
        {tooltipUncontrolledOpenChanges}
      </output>

      <Tooltip data-testid="render-tooltip-disabled" content="禁用提示" disabled side="top">
        <Button>禁用说明</Button>
      </Tooltip>
      <Tooltip
        data-testid="render-tooltip-toggle-disabled"
        content="动态禁用提示"
        disabled={tooltipTemporarilyDisabled}
        portalled
      >
        <Button onClick={() => setTooltipTemporarilyDisabled(true)}>点击禁用提示</Button>
      </Tooltip>
      <Button onClick={() => setTooltipTemporarilyDisabled(false)}>重新启用提示</Button>
    </main>
  )
}

const localization = createLocalization('zh', resources, { escapeValue: false })
createRoot(document.getElementById('root')!).render(
  <I18nextProvider i18n={localization}>
    <Fixture />
  </I18nextProvider>
)
