# 六业务域观察摘要（2026-10-23）

**current / 有界真实探索已结束，扩展资产仍为未提交 draft**。本页是可版本化的资产交接摘要，不是通过报告、批准需求或原始截图归档。
不可覆盖清单、逐图索引和证据摘要保存在本轮唯一忽略快照的 inventory.md、evidence-manifest.json 与 freeze.json；
覆盖为部分，不称完整客户端盘点或68条已执行；摘要以冻结文件真实读回为准。
首轮四域观察仍保留在 [observations.md](observations.md)，不覆盖其原生导入受阻和原模型结果。

## 身份与权限

| 项目 | 当前事实 |
| --- | --- |
| 本轮系列 / 快照 | desktop-six-domains / 20261023T003940133157Z-43ef6e720a58；同系列首次快照，四域历史只作参考 |
| 快照根 | `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-six-domains/20261023T003940133157Z-43ef6e720a58` |
| 包 | 用户确认 preview 目录唯一 DMG，654157845 字节；SHA-512 `43ef6e720a587064b92581036df3665dd9c00e597db6fc03c29f1ab7fad29a8f8d4b9ec1381573963a0629d3f7169dd8eafbc6970a14ed75f7c488b19cb2ef13` |
| 构建 / 平台 / 语言 | 202610221402 / preview / macOS arm64 / zh；不以此代替 Windows |
| 实例 | taskRoot `/private/tmp/ss-six.ikicl5`，任务 App、全新 h/p/Projects；main PID75505，renderer60115/backend60116，bundled Codex0.159.0 |
| 范围 | 项目、资料库、文献、AI对话、技能、模型与账户设置；全局搜索仅跨域线索 |
| 连续真实窗口 | T0 2026-10-23T00:45:50Z / 北京时间08:45:50；硬截止01:45:50Z / 09:45:50 |
| 首动作 | 00:46:53Z；之前仅就绪/只读观察，首启自动建立默认项目不追认为操作者完成项目用例 |
| 末业务动作 / 正常退出 | 01:25:47.040Z / CmdQ01:28:17.562Z，01:28:28Z进程消失；业务39分57.040秒，含终态核对与退出42分27.562秒，未超过60分钟 |
| 实际用量 / 观察数 | 产品用户AI7/12，无重试/Flash回退；UI分支发现76、选中46、结果42、部分4、未选候选20、排除10，另1非UI线索；61张原图逐张检查 |
| 预算 | 最多12次用户触发AI动作，Max优先、不可用才Flash，无自动模型重试；准备、资产维护和交付分别记录 |
| 授权 | 当前用户明确批准本包新隔离探索、六域维护、精确PID原生输入，并另接受同macOS账号非完全隔离 |
| 限制 | 不修改产品逻辑/规则，不关闭其他应用，不安装第三方技能，不退出真实账号，不输入新密钥、不自动提交push |

应用签名、Gatekeeper、staple 核验均通过，任务自有 DMG 挂载已正常卸载。标准 TMPDIR
只证明 Node 临时路径消费；Foundation、Electron系统会话、协调目录与协议注册仍有共享边界。
产品正常启动自动准备新版并记录清理旧安装缓存，属于额外产品副作用，不是评测执行的删除或更新命令；
未点击更新/重启，不将后台候选版本当作本轮运行版本。原始事实见快照 preparation/、launch.log、runtime.json。

## six-project

- 正常表单创建项目 A“六域探索A”；同名工作台和实际注册根可核。原创建POST→202、后续PATCH→200；
  项目 `01m5k3np4b6gnyre00gt9wyxnc` 可用，根为任务 Projects 下新目录，见 `tmp/llm-evaluation-explore/desktop-six-domains/20261023T003940133157Z-43ef6e720a58/observer/batch-0001/index.json`。
- 项目 B 通过真实原生面板选择仅含合成 safe.txt 的任务目录。首次停在信任提示并取消；
  未将“进入提示”记作创建。明确核本轮精确目录授权后再正常信任并创建，原 adopt POST→202，
  operation `bf2afd4b93224799892e89e75cf3b53a` 终态 succeeded；项目 `01m5k42473pyjmefq8dvvm86ta`、
  root `/private/tmp/ss-six.ikicl5/staging/project`、legacy布局与可用状态已读回，见 observer/batch-0003/index.json。
- B 的 safe.txt 实际正文已打开，原508字节与SHA-256未变；切回A后实际资料列表为四份已导入资料。
  图片020/021分别证明B正文与A列表，不仅是标题变化。早先取消只有线索，不判已验证。
