# 全局搜索需求构建依据

## 隔离资料准备边界：search/14

下方历史“数据与副作用边界”中的未导入状态属于当时建库记录，不是对后续每轮强制执行 UI 导入的要求。当前资料搜索可使用获准隔离项目中已准备的 examples 副本，以当轮收据、项目路径和文件摘要核身份；准备数据不代表搜索已执行或通过，也不自动授权新的产品写入。文献域仍需真实已入库文献及同范围独立参照，单有 Bib 文件不能代替。本轮按用户要求不评测导入；原判据、历史冻结及结果不变。

## 目标版本搜索结果参考图：search/13

`results-20261113-1823.png` 为 2026-11-13 macOS arm64 安装版 `0.3.2 / 202611121823 / preview` 隔离实例真实完整窗口原图副本；目标 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`，图片 SHA-256 `fb121f9cd85a2593bea83f9b1e87334a8326b7c686b7946459e3d08d4cda91c7`。原图为 `tmp/test_snapshot/desktop/baseline-1823-recheck-20261113/driver/evidence/f3-search.png`，忽略的原始运行和独立评审仅本机可回查。图片展示合成资料命中，不单独证明打开动作或其他分类；需求版本、判据和历史结果不变。

## 需求与运行进度分离：search/12

移除需求正文中笼统的历史“全部未实测”状态，运行进度与各轮结果以场景索引及运行记录为准；不改变稳定 ID、需求版本、采用范围、专项边界或历史冻结。参考图注的采集日期按下述既有来源补全。

## 打开目标参考图补充：search/11

`open-result-20261112.png` 为 2026-11-12 macOS arm64 安装版 `0.3.2 / 202611121823 / preview` 隔离实例打开合成 `sample.md` 的真实页面原图副本；目标 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`，图片 SHA-256 `b7fce64d6f133019af5d01ca1eff5335fef7c16de98b3c4f573bb0944b9a52b0`。原图为 `tmp/test_snapshot/desktop/baseline-1823-batch1/driver/evidence/f3-open.png`，忽略的运行证据仅本机可回查。该图显示目标文档，不单独证明搜索到打开的关联或其他分类；需求版本、判据和历史结果不变。

## 共享输入链接修正：search/10

资料和题录链接改为字节一致的共享 `examples`；原副本及来源提交分别见[资料构建依据](../resources/build.md)和[文献构建依据](../literature-list/build.md)。仅修正引用，不改变需求、判据或历史结果。

## F3 普通搜索路径沿用依据：search/9

针对 macOS arm64 `0.3.2 / 202611121823 / preview`，沿用 2026-10-30 用户统一采用规则及本页 `search/4` 的已采用正常子点：在已核当前项目范围内查询已知合成文件、核对资源命中并打开该目标。已核本页既有采用与后续修订，未发现该子范围被确认退役或改变的记录；这只是有界记录核查，不宣称完整需求变更史或源码与制品同源。无项目回退、仅文件入口、异常及其他搜索范围仍按原文待确认或另列专项。原编号、v`0.3`、判据及旧运行不变；新运行仍须核项目登记、样本与独立参照，由独立评审判断证据，不因本记录认定产品通过。下方 `search/8` 所述目标适用性待核针对当时未完成此项有界沿用分析的状态。

## 共享示例输入对齐：search/8

本修订仅将现行快评输入明确为共享项目 `evaluation/document`，以本轮准备收据核项目身份、路径及摘要。2026-11-12 核对 `examples/projects/evaluation/files/sample.md` 与原 `research/document` SHA-256 均为 `a77fec4534bce0994a47e17a2bc4f862839a295ccfa82c08555180afb55ec1e0`；内容相同不使两个项目身份相同，不能将旧收据移作新项目登记。原稳定 ID、需求版本、判据及历史结果不变；目标包适用性仍需独立核实，本修订不代表产品通过。

## 当前参考图修订：search/7

