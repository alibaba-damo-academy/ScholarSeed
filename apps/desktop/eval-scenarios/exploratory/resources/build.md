# 资料树与列表需求构建依据

## 分页原始输入：resources/25

新增独立 [resource-pagination](../../../../../examples/projects/resource-pagination/project.json)，`pages` 同层 101 个可见 Markdown 文件依次为 `item-001.md` 至 `item-101.md`，逐项记录大小与摘要。该输入可用于准备同层超过一页的资料树数据，不预置树的加载或续页结果。

本机目标安装包 `0.3.2 / 202611121823 / preview` 磁盘后端 `Contents/Resources/backend/python/lib/python3.14/site-packages/service/content/service/tree.py` 的 SHA-256 为 `3bcb1a575a34d4addd93815b29e446fb9ef7bc21e5556bab4ca3f459909a5249`，与当前仓库同文件相同；其 `PAGE_SIZE = 100`，同层按目录优先、同类名称排序，再按 offset 切页。该单文件比对不证明整个安装包或运行内存同源，也不证明真实分页行为。资料列表完整读取与资料树续页不同，不能以列表展示代替续页。

共享准备器串行准备且整次有 90 秒超时，本项目的 101 文件尚未真实运行准备，不能据清单声称可完成准备；须先核隔离实例、目录及写入授权，失败保留收据与缺口。人工导入及真实 UI 续页另核授权；本次不操作产品，不改变需求版本、已采用范围或历史冻结。

## 资源管理器打开方式菜单参考：resources/24

`explorer-open-menu-20261113.png` 是 `tmp/test_snapshot/desktop/explorer-open-menu-observe-20261113/menu.png` 原字节副本，SHA-256 `93f2f89d414f9850780f94ed0ab5d6a8119c3fe9ccddca10239b17656fc0531e`。2026-11-13 在 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例的合成 `sample.md` 预览中打开菜单并关闭，未选择菜单项；完整渲染视口中的窄面板导致面包屑截断。操作前隔离文件与 examples 原件 SHA-256 均为 `a77fec4534bce0994a47e17a2bc4f862839a295ccfa82c08555180afb55ec1e0`，未见操作后重算。切换活动标签可能改变辅助状态；该图不证明选项执行、跨项目或重启持久性，不改变候选采用及历史冻结。

## 深层目录状态参考：resources/23

2026-11-13 在 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例观察项目文件资料列表中的 `notes/methods` 展开及收起；同项目公开树响应中包含 `resources/notes/methods/appendix.md`。`deep-expanded-20261113.png` 和 `deep-collapsed-20261113.png` 分别是 `tmp/test_snapshot/desktop/resources-deep-20261113/expanded.png`、`collapsed.png` 原字节副本，SHA-256 分别为 `bf3c2f2a86c1df5c78d8852b5c457fada4fdc289eff8dc7792de90cdda98d701`、`ac1bf190f0b10427197473d7f195918e19ff9b890127e16334e15b0cdd10e082`。记录所核磁盘 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`，不证明运行内存字节。两图展示状态，操作顺序来自观察记录；未另存逐次点击命令，不证明文件内容、分页、侧栏树行为或正式评测通过。未改变需求版本与历史冻结。

## 搜索清空后的自然状态：resources/22

2026-11-13 在已运行的隔离 macOS arm64 `0.3.2 / 202611121823 / preview` 实例中，附着前核 PID 2153、隔离 profile 及本机监听端口 49382，磁盘 `app.asar` SHA-256 为 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`；磁盘摘要不等于运行内存取证。原有搜索框显示 `sample.md` 和 `resources/sample.md` 命中；清空输入后观察到项目根目录及折叠的 `resources` 目录恢复。操作改变隔离界面输入状态，未导入或修改文件，随后已断开控制连接。此次未展开目录核文件，也未复核其他匹配或失败状态，不作正式评测或需求采用。

完整窗口参考 `explorer-cleared-20261113.png` 是 `tmp/test_snapshot/desktop/resource-search-clear-20261113/cleared.png` 原字节副本，SHA-256 `c9a6ad3fa3f928b5ed1ab454f9ec1501bd303325562bfc5db2fd3ee76f5f8a9a`；操作前图 `search.png` 的 SHA-256 为 `6ecc68bd96a72aa1a9d1bb8e4c756a27253216ee211fd77523716061297c38c8`。两图已打开检查，右侧为窄分屏合成文档。候选语义、需求版本和目标适用仍待确认，既有判据及历史冻结不变。

## 项目文件分类与布局候选：resources/21

