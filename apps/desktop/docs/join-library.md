# 检索结果加入文献库

状态：current，2026-09-18，分支 `guide_subu`。

## 最终交互

- 检索结果单条、批量条和 AI 对话命中卡共用“加入文献库”菜单，统一调用 `pushLibItem()`。全览菜单顺序为直接加入、加入我的分类、加入项目；无项目时隐藏加入项目。项目上下文只显示直接加入和加入我的分类，并自动关联当前项目。
- 分类支持任意层级，悬停展开、点击加入当前节点。只在第一层分类列表及某项目的第一层分类列表提供“新建分类…”，不在每级重复。叶子分类不显示展开箭头。
- 入库菜单的新建分类弹窗：名称默认“未命名”且全选，“创建到”默认“我的分类”，使用已有 Select 组件的白底浮层。全览创建只能选择全局分类，项目创建只能选择对应项目的分类。
- 创建后刷新侧栏、展开祖先并高亮约 1.4 秒。由入库菜单发起时，把本次文献加入新分类；侧栏创建不触发入库。创建成功但入库失败时可重试入库，不重复创建分类。
- 成功后行内只显示“✓ 已加入”；toast 按数量显示“已添加1篇文献”等，不显示落点或跳转入口。
- 子菜单沿用共享组件的贴边翻转和高度限制；支持 Esc、外部点击及弹窗遮罩关闭。下拉展开时 Esc 先关闭下拉，保留弹窗。

## 工程映射与共享改动

当前工程是 React，原型的 `literature-library.js`、`ai.js`、`styles/app.css`、`scripts/check-demo.mjs` 不是本工程入口，没有创建同名替代文件。

- `features/literature/Search.tsx`：检索结果单条、批量和结果详情动作接入菜单，移除旧确认框。
- `features/literature/Results.tsx`：AI 命中卡接入同一菜单。
- `features/literature/JoinMenu.tsx`、`join.ts`、`joinState.ts`：菜单、统一 API 入库及当前运行期间的跨消费者回执同步。
- `features/literature/CreateCollectionDialog.tsx`：入库菜单的分类表单，保存逻辑由调用方持有。
- `features/literature/LiteraturePanel.tsx`：保留分类刷新和入库创建后的短暂高亮；侧栏创建使用原有单字段弹窗。侧栏名称与顺序见 `literature-sidebar.md`。
- `components/ui/DropdownMenu.tsx`：子菜单接受受控的 open/onOpenChange。
- `components/ui/Menu.tsx`：可选悬停展开、自动聚焦控制、方向键进入子面板，以及内容变化/窗口变化后的重新定位。
- `localization/locales/{zh,en}/literature.json` 与生成类型：本功能文案。

复用已有 DropdownMenu、Dialog、Input、Select、Button、Toast 及语义 token。未改本地文件/Zotero/BibTeX 导入流程、阅读器或文献详情布局。未调整检查基线。

## 验证

- `npm run build`、`git diff --check` 通过。
- `join.test.ts`：4 项通过，覆盖目的地、批量请求、项目隔离、重复请求保护和失败重试。
- 最新完整入库 Electron 验收通过（47.9 秒）：全览四种落点、无项目、项目上下文、创建并入库、侧栏高亮、批量数量提示、贴边翻转、关闭行为及白底下拉父级选择。后端使用隔离的真实存储；检索供给使用固定测试数据，没有验证真实模型生成检索结果。
- AI 消费者同步通过 Electron 内的组件夹具验证，确认真实后端写入及两处已加入状态；此项不是完整 AI 对话流程验收。
- 已查看实际产品的白底下拉截图 `tmp/test_snapshot/desktop/join-library/create-parent-dropdown.png`；其它截图和检查记录在同目录。截图为忽略的本地验证产物，不纳入提交。

## 已有检查阻塞及验证边界

