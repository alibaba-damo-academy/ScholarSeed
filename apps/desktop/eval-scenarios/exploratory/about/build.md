# 关于页基线构建记录

当前资产修订：`about-quick/18`；本次澄清读取契约须按目标实例实际核实，旧包记录仅作线索，不改变稳定ID、需求版本、判据或历史裁决。

## 202611121823 目标版本参考图

`window-20261112-1823.png` 是目标版本真实完整窗口原图的字节一致副本，来源 `tmp/test_snapshot/desktop/baseline-1823-batch3/driver/evidence/about.png`，2026-11-12 20:06:38 +0800，SHA-256 `e202eefeb7dbb059167f6138158f7663e023404c7f77038ce1a2546f72735884`。目标为 macOS arm64 `0.3.2 / 202611121823 / preview`，`app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`；原始运行记录位于本机忽略目录。展示版本及当时更新提示，不证明下载、更新或安装。参考图不替代本轮执行或判定；本次仅补图，不改变需求版本、判据和历史结果。

## 202611121823 关于页展示沿用依据：about-quick/16

针对 macOS arm64 `0.3.2 / 202611121823 / preview`，沿用2026-10-30 用户统一采用规则及本页 about-quick/14 的 ABOUT-OBS-001、003、010–014 已采用快评子点：版本、构建/渠道和主要支持入口展示。已核本页既有采用与后续修订，未发现该子范围被确认退役或更改的记录；此为有界核查，不证明完整需求变更史、源码与制品同源或实测通过。新运行需独立核本轮安装包版本/构建/渠道、客户端年份及适用的官方支持入口来源；旧包中的读取契约是线索，须核目标包仍可用，不能用页面自证或以失败取数推断默认。复制、更新、偏好和外链动作不属该快评。原编号、v`0.3`、判据及历史裁决不变。

## 采用与来源

- 历史资产修订：`about-quick/15`；正文为[requirements.md](requirements.md)，14 个稳定编号均为 v`0.3`。用户已明确采用 v0.3 现有功能为初始基线；采用不等于实测通过。
- 来源：Desktop `0.3.0`，首次分析提交 `4208262be8b32323320fe16da91741b196110226`。在 `23d3a79240643442c9830ab45655c1f9fb70970d` 核对下述页面/更新/偏好链路未变；不能据此声称任一安装包与源码完全绑定。
- 参考图：[reference.png](reference.png)，macOS arm64 安装版 `0.3.0` / 构建 `202610271421`，2026-10-28 11:16（Asia/Shanghai）。SHA-256：`2a68092ad1842fa08e706ec37a460c7c7835af37b8d309614c7946064dc1c36b`；获准复用的原图副本，未裁剪或标注。仅展示主要区域，动态取值及底部/弹层不以该图作判据。
- 修订摘要：`about-version/6` 首次纳入；`about-quick/7` 快速口径；`8` 自然条件；`9` 公共规则去重与参考图；`10` 动态字段定位；`11` 补齐阶段语义与动作映射、明确独立参照。均为表达/证据口径澄清，未改变产品需求版本。旧内容由 Git 历史及各运行冻结输入保留。

## 固定、动态与条件分析

修订13将需求参考图写为显式同目录路径 `./reference.png`，不改图片或业务判据；旧运行保留原冻结引用。

修订12依据用户明确要求划分验证归属：001–005、007–014为自动快评，006需要不支持更新的真实安装环境，归人工专项；只调整验证方式，不改变业务判据或需求版本。旧运行继续使用原冻结范围。