当时资产修订为 `resources/21`。`RES-LIBRARY-CATEGORY-CAND-001` 的需求依据为2026-10-21 资料目录与文件库标签切换中用户确认的三分类切换保持工作台布局；原记录同时明确当时未执行该回归。候选不改变原已采用要求、冒烟范围或历史冻结，需求版本、目标包适用及完整截图待核。

当前源码线索：`apps/desktop/src/renderer/src/features/project/Library.tsx` 的分类选择更新目标标签的 `libraryCategory`、访问分类集合并清空选择；`apps/desktop/src/renderer/src/features/resources/Listing.tsx` 承载资料目录展示。两文件相对基点 `acce09fa42ddf234d84b02dde34b2ab4be570215` 无差异，SHA-256 依次为 `f865c6acc9c24a27cea22674832a0a09853899041746d4247bcb4379a4a37202`、`79ae07f7e65f67029084fa15a40044d24948b9ead63b73f7aac2267761d15b14`；源码不是目标安装包同源证明，也不是产品验收。

验证需记录同一隔离项目的切换前布局与标签身份、各分类独立内容参照及切换后布局；分别记录空态和有真实数据的状态，缺少真实数据时不推断非空结果。示例数据仅是输入，导入需人工确认；生成任务产物涉及真实任务、模型或写入时另核权限。切换会改变隔离界面状态，不能宣称无副作用；本次未操作产品或取得目标版本三分类完整窗口图。

## 项目资源管理器搜索自然观察：resources/19

该次资产修订为 `resources/20`；本次澄清已收录截图的范围与其余缺口，不改变需求采用或判据。两张图为 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例的 1280×840 完整窗口原字节副本；原运行目录为 `tmp/test_snapshot/desktop/baseline-1823-project-explorer-search-20261113/`，采前后公开版本与磁盘 `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a` 有记录；磁盘摘要不等同运行内存字节取证。时间均为 2026-11-13 +0800：

| 参考副本 | 原始证据及截图命令 | 时间 | SHA-256 |
| --- | --- | --- | --- |
| `explorer-search-20261113.png` | `run/evidence/search.png`，`run/index.md` 第 11 项 | 12:53:55 | `3a73ac8e87d12dae785cef5b8f4e6b46b69c7401bb8e4056c941272c8f70d5f2` |
| `explorer-opened-20261113.png` | `run/evidence/opened.png`，`run/index.md` 第 14 项 | 12:54:08 | `c290fe43fc1aebd1f5acce687b9de2c92fa652ac9657e428321b861cbad33d75` |

受控记录显示输入 `sample.md`，出现 `resources/sample.md` 结果，点击后显示相同路径及合成文档标题；仓库原件与隔离副本的 SHA-256 均为 `a77fec4534bce0994a47e17a2bc4f862839a295ccfa82c08555180afb55ec1e0`。逐图打开检查无可见完整凭据，右侧为窄分屏合成文档。此为自然观察而非正式采用或评测裁决，不证明清空恢复、其他匹配语义、失败或分页；目标包需求适用、需求版本与匹配细节确认仍待核。打开可伴随隔离 MRU/布局状态，不声称零副作用；未导入或写入文件。原编号、判据、采用状态及历史冻结不变。

## 项目资源管理器自然状态参考：resources/18

当时资产修订为 `resources/18`。`explorer-20261113.png` 是原始运行 `tmp/test_snapshot/desktop/baseline-1823-project-explorer-20261113/run/evidence/explorer.png` 未裁切、未缩放的字节副本，1280×840，SHA-256 `0028dddce414500244fdef66b234b583e8227b31e21ffa848fd0fb2d7155838e`；采集于 2026-11-13 12:46:41 +0800，`run/index.md` 第 10 项为截图命令。同一运行的观察记录、采前后实例投影及进程路径记录目标 macOS arm64 `0.3.2 / 202611121823 / preview` 与磁盘 `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`；磁盘摘要不等同运行内存字节证明。受控记录显示通过工作台新标签打开项目资源管理器，未点击搜索或打开文件。

已打开检查为完整产品窗口，展示项目文件树、折叠的 `resources` 和右侧窄分屏合成文档，无可见完整凭据；分屏状态不作布局通过或缺陷结论。该图仅供当时入口与自然展示参考，不证明搜索结果、文件打开、写入、目标包需求适用或候选已采用；当时相关动作与完整图待核，后续自然观察见上节。原编号、需求版本、判据及历史冻结不变。

## 打开方式菜单副作用澄清：resources/17