- 另做唯一名称“六域取消探针-0116”的独立取消分支，依次取消原生目录面板和整个新建表单。
  observer/batch-0011/index.json 的前后精确登记均为3项目，ID集合及完整payload相同、目标名称均不存在；
  截图051–055及AX/原生记录095–098对应实际取消链。既有collector没有捕获原创建POST，
  只作为采集事实，不用“未捕获”独立证明没有请求；候选判据仍未批准，本页不作pass结论。
- 真实定位线索为 project-navigation-selector、project-menu-create、project-create-name、project-create；
  folder为只读字段，尝试fill被拒后未绕过。名称/短snapshot ref不是稳定身份，项目ID和根共同定位。

## six-settings

- 头像菜单显示已有登录态、遮挡的身份与设置入口；没有重新登录、退出或验证进程级认证恢复。
- 设置的模型服务页显示本次0/11启用与未添加厂商，内置配置页显示Qwen3.8Max/Flash及当时控件状态。
  这些是本版本观察，不是未来固定计数、名称或模型可调用性要求。
- 百炼空编辑中 API Key 的真实DOM type=password、hasValue=false；取消后未填密钥、探测或保存。
  空字段不证明真实密钥生命周期安全，不用它抵消 MODEL-CONFIG-01 的前提缺口。
- 定位线索为 activity-account、account-menu-settings、account-settings-nav-models、
  model-vendor-empty-dashscope、model-endpoint-api-key、model-endpoint-cancel。截图002/003/004已由Driver逐张打开检查。
- MODEL-CATALOG-01、ACCOUNT-STATE-01 是独立只读P2点；完整配置与登录/恢复仍分别P1、partial、待专用前提。
- 后补账户遮挡菜单截图043；关于页047显示当前202610221402/preview及待重启更新，未点更新或重启。

## six-library

真实原生目录复制已完成：job `2e2037e355e346ff8716f996ae6e7697` 为4项、43376字节、错误空；
四份源/副本字节和SHA-256一致，见 observer/batch-0002/index.json。随后分别打开DOCX正文、
Equipment表格、MD可视正文及PDF真实1/1页，所证截图013/014/015/017；不能只用导入终态证明可读或回答质量。
资料库PDF未触发解释/翻译，不能拿它替代文献附件路径。

另在 A 正常新建 `resources/六域观察夹/补充记录.md`、写入本轮合成句、保存并查看 v1/v2，
再通过真实 UI 重命名为 `探索留痕.md` 并重开正文。Observer batch-0009 只读核得新文件115字节、
SHA-256 `5d3dd27ccde74dedadbf79a04a981db6c74c2767a0c067baddccc23622cad825`，旧名不存在，
四份原 fixture 仍逐字节相同。截图040/041/042分别对应保存正文、版本、重命名后重开。
既有采集器在该有界时段未捕获 mutation 原请求/回执，传输原因未知；UI及文件终态是独立证据，
不补造 operation ID，也不称已验证版本恢复或所有写入规则。

四份原资料分别由真实节点菜单加入当前任务；单次资料问答的 session 为
`3427de7cfc4b4aa2bcecc360c2b80ac3`、turn 为 `01a16654-b81e-7930-a605-138b8b365032`。
`observer/batch-0010/index-running.json` 保留原 POST→202 与真实 product_context/runtime_submission：
四项 ready source_material、精确相对路径和原摘要均可对应；不是从 chip 文案推断上下文存在。
`index-terminal.json` 保留完整3899字节回答、runtime/product双 completed、精确session非运行态及
终态后四原件字节/摘要不变。这是一轮四源问答探索，不是四项独立 P0 判据通过报告。
该回合还实际读取两组内置研究指引，与用户提示“不要读取其他文件”的字面边界有差异；
如实交接待后续评审，不把没有外部检索/写入记录推断为全局无副作用或据此修改产品规则。

## six-literature

- 本轮合成论文明确虚构、无 DOI，不能作为公开发现结果。文献导入触发浏览器文件选择器，
  按真实 modal 使用 Playwright upload，而非 Electron 原生面板；Driver 观察解析结果 1/1 后从附件详情进入 PDF 阅读器。
  `022-literature-pdf-open.png` 仅是附件详情，`023-literature-reader.png` 才是正文。
  原始上传/解析 POST 未进入既有采集器，保留回执缺口，不用后续任务成功补造导入原始证据。
