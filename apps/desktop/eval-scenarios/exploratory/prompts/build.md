# AI提示词基线构建依据

当前资产修订：`prompts/11`；本次补充翻译服务配置候选和滚动视口参考，采用依据及提示词映射见[已确认当前承载映射](#已确认当前承载映射2026-11-04)。原四字段要求、稳定ID及需求v`0.3`保留，不自行推算新需求版本。

## 翻译服务配置候选与参考

翻译计划记录用户需求及 PDFE Mock 范围，包括默认服务与划词开关；交付记录记录后续真实 macOS 开发实例观察及其未完成的合并后真实复测。Mock 策略、历史默认值和开发实例不证明目标包适用或真实翻译通过；`TRANSLATION-CONFIG-CAND-001` 与已采用翻译提示词展示分开，偏好写入、凭据、联网与模型调用分别核授权。

`translation-services-20261112.png` 是 `tmp/test_snapshot/desktop/baseline-1823-batch4/capture/evidence/translation-02.png` 原字节副本，SHA-256 `6eb1b248532cf27fafc8a81a08a152a78c93fa7dfc1699a9c08ceaff66405633`；采集于 2026-11-12 的 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例，同批截图命令见 `capture/index.md` 第 19 项。图中为滚动视口与当时折叠服务状态，未展示各服务展开字段，不证明配置、验证或翻译；目标制品磁盘摘要见下节，不证明运行内存字节。

## 202611121823 目标版本参考图

`window-20261112-1823.png` 是目标版本真实完整窗口原图的字节一致副本，来源 `tmp/test_snapshot/desktop/baseline-1823-batch4/dynamic-followup/evidence/prompts.png`，2026-11-12 20:31:30 +0800，SHA-256 `ffa01c77418c13b722e0cad41c8fb324d350e0cab8d67b316e4654255cabb5c6`。目标为 macOS arm64 `0.3.2 / 202611121823 / preview`，`app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`；原始运行记录位于本机忽略目录。展示 AI 提示词，不证明恢复、保存或模型调用。参考图不替代本轮执行或判定；本次仅补图，不改变需求版本、判据和历史结果。

## 202611121823 翻译提示词参考图

`translation-20261112.png` 为 2026-11-12 macOS arm64 安装版 `0.3.2 / 202611121823 / preview` 隔离实例的真实页面原图副本，原图位于 `tmp/test_snapshot/desktop/baseline-1823-batch4/capture/evidence/translation-01.png`，SHA-256 `c49e9b2114caf9cd70244a4c1dbbd2be44a97d82e54ab194c8074f6df1f39a5a`；目标 `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。图中翻译提示词区域、长度和恢复入口分别对应 PROMPT-OBS-001–003 的可见部分，具体文本和状态随当前偏好变化；不以静图证明恢复、保存或翻译请求。原始运行证据位于忽略目录，仅本机可回查；原需求、判据和历史裁决不变。

## 202611121823 正常展示沿用

依用户统一采用已核正常行为的记录及本页用户确认的四字段承载映射，针对 macOS arm64 `0.3.2 / 202611121823 / preview` 有界沿用 PROMPT-OBS-001–003 已采用快评子点：AI 提示词页的解释、润色、图表解释与翻译配置页的翻译字段各自只读展示、长度及恢复状态；显式保存按钮仅按已确认映射适用。已核本页既有采用与后续记录，未发现该子范围被确认退役或更改；这不是完整变更史、源码制品同源或产品通过证明。原编号、需求版本、判据和历史裁决不变。

执行前须在同一隔离实例核四项偏好、目标包对应语言默认值及独立 JavaScript 字符串长度，确认参照时点；下文旧包读取契约及默认原文不能直接证明本包。缺失或陈旧的独立参照保留缺口，不由输入框反推。翻译字段 onChange 及恢复动作可能写偏好，仅观察不输入、不触发恢复或保存；模型请求和真实保存仍属专项。

## 202611121104安装版复核

资产修订 `prompts/6` 仅更新已采用判据的有界制品依据，不新增要求或改变快评、专项、历史运行与需求版本。macOS arm64 安装版 `0.3.2 / 202611121104 / preview` 的 `Contents/Resources/app.asar` SHA-256 为 `a95870ec674b95c3184c5e36c4bf2140cf8f5c86fbe38226644b26b6db107ab6`；构建号和渠道来自同包 `Contents/Resources/product.json`。源码提交未绑定，不能把当前 checkout 视为安装包源码。

直接核对该安装目录下松散 renderer 资源：`renderer/assets/shortcuts-BjK5lSWM.js` SHA-256 `e85b298b86c027574f2928c68a37a57920d500426534e41b2c27dd4ef24c7436`；`renderer/assets/WorkspaceFiles-CrlTtgoY.js` SHA-256 `3614ce05137d0407c0ac06d5f01ff39ddc0b37a3f67cfe8221573baa7426ee11`；`renderer/assets/store-B5hz8xdR.js` SHA-256 `1350291d59f5671d650eb788fcc12125622f2a353e2e5b5ffae5bc95db50b83f`。这些文件的对应关系是包内静态证据，不表示所有模块或仓库源码已绑定。

- 固定及动态：`shortcuts-BjK5lSWM.js:160` 持有四字段、语言对应默认值和 2000 上限；`:186` 对缺失、空白或超长值逐项回退当前语言默认值。长度按 JavaScript 字符串长度，不把当前偏好或一次显示固化为默认值。
- 承载及状态：`WorkspaceFiles-CrlTtgoY.js:113329` 的 `PromptsPage` 排除 translate，比较草稿与当前状态，按 changed、valid、saving 控制保存及恢复；`:110230` 的 `TranslationSettings` 独立读取 translate，显示长度与默认比较状态。`:110250` 和 `:110318` 表明翻译输入与恢复会调用保存，仍只纳入只读展示，写入及模型行为留专项。
- 偏好 Owner：`store-B5hz8xdR.js:8053` 将 `selectionPrompts` 提交至偏好写入器。后续执行仍须取得同一任务实例的四键独立只读参照并核其时效，不能从待判输入框反推已保存值；无法取得时保留缺口。

本次复核是静态来源更新，不新增产品操作授权、不证明保存成功或产品通过。旧参考图及其来源不变；其它页面不因本页复核自动视为已适配本包。

历史建库说明：修订：prompts/3（仅补参考图来源，修订1判据不变）。用户本轮采用指定包现有功能；三项自动快评，全部首次纳入v`0.3`。

来源：macOS arm64 0.3.0 / 202610281438 / preview；`app.asar` SHA256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`。安装renderer `assets/index-C4-PYlXk.js`的PromptsPage第77774行，与[AccountPanel.tsx](../../../src/renderer/src/components/business/AccountPanel.tsx)的对应函数有界核对；不证明全仓对应。

| 要点 | 固定 / 动态 / 条件与来源 |
| --- | --- |
| 001 | [prompts.ts](../../../src/prompts.ts)持有explain/translate/polish/figure四类及默认提示词 |
| 002 | selectionPrompts由profile偏好解析，缺失/非法值逐项采用目标包默认值；字符串length及2000上限，不限定字数分隔符样式 |
| 003 | changed/valid/saving控制保存可用性；恢复按钮按draft与对应默认值相等禁用 |

独立参照仅采本实例偏好白名单及目标包默认常量；默认原文保留运行冻结参照，不从画面反推。第四类及底部保存入口须可见；读取textarea.value不触发编辑。保存、恢复、真实模型采用另行专项。

参考图为已检查原始PNG的未改动副本，来源版本/日期见正文：reference.png来自ai-prompts.png（SHA256 `33823ef20e627af65195a7465117b7b598ea7c7a78e3b805acaca4304bb40f00`），bottom.png来自ai-prompts-bottom.png（`f09a56025374c0806329b0d56b0f1d369f195bf459af69b2fae9cce42bfd1bd2`）。动态值不固化；原冻结修订1保留，不追改运行输入。

## 发布快评分层（2026-10-30）

本资产修订为prompts/3；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为PROMPT-OBS-001–003的正文明确子要点；必要参照为任务实例当前获准偏好/原build默认内容及独立字符计数。未选范围为编辑、长度边界、恢复默认与保存，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。


## 历史制品复核

历史资产修订：`prompts/4`（2026-10-30）。本次仅增量更新制品定位与独立参照，不改变稳定ID、v`0.3`、完整判据或快评/专项边界；前文包号、旧源码行号、分层修订与结果均是历史记录，不作为本轮包绑定或通过结论。参考图仍保留原来源日期/构建。

本轮来源为已核安装包 `0.3.0 / 202610301343 / preview / macOS arm64`；app.asar SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。直接证据为实际松散发布目录 `renderer/assets/index-CddcCmKt.js`，SHA-256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`；下述编译函数/行号均指此文件，另名文件明确标出。引用的 `out/preload/index.js` SHA-256 `754a7f2fc34f7f1c6ac7f21c256c156f9c3b9dcf88c2c64a20b3d82bcb992219`，`out/main/index.js` SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`；偏好常量所在 `renderer/assets/AccountMenuPanel-CHQ1thBC.js` SHA-256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。源码提交未绑定；前文仓库Owner链接仅为辅助线索，不将checkout/远端HEAD等同本包。

- 固定/动态/条件：`PromptsPage:79492` 按 explain/translate/polish/figure 四类建立草稿，changed/valid/saving 控制保存，恢复默认比较各项默认值。四类、默认原文及逐项 sanitize 见 `AccountMenuPanel-CHQ1thBC.js:264–279`，JS string.length上限2000，不用字节数或Unicode码点计数替换。
- 独立偏好为 preload.preferences.selectionPrompts 启动快照，仅投影四个键；`INITIAL_PREFERENCES:9198`→state 初始化→页面不是另一独立来源。每项须为非空白字符串且length≤2000，否则回退目标制品默认常量；不可用时不能从textarea值反推“已保存”内容。
- 默认内容保留目标制品四项原文摘要链：解释=“结合上下文解释所选内容，说明关键概念，区分原文依据与推断。”；翻译=“准确翻译所选内容，保留专业术语、引用、数字和段落格式。”；润色=“改善所选内容的清晰度、流畅度和语法，保留原意、事实、引用和格式。”；图表=“解释图表展示的对象、坐标与图例、关键趋势和结论，区分图中直接信息与推断。”。仅目标默认常量，不固定用户已保存文本。
- 若启动后已编辑/保存或最新偏好无法独立确认，则相应内容核对留缺证，字数仍可独立计算；不调 savePreferences/reconcilePreferences，不读取其他偏好或用户文件，不把读取textarea.value当编辑/保存验证。

本次只核提取制品与资产，未启动/连接产品、读取用户状态或发起请求；未产生新运行截图或产品验收结论。后续run仍须在获准实例取得同一时段独立参照；缺少、陈旧或失败参照不能从待判页面自证。

## 已确认当前承载映射（2026-11-04）

资产修订`prompts/5`。采用依据为本任务聊天中用户明确确认真实产品迁移：保留原四项判据，AI三项与翻译配置一项分别只读验证，自动页面分母20→21；不授权编辑、自动保存操作、翻译请求或产品模型费用。此确认是当前映射采用依据，非由实现或旧Mock设计自行批准；无可访问的精确消息时间戳，不编造。仅供后续新冻结运行，candidate-02及更早运行仍保留原标准、分母与裁决，不追认旧轮通过。

源码基点为目标分支`shushen_release/mvp_v0.3.1.1_preview`的提交`d178f12d91ad3d82e797df6f9455ed49f13bbd2b`。以下为该worktree实际源码读取摘要；不将HEAD或这些摘要冒称绑定任意安装包，run另核目标产物身份与适用性。本次仅改基线文档，未改产品代码或实测新翻译页面。

| Owner/来源 | 当前摘要与有界事实 |
| --- | --- |
| [AccountPanel.tsx](../../../src/renderer/src/components/business/AccountPanel.tsx) | SHA256 `ecc337f17d197a766370781751be4a74509686f44ca1fa90c2ca74f3137c49d9`；317导航translation、429过滤translate，398保存三项时保留现有translate；5115渲染TranslationSettings。prompts承载explain/polish/figure及原显式保存初态。 |
| [translation/Settings.tsx](../../../src/renderer/src/features/translation/Settings.tsx) | SHA256 `086440ea07233cef89bc1a0550ad17795838691fa81535867695aee62ad1d9d1`；249起读取同一selectionPrompts.translate，提示词textarea及length/2000、恢复默认状态在同页独立承载；onChange进入savePrompt并调用saveSelectionPrompts，仅作副作用事实。 |
| [prompts.ts](../../../src/prompts.ts) | SHA256 `0fa3b5e581444b41b4b201204addfd4a4108a68ee4ddbe9e46dd14414b6f97a8`；仍持有explain/translate/polish/figure四键、原默认全文、JS string.length≤2000及逐项非法/缺失回退，不因迁移删字段。 |
| [store.tsx](../../../src/renderer/src/store.tsx) | SHA256 `0dc59a6ca915ec797e71b040633b79ea4fb8959238e91963645e0dc9d689bb6f`；2682的saveSelectionPrompts经PreferenceWriter.submit持久化，两个页面不是两套翻译提示词来源。 |
| [shell/Settings.tsx](../../../src/renderer/src/shell/Settings.tsx) | SHA256 `5394b8ae7576226a6b66fb3fd92ac3ef3666689feaa5bdf97f389ccab8b5a8ad`；原AccountPanel由设置portal承载；设置子窗不因此获得主renderer公开preload桥。 |

映射：PROMPT-OBS-001四类分别落在prompts三类和translation-prompts一类；002的四字段默认、当前偏好、字符串长度和2000展示全部保留；003的恢复入口状态逐项保留，AI页初始显式保存禁用仍选入，翻译页旧显式保存条件不强造同名按钮。翻译onChange自动保存及恢复点击会写偏好，不纳入只读快评；自动保存文案不证明真实写入成功，旧保存能力/生命周期留专项待独立验收。需求正文保留旧全文与v`0.3`，此修订只记录用户已确认承载及有界只读子范围，不编造新版本或保存能力已通过。

独立参照仍为精确任务实例获准公共白名单selectionPrompts四键与目标默认常量原文，分别对两个页面的textarea.value、独立JS长度和恢复状态比较；不能从待判textarea反推保存状态。启动后编辑/保存或快照陈旧则内容留缺口。设置portal只读DOM用于实际页面观察，公共偏好从已核主renderer对应桥安全投影，不用window.opener、复制桥或扫描任意about:blank；不能安全核实则缺证。进入翻译配置前仍需核当前挂载/取数安全前提，不把GET、自然挂载或本映射当零副作用保证，不读取凭据或操作其他设置。

页面计数是一份资产→两个实际页面，不新建translation-prompts目录或第二套requirements；全库22份资产/137原条目不变，含saving专项共22物理页面，现行自动快评21页面/3核心流程。当前build维护及结构检查不等于新映射已在宿主调用或产品验证；后续run须按新冻结原件实际采两页。