当时资产修订为 `resources/17`；独立复核发现 `resources/16` 对菜单选择的执行时点描述不足。当前源码中，选择系统定位项会先记录方式并立即调用 `reveal(currentPath)`，选择新标签项会先记录方式并立即调用 `openNewTab()`；主按钮也会按当前方式执行。展开菜单与选择菜单项因此是不同操作，执行选择前须分别核对应系统定位或打开标签的权限与独立结果；无权执行时仅观察菜单。此澄清不改变产品需求版本、确认级别、目标包适用性或历史冻结，源码不证明目标安装包同源。

## 项目资源管理器打开方式候选：resources/16

当时资产修订为 `resources/16`；新增 `RES-EXPLORER-OPEN-CAND-001`，不修改 `RES-LIST-001–007`、需求版本、采用状态或历史冻结。资源管理器打开方式设计记录标为 `current（源码）`，明确依据用户确认的三张截图：当前方式主按钮和下拉组合、系统定位或新标签页的菜单勾选；记录同项目重新挂载时保留内存选择且不增加磁盘持久化。该次记录声明状态修复尚未真实 Desktop 验证；不以源码或组件回归自动批准目标行为，也不将内存保持外推为跨重启持久化。目标 `0.3.2 / 202611121823 / preview` 适用、产品需求版本和真实完整窗口图待核。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[Explorer.tsx](../../../src/renderer/src/features/project/Explorer.tsx) 的 `rememberOpenInTab` 更新项目资源管理器内存选择，`openNewTab` 激活已有预览标签，`reveal` 解析目标后调用系统定位。该文件相对基点无未提交差异，SHA-256 `f120365ee5be15fc7e75b9076614fd4b0eb1025f2026d9e525ea8eba5fc18d0c`；仅定位入口与状态，不证明目标包同源或操作正确。可复用 `examples/projects/evaluation` 的隔离合成文件，以当前项目、文件身份、菜单选择及重新挂载状态为参照；菜单选择立即触发的真实标签或系统定位结果须事先核实与授权，不能以选择标记证明打开。

## 项目资源管理器搜索候选：resources/15

当时资产修订为 `resources/15`；新增 `RES-EXPLORER-SEARCH-CAND-001`，不修改 `RES-LIST-001–007`、需求版本、采用状态或历史冻结。资源管理器顶部工具栏设计映射标为 `current（源码，用户截图）`：用户截图涉及文件树搜索入口，记录同时描述当前项目文件名包含匹配、结果相对路径和清空恢复；该记录不等于这些行为均有单独用户验收，匹配细节和失败分支确认级别仍待核。目标 `0.3.2 / 202611121823 / preview` 的入口、适用、需求版本及真实完整窗口图在该修订时待核；历史记录明确当时未验证，后续自然状态观察见上节。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[project/feature.tsx](../../../src/renderer/src/features/project/feature.tsx) 注册工作台 `explorer` viewer，[NewTab.tsx](../../../src/renderer/src/features/project/NewTab.tsx) 提供资源管理器入口，[Explorer.tsx](../../../src/renderer/src/features/project/Explorer.tsx) 调用 [project/api.ts](../../../src/renderer/src/features/project/api.ts) 的 `listProjectFiles` 遍历项目目录并筛选名称。相对地，[ResourcePanel.tsx](../../../src/renderer/src/features/resources/ResourcePanel.tsx) 是资料库侧栏，当前源码的 `RESOURCE_TREE_SEARCH_VISIBLE` 为 false；这是不同承载，不能将资源管理器搜索直接用于推翻侧栏判据。上述五文件相对基点无未提交差异；Explorer、project API、侧栏文件的 SHA-256 分别为 `f120365ee5be15fc7e75b9076614fd4b0eb1025f2026d9e525ea8eba5fc18d0c`、`b6168890ff2f92eb905d2193b752f991153597edaf619763b7675026836ce7ad`、`d03c64965d9a673fd7525635f04e7e7d36eae79aa0551a265b8f8e09ac3ec061`。源码仅为入口和取数线索，不证明目标包同源或正确；可复用 `examples/projects/evaluation` 的嵌套合成文件，独立核项目身份、文件名与相对路径及真实打开结果。读取和打开范围须获准，不能用全局搜索或截图替代动作。

## 资料冲突合成输入：resources/14

[独立示例清单](../../../../../examples/projects/resource-conflict/project.json)登记两份仓库合成的 `plan.md`，`existing` 与 `incoming` 分别为 82 字节，SHA-256 为 `789bf4f16e54ac6f457099209f4c0091083e374409a33f5a3d22480ccebbf6e9` 和 `84c2b1083d41892dad01c605c04b36cdb3881576e6fcfb41c4564b1b90eb0a60`。两者同名但内容不同；运行时须分别核身份，获准准备隔离目标前态，再由人工确认将另一份导入同一目标目录，并以独立前后内容和路径参照核终态。两份输入均是原始样本，不预置产品状态、冲突选择或结果；版本化替换能力、授权、目标包适用与完整窗口截图仍待核。本修订只补充数据，不改变需求版本、采用范围或历史冻结。