`reference-20261112.png` 为 2026-11-12 macOS arm64 安装版 0.3.2 / 202611121104 / preview 隔离实例原图 `evidence/search-results.png` 的未改动副本，SHA-256 `e9e5f4923f8fdfe928e83c67af94c4a65663fe5174c426e24145faed5b8a8e2d`；仅展示合成资料查询状态，不证明全部分类或异常。原始运行在 `tmp/test_snapshot/desktop/release-20261112-fresh/`；不改变需求或历史裁决。

## 历史修订：共享示例项目输入接线（search/6）

资产修订：`search/6`。以下保留当时 `research/document` 的接线与状态，现行输入以 `search/8` 为准。本次仅维护输入来源、准备收据和执行接线，需求仍为v`0.3`，
GSEARCH稳定ID、发布快评子范围及所有旧裁决不变。以下安装包分析仍是各自历史来源，
不是新代码的同构建绑定；本修订未启动产品或执行Skill宿主验收。

首条共享数据消费链选择已有正常项目范围的综合搜索→打开已知Markdown，不纳入
查找Next、编辑保存、会话/模型、跨项目和分页专项。原Markdown字节已迁至
[共享原件](../../../../../examples/projects/research/files/sample.md)，由
[项目定义](../../../../../examples/projects/research/project.json)引用；文件身份为
`research/document`，实际产品路径只从本轮准备收据取得，不能固化模板路径或旧项目ID。

执行时复用公共解析与真实项目准备能力，流程由
执行规程持有。
冻结数据选择、contentDigest、源码提交/未提交输入身份、实际目标包/实例、项目key/id/root，
以及document文件的path/relativePath/sha256/size。先核唯一自有实例、真实API基址及
隔离workspace归属；只准备原始资料，不预先执行被测搜索、打开或写MRU。

独立参照包括源文件摘要、公开登记的当前项目身份和已知相对资料位置；公开搜索API
的同查询/同项目命中可补充比对，不能从待判页面取值自证。隐藏判据和参考不进入产品
目录或Driver输入，Driver仅获得必要任务定位。准备失败保留原错误和部分receipt，
不重提创建mutation、不伪装空结果。当前只完成静态接线；真实准备、UI终态、宿主
transcript和独立Judge结果仍需后续授权资源窗口验证，不沿用历史截图宣称通过。

## 历史修订：202610301343包内静态复核

资产修订：`search/5`；本次只补指定新包来源、输入/独立参照与快评边界。原稳定ID、v`0.3`、采用规则、完整正文、参考图原版本/日期及历史结果保留；以下旧来源与修订记录均属历史，不代表本包绑定或本轮执行结论。

目标：macOS arm64 `0.3.0 / 202610301343 / preview`；ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。来源为本任务已提取的实际安装包与松散renderer payload；源码提交未知，当前checkout/remote HEAD仅可辅助定位，不声明同源。证据清单为忽略目录 `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`，包内定位均相对该根`package/`；不将临时提取目录当正式跨工作树资产。

包内`out/main/index.js` SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`：1338的applicationRenderer在packaged时取applicationResources下renderer，41203的无开发URL分支交给serveAssets。该链绑定本次分析的实际松散payload，不证明运行时未设置开发覆盖，也不把静态入口当产品观察。

- `renderer/assets/index-CddcCmKt.js`：SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`。

包内index:86826 searchEverything读取/api/search的hits/groups；86901 GlobalSearch在literature用query.project_id，其它范围用homeSelectedProjectId，240ms查询和generation/abort防旧结果覆盖。固定三域、动态高亮与打开链仍在；只选已知项目中的正常综合搜索和一个资源结果，不升级files或无项目回退为要求。执行参照须先登记项目ID、原始样本摘要、实际导入相对路径及查询词；API命中与待判UI不是唯一输入身份答案。错误仍可能转空hits，保留007未确认语义，不批准为正常空态。

