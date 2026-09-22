/**
 * content 域前端契约（开发 1 拥有）。
 *
 * 与 `service/platform/content.py` 一一对应。跨 Feature 传递资产时用这里的
 * 类型，不传绝对路径 —— 架构文档 §2.3 要求只提交稳定 ID。
 */

/** 资产种类。 */
export type AssetKind = 'file' | 'dir'

/** 导入模式（PRD「资料导入」的复制/关联双卡片）。 */
export type ImportMode = 'copy' | 'link'

/**
 * 项目内被登记/监听的根，与后端 `platform/content.py:RootKind` 一一对应。
 * 资料树只认 `resources`；literature / artifacts / sessions 三个根的事件走同一条
 * SSE 广播过来，但都不应触发资料树重取——这正是新建空项目闪屏的根因。
 */
export type RootKind = 'resources' | 'literature' | 'artifacts' | 'sessions'

/**
 * 项目显示名长度上限（PRD「新建项目」：最长 100 个字符）。
 *
 * 前端唯一来源，与后端 `content/domain/naming.py` 的 `DISPLAY_NAME_MAX` 同值。
 * 输入框靠 maxLength 先挡住，后端超长仍会抛 `name_too_long` 兜底。
 */
export const PROJECT_NAME_MAX = 100

/**
 * 项目目录布局。
 *
 * `legacy` 是「选一个本地文件夹即项目」的存量形态（资料铺在项目根下），
 * `managed` 是内置双库形态（`resources/`、`literature/`）。UI 要能区分：存量项目
 * 没有双库，把它当 managed 渲染会显示两个不存在的目录。
 */
export type ProjectLayout = 'managed' | 'legacy'

/**
 * 资产来源。`link` 节点的物理文件在项目外，改名/删除作用于原始文件，
 * 因此必须与项目内副本在界面上可区分。
 */
export type AssetOrigin = 'local' | 'link'

/**
 * 一份资产的稳定引用。
 *
 * `path` 是相对项目根的 posix 路径，作为跨 Feature 唯一标识。
 * 绝对路径只在需要调原生能力（访达、废纸篓）时由后端按需回报。
 */
export interface FileAssetRef {
  path: string
  name: string
  kind: AssetKind
  origin?: AssetOrigin
}

/** 文件事件类型。`rescan` 不是文件事件，是「整棵树重取」的指令。 */
export type FileEventKind = 'created' | 'modified' | 'deleted' | 'moved' | 'rescan'

/** 变更来源。`product` 是产品自己写的，前端本来就知道，不必二次刷新。 */
export type EventSource = 'product' | 'external'

/**
 * 文件变更事件（proposal 47 §6.2(c)）。
 *
 * `epoch` + `seq` 是断线续传的全部依据：epoch 变了说明后端重启过，手上的 seq
 * 不再可比，必须整棵树重取而不是接着往后读——那是静默错位，比丢事件更糟。
 */
export interface FileEvent {
  epoch: string
  seq: number
  project_id: string
  root: RootKind
  kind: FileEventKind
  path: string
  source: EventSource
  previous_path: string | null
}

/*
 * 与后端 `FileAssetRef` 的一处**有意**差异：后端记录带 `project_id`，前端不补。
 * 理由：前端的项目上下文只有一个（当前项目），每个节点重复带一遍是冗余字段，
 * 而冗余字段一旦与上下文不一致就会产生「这个节点属于哪个项目」的第二个答案。
 * 提交给后端的请求由调用方从上下文附上 project。
 *
 */

/** 资料树节点。目录带 children 与 count。 */
export interface AssetTreeNode extends FileAssetRef {
  count?: number | null
  children?: AssetTreeNode[]
}

/** 项目引用。`name` 是显示名，可改；`root` 的目录名不跟随改名。 */
export interface ProjectRef {
  id: string
  name: string
  root: string
  layout: ProjectLayout
  /** 目录当前可访问。false = 关联/项目失效，与「空项目」不是一回事。 */
  available: boolean
  /** 登记时间（秒）。列表已按它倒序返回，前端不必再排。 */
  created_at?: number | null
  /** 归档时间（秒）。非空即已归档：默认列表不显示，身份与路径解析不受影响。 */
  archived_at?: number | null
}

/** 一处被授权的项目外根。`sourcePath` 只用于原生能力提示，不参与业务寻址。 */
export interface ExternalRootRef {
  rootId: string
  projectId: string
  mountPath: string
  sourcePath: string
  kind: AssetKind
  authorizedAt: number
  available: boolean
}

/** 后端稳定错误码。前端按码分支，不按文案。 */
export type ContentErrorCode =
  | 'path_outside_project'
  | 'invalid_name'
  | 'file_not_found'
  | 'node_not_found'
  | 'not_text_file'
  | 'file_too_large'
  | 'no_project_selected'
  | 'unknown_project'
  | 'write_failed'
  | 'authorized_root_unavailable'
  | 'parent_not_writable'
  | 'read_failed'
  | 'name_required'
  | 'name_too_long'
  | 'no_workspace_root'
  | 'project_directory_exists'
  | 'project_create_failed'
  | 'mount_conflict'
  | 'mount_required'
  | 'invalid_mount'
  | 'root_exists'
  | 'unknown_root'
  | 'root_already_revoked'
  | 'source_not_found'
  | 'source_not_supported'
  | 'source_inside_project'
  | 'source_contains_project'
  | 'invalid_trash_token'
  | 'cannot_archive_current_project'