## 需求与运行进度分离：resources/13

移除需求正文中笼统的历史“全部未实测”状态，运行进度与各轮结果以场景索引及运行记录为准；不改变稳定 ID、需求版本、采用范围、专项边界或历史冻结。

## 目标版本完整窗口参考：resources/12

新增 资料列表及目录展开参考图，为原始运行文件 `tmp/test_snapshot/desktop/baseline-1823-batch1/driver/evidence/f1-notes.png` 未裁切、未缩放的字节副本，SHA-256 `b3c7659f3949e5a6654931576831814b1ab0d6e10ab62f9efa30c1ea4c7f3e82`，1280 × 840；逐图检查其为完整产品窗口，显示合成项目资料列表及 `notes` 的直接子项，动态名称、时间与状态不固化。采集于 2026-11-12 19:33:57（UTC+8），原运行 `driver/index.md` 的第 7 项为截图命令，计划记录 macOS arm64 `0.3.2 / 202611121823 / preview` 及 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`、隔离项目和共享合成输入；原执行证据目录为 `tmp/test_snapshot/desktop/baseline-1823-batch1/`。

该图不证明资料导入、关联、创建或其他专项终态，也不替代本轮实际执行和独立参照；其他状态的真实完整窗口图仍有缺口。本修订仅补图及来源，不改变稳定 ID、需求版本、采用状态或历史裁决。

## 资料接入与管理候选：resources/11

本修订仅整理原历史业务点的候选范围，不变更 `RES-LIST-001–007`、需求版本、已采用快评或历史结果。目标 `0.3.2 / 202611121823 / preview` 的业务适用、入口、需求版本及候选采用仍待核；旧 ID 的 `@` 是历史资产修订，不是产品需求版本。完整目标窗口图及隔离数据/权限未准备齐全，不能作为已完成评测。

从 [P2 冻结](../../frozen/p2-20261025-539af0794/freeze.json) 的 `sourceCommit` `539af079455cc821b976760728fc13dfedbb8b66` 回查 `apps/desktop/docs/scenarios/catalog.json`（SHA-256 `e4a029cce1e58db658acb2643ea05621f48c288d12209eb0df41f5a4329ec45f`）和 `apps/desktop/eval-scenarios/exploratory/desktop-business/cases/library.json`（SHA-256 `76de261523523ab546a5412845365d159974d8c7f6c6a89453a138e42348b738`），与冻结来源清单一致。可用 `git show <sourceCommit>:<路径>` 回查，未恢复或改写历史文件。

| 历史业务点 | 历史用例 | 探索边界 |
| --- | --- | --- |
| `RES-COPY-DIR-01@3`、`RES-LINK-DIR-01@3` | `D4-RES-005/006` | 两种接入和原件保护分别核；不能把项目已有文件视为真实导入。 |
| `RES-CONFLICT-RENAME-01@4`、`RES-CONFLICT-REPLACE-01@4` | `D4-RES-007/008` | 需同名不同字节输入；替换须真实版本能力和写入授权，不假定均可替换。 |
| `RES-CREATE-FOLDER-01@3`、`RES-CREATE-MD-01@4` | `D4-RES-009/010` | 创建对象及读回终态独立于导入。 |
| `RES-RENAME-01@4`、`RES-MOVE-01@4` | `D4-RES-011/012` | 需独立记录路径与内容；移动真实入口和跨目录行为仍需核实。 |

上述八个 catalog 均为 `reviewState=pending`、`coverageEligibility=exploratory`，对应历史用例均为 `candidate_unapproved`；历史资产就绪或局部观察不是当前包采用依据。独立需求 Owner 应确认目标版本语义及需求版本，缺失部分保留候选，不将它们计入现行已采用清单。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；[项目 Explorer](../../../src/renderer/src/features/project/Explorer.tsx) 的创建/重命名、移动及文件选择后导入分别调用 [项目 API](../../../src/renderer/src/features/project/api.ts)；[资料导入对话框](../../../src/renderer/src/features/resources/ImportDialog.tsx) 持有独立的模式选择与导入动作。三文件相对基点无未提交差异，SHA-256 依次为 `f120365ee5be15fc7e75b9076614fd4b0eb1025f2026d9e525ea8eba5fc18d0c`、`b6168890ff2f92eb905d2193b752f991153597edaf619763b7675026836ce7ad`、`a69b8e97fb2063ac79bc3b322ffe86f48b7574cb6df8c7d889d4fce8f077c4ee`。源码只解释可能的入口、状态与副作用，不能据此认定安装包同源、当前真实入口、目录关联/冲突语义或产品正确。

[examples 项目清单](../../../../../examples/projects/evaluation/project.json)提供可核摘要的嵌套合成文件；实际执行须单独核原件、项目映射及获准隔离副本。复制、关联、同名冲突与版本读回须按各自终态选择输入和独立参照；相关授权、真实完整窗口截图及目标包适用缺口留待后续，不操作原生选择器或预置结果。

## 共享输入去重：resources/10

原页面目录的合成输入已迁至字节一致的共享 `examples/projects/evaluation/files/`，原路径与内容可按历史提交 `193c5c28d9` 回查；仅整理输入引用，不更改需求版本、判据或冻结记录。

## F1 普通资料路径沿用依据：resources/9

针对 macOS arm64 `0.3.2 / 202611121823 / preview`，沿用 2026-10-30 用户统一采用规则及本页 `resources/5` 的已采用正常子点：当前项目资料入口、已知合成目录的名称层级与一次展开。该规则适用于已有及后续页面；已核本页既有采用与后续修订，未发现这些子点被确认退役或改变的记录。此为有界记录核查，不宣称完整需求变更史或源码与制品同源；关联目录失败、分页、全部筛选与写入仍不在该子范围内。原编号、v`0.3`、判据及旧运行不变；新运行仍须核制品、实例、项目和独立输入身份，由独立评审判断证据，不因本记录认定产品通过。下方 `resources/8` 所述目标适用性待核针对当时未完成此项有界沿用分析的状态。

## 共享示例输入对齐：resources/8

本修订仅将现行快评的四份基础资料入口指向 `examples/projects/evaluation`，按 `overview`、`detail`、`summary`、`appendix` 的文件身份和本轮准备收据核对项目及相对路径；原稳定 ID、需求版本、判据与历史结果不变。2026-11-12 核对共享原件与本场景旧副本的 SHA-256 均逐对一致：`252d2a97beb5f1b8b786a961fbd12964e70d150700acb92a46d1a3ffa0f8b814`、`5ac03866d59c97942f7c2e1ff82441aa7e72abb1d437859d0952634122e67a11`、`749eb83681017d3bed102829eead2d17a1f551c64e2def33df8f1de4fdcdb6fb`、`e96924f026671ff3562e61a052b78cd206382d091b885ebc7ae80aa893ecd365`。旧路径 `exploratory/resources/sample/` 可从源提交 `193c5c28d9` 回查，以下记录保留历史溯源。数据准备不证明导入功能；目标包适用性仍需独立核实，本修订不代表产品通过。

## 当前参考图修订：resources/7

`reference-20261112.png` 为 2026-11-12 macOS arm64 安装版 0.3.2 / 202611121104 / preview 隔离实例原图 `attempt-supplement/evidence/resources-notes.png` 的未改动副本，SHA-256 `1a90e0bc5d239fae1881f3882314684453b0572ba8a1774cfe43f5a588c438f2`；仅展示合成项目的展开资料树，不证明写操作。原始运行在 `tmp/test_snapshot/desktop/release-20261112-fresh/`；不改变需求或历史裁决。

## 历史修订：202610301343包内静态复核

资产修订：`resources/6`；本次只补指定新包来源、输入/独立参照与快评边界。原稳定ID、v`0.3`、采用规则、完整正文、参考图原版本/日期及历史结果保留；以下旧来源与修订记录均属历史，不代表本包绑定或本轮执行结论。

目标：macOS arm64 `0.3.0 / 202610301343 / preview`；ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。来源为本任务已提取的实际安装包与松散renderer payload；源码提交未知，当前checkout/remote HEAD仅可辅助定位，不声明同源。证据清单为忽略目录 `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`，包内定位均相对该根`package/`；不将临时提取目录当正式跨工作树资产。

包内`out/main/index.js` SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`：1338的applicationRenderer在packaged时取applicationResources下renderer，41203的无开发URL分支交给serveAssets。该链绑定本次分析的实际松散payload，不证明运行时未设置开发覆盖，也不把静态入口当产品观察。