需求正文中的样本指仓库原件的获准隔离副本；执行前登记原件摘要→任务项目ID/导入后实际路径的映射，历史`eval-*-20261030`只是旧运行别名，不假定新安装中存在。项目/资源、列偏好及API最小投影尚需本轮获准独立取证；静态相容不证明正常UI已可达或实测通过。本次未启动、连接或操作产品，未读用户状态/凭据，未调用外部API；不改变运行状态，不缩减未就绪专项。

## 历史构建与分层记录


修订：search/4。依据2026-10-30用户统一采用规则，以已绑定安装版v0.3.0 / 202610281438 / preview的已核实正常行为作为v`0.3`需求依据；复用现有源码、精确产物绑定及修订2的独立Review。GSEARCH-001正常综合搜索入口/已明确项目范围、002–006正常最近文件/结果/数量/高亮/打开，以及007正常查询更新已采用。001仅文件入口、无项目范围与文献筛选入口可达性，007首查加载、失败与零命中区分仍待确认，不批准默认项目回退或失败空组。全部未实测，006跳转仍需真实数据与读取/MRU权限，不扩产品、模型或写入授权。

本修订仅变更采用状态，七个ID、判据和需求版本不变，不修改导航、资料、文献及会话的唯一业务判据。

## 精确产物与设计依据

目标为本任务指定的macOS安装包0.3.0 / 202610281438 / preview，重新核`/Applications/ScholarSeed.app/Contents/Resources/app.asar` SHA256=`1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`。ASAR内out/main/index.js:41022的packaged分支从applicationResources(app)/renderer加载静态资源；真实`Contents/Resources/renderer/assets/index-C4-PYlXk.js` SHA256=`22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57`，下文包行均指该renderer。没有假定整仓同源。

本地[MasterGo搜索记录](../../../docs/design/mastergo/search.md)是设计证据而非验收或新增批准：支持最近文件布局、三域结果及高亮的观察，明确搜索范围、导航、加载/错误等未知；不能从图中五条历史或每组三条推断完整规则。当前固定行数另有下述绑定实现依据，按统一规则已采用为正常展示要求；设计中的未知项仍不由此批准。

## 逐项绑定及独立参照

| 条目 | 固定、动态、条件与当前源码/包定位 |
| --- | --- |
| 001 | [TopBar](../../../src/renderer/src/shell/TopBar.tsx):54/102及[项目Navigation](../../../src/renderer/src/features/project/Navigation.tsx):332两个真实入口均设置all；全局文献未选项目时顶栏搜索隐藏。包TopBarLeft:86485、ProjectNavigation:56588、GlobalSearch:85184；范围表达式:85195在literature取catalogue.query.project_id，其它取homeSelectedProjectId。files分支:85196仅按state分支，当前源码及整份renderer未找到设置files的正常入口，不通过内部set激活，不按常规入口纳入断言 |
| 002 | [GlobalSearch](../../../src/renderer/src/features/search/GlobalSearch.tsx):213及包:85274按searchProjectId过滤recentFiles、排除无有效项目引用的记录并slice(0,5)，不校验实际文件可用性。标题取路径末段，路径显示去resources/前缀；openedAt按客户端语言/时区格式化。独立参照获准隔离偏好的recentFiles最小投影及公开项目id/name，不能用画面或启动快照自证最新MRU |
| 003 | GlobalSearch.tsx:207及包:85269按resource/literature/session固定顺序分组；空组独立EmptyState。api.ts:49对应包searchEverything:85109，trim仅用于query首尾，HTTP公开命中作为本轮标题/副标题/身份独立参照。不同域的命中理由可能来自路径、正文或其他字段，不要求所有命中标题都有查询词 |
| 004 | GlobalSearch.tsx:306起，包:85369从groups读total/truncated、:85371初始最多3项，:85422更多追加10、:85427已展示完返回窗口且truncated时提示。更多只改变本地expanded，不重取下一页；后端platform/search.py:70的_window每域最多80项，计数与截断来自域结果，不能用当前3条或80条自证总量 |
| 005 | [highlight](../../../src/renderer/src/features/search/highlight.ts):12对应包:85124；关键词trim后toLowerCase，以非重叠区间切原文，渲染保留原始大小写。对公开hit.title/subtitle独立计算范围再核实际mark，不用页面mark反推预期；普通拉丁文合成词可先核，不外推所有Unicode语言归一化 |
| 006 | GlobalSearch.tsx:168、包openHit:85237分别走openResourceFile/revealResourceFile、catalogue.focus及openPanelSession(turnId,itemId)，随后close。包openResourceTarget:4967用于最近文件，先选择记录项目再打开。文献视图筛选项目与homeSelectedProjectId可能不同，资料/会话分支未显式统一选择searchProjectId，故尤其要以真实目标终态核范围，不能把注释或调用存在当跳转已正确 |
| 007 | GlobalSearch.tsx:124起、包:85203起的effect在query/filesOnly/searchProjectId变化时清expanded、取消timer/AbortController，返回检查generation与aborted；结果成功落页后scrollTo top=0。api失败null与加载优先级的缺口见下文，不把当前错误折叠当产品要求 |