| 编号 | 固定内容 / 动态来源与边界 | 代码定位 |
| --- | --- | --- |
| 014 | 标题、说明及导航语义来自文案资源；布局/翻译非固定像素或中文快照；版权年份由当前日期生成 | [AboutPage](../../../src/renderer/src/components/business/AccountPanel.tsx#L791)、[页面标题](../../../src/renderer/src/components/business/AccountPanel.tsx#L994) |
| 001 | 当前版本优先 update.currentVersion，未取得则用 preload version；显示值另拼 buildNumber。判据独立对照目标包，不拿页面自述自证 | [版本取值](../../../src/renderer/src/components/business/AccountPanel.tsx#L779)、[boot 元数据](../../../src/main/index.ts#L2935) |
| 002 | 复制的是当前版本标签＋systemVersion；后者由真实 OS 类型/版本/架构格式化而来，无系统值时禁用；反馈是短暂状态，必须实读剪贴板 | [复制值与禁用](../../../src/renderer/src/components/business/AccountPanel.tsx#L1021)、[系统格式](../../../src/main/system.ts#L6)、[复制反馈](../../../src/renderer/src/components/ui/CopyButton.tsx#L65) |
| 003 | buildNumber/channel 经 boot/preload 下发；有构建号才拼接，Preview 条件决定徽标；不能固化本轮构建号 | [徽标](../../../src/renderer/src/components/business/AccountPanel.tsx#L1016)、[preload](../../../src/preload/index.ts#L358) |
| 004 | getUpdateState＋onUpdateState 提供阶段、候选、大小、说明及错误；打开页面会静默刷新。MB 为十进制，说明可缺；都不是固定版本、大小或日期 | [状态订阅](../../../src/renderer/src/features/updates/state.ts#L37)、[候选展示](../../../src/renderer/src/components/business/AccountPanel.tsx#L831)、[大小格式](../../../src/renderer/src/features/updates/state.ts#L176)、[刷新](../../../src/renderer/src/components/business/AccountPanel.tsx#L741) |
| 005 | action 由阶段及恢复限制决定：idle/up-to-date 等为检查，有候选 available/failed 为下载，ready 为安装，忙碌/恢复限制下无可执行动作；入口展示不证明动作完成 | [动作选择](../../../src/renderer/src/features/updates/state.ts#L80)、[按钮/进度](../../../src/renderer/src/components/business/AccountPanel.tsx#L919) |
| 006 | 诊断入口仅 unsupported 状态出现，诊断结果在实际点击后才产生；快速评审不制造状态或点击诊断 | [诊断](../../../src/renderer/src/components/business/AccountPanel.tsx#L919)、[结果区域](../../../src/renderer/src/components/business/AccountPanel.tsx#L1050) |
| 007 | 文案语义固定，开关来自 renderer 偏好，不是固定 false；默认 true，开启可能触发自动准备，因此快速评审只核已知当前值 | [开关绑定](../../../src/renderer/src/components/business/AccountPanel.tsx#L1037)、[默认偏好](../../../src/preferences.ts#L184)、[主进程处理](../../../src/main/index.ts#L3097) |
| 008 | 仅 Preview；策略由主进程读取，未加载/提交中/指定目标及 blocked 状态限制修改，读取失败另有恢复入口；两种范围标签固定而策略值动态 | [渠道入口](../../../src/renderer/src/features/updates/Preview.tsx#L24)、[策略取数](../../../src/renderer/src/features/updates/Preview.tsx#L57)、[范围与限制](../../../src/renderer/src/features/updates/Preview.tsx#L124) |
| 009 | listPreviewUpdateLines 返回真实列表，空/错误/加载及指定目标决定展示；已有目标时以目标及取消入口替代切换按钮，不能固定期待非空列表；确认可触发更新，不进入快速动作 | [列表取数](../../../src/renderer/src/features/updates/Preview.tsx#L104)、[目标替代入口](../../../src/renderer/src/features/updates/Preview.tsx#L151)、[列表分支](../../../src/renderer/src/features/updates/Preview.tsx#L238) |
| 010 | 官方网站语义固定；siteBase 初取 accountBase 或固定后备域名，随后 getAuthStatus.account_base_url 可更新，因此不能将一次截图域名当永远固定 | [地址来源/回退](../../../src/renderer/src/components/business/AccountPanel.tsx#L726)、[显示与外链](../../../src/renderer/src/components/business/AccountPanel.tsx#L1059) |
| 011 | CONTACT_MAIL 是本版固定常量；页面展示与复制均引用它，成功反馈短暂替换邮箱文字。正文明确期望地址，避免 run 临时猜值 | [常量](../../../src/renderer/src/components/business/AccountPanel.tsx#L223)、[复制](../../../src/renderer/src/components/business/AccountPanel.tsx#L757)、[展示/反馈](../../../src/renderer/src/components/business/AccountPanel.tsx#L1091) |
| 012 | 社群语义固定，真实外链与网站共用动态 siteBase；快速范围仅核入口语义，不推断已打开或已加入 | [社群](../../../src/renderer/src/components/business/AccountPanel.tsx#L1102) |
| 013 | 手册语义固定，完整地址为动态 siteBase＋固定 /docs.html；快速范围仅核入口与说明，不据控件存在证明外部正文可用 | [路径常量](../../../src/renderer/src/components/business/AccountPanel.tsx#L227)、[地址拼接](../../../src/renderer/src/components/business/AccountPanel.tsx#L777)、[入口](../../../src/renderer/src/components/business/AccountPanel.tsx#L1123) |

已知状态分支来自源码分析，不代表实测通过；独立引导按钮仍被注释，未纳入现有入口。固定文案按当前语言的语义核对，不绑定坐标或翻译字面完全相同。动态来源无法取得时明确缺证，不以页面与自身比较替代参照。
静态缺口：领域动作选择含 `preparing` 阶段，但 AboutPage 的提示 switch 未显式处理该阶段；不能把领域枚举直接写成已实现的稳定页面提示。若未来真实进入该状态，再按当时可见结果判断，本次不制造状态或宣称产品缺陷已复现。
偏好链路另核：renderer 的 [setAutoDownloadUpdates](../../../src/renderer/src/store.tsx#L2416) 修改状态，经 [PreferenceWriter](../../../src/renderer/src/store.tsx#L1664) 保存到主进程；快速检查仅消费已知偏好，不以未切换的开关证明保存全过程。


## 执行所需独立参照

这些是只读取数线索，不代替页面证据，不执行内部写入：
- 包版本：macOS目标包 `Contents/Info.plist` 的 `CFBundleShortVersionString`；构建/渠道：`Contents/Resources/product.json` 的 `build_number` / `update_channel`。构建与渠道须对照原值，不能以文件摘要或手填expected代替。其他平台按实际包元数据契约取数；系统版本/架构和本地年份来自客户端所在系统。
- 004–006：已有公开只读桥 `getUpdateState()`，保留 phase、candidate 的版本/大小/说明、percent、installStage、恢复/失败标志。与同一时段页面比对，状态改变则分时记录，不能用页上提示反推状态。
- 007：隔离状态的已知 `autoDownloadUpdates` 偏好；008–009：`getPreviewUpdatePolicy()`、`listPreviewUpdateLines()` 的只读结果；只对当前渠道/已知策略及本轮已加载结果判定，不以非空为预期。
- 010：历史记录中的 `getAuthStatus()` 是renderer内部函数名，不能作为window.scholarseed公开方法调用；实际公开读取路径、容器与最小字段见[当前制品复核](#当前制品复核)，不记录凭据或完整认证响应。
- 011：已采用常量 `the configured support email`；实际复制及反馈仍须实测。

## 未知与边界

`preparing` 在领域存在，但 About 提示 switch 无明确分支；若自然遇到，保留判据缺口，不按枚举臆造已实现的文案。独立新手引导按钮被注释，未纳入本版入口。完整交互/默认快速动作规则归执行 Skill，不在本文重复；调用轨迹、运行路径与原图原件索引归忽略运行记录。

## 发布快评分层（2026-10-30）

本资产修订为about-quick/14；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为ABOUT-OBS-001、003、010–014的正文明确子要点；必要参照为已核安装0.3.0 / 202610281438 / preview及原build支持入口来源。未选范围为复制版本、更新检查/下载/安装、自动下载与版本线切换，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。


## 当前制品复核

历史资产修订：`about-quick/15`（2026-10-30）。本次仅增量更新制品定位与独立参照，不改变稳定ID、v`0.3`、完整判据或快评/专项边界；前文包号、旧源码行号、分层修订与结果均是历史记录，不作为本轮包绑定或通过结论。参考图仍保留原来源日期/构建。

本轮来源为已核安装包 `0.3.0 / 202610301343 / preview / macOS arm64`；app.asar SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。直接证据为实际松散发布目录 `renderer/assets/index-CddcCmKt.js`，SHA-256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`；下述编译函数/行号均指此文件，另名文件明确标出。引用的 `out/preload/index.js` SHA-256 `754a7f2fc34f7f1c6ac7f21c256c156f9c3b9dcf88c2c64a20b3d82bcb992219`，`out/main/index.js` SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`；偏好常量所在 `renderer/assets/AccountMenuPanel-CHQ1thBC.js` SHA-256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。源码提交未绑定；前文仓库Owner链接仅为辅助线索，不将checkout/远端HEAD等同本包。

- 固定/动态/条件：入口注册见该 chunk 的 `NAV_ITEMS` / `SettingsContent`；`AboutPage:79757` 仍从更新状态取 currentVersion、回退 preload version，并拼 preload buildNumber；Preview 徽标、邮箱常量、客户端本地年份、网站/社群/手册关系未改。更新状态及限制仍走 `useUpdateState:77401` / `updateActionOf:77404`，进入页面会调用 refreshUpdate，不能声称观察零后台活动；不主动检查、下载、诊断或切策略。
- 010 的读取契约纠正：`getAuthStatus:1613` 是 renderer 内部函数，不是 `window.scholarseed` 方法。它用 `getJson` → `apiFetch:1438`，向 `window.scholarseed.getApiBase() + '/api/auth/status'` 发同实例 GET（`credentials:'include'`），成功 JSON 顶层只投影 `account_base_url`；非成功/解析失败记缺参照，不猜 `body`、`data` 包装，不输出认证全体。
- `AboutPage:79764` 的站点先用内存 accountBase 或 `https://scholarseed.damo.alibaba.com`，成功 status 的非空 account_base_url 去尾斜线后更新；手册追加 `/docs.html`，显示域名由 siteHostLabel 生成。安装包 product.json 的公开 accountBaseUrl 为同一后备域名，仅证明静态配置，不证明启动覆盖或当前状态。若无法取得实际配置/响应，010 的动态核对保留缺口，不能从页面域名反推参照。
- 偏好仅白名单 `autoDownloadUpdates`；preload `preferences:316` 是启动快照，不是实时查询。007 专项须绑定已知隔离偏好或独立最新投影；本轮未改偏好可用启动值，发生修改/重载不明则缺证。004–009 继续使用 `getUpdateState()` / `getPreviewUpdatePolicy()` / `listPreviewUpdateLines()`，只在其原条件适用时读取最小字段。
- 保留缺口：`preparing` 动作受限但 About 提示 switch 仍无显式分支；不新增正确文案预期，不把它宣称为已复现或已修复。

本次只核提取制品与资产，未启动/连接产品、读取用户状态或发起请求；未产生新运行截图或产品验收结论。后续run仍须在获准实例取得同一时段独立参照；缺少、陈旧或失败参照不能从待判页面自证。