- `renderer/assets/index-CddcCmKt.js`：SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`。
- `renderer/assets/AccountMenuPanel-CHQ1thBC.js`：SHA256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。

包内index:70155 ResourcePanel取homeSelectedProjectId与resource树；70597 ResourceListing独立取完整列表，清项目查询状态，按名称/类型/来源过滤并共享expanded。workspace:1282/1296分别调用/api/resource/list及/tree，带project与适用path/offset；固定入口、动态层级/类型和条件空态分开判断。最小独立登记包含项目ID/根身份、冻结相对路径及kind；公开树同层total用于直接子项，不是后代总数。sample/四文件只提供原始内容，未给新包实际登记、更新时间/来源，不能据仓库路径猜产品路径。保留007关联失效/子页失败缺口与分页专项。

需求正文中的样本指仓库原件的获准隔离副本；执行前登记原件摘要→任务项目ID/导入后实际路径的映射，历史`eval-*-20261030`只是旧运行别名，不假定新安装中存在。项目/资源、列偏好及API最小投影尚需本轮获准独立取证；静态相容不证明正常UI已可达或实测通过。本次未启动、连接或操作产品，未读用户状态/凭据，未调用外部API；不改变运行状态，不缩减未就绪专项。

## 历史构建与分层记录


修订：resources/5。依据2026-10-30用户统一采用规则，以已绑定安装版v0.3.0 / 202610281438 / preview的已核实正常行为作为v`0.3`需求依据；复用现有源码、精确产物绑定及独立Review。RES-LIST-001–006正常浏览、展开、加载更多/刷新、展示、查询过滤排序，以及007正常加载/成功空态已采用；007失败反馈、关联根失效/冲突和子页读取失败提示仍待确认，不批准失败无提示或伪装空态。全部未实测，采用不授予产品、用户数据或写入操作权限。

修订2的刷新范围/排序及修订3的合成资料保留；本修订仅变更采用状态，七个ID、判据和需求版本不变，不扩展导航、文献或Viewer判据。

## 精确产物

目标为本任务指定的macOS安装包0.3.0 / 202610281438 / preview。重新核`/Applications/ScholarSeed.app/Contents/Resources/app.asar` SHA256为`1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`；ASAR内out/main/index.js:41022按packaged分支从applicationResources(app)/renderer加载静态资源。只读核下列真实旁置文件，不外推整仓同源：

| 文件（Contents/Resources/renderer/assets下） | SHA256 |
| --- | --- |
| index-C4-PYlXk.js（下文简称index） | `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57` |
| AccountMenuPanel-CZYu9yKi.js（下文简称api chunk） | `fe2d49b09ad2f7d3134775d006fd077653559d4476c7a7a6c1d90c09dd99aa00` |

## 逐项固定、动态与条件

| 条目 | 当前源码及有界产物定位、独立参照 |
| --- | --- |
| 001 | [resources feature](../../../src/renderer/src/features/resources/feature.tsx):31将resource-tree贡献为module面板，material-list贡献为ResourceListing；对应index resourcesFeature:69813。[项目Library](../../../src/renderer/src/features/project/Library.tsx):81的materials选择material-list，对应index Library:57151。入口项目来自homeSelectedProjectId；独立参照获准项目身份和相同project参数，不通过内部store取状态自证 |
| 002 | [ResourcePanel](../../../src/renderer/src/features/resources/ResourcePanel.tsx):155的TreeRow对应index:67973；[state](../../../src/renderer/src/features/resources/state.ts):57的ResourceNode及pendingChildCount对应index:4380，pending=max(0,count-children.length)。目录计数是直接子项总数；根层总数在rootTotal。图标按kind、origin/linkRoot、gitRepository及文件名投影，策略图标由ResourceStatus/resourceVersionBadge投影，版本状态只读公开字段，不据名称猜能力 |
| 003 | [store](../../../src/renderer/src/store.tsx):3299/3314/3356对应index toggleResourceDir:10485、loadMoreResourceChildren:10514、collapseAllResourceDirs:10537；目录展开设置selected并按需续取，折叠只清展开标志，已加载子项保留。index ResourcePanel:68335内hasExpandedDirs:68416控制全部折叠禁用；列表resourceListingRows:58818按同一expanded投影层级 |
| 004 | TreeRow内展开且pending>0、有已投影子项时显示LoadMoreRow，根层按rootTotal-tree.length显示，包LoadMoreRow:68306、根层条件:68523。reloadResourceTree:10424仅对仍是当前项目且未被新刷新替代的结果落页；:10448补根层直到loaded达到min(旧根层loaded,新total)，fetchPendingChildren:8623按浅到深只处理expanded=true且新树可定位的目录，:8633补到min(旧children.length,新total)，首次未投影时至少取一页，分页可超过最低补齐数。数据增加不承诺自动取全新增项，数据减少不保留已删除项；不补已折叠目录全部缓存，也不保证新排序将某目录移出已加载范围后仍可定位。后端page total/offset及节点count是独立参照，不以截图行数自证总数；续取失败的独立反馈未得到完整支持，不编造保证 |
| 005 | [Listing](../../../src/renderer/src/features/resources/Listing.tsx):43对应index ResourceListing:68777，fetchResourceListing取得完整flat items，经resourceListingRows:58818按目录层级投影；sourceLabel:68829、类型及更新时间对应公开source/file_type/updated_at。时间由libraryUpdatedAt(index:35742；[business utils](../../../src/renderer/src/components/business/utils.ts):12)以客户端Date.now、语言/时区计算，缺时间为破折号，7天内相对时间、之后本地日期；边界样本不写死一次取值 |
| 006 | index ResourceListing内matching:68835、visible:68839对应Listing.tsx:109，名称toLocaleLowerCase/includes及query.trim，类型与来源精确过滤；[utils](../../../src/renderer/src/features/resources/utils.ts):4在过滤时补齐祖先并展开匹配路径，时间排序按每层兄弟节点、缺时间置后。筛选/排序为当前列表内存状态，不调用内容或全网检索。完整搜索业务另属专项 |
| 007 | ResourcePanel.tsx:669起及index:68470分初次空树加载、整体error、成功空目录；Listing.tsx:355起分别显示loading、failed重试及成功空/无匹配。迁移提示来自loadFileVersionSettings的migration_required；节点策略异常由公开version投影。关联失效/conflict及子页失败提示存在待确认缺口，见后文，不把源码缺漏批准为正确判据 |

树本地搜索与列表搜索必须分开：[ResourcePanel](../../../src/renderer/src/features/resources/ResourcePanel.tsx):65将RESOURCE_TREE_SEARCH_VISIBLE设false；绑定index的ResourcePanel已消除panel.searchFiles/resource-search输入，不能因searchResources函数仍存在就编可操作要求。相反index ResourceListing:68777明确保留LibraryToolbar的searchVisible及query/type/source/ascending状态。ResourcePanel另有resource-ai-search全网发现入口和提交按钮，只核存在及自然禁用状态，不输入或发送任务。

## 后端Owner绑定

安装包后端根为`Contents/Resources/backend/python/lib/python3.12/site-packages/`。下列包文件与同路径仓库源码SHA256一致，已核对应路由、枚举及同步逻辑；没有读取用户文件、数据库或实际项目目录：

| 仓库Owner | 包与仓库共同SHA256 |
| --- | --- |
| [resources/api/routes.py](../../../../serve/service/resources/api/routes.py) | `7bc0a012b4a49768deb767c1e98b33d56f6da85b6d3e7eaa975613db57ebecd2` |
| [resources/service/listing.py](../../../../serve/service/resources/service/listing.py) | `665c352ae5621ea953fcdf63fb8544a40f569b946d9d01ff20279e8c646bfc17` |
| [resources/persistence/listing.py](../../../../serve/service/resources/persistence/listing.py) | `9513f21e0403cc4e6c797f8d2a7c412960a372b8346fc8ada72cefa5f6d26cb5` |
| [resources/service/observe.py](../../../../serve/service/resources/service/observe.py) | `fb16a3f62c14956eabe86a92483ba78982886bf9fe430aa1c843611898673dc9` |
| [content/service/tree.py](../../../../serve/service/content/service/tree.py) | `3bcb1a575a34d4addd93815b29e446fb9ef7bc21e5556bab4ca3f459909a5249` |

## 同项目公开参照

页面已有认证会话通过window.scholarseed.getApiBase定位Serve，fetch使用credentials=include，不需要猜preload、提取Token或读取磁盘内容。仅在获准隔离实例内，用同一个明确项目参数和必要目录参数取得最小公开投影：

- GET `/api/resource/tree?project=…`；子目录续取追加`path`，同层分页追加`offset`。成功顶层为`{root,resource_root,nodes,linked_roots,total,offset}`，不是裸数组。api chunk fetchResourceTree:1285、后端routes.py:501；默认depth=3，每层PAGE_SIZE=100，额外层级及同层后续条目可续取，不是可见性总上限。
- GET `/api/resource/list?project=…`成功顶层为`{items,linked_roots}`。api chunk fetchResourceListing:1271将items转换为ResourceNode；routes.py:437、service/listing.py:21遍历完整目录及各层页后返回flat items。因此列表不能拿树当前页代替完整参照，也不能用列表折叠后的可见行数当文件总数。
- 仅保留本次获准合成资料的path/name/kind/count/children、origin、git_repository，以及file_type/source/updated_at；必要version仅management_state/drifted/manual_admitted/needs_review等页面所用字段。关联映射只取root_id/mount_path及必要available/conflict，不输出source_path、root/resource_root绝对路径、writableRoots、文件内容、版本内部操作标识或真实用户资料。
- 迁移提示可按已有公开读取`/api/serve/settings/file-versions`仅投影migration_required，包index loadFileVersionSettings:4346；不输出整套策略。刷新还调用`/api/content/roots?project=…`取得关联根，index listExternalRoots:5579；若确需诊断，仅取获准root_id/mount_path/available，不输出外部物理路径。
- 保存查询身份与读取时间，分别核总量、子项和列表字段；读取失败不是空数组或零数量，不能自行补值。不可用/conflict字段缺失与false也不得混用。不得读取内部resource/store或直接调用act代替真实操作。

## 原生副作用及待确认缺口

**GET不等于零状态变化。** routes.py的tree/list在读取前调用supervisor.activate_project；observe.py:264可能准备项目、刷新事件、建立观察流并schedule_scan。list还经ResourceListingCatalog.synchronize维护项目数据库resources_listing表（CREATE TABLE/UPSERT、清理消失记录），不只是内存读取。树刷新调用listExternalRoots时，也可能按既有活动项目将已有writableRoots同步到主进程授权白名单；不是新增外部根授权，但属于正常宿主状态同步。实际执行须明确包含这些原生伴随写入/观察活动；只承诺不发管理写API，不能宣称零状态变化。

已采用正常范围中的轻量动作仅为目录展开/折叠、加载更多、刷新、列表本地查询/筛选/排序及必要滚动，实际执行仍需授权。目录点击不等于文件点击：TreeRow及Listing文件名称均调用openResourceFile，会打开Viewer及改变工作台/最近访问等状态；本页不借点击文件验证展示。拖拽、NameEditor失焦提交、菜单管理、新建、导入、关联、复制/导出、历史/版本、全网提交及设置确认须另授权。

待确认的具体缺口：后端routes.py:253的_tree_payload会返回关联根available=false/conflict=true；但api chunk toNode:1210及当前api.ts:941没有保留这两个字段，TreeRow没有直接对应提示。因此不能认定失效关联显示为空目录是正确，也不能声称当前实现保证了不可用警告。子目录ensureResourceChildren/loadMoreResourceChildren失败当前有直接返回路径，未恢复出统一的逐层失败提示；整体error提示不能自动替代子页失败。这些异常分支仍须取得明确采用依据后再冻结，不随正常行为采用；不据源码单独判定产品已失败，更不为追绿移除条件。

## 数据与未观测范围

可复用基础资料为[sample/overview.md](../../../../../examples/projects/evaluation/files/overview.md)、[notes/detail.txt](../../../../../examples/projects/evaluation/files/notes/detail.txt)、[notes/summary.md](../../../../../examples/projects/evaluation/files/notes/summary.md)及[methods/appendix.md](../../../../../examples/projects/evaluation/files/notes/methods/appendix.md)，均为明确合成的Markdown/纯文本。四个文件共享SYNTHETIC-CORPUS词，分别有ALPHA/BETA/GAMMA/DELTA标记；可供基础层级、类型、列表筛选及文件搜索准备，不含真实资料、外部地址或预设通过结论。它们尚未导入项目；根路径、source、更新时间、MRU及关联须由后续获准真实流程产生，不直接改库或复制成已完成的业务结果。

此小样本不提供单层超过100项、超出首次深度的完整场景、非零关联/Git/版本异常或不同来源类型，不能据此完成全部条件分支。来源与时间比较仍取实际公开元数据，不按仓库文件时间或文件扩展名推断。

最小非空资料是一个获准隔离项目、两层可区分目录和少量不同扩展名的合成文件；真实来源字段只能通过获准创建/导入/关联流程产生，不凭文件位置猜source。分页须单层超过100项，深层续取须超过首次深度投影；空项目不能代替这两项通过。若本轮未授权数据准备，保留未就绪，不直接改库或把最终展开状态预置成已完成步骤。

关联根失效/冲突、Git、版本迁移或策略异常需其自然状态或专项环境；不得为取图移走用户目录、撤销关联、改权限或切版本策略。较大样本准备、文件管理、Viewer、内容搜索和全网模型任务分别走所属专项，不由本页展示范围扩大授权。

当前没有本页真实截图或已批准运行，参考图待获准采集，不编造图及占位资产。已采用要求、当前源码、包实现、待确认分支及运行事实分开；后续可补获准参考图和构建修订，不以图中动态文件、时间、展开位置固化长期预期。

## 发布快评分层（2026-10-30）

本资产修订为resources/5；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为RES-LIST-001–003、005、007的正文明确子要点；必要参照为已有eval-resources-20261030及其冻结相对路径清单；只核选定目录，不读未知根。未选范围为分页、刷新、全筛选/排序、加载瞬态、失败/空根/关联失效及写入；不执行旧collector，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。