- 两项 PDF AI 操作均有原始 POST→202 和精确 GET→200、`task_status=completed`、空错误与完整 `task.json`：
  解释摘要任务 `84ba8d5a-e1a7-46c7-89f0-177b2349cff3` 见快照 `observer/batch-0004/index.json`，
  整页翻译任务 `c2cbb83e-452d-43f3-9038-00975c5d9805` 见 `observer/batch-0005/index.json`。
  两者文献 `12ac602bd10640d9b2d0d5c46f109627`、附件 `af03e84f-3f69-4d96-8d93-e04860ec6cb0`
  及请求/结果 revision 均对应本轮 3158 字节合成 PDF 的 SHA-256
  `9f17a9dca085c0d52c74d4c995cd7da9b5b27154084b963234d912222cd16692`。
  翻译结果结构保留第 1 页的 31 个块；这些是任务终态和结果存在证据，不是解释/翻译语义质量通过。
- 实际操作分别对应 `LIT-PDF-SUMMARY-01` 与 `LIT-PDF-DOCUMENT-TRANSLATE-01` 的 P1 路径。
  不以摘要或全文翻译代替 P0 指定选区解释/翻译，也不据两项 completed 声称 P0 Check 已完成；
  原 P0 判据及范围不变，指定选区分支本轮未独立执行。
- 解释面板显示结构化结果，点击第 1 页来源后原文句实际滚动并高亮；全文翻译在打开且自动开关已选时触发，
  没有点击重试。翻译句被点击时原文高亮已存在，不能认定又产生了一次独立映射效果。
  两项任务请求/结果投影均为 `qwen3.8-max`，但上游实际执行模型、提供方回执和费用仍未知；
  PDF 任务 API 没有观测到普通会话/turn 身份，不为其编造 session 或 Trace。
- 已逐张打开检查的图片：
  `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-six-domains/20261023T003940133157Z-43ef6e720a58/screenshots/024-literature-explain-result.png`
  证明解释面板和可见结果；
  `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-six-domains/20261023T003940133157Z-43ef6e720a58/screenshots/025-literature-source-location.png`
  证明来源句高亮；
  `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-six-domains/20261023T003940133157Z-43ef6e720a58/screenshots/026-literature-translation-result.png`
  证明原文与可见中文译块，并非单张图片展示全部 31 块或完成语义核验。
- 公开论文 discovery 的真实请求是检索 Attention Is All You Need（2017），明确排除当前虚构 PDF，
  并要求不下载、不添加、不写文件。`observer/batch-0006/index.json` 冻结同一 session
  `206cdf3cb3084bf29762dca8cb2a3b31`、turn `01a16646-02c0-7dd1-9c04-a8cf52fef03b` 的原始 POST→202、
  runtime/product completed 与完整答复。实际调用 `scholarseed_bridge` 的 `search/run`，query 为
  `Attention Is All You Need Vaswani 2017 arXiv`、profile 为 `official`、limit=20；结果 `ok=true`、
  `status=completed`，search/invocation ID `a2594b821b36479dbf7a1ba71a0154fb`，10 个候选、未截断。
  `official-api` 仅是工具结果的 provider 投影，不是独立上游回执。另有读取及 Bash 工具记录，
  一次 `zsh:1: == not found` 失败被保留而非最终任务失败；本次工具快照未观察到直接全文抓取或 PDF 下载。
- 来源弹层区分：arXiv 为“已读取网页并关联证据”，NeurIPS PDF 仅为“回答声明的网页来源”，
  CSDN 亦显示已读/关联，但属于第三方页面；界面还提示部分内容未关联来源，Driver 另记录 7 个未用候选。
  这些状态不证明三项来源都经一手原文核实；未点击“查看原文”，不能称已独立打开外站或完成元信息复核。
  `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-six-domains/20261023T003940133157Z-43ef6e720a58/screenshots/034-discovery-source-list.png`
  已打开检查，证明真实来源弹层与可信度区别；
  `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-six-domains/20261023T003940133157Z-43ef6e720a58/screenshots/035-discovery-citation-detail.png`
  已打开检查，只证明来源 1 的应用内 URL/状态预览。文件名 `033-literature-discovery-sources.png`
  实际仍是回答，不拿它冒充来源弹层。模型自述“已核实”或“无下载/添加”不作为真实性及无副作用证明；
  Trace 的 execution coverage 等完整性仍为 partial，不能从此快照宣称全局无副作用，也不作 discovery 语义通过判定。

## six-conversation

- 普通任务首轮根据合成信息写内部通知，次轮在同一任务要求标题、两条要点并删除首轮新增的“请勿外传”。
  `observer/batch-0007/index.json` 保留两次原始 POST→202，URL 均属于 session
  `9ad9c68de3a246f5af0074a0ddd312d3`，runtime thread 均为 `01a16649-cc91-7d32-b630-91ba528e2817`；
  两个独立 turn 为 `01a16649-cda3-71a0-adb0-e82894e008f2` 与 `01a1664a-a54b-7881-a814-06a1e54dc7da`，
  各有独立 runtime/product completed，不只凭 Composer 或 `running=false` 推断回合完成。
