# 浏览器设置基线构建依据

当前资产修订：`browser-settings/17`（前向保留高级设置配置边界及 `browser-settings/16` 的清理展示与实际清除边界）；目标包有界来源及未核条件见[202611121823 有界复核](#202611121823-有界复核)，旧包读取记录仅为线索。原稳定ID、原v`0.3`要求及历史裁决保留；新增确认规则的需求版本及更广泛的版本适用范围待核。

## 目标版本规则区域参考：browser-settings/15

`window-middle-20261113.png` 为 `tmp/test_snapshot/desktop/baseline-1823-browser-clear-20261113/driver/evidence/browser-middle.png` 的未裁切、未缩放原字节副本，1280×840，SHA-256 `718fc9c2c689de7857d4e83851d8dfc096dd853f666c910b1cf27bda24157959`；采集于 2026-11-13 11:46:35 +0800，`driver/index.md` 第 22 项为截图命令。同轮 `freeze.md` 与准备记录绑定 macOS arm64 `0.3.2 / 202611121823 / preview` 和 `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。已打开核对为完整设置窗口的中部滚动视口，展示外部自动化及 Agent 网站规则；图含本机端口，不含完整连接密钥。端口、开关和站点规则均为动态状态，此图不证明规则编辑、Agent 授权或 CDP 连接，也不替代当轮评测及独立参照；需求判据、版本及历史裁决不变。

## 清理选项演进线索：browser-settings/14

提交 `0cbc8457747275cbdb3bdd0e98b18ad0ef9e7c38`（2026-10-28）将清理对话框的类型选择改为统一呈现，未选择时禁用提交；该提交是当前源码基点 `acce09fa42` 的祖先，但不是原基线源码提交 `74eedd1807` 的祖先。目标包真实截图也显示类型复选项，但尚无可信源码与安装包同源证明。有限检索的设计映射、浏览器文档、工作记录及相关提交中未找到用户明确确认此改动取代旧 `BROWSER-SET-006` 的要求；源码或提交不能自行批准新判据，也不能撤销本轮按原冻结作出的不符合。需求演进和目标适用性仍须 Owner 核实，未检索的外部需求不能据此认定不存在。

## 清理选项实际状态参考：browser-settings/13

`clear-options-20261113.png` 为 `tmp/test_snapshot/desktop/baseline-1823-browser-clear-20261113/supplement/evidence/options.png` 的未裁切、未缩放原字节副本，1280×840，SHA-256 `14afbaf179cb87fa1c432a4cbe9b0ee9cbf02d6cfe863130556c6ae6d235fcd3`；采集于 2026-11-13 11:51:03 +0800，运行 `supplement/index.md` 第 8 项为截图命令。该轮 `freeze.md` 与准备记录绑定 macOS arm64 `0.3.2 / 202611121823 / preview` 和 `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`；已打开核对完整窗口及弹窗，无可见凭据或历史条目。补证独立 Judge 以原冻结判本展示单元**不符合**：默认范围可见类型复选项，与已采用 BROWSER-SET-006 不显示该区域的要求冲突；网站数据按站点处理的说明另留缺证。需求 Owner 对差异的确认待完成，截图是实际状态参考，不是正确预期或调整判据的依据。未选择类型或执行清除，不由此证明清理、历史搜索或浏览器设置整页通过；原冻结及先后裁决保留。

## 目标版本顶部完整窗口参考：browser-settings/12

`window-top-20261113.png` 是 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例于 2026-11-13 09:42:37 +0800 的完整窗口原图副本，源为 `tmp/test_snapshot/desktop/baseline-1823-vault-confirmed/driver/evidence/browser-top.png`，对应该批 driver/index 的第 16 次截图；SHA-256 `e671690493d944e9f098083b473a3ed86450cd0217474add182caf48e1cfc750`。批次计划记录目标 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。图含本机用户名、下载目录和本机端口，未显示完整连接密钥；仅展示顶部设置和当时状态，不证明下载、授权或运行通过，不改历史判据和冻结。

## 20261113 完整窗口参考图：`browser-settings/9`

`window-20261113.png` 是 2026-11-13 在 macOS arm64 安装版 `0.3.2 / 202611121823 / preview` 隔离实例采集的完整设置窗口原图副本，来自 `tmp/test_snapshot/desktop/baseline-1823-browser/driver/evidence/browser-03.png`，SHA-256 `92e776f084510fb6f7932afcf6634ad575f96561975b3aa2932276ecf4fe957d`；目标 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。截图为高级设置的滚动视口，未展示的区域仍是截图缺口；旧局部图及历史记录保留，不再嵌入现行需求和概览。图仅作参考，不改变需求或历史裁决。

## 2026-11-13 本轮适用确认：`browser-settings/8`

用户在本次评测会话中明确要求“继续根据已确认的规则推进剩余基线建设和评测，未确认的事项先记录”。结合此前对 `unavailable/revoked` 的明确答复，该补充规则用于当前目标包 `0.3.2 / 202611121823 / preview` 的新运行；仅限状态不可用且错误码为 `revoked` 的组合，其他错误仍按原要求处理。用户未指定需求版本号或对其他制品的适用范围，均不推断。新运行须重新冻结规则并核实例、同期状态与独立参照；不以规则确认或现有截图认定产品通过，也不回写旧冻结和裁决。下文 `browser-settings/7` 的适用范围待核描述保留当时状态。

## 2026-11-13 用户确认：`browser-settings/7`

用户在本次评测会话中针对“密码库状态为不可用、接口返回 `revoked` 时是否额外显示错误说明”明确选择“仅显示不可用即可”。因此在 BROWSER-SET-002 保留原要求，并单独记录仅适用于该状态和错误码组合的补充规则；其他错误仍须按原文判断。用户未指定该实质补充的需求版本或适用版本范围，不能用当前安装包号推断，先标记待确认，不作为已冻结运行判据。目标包对 `revoked` 的实现分析和后采状态仅为线索，不替代用户确认、同期状态参照或产品验收；原评测冻结与独立裁决不变。

## 202611121823 有界复核

依据2026-10-30 用户统一采用规则及本页既有发布快评分层，BROWSER-SET-001–006 中正文已明确采用的正常展示子点继续作为本目标的有界回归依据；未确认条件、完整细则及专项不因此获批。已读本页采用记录及相关变更，未发现授权删除上述正常要求的明确决定；这不是完整需求变更史或源码与制品同源证明。页面真实可达性、当前状态与独立参照仍须本轮核实，不代表产品通过。

只读制品来源：macOS arm64 `0.3.2 / 202611121823 / preview`，`app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。包内 `out/main/index.js` 的 packaged `applicationRenderer` 使用 Resources 下 renderer；实际 `WorkspaceFiles-iWg6TRxB.js` SHA-256 `958c5818ef2365627df2d3ae580e73aa7f4e4248cfbf32266af065e4296799fb` 在约112197行对 overview 自然发起 downloads read。包内 main 的 `createDownloadPreferences.snapshot()` 仍以 `directoryOverride ?? defaultDirectory` 选择目录并在条件满足时执行探针；默认目录来自 Electron `app.getPath('downloads')`，不因隔离 profile 自动成为隔离路径。`canPublishDownload` 使用 Python 子进程、5 秒超时；探针涉及源和目标目录写入与清理，不能由源码推断实际清理成功。实际目录、运行状态及探针写删授权未核前，不进入该 overview，也不主动发起该 read；保留所选缺口，不改分母。

仓库 `HEAD` 为 `acce09fa42ddf234d84b02dde34b2ab4be570215`，已包含 `9d0d0f6d4`（初始浏览器下载和状态通知修复）；该提交改动下载来源准入及状态通知，不作为重写本页展示判据或证明目标包包含该提交的依据。当前仓库 `downloads.ts`、`browser.ts`、`Settings.tsx` 与 HEAD 无未提交差异，SHA-256 分别为 `f75be4056a649d48a36942f4bfe6133ff788ddcb193c93fda5c821dd1278a15e`、`4671c6c12136e8488085525f3673d17df48836b43144884f09b62bf6e98d93fc`、`3ed969faf908add9fc6c7e87a707e9f8f98a0d91cb88b83d58acf80541132edf`。其他后续 UI/动态语义、平台状态及真实探针结果仍待核；不据源码或旧参考图推断目标包已通过。
目标分支历史修订 `browser-settings/6`：依据 2026-11-13 确认的高级设置下线范围，默认配置核历史管理与下载设置可达、高级入口不出现；历史判据及截图保留，仅适用于显式开启高级能力的配置。通过 manifest 和 Main IPC 准入区分两类制品；下载读取仍须遵守下文的目录隔离要求。此修订不包含搜索、Windows 或历史评测通过结论。目标分支与本工作分别演进，原修订号保留以追溯来源。

历史资产修订：`browser-settings/5`；下载读取的安全前提见[当前源码与安全副作用复核](#当前源码与安全副作用复核)。原稳定ID、v`0.3`、业务判据和历史裁决不变。

历史资产修订：`browser-settings/4`，仅澄清已采用快评边界；其下建库、制品与读取说明均保留原来源范围，不充当当前源码的零副作用保证。其中 downloads read 无写入的表述由本页最新复核更正，原制品锚点仍保留。

2026-10-30增量：依据用户速度优先、保留原要求的Goal及已在speed轮实测前冻结的解释，快评段显式列主要状态/参照，不由“按原判据”回到恢复默认disabled等完整细则。原001–006全文、ID、v`0.3`、参考图和历史未知不改；不是产品预期变化或按本轮结果追绿。本次仅文档Review澄清，无新增源码事实或产品验收结论。

历史建库说明：修订：browser-settings/2，6项需求已独立Review；202610281438同构建首采5符合/1缺证，同轮补证后6/6当前展示符合、必要截图齐全。用户采用v0.3功能建库；范围为设置展示，不包括网页浏览、历史条目、设置写入、密码库解锁或清理行为。首采漏项、阶段重复开启被拒绝及CLI自动快照限制留运行记录，不宣称执行无偏离。

目标：macOS arm64，0.3.0 / 202610281438 / preview；app.asar SHA256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`，renderer index-C4-PYlXk.js SHA256 `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57`。包内BrowserSettings:76605、VaultSettings:76502及History:76329与下列源码有界核对；不声称整仓同源。

中文固定说明参照browser命名空间。目标包components-2gI1CB8f.js SHA256 `8b637a08f0b610d7d18aa58c9706342ff84695ba84acff0fe0927c23a699039f`；其中settings.title/cdpDescription/warning/downloadAgentNavigationBlocked/agentSubmit/dataDescription六条与仓库中文资源相符，不外推整包本地化同源。

| 要求 | 固定/动态/条件来源与独立参照 |
| --- | --- |
| 001 | [AccountPanel](../../../src/renderer/src/components/business/AccountPanel.tsx):330/5159及[能力策略](../../../src/renderer/src/app/policy.ts)控制入口；[Settings](../../../src/renderer/src/features/browser/Settings.tsx):464起组合各分区，History独立卡片。先核browser能力是否开放，不启用能力以制造可达 |
| 002 | Settings:55–173，[状态文案映射](../../../src/renderer/src/features/browser/messages.ts)及[中文资源](../../../src/localization/locales/zh/browser.json)；状态来自vault.status及订阅，只有unlocked调用listMetadata并投影count；unavailable/unlocking/locking禁用解锁及删除，invalid_format另禁解锁；uninitialized不显示删除入口 |
| 003 | Settings:234/431/470；browser.snapshot返回snapshot.automation，只取enabled/port；enabled且port非null才拼127.0.0.1:port，不能把产品调试CDP端口当内置浏览器端口。开关仅desktop_bridge_unavailable或busy禁用，地址复制为写剪贴板动作，不执行 |
| 004 | Settings:258/512；browser.downloads({kind:'read'})返回settings的directory/isDefault/directoryAvailable/askEveryTime/automaticAvailable。askEveryTime无参照时暂回退true；automaticAvailable=false禁开关，isDefault=true禁恢复；目录换选/恢复及询问开关均为写操作 |
| 005 | Settings:275/575；browser.policy({kind:'read'})返回policy的agentBrowserUseEnabled/sites，站点含origin/read/interact；加载与policy缺失/错误不同于空sites。空表单默认read/allow，实际有规则时映射ask/allow/block；不编辑或发起Agent任务 |
| 006 | Settings:200/746；clearChoice首次为hour，无站点/类型子表单；固定警告由中文资源提供。清除按钮会展开破坏性确认，未获准点击；不能以展示判断清理或关闭标签成功 |

参照协议经[preload](../../../src/preload/index.ts):254/270与[主进程IPC](../../../src/main/browseripc.ts):59/132/150核对。snapshot只读host快照；downloads read取当前目录设置；policy read取策略快照，不发起导航、授权或写入。vault.status返回state/generation/error，不解锁；只有确有unlocked条件才读取metadata并只留count/generation，不输出items或秘密。原始快照可能含标签网址，必须在renderer内投影automation后才输出。

页面自然挂载会读取上述状态，并由History卡片查询隔离实例的历史；本轮不主动调用history、不提取条目/标题/网址。采证白名单限本页设置卡片和历史标题/搜索入口；如存在非空历史，不采含条目的画面、不展开，不把条目纳入判断。设置页显示不证明历史权限或凭据行为通过。

精确容器：`window.scholarseed.browser.snapshot()`→`{ok,snapshot.automation}`，`.downloads({kind:'read'})`→`{ok,settings}`，`.policy({kind:'read'})`→`{ok,policy}`；`window.scholarseed.vault.status()`直接返回状态，无ok包装。设置区成功加载策略才显示添加表单；失败显示不可用及重试。History自然挂载查询首批20条，不声称产品没有读取历史；自动化不主动查询、提取或采证条目，优先采用白名单设置卡片原生截图，非空历史不阻塞其他设置区域。

真实入口已核为头像菜单→设置→浏览器。参考图复用2026-10-29本轮采证的02-cdp.png与04-agent-sites.png，保存为reference.png/access.png，均为未编辑、无历史条目或凭据的原生卡片截图；SHA256依次为`ab79cefc67771a432ada69c13d7dd145e0132d7683c902ffdc83f4b703b6b678`、`80b01d2994325420b242f632fef8086d824d7680d12253ef0fc72f4e1f499d92`。它们仅帮助理解局部界面，不将动态端口、开关或站点规则固化为预期。

运行实例、动作预算、权限、调用及详细报告只留忽略运行目录；缺少页面证据的点不标评测完成。

## 发布快评分层（2026-10-30）

本资产修订为browser-settings/2；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为BROWSER-SET-001–006的正文明确子要点；必要参照为任务实例各Owner当前状态最小投影；不取密码、凭据或历史条目。未选范围为密码库创建/解锁、历史正文、偏好修改、CDP复制/访问、规则编辑及清理，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。


## 当前制品复核

本节保留历史制品依据；目标 `202611121823` 的有界沿用与安全前提见本文开头 `browser-settings/6`，不得将以下旧包契约直接当作目标包验证。

历史资产修订：`browser-settings/3`（2026-10-30）。本节标题锚点保留供旧引用回查；当前读取与安全前提见[最新源码复核](#当前源码与安全副作用复核)。本节仅增量更新原制品定位与独立参照，不改变稳定ID、v`0.3`、完整判据或快评/专项边界；前文包号、旧源码行号、分层修订与结果均是历史记录，不作为本轮包绑定或通过结论。参考图仍保留原来源日期/构建。

本轮来源为已核安装包 `0.3.0 / 202610301343 / preview / macOS arm64`；app.asar SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。直接证据为实际松散发布目录 `renderer/assets/index-CddcCmKt.js`，SHA-256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`；下述编译函数/行号均指此文件，另名文件明确标出。引用的 `out/preload/index.js` SHA-256 `754a7f2fc34f7f1c6ac7f21c256c156f9c3b9dcf88c2c64a20b3d82bcb992219`，`out/main/index.js` SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`；偏好常量所在 `renderer/assets/AccountMenuPanel-CHQ1thBC.js` SHA-256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。源码提交未绑定；前文仓库Owner链接仅为辅助线索，不将checkout/远端HEAD等同本包。

- 固定/动态/条件：`BrowserSettings:78326` 分 overview/history，overview 仍组合密码库、自动化、下载、网站规则、History 和清理区；`section==='history':78553` 是独立历史页分支，不自动扩为本页历史正文快评。入口受 browserEnabled/能力策略控制；安装包 product.json 的 features.browser=true 只证明构建配置，不能替代实际实例开放条件。
- 精确读取沿用并复核：`browser.snapshot()` → `{ok,snapshot.automation}`，只留 enabled/port；`browser.downloads({kind:'read'})` → `{ok,settings}`，只留 directory/isDefault/directoryAvailable/askEveryTime/automaticAvailable；`browser.policy({kind:'read'})` → `{ok,policy}`，只留 agentBrowserUseEnabled/sites 的 origin/read/interact。必须在执行上下文内先投影再输出；snapshot 不落标签网址，自动化端口不等于产品调试端口。
- `VaultSettings:78223` 的 `vault.status()` 直接返回 state/generation/error；仅 unlocked 时 `listMetadata()`，只留 count/generation，不输出 items。所有桥均见 preload 的 vault/browser 对象（:214/:225），不得尝试创建、解锁、复制端点或读凭据。
- `BrowserSettings:78340` 初始 clearChoice=hour，读取失败/加载与空规则不同；下载目录及开关不是固定值。自然挂载的 History 读取仍可能发生，不承诺零读取；不主动调用 history、不提取或截图历史条目，不为独立 history 分支增加操作权限。

本次只核提取制品与资产，未启动/连接产品、读取用户状态或发起请求；未产生新运行截图或产品验收结论。后续run仍须在获准实例取得同一时段独立参照；缺少、陈旧或失败参照不能从待判页面自证。

## 当前源码与安全副作用复核

资产修订：`browser-settings/5`（2026-11-04）。源码基点为 `d178f12d91ad3d82e797df6f9455ed49f13bbd2b`；以下三个 Owner 文件按实际工作区字节核验，均未在本任务修改。本节只更新来源、安全副作用及执行前提，不将源码等同运行制品绑定或产品验收，不追改旧冻结输入和裁决。

| 当前 Owner | SHA-256 |
| --- | --- |
| [浏览器下载设置接线](../../../src/main/browser.ts) | `b614d46acd1e07be815e0662e0eb6df6af02899672208064c51c4f4fe1dc1568` |
| [下载偏好与原生探针](../../../src/main/downloads.ts) | `b12514185836ab892625735bcab065e4428ba7e0ec36e7dd3533d0f5723748a9` |
| [浏览器设置页面](../../../src/renderer/src/features/browser/Settings.tsx) | `bd8bda68bc17c030ae9c298343acf217a27aadaa134947fedb97a2780cc1b156` |

- **current（源码）**：`Settings.tsx:268` 在 overview 挂载及切回该分区时自然调用 `browser.downloads({kind:'read'})`；effect 清理仅忽略后续响应，不取消已发 IPC。`browser.ts:365/2251` 将该读取接到 `downloads.snapshot()`；`downloads.ts:491` 在 macOS、具备 Python 且目录存在时执行 `canPublishDownload`。因此进入页面本身即可触发目标目录探针写入，不是只在点击设置保存时写入；源码条件成立不证明某次运行已经执行探针。
- **current（源码）**：目标为 `directoryOverride ?? defaultDirectory`，默认来自 `app.getPath('downloads')`，不是任务 Home/profile 隔离即可覆盖的路径，也不必等于字面 `~/Downloads`。`downloads.ts:152` 生成 UUID 命名的源/目标探针；源在浏览器 Home（本轮须核任务隔离归属）独占创建，目标在实际下载目录经原生 clone 创建，随后尝试删除两者。不读取已有用户文件正文，不据此承诺零文件系统写入。
- **gap**：`downloads.ts:163` 的清理未跟踪目标是否由本次 clone 成功创建，失败后仍按随机目标名尝试 unlink；不能保证同名已有文件绝不受影响。`spawnSync` 配有5000毫秒超时，但超时或异常中断不证明清理完成，且没有删除后读回核验。只读源码不能证明本轮已写入、已清理、无残留或已安全；实际副作用及在途状态仍须本轮独立证据。
- **required**：触发 overview 自然挂载或主动读取下载偏好前，必须已核实际下载目录位于任务隔离范围，且本次授权涵盖上述探针写入/删除。当前没有已核的无副作用公开读取契约可替代它；不猜备用路由、不直接改偏好或产品逻辑来制造隔离。前提不足时按执行 Skill 保留不安全分支及依赖项缺口，不删除原要求、不改快评分母、不以另一设置参照自证下载项。
- **current（源码）**：设置截图所在的无脚本 Portal 文档与业务桥所在的主 renderer 不是同一执行上下文，见[原生浮层 Owner 契约](../../../docs/architecture/ownership.md#浏览器原生浮层)。必要公开状态回调只在已核主 renderer 取得并先作白名单投影；截图取实际设置 Portal。不得在子页猜 preload、读取 opener 或复制业务桥；此处不复制执行流程，也不新增任何桥调用权限。

上述安全来源补充不批准密码库、偏好修改、下载或其他专项，不将正常实现采用规则扩为操作授权。原 `BROWSER-SET-001–006`、需求版本和历史报告全部保留；缺条件或缺证不改写为通过。
