# Desktop业务覆盖与全用例分级索引

**current / draft**：唯一目录88点、六分片105条用例，全部绑定；不是运行结果。资料库23、文献25、AI对话23、技能中心13、项目10、模型与账户设置11；P0/P1/P2/P3=10/45/44/6。目录76 manual_ready / 12 partial只是资产声明；新增20及补证9不代表全套执行。详见[本轮入库与分级](intake.md)，前次[增量来源](observations-incremental.md)保留历史。

本次补齐29点P1输入与Check映射；该次第二档41点/51必需Check（历史）；新PDF拆档后第二档43点/54必需Check，默认P0不变。专用账号、Zotero、模型预算和平台实测仍需运行前核；历史观察未改为通过。见[P1配套资产](../p1-assets/README.md)。

## 业务线 → 入口 → 点位 → 用例 → Check → A/B → 资产状态

| 业务线 / 专项 | 入口（目录记录） | 稳定点位 | 候选用例ID | 已登记Check ID / 类型 | 点位类型 | 资产状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 资料库 | 资料库导入本地资料 | `RES-DOCX-01@1` · P0 | `D4-RES-001` | `RES-DOCX`（mixed） | mixed | `manual_ready`（资产声明；非运行通过） |
| 资料库 | 资料库导入本地资料 | `RES-XLSX-01@1` · P0 | `D4-RES-002` | `RES-XLSX`（mixed） | mixed | `manual_ready`（资产声明；非运行通过） |
| 资料库 | 资料库导入本地资料 | `RES-MD-01@1` · P0 | `D4-RES-003` | `RES-MD`（mixed） | mixed | `manual_ready`（资产声明；非运行通过） |
| 资料库 | 资料库导入本地资料 | `RES-PDF-01@1` · P0 | `D4-RES-004` | `RES-PDF`（mixed） | mixed | `manual_ready`（资产声明；非运行通过） |
| 文献全览 | 文献全览的文献附件 | `LIT-PDF-OPEN-01@2` · P0 | `D4-LIT-001` | `LIT-OPEN`（A）、`LIT-EVIDENCE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献全览 | 文献附件 PDF 的选区解释 | `LIT-PDF-EXPLAIN-01@2` · P0 | `D4-LIT-002` | `LIT-EXPLAIN`（A）、`LIT-EVIDENCE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献全览 | 文献附件 PDF 的选区翻译 | `LIT-PDF-TRANSLATE-01@2` · P0 | `D4-LIT-003` | `LIT-TRANSLATE`（A）、`LIT-EVIDENCE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 对话 | AI 对话输入框 | `CHAT-TURN-01@1` · P0 | `D4-CHAT-001` | `CHAT-TURN`（A）、`CHAT-QUALITY`（B）、`CHAT-BOUNDARY`（A）、`CHAT-FOLLOWUP`（mixed） | mixed | `manual_ready`（资产声明；非运行通过） |
| 文献全览 | 文献全览中的 AI 对话检索 | `DISC-NEW-PAPER-01@1` · P0 | `D4-LIT-004` | `DISC-ENTRY`（A）、`DISC-NEW`（A）、`DISC-SOURCE`（mixed）、`DISC-BOUNDARY`（A） | mixed | `manual_ready`（资产声明；非运行通过） |
| 项目 | 项目总览的新建项目 | `PROJ-CREATE-01@4` · P1 | `D6-PROJ-001`、`D6-PROJ-005` | `PROJ-CREATE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 项目 | 新建项目表单的选择目录 | `PROJ-ADOPT-01@3` · P2 | `D6-PROJ-003`、`D6-PROJ-004` | `PROJ-ADOPT`（A）、`PROJ-ADOPT-CANCEL`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 项目 | 项目总览中的项目卡片 | `PROJ-SWITCH-01@3` · P1 | `D6-PROJ-002` | `PROJ-SWITCH-SCOPE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 资料库管理 | 资料库导入本地资料的复制选项 | `RES-COPY-DIR-01@3` · P1 | `D4-RES-005`、`D4-RES-015` | `RES-COPY-DIR`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 资料库管理 | 资料库导入本地资料的关联选项 | `RES-LINK-DIR-01@3` · P2 | `D4-RES-006` | `RES-LINK-DIR`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 资料库管理 | 资料导入冲突弹窗的重命名导入 | `RES-CONFLICT-RENAME-01@4` · P1 | `D4-RES-007`、`D4-RES-016` | `RES-CONFLICT-RENAME`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 资料库管理 | 资料导入冲突弹窗的替换导入 | `RES-CONFLICT-REPLACE-01@4` · P1 | `D4-RES-008` | `RES-CONFLICT-REPLACE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 资料库管理 | 资料树新增菜单的新建文件夹 | `RES-CREATE-FOLDER-01@3` · P2 | `D4-RES-009` | `RES-CREATE-FOLDER`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 资料库管理 | 资料树新增菜单的新建文档 | `RES-CREATE-MD-01@4` · P2 | `D4-RES-010` | `RES-CREATE-MD`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 资料库管理 | 资料节点右键菜单的重命名 | `RES-RENAME-01@4` · P2 | `D4-RES-011` | `RES-RENAME`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 资料库管理 | 资料树移动操作（历史拖拽线索，当前真实提交入口待核） | `RES-MOVE-01@4` · P2 | `D4-RES-012` | `RES-MOVE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 资料库管理 | 资料列表的搜索与筛选控件 | `RES-LIST-FILTER-01@3` · P2 | `D4-RES-013`、`D4-RES-017` | `RES-FILTER-NAME`（A）、`RES-FILTER-TYPE`（A）、`RES-FILTER-SOURCE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 资料库管理 | 项目资料节点加入当前任务，或AI对话加号菜单引用资料库（按当前构建核入口） | `RES-CHAT-REF-01@4` · P1 | `D4-RES-014`、`D4-RES-018` | `RES-CHAT-REF`（mixed） | mixed | `manual_ready`（资产声明；非运行通过） |
| 文献全览管理 | 文献全览导入本地 PDF | `LIT-IMPORT-PDF-01@3` · P1 | `D4-LIT-005` | `LIT-IMPORT-PDF`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献全览管理 | 文献全览的 DOI/arXiv 标识导入 | `LIT-IMPORT-ID-01@3` · P2 | `D4-LIT-006` | `LIT-IMPORT-DOI`（A）、`LIT-IMPORT-ARXIV`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献全览管理 | 文献全览的书目文件导入 | `LIT-IMPORT-BIB-01@4` · P2 | `D4-LIT-007` | `LIT-IMPORT-BIB`（A）、`LIT-IMPORT-RIS`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献全览管理 | 文献全览列表搜索框 | `LIT-LIST-SEARCH-01@3` · P2 | `D4-LIT-008` | `LIT-LIST-SEARCH`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献全览管理 | 文献全览侧栏的新建分类 | `LIT-CREATE-COLLECTION-01@3` · P2 | `D4-LIT-009` | `LIT-CREATE-COLLECTION`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献全览管理 | 文献详情的分类关联操作 | `LIT-JOIN-COLLECTION-01@3` · P2 | `D4-LIT-010` | `LIT-JOIN-COLLECTION`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献全览管理 | 文献详情的项目关联操作 | `LIT-JOIN-PROJECT-01@5` · P1 | `D4-LIT-011` | `LIT-JOIN-PROJECT`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献全览管理 | 文献详情中的元数据字段 | `LIT-EDIT-META-01@4` · P2 | `D4-LIT-012` | `LIT-EDIT-META`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献全览管理 | 文献详情的添加附件 | `LIT-ADD-ATTACHMENT-01@4` · P1 | `D4-LIT-013` | `LIT-ADD-ATTACHMENT`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献全览管理 | 文献详情的新增笔记 | `LIT-NOTE-01@4` · P2 | `D4-LIT-014` | `LIT-NOTE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献 PDF 阅读 | 文献 PDF 阅读器的大纲 | `LIT-PDF-OUTLINE-01@4` · P2 | `D4-LIT-016` | `LIT-PDF-OUTLINE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献 PDF 阅读 | 文献 PDF 选区工具的高亮 | `LIT-PDF-ANNOTATE-01@3` · P2 | `D4-LIT-017` | `LIT-PDF-ANNOTATE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献 PDF 阅读 | 文献 PDF 标注记录的查看原文 | `LIT-PDF-ANNOTATION-LOCATE-01@3` · P2 | `D4-LIT-018` | `LIT-PDF-ANNOTATION-LOCATE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献 PDF 阅读 | 文献 PDF 阅读器的文档翻译 | `LIT-PDF-DOCUMENT-TRANSLATE-01@3` · P1 | `D4-LIT-019` | `LIT-DOCUMENT-TRANSLATE`（mixed） | mixed | `manual_ready`（资产声明；非运行通过） |
| 文献 PDF 阅读 | 文献 PDF 阅读器的 AI 解读 | `LIT-PDF-SUMMARY-01@3` · P1 | `D4-LIT-020` | `LIT-DOCUMENT-SUMMARY`（mixed） | mixed | `manual_ready`（资产声明；非运行通过） |
| 文献全览管理 | 文献 AI 检索结果的加入文献库 | `LIT-SEARCH-SAVE-01@4` · P1 | `D4-LIT-015` | `LIT-SEARCH-SAVE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 对话管理 | 侧栏的新对话 | `CHAT-NEW-01@3` · P1 | `D4-CHAT-002` | `CHAT-NEW`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 对话管理 | 侧栏历史会话列表 | `CHAT-HISTORY-01@3` · P1 | `D4-CHAT-003`、`D4-CHAT-011` | `CHAT-HISTORY`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 对话管理 | 侧栏会话搜索 | `CHAT-SEARCH-01@4` · P2 | `D4-CHAT-004` | `CHAT-SEARCH`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 对话管理 | 侧栏会话操作的重命名 | `CHAT-RENAME-01@2` · P3 | `D4-CHAT-005` | —（未登记） | A | `partial`（资产声明；非运行通过） |
| 对话 | 已有会话的对话输入框 | `CHAT-FOLLOWUP-01@3` · P1 | `D4-CHAT-006`、`D4-CHAT-012` | `CHAT-REVISION`（mixed） | mixed | `manual_ready`（资产声明；非运行通过） |
| 对话 | 对话运行中的停止按钮 | `CHAT-STOP-01@4` · P1 | `D4-CHAT-007`、`D4-CHAT-013` | `CHAT-STOP`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 对话 | 对话运行中的输入框发送 | `CHAT-QUEUE-01@4` · P2 | `D4-CHAT-008` | `CHAT-QUEUE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 对话 | 对话输入区的模型选择器 | `CHAT-MODEL-SWITCH-01@3` · P1 | `D4-CHAT-009` | `CHAT-MODEL-SWITCH`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 对话 | 对话输入区加号菜单的添加文件 | `CHAT-LOCAL-FILE-01@3` · P1 | `D4-CHAT-010`、`D4-CHAT-014` | `CHAT-LOCAL-FILE`（mixed） | mixed | `manual_ready`（资产声明；非运行通过） |
| 全局搜索 | 全局搜索面板 | `SEARCH-GLOBAL-01@4` · P2 | `D6-CHAT-004` | `SEARCH-RESOURCE`（A）、`SEARCH-LITERATURE`（A）、`SEARCH-SESSION`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 技能 | 客户端技能页 | `SKILL-BROWSE-01@4` · P2 | `D4-SKILL-001`、`D4-SKILL-002`、`D4-SKILL-003`、`D4-SKILL-004`、`D4-SKILL-005`、`D4-SKILL-006` | `SKILL-BROWSE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 模型配置 | 头像菜单的设置 → 模型服务配置 | `MODEL-CONFIG-01@5` · P1 | `D6-SET-001`、`D6-SET-005` | `MODEL-SAVE-SELECT`（A）、`MODEL-KEY-REDACTION`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 账户 | 客户端账户入口的应用内登录交接（具体未登录入口待核） | `ACCOUNT-LOGIN-01@3` · P1 | `D6-SET-002` | `ACCOUNT-LOGIN`（A）、`ACCOUNT-RESTORE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 技能 | 技能中心内置技能详情 → 使用技能 → 新任务的技能引用 | `SKILL-INVOKE-01@2` · P0 | `D4-SKILL-008`、`D6-SKILL-004` | `SKILL-SELECT`（A）、`SKILL-RESULT`（B）、`SKILL-BOUNDARY`（A） | mixed | `manual_ready`（资产声明；非运行通过） |
| 模型配置 | 头像菜单设置中的模型服务与模型配置 | `MODEL-CATALOG-01@2` · P2 | `D6-SET-003` | `MODEL-CATALOG`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 账户 | 模块导航头像菜单 | `ACCOUNT-STATE-01@1` · P2 | `D6-SET-004` | `ACCOUNT-STATE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 项目 | 项目卡片操作 → 编辑项目 → project-edit-name / project-save | `PROJ-EDIT-01@3` · P2 | `D6-PROJ-006` | `PROJ-EDIT`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 项目 | 项目卡片操作 → 归档项目 → home-archive-confirm → 设置归档管理 | `PROJ-ARCHIVE-01@2` · P1 | `D6-PROJ-007` | `PROJ-ARCHIVE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 项目 | 设置 → 归档管理 → account-archived-restore-ID | `PROJ-RESTORE-01@2` · P1 | `D6-PROJ-008` | `PROJ-RESTORE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 连接器 | 技能中心 → 连接器 → 添加连接器 → custom-connector-dialog → 预览配置 | `CONNECTOR-VALIDATE-01@2` · P2 | `D6-SKILL-001` | —（未登记） | A | `partial`（资产声明；非运行通过） |
| 连接器 | 技能中心 → 连接器 → 添加连接器 → JSON → 预览配置 / 我的 | `CONNECTOR-PREVIEW-01@1` · P2 | `D6-SKILL-002` | —（未登记） | A | `partial`（资产声明；非运行通过） |
| 技能管理 | 技能中心 → skills-add → 本地上传 → skill-install → skills-tab-user → 详情 | `SKILL-INSTALL-LOCAL-01@1` · P1 | `D6-SKILL-003` | —（未登记） | A | `partial`（资产声明；非运行通过） |
| 会话管理 | 目标回复 → message-fork-task | `CHAT-BRANCH-01@2` · P2 | `D6-CHAT-001` | `CHAT-BRANCH`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 会话管理 | workspace-conversation-menu → 归档任务 → task-archive-submit | `CHAT-ARCHIVE-01@2` · P1 | `D6-CHAT-002` | `CHAT-ARCHIVE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 会话管理 | project-archive-toggle → 悬停目标归档行 → 恢复任务 | `CHAT-RESTORE-01@2` · P1 | `D6-CHAT-003` | `CHAT-RESTORE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献全览管理 | 文献标签区 → 新建标签 → 添加到标签 → 选择标签 | `LIT-TAG-FILTER-01@2` · P2 | `D6-LIT-001` | `LIT-TAG-FILTER`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 模型配置 | 设置 → 模型服务 → 模型配置 → 目标模型combobox → 新任务模型标签 | `MODEL-REASONING-01@2` · P2 | `D6-SET-006` | `MODEL-REASONING`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 技能管理 | 技能详情 → 启用/停用 → 新任务slash技能选择器 | `SKILL-ENABLE-01@2` · P1 | `D4-SKILL-007` | —（未登记） | A | `partial`（资产声明；非运行通过） |
| 项目 | 项目首页卡片操作 → 置顶 | `PROJ-PIN-01@1` · P3 | `D6-PROJ-009` | —（未登记） | A | `partial`（资产声明；非运行通过） |
| 项目 | 项目首页 → 搜索项目 | `PROJ-FILTER-01@2` · P2 | `D6-PROJ-010` | `PROJ-FILTER`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 资料库 | Markdown编辑器 → 版本历史 → 查看版本/恢复 | `RES-VERSION-RESTORE-01@2` · P1 | `D6-RES-001` | `RES-VERSION-RESTORE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 资料库 | 资料文件更多操作 → 创建副本 | `RES-DUPLICATE-01@2` · P2 | `D6-RES-002` | `RES-DUPLICATE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 资料库 | Markdown编辑器 → Markdown查看方式 | `RES-VIEW-MODE-01@2` · P2 | `D6-RES-003` | `RES-VIEW-MODE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 文献 | 文献中心 → 设置显示列 | `LIT-COLUMNS-01@1` · P3 | `D6-LIT-002` | —（未登记） | A | `partial`（资产声明；非运行通过） |
| 文献 | 文献中心 → 导入文献 → 从Zotero导入 | `LIT-IMPORT-ZOTERO-01@2` · P1 | `D6-LIT-003` | `LIT-IMPORT-ZOTERO`（A） | A | `manual_ready`（资产声明；非运行通过） |
| AI对话 | AI对话文件交付 → 产物卡/任务概览/项目任务产物 | `CHAT-ARTIFACT-01@2` · P1 | `D6-CHAT-005` | `CHAT-ARTIFACT`（mixed） | mixed | `manual_ready`（资产声明；非运行通过） |
| AI对话 | 对话产物卡 → 导入资料库 → 保存到资料库 | `CHAT-ARTIFACT-IMPORT-01@2` · P1 | `D6-CHAT-006` | `CHAT-ARTIFACT-IMPORT`（A） | A | `manual_ready`（资产声明；非运行通过） |
| AI对话 | AI对话加号菜单 → 引用任务 | `CHAT-TASK-REF-01@2` · P1 | `D6-CHAT-007` | `CHAT-TASK-REF`（B） | B | `manual_ready`（资产声明；非运行通过） |
| AI对话 | AI对话加号菜单 → 引用文献库 | `CHAT-LIT-REF-01@2` · P1 | `D6-CHAT-008` | `CHAT-LIT-REF`（B） | B | `manual_ready`（资产声明；非运行通过） |
| AI对话 | 项目工作区 → 新标签页及已打开资料标签 | `CHAT-WORKSPACE-TABS-01@2` · P2 | `D6-CHAT-009` | `CHAT-WORKSPACE-TABS`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 技能中心 | 技能中心连接器详情或设置MCP服务入口 | `CONNECTOR-AUTH-01@1` · P1 | `D6-SKILL-005` | —（未登记） | mixed | `partial`（资产声明；非运行通过） |
| 模型与账户设置 | 设置 → 模型服务 → 模型配置 → 上下文窗口 | `MODEL-CONTEXT-01@2` · P2 | `D6-SET-007` | `MODEL-CONTEXT`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 资料库 | 设置 → 资料库文件 → 文件自动保存 | `RES-AUTOSAVE-01@2` · P1 | `D6-RES-004` | `RES-AUTOSAVE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 资料库 | 设置 → 资料库文件 → 版本数量/最大文件大小 | `RES-VERSION-POLICY-01@2` · P2 | `D6-RES-005` | `RES-VERSION-COUNT`（A）、`RES-VERSION-SIZE`（A） | A | `manual_ready`（资产声明；非运行通过） |
| 模型与账户设置 | 设置 → AI提示词 → 解读/翻译/润色/图表解释 | `MODEL-PROMPTS-01@1` · P2 | `D6-SET-008` | —（未登记） | B | `partial`（资产声明；非运行通过） |
| 模型与账户设置 | 设置 → 通知及消息中心 | `NOTIFICATION-01@1` · P2 | `D6-SET-009` | —（未登记） | A | `partial`（资产声明；非运行通过） |
| 模型与账户设置 | 设置 → 数据存储 → 项目根目录 | `STORAGE-CONFIG-01@1` · P1 | `D6-SET-010` | —（未登记） | A | `partial`（资产声明；非运行通过） |
| 模型与账户设置 | 设置 → 浏览器 → 浏览历史 | `BROWSER-HISTORY-01@1` · P2 | `D6-SET-011` | —（未登记） | A | `partial`（资产声明；非运行通过） |
| 文献全览 | 文献附件 PDF 的选区解释 | `LIT-PDF-EXPLAIN-QUALITY-01@1` · P1 | `D6-LIT-004` | `LIT-EXPLAIN-QUALITY`（B）、`LIT-QUALITY-EVIDENCE`（A） | mixed | `manual_ready`（资产声明；非运行通过） |
| 文献全览 | 文献附件 PDF 的选区翻译 | `LIT-PDF-TRANSLATE-QUALITY-01@1` · P1 | `D6-LIT-005` | `LIT-TRANSLATE-QUALITY`（B）、`LIT-QUALITY-EVIDENCE`（A） | mixed | `manual_ready`（资产声明；非运行通过） |

## 缺口与默认方向

- 默认P0仍五方向、10主用例、18必需Check与1可选Check；启动失败是前提阻塞，下游not_evaluated，不逐条判fail。准备另计，正式30分钟从首个必需业务动作起，不把项目创建/导入倒移到准备。
- 表内方向与catalog逐档投影不同。SKILL-MGMT-01、CONNECTOR-01、APP-SET-01共9点为表外候选，不自动扩默认；表内新来源仅相关点/方向待审，不作整库失效。
- 引用来源、上下文窗口保存、有效排队、移动及专用认证保留精确缺口。跨项目搜索补了空项目对照，但未完成所有关联后跳转/隔离分支；缺证据不把期望改成当前表现。
- 仅版本化macOS局部观察，Windows另做实机验证；无获批需求，不计正式覆盖。评测与产品修复严格分离，执行前准备校验冻结，不边测边补资产或改判据。

## 全用例分级索引

本表由当前分片投影，按P0→P3、业务域、稳定ID展示，不重排或复制可编辑用例。分级原则与16项既有调级理由见[intake](intake.md#priority-review)。partial仍保留计划分母，不因本表列出就可执行；点数、用例数、Check数分别计算。

| 用例ID | 等级 | 业务域 | 用例 | 业务点 | 目录资产状态 |
| --- | --- | --- | --- | --- | --- |
| `D4-SKILL-008` | P0 | 技能中心 | 从技能中心显式选择内置技能完成只读任务 | `SKILL-INVOKE-01@2` | manual_ready |
| `D4-LIT-001` | P0 | 文献 | 打开文献附件 PDF 并读取文字 | `LIT-PDF-OPEN-01@2` | manual_ready |
| `D4-LIT-002` | P0 | 文献 | 解释文献 PDF 指定选区 | `LIT-PDF-EXPLAIN-01@2` | manual_ready |
| `D4-LIT-003` | P0 | 文献 | 翻译文献 PDF 指定选区 | `LIT-PDF-TRANSLATE-01@2` | manual_ready |
| `D4-LIT-004` | P0 | 文献 | 从文献全览 AI 对话发现新题录 | `DISC-NEW-PAPER-01@1` | manual_ready |
| `D4-RES-001` | P0 | 资料库 | DOCX 资料导入、打开并用于回答 | `RES-DOCX-01@1` | manual_ready |
| `D4-RES-002` | P0 | 资料库 | XLSX 资料导入、打开并用于回答 | `RES-XLSX-01@1` | manual_ready |
| `D4-RES-003` | P0 | 资料库 | Markdown 资料导入、打开并用于回答 | `RES-MD-01@1` | manual_ready |
| `D4-RES-004` | P0 | 资料库 | 资料库 PDF 资料导入、打开并用于回答 | `RES-PDF-01@1` | manual_ready |
| `D4-CHAT-001` | P0 | AI对话 | 完成真实单轮研究问题回答 | `CHAT-TURN-01@1` | manual_ready |
| `D6-SKILL-003` | P1 | 技能中心 | 本地合成技能预览安装后读回来源与版本 | `SKILL-INSTALL-LOCAL-01@1` | partial |
| `D6-SKILL-004` | P1 | 技能中心 | 本地安装技能显式选择后进入真实回合 | `SKILL-INVOKE-01@2` | partial |
| `D6-SKILL-005` | P1 | 技能中心 | 获准连接器认证连通后进入可见工具并被任务消费 | `CONNECTOR-AUTH-01@1` | partial |
| `D6-SET-001` | P1 | 模型与账户设置 | 保存获准模型服务后可选择目标模型 | `MODEL-CONFIG-01@5` | manual_ready |
| `D6-SET-002` | P1 | 模型与账户设置 | 专用账户登录后恢复正确身份状态 | `ACCOUNT-LOGIN-01@3` | manual_ready |
| `D6-SET-010` | P1 | 模型与账户设置 | 数据路径配置按声明生效并保留原资料 | `STORAGE-CONFIG-01@1` | partial |
| `D6-LIT-003` | P1 | 文献 | 从专用Zotero资料源导入所选题录 | `LIT-IMPORT-ZOTERO-01@2` | manual_ready |
| `D6-PROJ-001` | P1 | 项目 | 新建项目并进入对应工作台 | `PROJ-CREATE-01@4` | manual_ready |
| `D6-PROJ-002` | P1 | 项目 | 切换项目后资料范围对应所选项目 | `PROJ-SWITCH-01@3` | manual_ready |
| `D6-PROJ-007` | P1 | 项目 | 归档项目后默认列表隐藏且归档管理保留对象 | `PROJ-ARCHIVE-01@2` | manual_ready |
| `D6-PROJ-008` | P1 | 项目 | 恢复归档项目后读回原资料与任务 | `PROJ-RESTORE-01@2` | manual_ready |
| `D6-RES-001` | P1 | 资料库 | 查看并恢复合成资料的指定历史版本 | `RES-VERSION-RESTORE-01@2` | manual_ready |
| `D6-RES-004` | P1 | 资料库 | 资料自动保存策略与实际落盘行为一致 | `RES-AUTOSAVE-01@2` | manual_ready |
| `D6-CHAT-002` | P1 | AI对话 | 已完成任务归档后历史可读且输入只读 | `CHAT-ARCHIVE-01@2` | manual_ready |
| `D6-CHAT-003` | P1 | AI对话 | 恢复归档任务后原消息保留并可编辑 | `CHAT-RESTORE-01@2` | manual_ready |
| `D6-CHAT-005` | P1 | AI对话 | 真实对话交付可从多个入口打开的文件产物 | `CHAT-ARTIFACT-01@2` | manual_ready |
| `D6-CHAT-006` | P1 | AI对话 | 将已发布任务产物保存为资料库副本 | `CHAT-ARTIFACT-IMPORT-01@2` | manual_ready |
| `D6-CHAT-007` | P1 | AI对话 | 新任务引用指定历史任务并据其回答 | `CHAT-TASK-REF-01@2` | manual_ready |
| `D6-CHAT-008` | P1 | AI对话 | 引用指定文献题录并区分摘要与全文依据 | `CHAT-LIT-REF-01@2` | manual_ready |
| `D4-SKILL-007` | P1 | 技能中心 | 停用技能后选择器不误报为可调用 | `SKILL-ENABLE-01@2` | partial |
| `D4-LIT-005` | P1 | 文献 | 导入本地 PDF 为文献条目 | `LIT-IMPORT-PDF-01@3` | manual_ready |
| `D4-LIT-011` | P1 | 文献 | 将已有文献加入项目 | `LIT-JOIN-PROJECT-01@5` | manual_ready |
| `D4-LIT-013` | P1 | 文献 | 为已有文献添加附件 | `LIT-ADD-ATTACHMENT-01@4` | manual_ready |
| `D4-LIT-015` | P1 | 文献 | 将 AI 检索结果题录加入文献库 | `LIT-SEARCH-SAVE-01@4` | manual_ready |
| `D4-LIT-019` | P1 | 文献 | 执行文献 PDF 逐页翻译 | `LIT-PDF-DOCUMENT-TRANSLATE-01@3` | manual_ready |
| `D4-LIT-020` | P1 | 文献 | 生成可追溯文献 AI 解读 | `LIT-PDF-SUMMARY-01@3` | manual_ready |
| `D6-LIT-004` | P1 | 文献 | 核对文献 PDF 选区解释语义准确性 | `LIT-PDF-EXPLAIN-QUALITY-01@1` | manual_ready |
| `D6-LIT-005` | P1 | 文献 | 核对文献 PDF 选区翻译语义准确性 | `LIT-PDF-TRANSLATE-QUALITY-01@1` | manual_ready |
| `D4-RES-005` | P1 | 资料库 | 复制导入目录保留层级与文件 | `RES-COPY-DIR-01@3` | manual_ready |
| `D4-RES-007` | P1 | 资料库 | 同名导入重命名保留新旧资料 | `RES-CONFLICT-RENAME-01@4` | manual_ready |
| `D4-RES-008` | P1 | 资料库 | 同名导入版本化替换可追溯旧版 | `RES-CONFLICT-REPLACE-01@4` | manual_ready |
| `D4-RES-014` | P1 | 资料库 | 将项目资料引用为对话上下文 | `RES-CHAT-REF-01@4` | manual_ready |
| `D4-RES-015` | P1 | 资料库 | 复制导入中文及空格目录名 | `RES-COPY-DIR-01@3` | manual_ready |
| `D4-RES-016` | P1 | 资料库 | 中文同名文件冲突保留双方 | `RES-CONFLICT-RENAME-01@4` | manual_ready |
| `D4-RES-018` | P1 | 资料库 | 同名不同目录资料引用身份正确 | `RES-CHAT-REF-01@4` | manual_ready |
| `D4-CHAT-002` | P1 | AI对话 | 新建会话与原会话分离 | `CHAT-NEW-01@3` | manual_ready |
| `D4-CHAT-003` | P1 | AI对话 | 重新打开历史会话读回消息 | `CHAT-HISTORY-01@3` | manual_ready |
| `D4-CHAT-006` | P1 | AI对话 | 同会话追问承接上下文并修订 | `CHAT-FOLLOWUP-01@3` | manual_ready |
| `D4-CHAT-007` | P1 | AI对话 | 停止正在生成的模型回合 | `CHAT-STOP-01@4` | manual_ready |
| `D4-CHAT-009` | P1 | AI对话 | 切换模型后下一轮身份一致 | `CHAT-MODEL-SWITCH-01@3` | manual_ready |
| `D4-CHAT-010` | P1 | AI对话 | 添加本地附件并依据内容回答 | `CHAT-LOCAL-FILE-01@3` | manual_ready |
| `D4-CHAT-011` | P1 | AI对话 | 含多轮消息的历史会话完整读回 | `CHAT-HISTORY-01@3` | manual_ready |
| `D4-CHAT-012` | P1 | AI对话 | 追问调整表达但保持核心事实 | `CHAT-FOLLOWUP-01@3` | manual_ready |
| `D4-CHAT-013` | P1 | AI对话 | 已有部分输出时停止回合 | `CHAT-STOP-01@4` | manual_ready |
| `D4-CHAT-014` | P1 | AI对话 | 同名本地附件依据所选文件回答 | `CHAT-LOCAL-FILE-01@3` | manual_ready |
| `D6-SKILL-001` | P2 | 技能中心 | 连接器无效URL配置被拒绝并可修正 | `CONNECTOR-VALIDATE-01@2` | partial |
| `D6-SKILL-002` | P2 | 技能中心 | 批量连接器配置预览身份正确且取消不安装 | `CONNECTOR-PREVIEW-01@1` | partial |
| `D6-SET-003` | P2 | 模型与账户设置 | 只读查看模型服务与内置模型目录 | `MODEL-CATALOG-01@2` | manual_ready |
| `D6-SET-004` | P2 | 模型与账户设置 | 头像菜单显示当前账户状态与遮挡身份 | `ACCOUNT-STATE-01@1` | manual_ready |
| `D6-SET-005` | P2 | 模型与账户设置 | 无效模型服务地址探测反馈并可取消 | `MODEL-CONFIG-01@5` | partial |
| `D6-SET-006` | P2 | 模型与账户设置 | 模型思考强度保存重开及新任务显示一致 | `MODEL-REASONING-01@2` | manual_ready |
| `D6-SET-007` | P2 | 模型与账户设置 | 模型上下文窗口选择保存后读回一致 | `MODEL-CONTEXT-01@2` | manual_ready |
| `D6-SET-008` | P2 | 模型与账户设置 | 任务级AI提示词配置仅作用于对应动作 | `MODEL-PROMPTS-01@1` | partial |
| `D6-SET-009` | P2 | 模型与账户设置 | 任务提醒与真实状态一致且标已读不改变任务 | `NOTIFICATION-01@1` | partial |
| `D6-SET-011` | P2 | 模型与账户设置 | 按时间或站点检索和管理客户端浏览历史 | `BROWSER-HISTORY-01@1` | partial |
| `D6-LIT-001` | P2 | 文献 | 文献标签关联与筛选命中正确对象 | `LIT-TAG-FILTER-01@2` | manual_ready |
| `D6-PROJ-003` | P2 | 项目 | 新建项目时确认接入已有合成目录 | `PROJ-ADOPT-01@3` | manual_ready |
| `D6-PROJ-004` | P2 | 项目 | 取消已有目录接入后不创建项目 | `PROJ-ADOPT-01@3` | manual_ready |
| `D6-PROJ-005` | P2 | 项目 | 空名称创建被拒绝并可修正后继续 | `PROJ-CREATE-01@4` | partial |
| `D6-PROJ-006` | P2 | 项目 | 编辑项目元数据后保持原资料与任务归属 | `PROJ-EDIT-01@3` | manual_ready |
| `D6-PROJ-010` | P2 | 项目 | 按项目名称筛选并恢复项目列表 | `PROJ-FILTER-01@2` | manual_ready |
| `D6-RES-002` | P2 | 资料库 | 创建资料副本并保留原件 | `RES-DUPLICATE-01@2` | manual_ready |
| `D6-RES-003` | P2 | 资料库 | Markdown查看方式切换保持同一资料正文 | `RES-VIEW-MODE-01@2` | manual_ready |
| `D6-RES-005` | P2 | 资料库 | 历史版本数量及最大文件阈值按声明策略生效 | `RES-VERSION-POLICY-01@2` | manual_ready |
| `D6-CHAT-001` | P2 | AI对话 | 从指定回复创建任务分支并保留原任务 | `CHAT-BRANCH-01@2` | manual_ready |
| `D6-CHAT-009` | P2 | AI对话 | 工作区多标签切换保持资料对象与状态 | `CHAT-WORKSPACE-TABS-01@2` | manual_ready |
| `D6-CHAT-004` | P2 | AI对话 | 跨资料文献任务搜索并打开同身份对象 | `SEARCH-GLOBAL-01@4` | manual_ready |
| `D4-SKILL-001` | P2 | 技能中心 | 浏览技能分组并打开目标说明 | `SKILL-BROWSE-01@4` | manual_ready |
| `D4-SKILL-002` | P2 | 技能中心 | 切换另一可见分组定位技能 | `SKILL-BROWSE-01@4` | manual_ready |
| `D4-SKILL-005` | P2 | 技能中心 | 依次打开不同技能不串说明 | `SKILL-BROWSE-01@4` | manual_ready |
| `D4-LIT-006` | P2 | 文献 | 通过稳定标识符导入文献 | `LIT-IMPORT-ID-01@3` | manual_ready |
| `D4-LIT-007` | P2 | 文献 | 通过书目文件导入题录 | `LIT-IMPORT-BIB-01@4` | manual_ready |
| `D4-LIT-008` | P2 | 文献 | 筛选已有文献而非执行发现 | `LIT-LIST-SEARCH-01@3` | manual_ready |
| `D4-LIT-009` | P2 | 文献 | 创建文献分类并读回 | `LIT-CREATE-COLLECTION-01@3` | manual_ready |
| `D4-LIT-010` | P2 | 文献 | 将已有文献加入分类 | `LIT-JOIN-COLLECTION-01@3` | manual_ready |
| `D4-LIT-012` | P2 | 文献 | 编辑文献元数据并持久读回 | `LIT-EDIT-META-01@4` | manual_ready |
| `D4-LIT-014` | P2 | 文献 | 创建文献笔记并读回 | `LIT-NOTE-01@4` | manual_ready |
| `D4-LIT-016` | P2 | 文献 | 通过 PDF 大纲定位章节 | `LIT-PDF-OUTLINE-01@4` | manual_ready |
| `D4-LIT-017` | P2 | 文献 | 为选中文字创建高亮标注 | `LIT-PDF-ANNOTATE-01@3` | manual_ready |
| `D4-LIT-018` | P2 | 文献 | 从标注记录回到 PDF 原文 | `LIT-PDF-ANNOTATION-LOCATE-01@3` | manual_ready |
| `D4-RES-006` | P2 | 资料库 | 外部目录关联不复制原件 | `RES-LINK-DIR-01@3` | manual_ready |
| `D4-RES-009` | P2 | 资料库 | 在目标资料位置创建文件夹 | `RES-CREATE-FOLDER-01@3` | manual_ready |
| `D4-RES-010` | P2 | 资料库 | 新建 Markdown 文档并读回 | `RES-CREATE-MD-01@4` | manual_ready |
| `D4-RES-011` | P2 | 资料库 | 重命名资料节点保持内容 | `RES-RENAME-01@4` | manual_ready |
| `D4-RES-012` | P2 | 资料库 | 移动资料文件到目标目录 | `RES-MOVE-01@4` | manual_ready |
| `D4-RES-013` | P2 | 资料库 | 按资料名称筛选正确对象 | `RES-LIST-FILTER-01@3` | manual_ready |
| `D4-RES-017` | P2 | 资料库 | 按资料类型筛选不同格式 | `RES-LIST-FILTER-01@3` | manual_ready |
| `D4-CHAT-004` | P2 | AI对话 | 按标题搜索正确历史会话 | `CHAT-SEARCH-01@4` | manual_ready |
| `D4-CHAT-008` | P2 | AI对话 | 运行中再次发送保持队列顺序 | `CHAT-QUEUE-01@4` | manual_ready |
| `D6-LIT-002` | P3 | 文献 | 文献列表显示列配置与重开状态一致 | `LIT-COLUMNS-01@1` | partial |
| `D6-PROJ-009` | P3 | 项目 | 置顶项目后顺序与对象身份保持一致 | `PROJ-PIN-01@1` | partial |
| `D4-SKILL-003` | P3 | 技能中心 | 以完整技能名称检索目标 | `SKILL-BROWSE-01@4` | manual_ready |
| `D4-SKILL-004` | P3 | 技能中心 | 以部分关键词检索目标 | `SKILL-BROWSE-01@4` | manual_ready |
| `D4-SKILL-006` | P3 | 技能中心 | 无匹配关键词不误显示目标 | `SKILL-BROWSE-01@4` | manual_ready |
| `D4-CHAT-005` | P3 | AI对话 | 重命名会话标题持久读回 | `CHAT-RENAME-01@2` | partial |