## 后端Owner与公开协议

安装包后端根为`Contents/Resources/backend/python/lib/python3.12/site-packages/`，以下目标文件与仓库SHA256一致，已核路由、作用域和提供者链；没有查询实际数据：

| Owner源码 | 安装包与仓库共同SHA256 |
| --- | --- |
| [platform/search.py](../../../../serve/service/platform/search.py) | `78e454322a3be574957f2ddd4e9f592e831f78aa2eb1df6143096c65966e2a47` |
| [content/service/search.py](../../../../serve/service/content/service/search.py) | `fc5cbfc5214664d6f2310a6d075234958e9ff9b965c813fb526d33ac0a01e54c` |
| [content/service/port.py](../../../../serve/service/content/service/port.py) | `e04f6b582e536458136328f4f2a09bdeedac18982b2f6c037843d6ec670b20e0` |
| [chat/service/sessions.py](../../../../serve/service/chat/service/sessions.py) | `d7bba25c600f0b104e36a361f939d95380f153738ca4da323c058a06dda3a71b` |

GET `/api/search?q=…&project=…`使用页面已有认证会话、credentials=include，Serve基址来自window.scholarseed.getApiBase；空项目参数省略，不猜preload方法或提取Token。成功顶层为`{query,hits,groups}`，hits为数组，groups按resource/literature/session包含`{total,truncated}`；每个hit含domain/id/title/subtitle及可空reveal/locator，不是分页items容器。取数只读公开接口不证明没有内容读取权限要求。

独立参照保存本次q（保留词中空格）、是否传project及实际获准项目身份；只投影合成资料命中的domain/id/title/subtitle、groups.total/truncated及必要reveal.kind/query/source_revision、locator.turn_id/item_id。正文片段与对话摘要仅在明确获准的合成数据范围保存，不输出真实历史、其他项目路径、完整会话、凭据或整个未审响应。截断时不能凭返回窗口重建全库精确命中数；可用合成清单及公开计数共同核总量语义。

platform/search.py:80由Content search取得资料命中，资料按精确文件名、文件名、路径、正文优先，正文可提取时读稳定快照并返回片段及find定位；:100复用文献load_library/apply_query，副标题为作者/年份；:121经SessionService.search_project调用项目可见会话及portable_history，返回片段和消息locator。搜索不是全网搜索，不调用模型，但会读取资料内容与可见会话片段；files模式也仍发送同一三域查询，只在前端过滤，绝不能当作隐私隔离。

## 尚未批准的语义缺口