- 工程不存在 `scripts/check-demo.mjs`，使用本工程构建、单元测试及 Electron 验收替代，不能声称该命令通过。
- `npm test` 停在 pretest：27 项中 25 通过，TeXLive 归档路径断言与 uv 错误版本夹具两项失败；相关文件未修改。
- `npm run typecheck`：34 个已有错误；与干净 HEAD 源码逐项比较，排除路径与行号后完全一致，没有新增错误。
- `npm run docs:check`：已有视觉值、所有权和债务库存检查失败；未修改 baseline 掩盖失败。
- `npm run i18n:check -- --base HEAD`：未改动的 `input.ts` 引用历史缺失文案，检查失败。
- 关联 `search.test.ts`：仅更新两项旧入库流程断言。与新增用例一起运行 19 项，17 通过；剩余宽度源码断言及附件删除源码断言在 HEAD 同样失败。
- 既有非模态弹窗外部点击关闭测试失败；用干净 HEAD 源码重跑，得到相同超时。本次未修改 Dialog 实现。
- 入库回执用于当前运行期间的跨消费者状态同步。结果行始终只显示“已加入”；未扩展后端状态协议。
- 本次截图验收为浅色桌面；没有进行完整暗色视觉验收。


提交前复核：入库单元测试 4/4、后端存储 43 项及 7 个子测试通过；类型检查 34 项错误与干净 HEAD 的日志按路径/行号归一后完全一致。`npm test` 停在 pretest（25/27，通过数未掩盖其余两项失败）；`docs:check` 仍受既有样式债务、所有权和文档一致性检查阻塞。

2026-09-19 侧栏创建恢复：按用户图1及历史实现恢复窄版“新建分类 / 新建子分类”弹窗，包含位置说明、空名称输入框和“取消 / 创建”；不提供“创建到”，创建位置由点击的侧栏入口确定。入库菜单仍保留“未命名”、白底父级下拉及“创建分类”，两种入口互不改变。

本轮复验：构建通过；完整 Electron 入库回归通过（51.8 秒），包含侧栏空名称/说明/无父级下拉、全局创建、项目根分类与指定子分类保存，以及入库菜单白底下拉。已查看 sidebar-create-dialog.png。release 合并后缺失的 xlrd 已通过 uv sync --locked 按锁文件补齐；验收脚本同步了 release 已调整的检索标题定位。类型检查当前报告 25 项错误，未出现在本次修改的 LiteraturePanel.tsx；npm test 仍在 pretest 的 TeXLive/uv 两项失败，docs:check 仍报告样式债务等问题，因此不宣称全套门禁通过。

命名统一后复验：桌面构建通过；入库和侧栏两组 Electron 回归均通过（共 1.2 分钟）。i18n:check 仍被未修改的 input.ts 中缺失的消息键阻塞。

2026-11-10 加入方式改造：批量入库弹窗的“加入方式”不再对所有检索结果出现。只有结果来自精确检索卡片，且本次勾选的论文中至少有一篇已经下载完成时，才渲染“仅元信息 / 元信息和全文”，副文案如实给出已下载篇数；其余情况（其他来源卡片、无已下载论文、状态查询失败）不渲染该选择，确认按钮直接按仅元信息提交。文案由“元信息与可开放获取的文献”改为“元信息和全文”，判据不再是元数据里的 `access` 预测。

“元信息和全文”只复用已经下载好的字节：Serve 侧 `apps/serve/service/literature/service/holdings.py` 认两条证据 —— 本次会话 bridge 下载后托管存储里仍在的 PDF，或技能自己下进 run 目录、scoped 读到真实存在的 PDF；挂载走附件域唯一入口，不产生第二次下载。非精确检索来源由 Serve 直接拒绝。附全文失败不影响已成功的题录入库，完成后提示“已加入 N 篇文献，其中 M 篇含全文”，未附上的篇数单独提示。

本轮改动落在 `features/literature/JoinDialog.tsx`、`JoinMenu.tsx`、`join.ts`、`api.ts`、`Matches.tsx`、`Report.tsx`、`Results.tsx` 与 zh/en `literature.json`；`fulltextCandidates` 与入库时的 arXiv 重新下载腿已移除，`fetchArxivFulltext` 仍由文献详情页的下载按钮使用。