- 两份完整原始 assistant 结果分别保存在快照
  `observer/batch-0007/span-37179388fc0d447398cda013b57499a7-content.json` 和
  `observer/batch-0007/span-039f69e079524249868dcd4e1d54245f-content.json`，索引同时关联原始输入及两层终态。
  `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-six-domains/20261023T003940133157Z-43ef6e720a58/screenshots/036-ordinary-result.png`
  已打开检查，证明首轮实际通知包含新增句；
  `/Users/zhengyunjie/Documents/java/workSpace/DeepR_D_v3/tmp/llm-evaluation-explore/desktop-six-domains/20261023T003940133157Z-43ef6e720a58/screenshots/037-ordinary-revision-result.png`
  已打开检查，证明同屏保留首轮、修订请求与第二轮标题/两条内容；不擦除首轮结果，也不据画面判断语义质量通过。
- 产品 session 列表仍投影 `turns=1`，与两次 POST、不同 turn 及两次终态并存；原样记录，不猜计数语义或据此删去一次提交。
  本次精确工具快照为 0 条、未截断，但 Trace 完整性仍含 execution_coverage_unverified、外部日志等缺口，
  只称“未观察到工具调用”，不宣称绝无文件/外部副作用。普通两轮与公开检索属于不同 session，证据不混用；
  完成状态不批准候选要求，也不替代独立语义评审。

## six-skills

- 真实技能中心分别查看广场空态、系统预置五项和我的添加空态，打开
  `design-research-validation` 详情及未匹配搜索；仅查看本地上传菜单，未安装、上传或切换启用状态。
- 从新任务加号技能入口选择该内置技能，草稿 chip 只证明选择。随后实际发送本轮合成研究材料，
  要求仅只读该技能及必要指引、不检索、不读取其他文件、不做实验或写文件。
  `observer/batch-0008/index.json` 冻结原输入中的 `type=skill`、版本1.0.8与任务 App 内精确路径，
  session `8ddbd03be96147f190dfb97c650d39eb`、turn `01a1664d-560e-7221-a1e3-b871bbe2ff71`。
- 精确 Trace 实际读取了该技能 `references/draft-preservation.md`，完整962字节输出已留；
  不把显式引用等同于另一次未观察到的 SKILL.md 工具读取。完整3083字节回答及 runtime/product
  双 completed 均已冻结，截图044/045分别显示最终方案后半与开头，Driver已逐张检查，root另查045。
  这些证明真实技能选择、执行轨迹与回答存在，不证明语义质量通过或所有内部副作用均已观测。

## 分档、维护与比较边界

本次合并新增8行、2稳定只读点：套件68行，目录54点，完整登录和新密钥配置仍有前提缺口。
旧60行保持其历史证据与候选预期，新快照不覆盖旧清单。P0仍10点/18必需Check，
P1/P2/P3扩展按唯一目录和独立Check筛选；人工资产就绪不等于已运行、通过或正式发布覆盖。
无批准精确文案依据，实际名称、静态文字变化只能作为差异待确认；按稳定控件/业务对象先定位，
再读取语言、AX名称、实际文字与比较策略，不用旧名称找不到直接判控件消失。
同系列首次观察且缺更早批准依据时，明确无法判断此前是否发生回归。

## 终态与校验

Observer batch-0012 一次最终只读快照核4个会话及2个PDF任务均completed，无waiting或unknown；
随后只向精确任务App正常CmdQ，root复核main/backend进程和三个已知端口均已退出，无强杀/重开。
临时凭据未复制，任务业务数据留在任务根；系统共享状态未声称已恢复，未知目录不清理。

六域用例仍为候选68行，P0/P1/P2/P3为10/21/28/9；唯一目录54点，保留旧52个ID。
macOS与Windows各自最终预检，P0均10点/18必需Check/1可选/资产缺口0，但Windows无实机证据。
高档计划25/50/54点、已知必需24/28/28，分母不完整；新增三场景9个三件套未跟踪，保持draft，
不自动stage/commit/push或把缺口写成已覆盖。P0指定选区AI没有被本轮P1结果替代。

48项定向资产/目录/预检测试通过，根docs:check及diff-check通过。
Desktop docs:check仍报未改动产品路径的CSS owner/Tailwind及生成文档过期；准确失败日志保留，
不因本轮任务修产品样式、业务逻辑或规则，不把结构检查当产品通过。