- 无项目范围：前端searchProjectId=null时省project，platform/search.py:163的_scope仍调用content.project(None)，port.py:427的registry.resolve(None)采用default项目，而不是跨全部项目；最近记录在同样null时却跨项目。该差异只作为实现事实，待确认应有产品范围，不批准fallback为正确或据名称要求全域。全局文献顶栏搜索隐藏，其query.project_id分支的正常入口也待观察，不能强制内部激活。
- 错误与空结果：包searchEverything:85109非2xx或异常返回null，GlobalSearch:85218转为hits=[]/counts={}，catch也同样清空，最后显示三域零命中。源码注释称失败null可区分，并不证明UI已区分；不能把失败伪装无命中批准为正确需求，也不能仅凭源码宣布实际产品失败。
- 首查加载：包:85303先判断hits===null才到:85362的loading，首次关键词等待时可能仍显示最近文件；已有结果再查询时路径不同。未恢复出统一且已批准的首查反馈标准，保留待确认，不虚构加载截图或故障测试通过。
- files入口：模式分支已绑定，但无正常可见入口依据；正常all路径已采用，不因files缺口退役，不以内部store、测试fixture或隐藏模式替代用户流程。

## 数据与副作用边界

复用资料场景的[overview.md](../../../../../examples/projects/evaluation/files/overview.md)、[detail.txt](../../../../../examples/projects/evaluation/files/notes/detail.txt)、[summary.md](../../../../../examples/projects/evaluation/files/notes/summary.md)、[appendix.md](../../../../../examples/projects/evaluation/files/notes/methods/appendix.md)，共享词SYNTHETIC-CORPUS及ALPHA/BETA/GAMMA/DELTA区分标记；不另建搜索语料。也可复用[文献列表sample.bib](../../../../../examples/projects/evaluation/files/sample.bib)作为合成题录输入，该BibTeX仅纯解析核过。建库时上述资料与题录尚未导入，当时记录的 UI 导入前提不适用于后续所有轮次；现行区分见 [search/14](#隔离资料准备边界search14)。样本自身不是现有命中或产品通过证据。基础场景仍需获准隔离项目；会话命中须已有获准合成对话及消息位置，没有时不发模型请求或私写会话库造数据。跨项目范围至少两个可区分项目，最近记录通过获准正常文件打开产生，不直接写MRU或内部状态。

更多需同域至少4个命中，截断需超过80项或自然截断；没有大样本就保留分支未覆盖，不缩成3条总数或宣称更多取尽所有匹配。空查询不发搜索API，不能用其最近列表证明非空查询范围；零命中也不能代替失败场景。

打开结果可能加载Viewer、会话消息或文献详情，并改变工作区/最近访问/持久导航等状态；资料openResourceFile在store.tsx:3140更新recentFiles，文献catalogue.focus同样记录最近访问。最近文件字段为projectId/path/openedAt；最新独立参照需Owner解析隔离profile的renderer-preferences.json后只投影recentFiles，并用公开项目目录核有效身份，不能用preload.preferences启动快照当操作后的最新值。实际执行须集中授权合成内容与会话片段读取、目标打开及其原生伴随状态变化；旧授权不继承。

本页不扩张文件编辑、文献同步、历史全文、会话任务、模型或网页权限；不从原始数据预先生成完成后的目标状态。当前无获准产品运行、截图或完整已导入搜索数据，参考图待后续许可后采集，不造图或机器框架。公共预算、冻结、驱动和Judge规程由Skill持有，不复制到本页。

## 发布快评分层（2026-10-30）

本资产修订为search/4；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为GSEARCH-001、003、005、006的正文明确子要点；必要参照为当前任务项目身份与eval-editor-20261030.md的既有路径；范围无法核明则F3及本动作缺证停止，不自批。未选范围为001仅文件入口/无项目回退/文献范围、最近文件、全部分组分页、高亮全矩阵及007失败/首查瞬态仍未选或待确认，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。
