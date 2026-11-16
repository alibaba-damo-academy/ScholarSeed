# 内置浏览器

## 工作区页签

**current（源码）**：从新标签页选择内置浏览器时，保留当前页签身份与位置，
原位转换为浏览器，不额外添加页签。多个浏览器页签分别绑定原生网页 ID，
导航和前进后退记录按网页隔离；仍共用既有浏览器 profile，不声明 Cookie 隔离。
页签名称按对应网页标题更新，标题缺失回退网址，空白页使用本地化默认名称。

普通页签关闭时释放其拥有的网页；检索结果已打开的网页沿显式身份接入，
Agent reveal 保留原有会话与目标代次校验，不借展示动作接管或关闭 Agent 网页。
原生网页已关闭时同步关闭对应工作区页签。网页 ID、标题和图标只是当前窗口状态，
不新增跨启动的网页会话恢复存储。

**current（源码）**：网址栏非编辑态超长省略，字重使用 regular；聚焦编辑时保留完整值。
网页 favicon 在所属网页的隔离世界中通过正常 fetch 与既有网络边界读取，
不绕过 CORS、站点 CSP、私网限制或 Renderer CSP，不携带凭据且拒绝重定向。
只接受有界栅格图片，最多 64 KiB；未取得可用图标时保留默认图标。
图标结果同时核验网页身份、网址及本轮来源，旧导航的异步结果不覆盖新网页。

**gap**：确定性回归不代替原生网页的多页签切换、关闭、标题和图标实际验收；
macOS 证据不代表 Windows 已验收。

## 产品开关

**current**：随产品提供的 manifest 将 `features.browser` 默认设为 `true`。显式 `false` 仍关闭；缺失声明或安全兜底仍不启用。只有严格布尔值 `true` 才开启；配置仅完全退出并重启 Desktop 后生效。开发版读取 app 根目录 `resources/product.json`，安装版读取 Resources 中的 `product.json`。这不是用户设置，也不同于网页 Agent 使用偏好或 CDP 自动化开关。

关闭时活动栏、浏览器工作台标签和浏览器设置页不参与组合；旧导航指针投影回安全页面，不删除已有浏览器数据。Main 不构造网页、CDP、Agent transport 或建议/tooltip owner；IPC 与 Serve browser/history bridge 在访问状态或重放结果前拒绝。旧浏览器审批记录只显示只读的关闭说明，不展示专用授权按钮或网页/历史查询内容。共享账户菜单与非浏览器聊天保持原能力。

产品 manifest 默认开启 `features.browser_agent_navigation`，允许助手在当前会话所属的隔离标签中打开网页，继续遵守已有站点规则，未授权站点仍需审批。`features.browser_advanced_settings` 默认关闭：不显示密码库、外部 CDP 或 Agent 网站规则，不开放通用读取、交互与历史查询。已有显式禁用和站点规则不覆盖。手动浏览、历史、下载和产品搜索兜底不受影响。

Web fallback 不提供内置浏览器。Desktop 与受管理 Serve 在 `/api/healthz` 校验同一浏览器产品开关；显式不一致、非法声明或必需字段缺失报告启动错误。关闭状态允许连接缺少该字段的旧外部 Serve，但远端能力未知、本地浏览器仍完全关闭，不能据此声称任意外部服务没有浏览器能力。

**English:** The packaged manifest enables `features.browser_agent_navigation` by default. The assistant can open websites in an isolated tab belonging to the current session, subject to existing site rules and approval for sites without an authorization. Advanced settings stay off by default: the password vault, external CDP and site-rule settings remain hidden, and general Agent reading, interaction and history queries remain disabled. Existing opt-outs and site rules are preserved. Manual browsing, history, downloads and product search are unaffected.

**current（构建策略）**：Main 使用 ws 官方 `WS_NO_BUFFER_UTIL` / `WS_NO_UTF_8_VALIDATE` 编译期 truthy flags，消去可选 native addon 探测，保留 JS masking/unmasking、UTF-8 校验和可用时的 Node `buffer.isUtf8`。不依赖用户环境、不安装 addon、不关闭 WebSocket/CDP 功能；可选 native 加速不再使用，不承诺性能不变。macOS arm64/x64 与 Windows x64 使用相同 non-native 算法与 host 校验选择，无新增 addon ABI、签名或 unpacked 依赖。**required**：实际 Main/preload 仍须通过原完整模块闭包，不能外部引用 npm addon；关闭产品开关不替代编译闭包验证。**gap**：各目标真实构建/asar、binary/text CDP 与正常密码库 UI/重启/截图验收独立进行，纯编译与 Node roundtrip 不代表产品验收。

## 产品搜索 fallback

**current**：产品 bundled `web-search` 通过 `search/browser` 私有宿主桥使用内置浏览器。
资料搜索框沿[资源搜索 Owner](../../../docs/features/resources.md)执行官方搜索及受限 fallback，
浏览器阶段先打开 Bing 首页并完成独立区域站授权，等待 1 秒后观察表单并输入原始关键词，通过宿主固定 isolated world 调用原生 `HTMLFormElement.prototype.submit`，不派发 Enter，也不拼接 URL 直接导航。表单目标仍由完整观察冻结，但原生 `form.submit()` 不携带提交按钮字段。
不启动外部 Chrome、Edge 或 Playwright Chromium，也不使用用户浏览器的持久 profile。
私有搜索页面从创建时禁用网页 JavaScript，避免首页预建连接或输入事件外传关键词；
宿主固定 isolated world 检查与原生表单操作仍可用。仅搜索专用 WebContents 设置 `disableBlinkFeatures: AutomationControlled`，不设置全局启动参数；普通 Agent 和手动网页不变。
若站点依赖网页脚本而无法提供合规表单或结果，明确失败，不自动恢复网页脚本或绕过守卫。

该桥仅供活动搜索 Invocation 的真实轮次与允许的
skill/profile 调用；桥自身准入支持 `ask`、`safe_auto` 与 `bypassPermissions`，
仍拒绝只读或未知模式，不改变 Skill 已声明的权限及父权限限制。请求不接受 URL、
CDP 地址或任意脚本；身份不向共享 App Server 或 shell 注入。内置搜索目标保持
非持久、禁下载/弹窗、公共 CDP 不可见和终态精确清理。高级设置关闭时，Desktop 私有宿主
传输只接受 scope 控制与产品搜索，不接受通用浏览或历史查询动作。

**current（资源结果接收）**：资源页的浏览器执行证据接受宿主已支持的 `ask`、`safe_auto` 与 `bypassPermissions`，不要求将父会话升级为全权限；只读、缺失及未知模式仍拒绝。结果接收不是执行授权，仍校验 Skill/profile、查询、同轮次产物发布身份及结果契约，网站授权和实际副作用校验由原宿主持有。

产品搜索只对真实私有搜索目标使用搜索 provider 声明的精确 HTTPS origin 白名单，不读取旧 Agent Browser Use 开关或网站规则。搜索专用授权只覆盖一次固定 GET 表单提交，不调用普通动作的审批接口。授权绑定父会话/轮次、目标实例、策略 revision、关键词、精确同源目的 URL 和有效期；表单结构、输入及提交控件在执行前重新校验。输入前启用请求边界，拒绝 POST、XHR/fetch/beacon、非许可资源与额外或跨源导航；只接受冻结目标的一次 GET 请求。撤销、超时和未知结果不自动重试，终态关闭本次目标。提交后重新申请结果页读取授权，不沿用首页读取能力。

**required（区域首页边界）**：仅受控私有搜索目标的真实跨源首页重定向被守卫阻止后，宿主才可消费绑定原请求与目标的短 TTL、一次性 receipt；它是已阻止跳转的证据，不是导航授权。一次搜索最多继续一次 provider 精确声明的 `https://www.bing.com/` 与 `https://cn.bing.com/` 之间的首页跳转；目标不得含 `q`、URL 凭据或 fragment，可保留 `mkt` 等 Bing 非 `q` 区域参数，并非禁止所有 query。宿主必须针对完整目标地址重新取得独立 Navigate 与 Read grant；`cn` 不继承 `www` 的网站许可，`ask/block` 均停止，不修改网站设置。该边界不适用于表单提交：表单仍限定一次同源 GET，提交重定向一律拒绝；无有效 receipt 的未知导航结果、过期、重放或再次区域跳转不自动重试。

**current（提交诊断）**：`browser-search` 日志以 request/session/tab 关联执行阶段；`browser-search-form` 记录输入校验、原生表单提交的 `submit_issued/submit_ack` 与 `submissionAcknowledged`、主框请求、导航及 DOM 就绪，并保留首个固定分类失败原因。`browser-search-navigation` 补充总请求过滤、导航守卫、响应码与 provisional/load 失败码。日志仅记录固定枚举、布尔判定、计时和关联标识，不包含关键词、完整 URL、DOM 或 CDP 错误原文。提交已发出但结果未知时仍对外返回 `browser_search_submission_unknown`，不以内部首因推定服务端未收到请求，也不自动重放。内部表单超时与取消分别记录，外层 bridge 的 `timedOut=false` 不证明内部未超时。

**current（拒绝路径）**：表单边界对非主框资源始终直接拒绝，不为这些不可能获准的请求同步读取网站策略；拒绝数量聚合到终态诊断，避免资源风暴中的重复策略 I/O 与逐条日志阻塞导航完成事件。主框请求、导航、输入效果与 DOM 就绪仍即时复验原授权、目标和撤销状态，不缓存授权结果，不延长超时，也不放行子资源。

**current（私有搜索渲染）**：搜索专用视图从创建起保持原生隐藏，使用固定非零 viewport 并关闭该 WebContents 的背景节流；renderer 的显示或 bounds 消息不能显示此视图或清零其渲染尺寸。构造偏好不代表导航后的当前主帧已处于可绘制状态：仅搜索视图在 `dom-ready` 与挂载后的布局阶段重新应用 `setBackgroundThrottling(false)`，同步 hidden-but-painting 状态；不因 getter 已返回 false 而跳过。`browser-search-render` 记录同步阶段、原生可见性、尺寸和节流值，不含页面内容。输入前在原有超时、撤销和身份校验边界内等待两个渲染调度周期，并记录 `render_wait/render_cycles` 与尺寸、原生焦点布尔值；不调用窗口或 WebContents 聚焦，也不启用网页 JavaScript。双 rAF 不是 compositor 提交证明，成功仍要求精确 GET 请求、导航提交和 DOM ready。Electron 的节流配置会影响同宿主窗口的渲染调度，搜索目标关闭后不保留该配置对象；普通网页的配置不改。回归覆盖显示与从未显示的父窗口、首页及结果文档，关闭 Playwright 自动注入的 `allow-pre-commit-input`、背景渲染及 `disable-features` 覆盖，并包含无 Playwright 启动的真实运行证据；不得在生产添加全局输入抑制绕过开关。

**current（结果就绪）**：自然导航提交与 DOM 就绪后等待 1.5 秒，在原有身份、授权和取消边界内，每 250ms 检查一次，最多 8 次；同文档的 URL、结果页输入框必须与原始关键词相符，文档 complete、结果容器可见且非 busy、卡片连续两次稳定才返回。遇到 content-visibility 跳过渲染的卡片，仅在搜索交互与结果读取授权同时有效时对有界卡片执行固定滚动，再重新校验与采样；不改 CSS、不读取隐藏文本、不强制刷新、不做语义筛选、重排或改写。等待阶段记录 `homepage-settle/result-settle`；终态仍关闭临时 Session，不持久化或共享 Cookie。参数与等待改善不能保证 Bing 相关性，真实参数对照和多关键词回归须独立报告。

读取使用固定 isolated world 脚本，仅限主框结果卡的标题、链接和摘要，过滤隐藏、inert、敏感输入及跨框内容，完整拒绝超长链接而非截断；不扩展普通 Agent AX 输出。其他搜索 provider、候选 artifact 和主搜索入口保持原有契约。产品关闭、授权不足或宿主不可用时明确失败，不回退外部浏览器。两平台的搜索均不依赖 Agent 规则存储；显式启用高级能力时，Windows 的规则持久化及 Agent 授权需要独立安装态验收。**gap**：新表单路径的真实产品验收与目标平台证据须独立核实，确定性测试不代表 Bing 当前页面必然适配。

**current（高级能力显式开启时）**：通用 Agent Browser Use 的首次配置仍保留两个 Bing 精确来源的原预设；其他来源默认询问，普通网页提交仍逐次询问。已有 v1/v2 策略不覆盖，损坏或无法安全读取时失败关闭。这些规则只约束通用 Agent 浏览，不约束产品搜索。

## 打开和浏览

工作台“新标签页”提供“内置浏览器”入口，复用现有浏览器工作台并保留当前项目上下文；已有网页保持不变，无网页时显示原有地址栏与引导。产品开关关闭或 Web fallback 环境不显示该入口。

浏览器不提供左侧活动栏入口；产品开关保持开启，设置页仍保留浏览器设置。通过对话请求打开网页时，`browser/open` 仅创建隔离空白标签并返回 `tab_id`，不接受 URL 或访问外网；随后使用既有 `browser/navigate`，沿原站点规则与审批流程导航。导航成功后，Main 发送具名网页目标，由 browser feature 验证当前对话及目标身份后展示工作台；不会唤起用户外部浏览器，不开放公共 CDP，也不改变网站权限。

`browser/close` 只接受 `tab_id`，在既有活跃轮次、私有认证和重放检查下关闭该会话通过 `browser/open` 创建的目标；支持同会话跨轮次关闭，拒绝手动、其他会话或陈旧目标。Main 持有真实 entry 身份，仅在合法导航提交时精确转移归属；手动关闭和宿主销毁同步清理。该契约不提供任意 UI dispatch，也不修改导航站点授权、对话审批或外部 CDP 偏好。

浏览器位于工作台顶部“浏览器”标签内，网页显示在地址栏下方；不是独立浏览器窗口。不再显示内部网页标签栏或新建网页按钮，手动浏览通过地址栏、后退、前进和刷新操作当前网页。已有网页目标及弹窗、Agent/CDP 的隔离管理保持不变；URL 为空或 `about:blank` 的活动网页与无网页时均显示使用引导，不用原生空白网页遮盖引导。真正退出销毁网页视图；隐藏窗口暂时隐藏网页，恢复后可继续使用。

空白页只显示地球图标和“输入网址，在当前工作台中浏览”，不展示教程卡片或示例按钮。“更多浏览器功能”继续使用隔离的原生下拉菜单，包含页内查找、打印、复制网址、缩放、开发者工具、历史记录、清除浏览数据和浏览器设置。缩放行使用等尺寸图标按钮；重置按钮悬停显示“重置缩放”。清除入口定位到既有设置中的数据清理区域，不直接清除数据，仍需用户选择范围并确认。

地址栏接受完整 `http://` / `https://` 地址；输入普通域名时默认补 `https://`。不接受 `file:`、`javascript:`、`data:` 等非网页协议。私有网络地址默认不可访问；只有用户在地址栏明确打开当前 ScholarSeed 服务的 `apiBase` 同源地址时，才会为该网页标签临时授权，不能通过网页跳转或 CDP 扩大授权。

网页弹窗不会打开独立系统窗口。公网网页发起的允许地址在内置标签中打开，弹窗标签最多同时保留 8 个；超额请求拒绝，手动新建标签不受此限制。加载失败会清理临时页；关闭或替换来源网页只取消尚未打开完成的临时页，已成为独立标签的网页继续保留。本地 `apiBase` 网页发起的弹窗一律拒绝，不继承地址栏授予的临时本地访问权限。

Closing or replacing the source page cancels pending popups only. A popup promoted to an independent tab remains open and keeps its quota slot until that tab closes.

## 开发者工具

在目标网页标签上选择“开发者工具”以打开该页的 Elements、Console 和 Network 等 Chromium 工具。工具窗口是辅助窗口，网页仍在 ScholarSeed 工作台内部。一个网页标签的开发者工具与外部 CDP 调试连接不能同时控制同一目标：打开工具会断开该页的外部调试连接并显示冲突状态；关闭工具后重新连接 CDP 即可恢复，其他网页标签不受影响。

## Playwright CDP

本节描述显式开启高级能力后的行为；产品默认不创建外部 CDP 监听器。

“设置 → 浏览器 → 外部浏览器自动化（CDP）”沿 Desktop `RendererPreferences.browserAutomationEnabled` 持久化。首次没有明确配置时开启；已有合法布尔值不覆盖，用户关闭或开启后重启保持。损坏记录或非法显式值不据默认值开放访问；普通 renderer 偏好保存保留该项磁盘权威值，只有浏览器开关的窄保存路径修改。该开关不控制 `features.browser`、Agent 站点授权或产品搜索。设置页可查看本机监听地址并点“复制 CDP 地址”。**完整地址仅写入操作系统剪贴板**，包含本次启动生成的令牌；设置页只显示不含令牌的 `127.0.0.1:<port>`。持有地址的本机程序可读取和操作允许公开的内置网页，不开放产品主界面。请像临时凭证一样保管完整地址，不要放入日志、截图或代码仓库。服务只绑定本机 `127.0.0.1`，停用、退出或重启后原地址失效。实际协议及网页目标限制、私有 Agent/搜索目标隔离和 DevTools 互斥不变，并非开放 Electron 的完整调试能力。

```ts
import { chromium } from '@playwright/test'

const endpoint = process.env.SCHOLARSEED_BROWSER_CDP_ENDPOINT
if (!endpoint) throw new Error('先在 Desktop 复制 CDP 地址并设置环境变量')
const browser = await chromium.connectOverCDP(endpoint)
try {
  const pages = browser.contexts()[0].pages()
  const page = pages.find(candidate => candidate.url() === 'https://httpbingo.org/forms/post')
  if (!page) throw new Error('先在内置浏览器中打开目标网页')
  console.log(await page.locator('form').textContent())
  await page.getByLabel('Customer name:').fill('ScholarSeed CDP')
  await page.getByLabel('Medium', { exact: true }).check()
  await page.screenshot({ path: 'browser-page.png' })
} finally {
  await browser.close()
}
```

CDP 只暴露产品内置浏览器的手动网页标签；Agent 隔离标签不出现在目标列表中，手动标签切换为 Agent 上下文时已有外部 CDP 会话立即失效。不暴露 ScholarSeed 主界面、Electron 全局目标或其他应用窗口。连接器实现的是受限 browser-level CDP 子集，专为当前锁定的 Playwright `chromium.connectOverCDP()` 所需能力验证；不能创建任意目标、下载文件、更改权限或访问未登记的目标。网页本身仍受到浏览器的地址、网络、权限及下载策略限制。

## 浏览器设置与数据

“设置 → 浏览器”是独立的一级设置页。浏览历史只记录成功打开的公网网页，保存在产品用户主目录下的独立浏览器库中；本地临时服务网页、主界面和开发者工具不写入历史。可以搜索、分页、重新打开或逐条删除，重启 Desktop 后仍可查询。浏览器网页的 Cookie、缓存与网站存储由 Chromium 保存在按当前产品主目录隔离的专属持久 partition 中，不与主界面或凭证 Session 共用；因 Electron 存储限制，该 partition 的文件位于系统级 `sessionData/Partitions`，而不是浏览历史库内。

清理可选择最近一小时/一天/全部历史、指定网站、全部数据，或按类型组合清理历史、Cookie、网站存储与缓存。按站点或按类型清理仅作用于手动浏览的持久网页会话；本地临时网页和 Agent 的非持久独立会话不受影响，即使其网站与目标网站相同。由于持久网页标签共享 Session，站点数据可能作为其他顶层网站的第三方资源被重建，因此会关闭该持久 Session 的**全部**标签并撤销这些目标的 Agent 授权；未受影响的隔离会话可继续导航。清理全部历史和网站数据仍会关闭所有浏览器网页及非持久会话。历史-only 清理不打断正在进行的 Agent 导航。按类型清理网站数据仅支持全部时间；时间范围**只用于历史**，Electron 不提供按时间范围清理网站数据的能力。指定网站清理 Cookie 时，Electron 的实际范围可覆盖同一注册域的其他子域名。清理网站数据会先停用 CDP，不删除已经下载的文件。

下载区域显示当前目录，允许通过系统文件夹选择器修改或恢复系统默认下载目录。“每次询问”使用系统“另存为”对话框。macOS 自动模式仅在当前目标目录通过真实 `fclonefileat` 能力探针时可用：下载先写入 Main 私有暂存区，再通过固定目录句柄、防符号链接、独占文件名的原子克隆发布。跨卷或不支持克隆时保持“每次询问”；目录能力变化时再次检查并失败关闭，不会覆盖已有文件。发布前持久记录已尝试状态；若发布结果因进程崩溃或后续错误无法确定，保留暂存文件并提示打开目录、删除或稍后处理，**不自动重发**，以免生成重复文件。中断的部分下载保留并记录，避免另一实例启动时误删活跃下载。Windows 目前没有等价的安全发布边界，自动模式不可开启。内置网页的下载来源受导航及网络策略约束：仅允许下载链始终为同一 URL、创建来源与顶层网页同源且内层来源仍符合网络策略的 `blob:` 下载；`data:`、不透明来源、跨域及混合跳转链仍被拒绝。此校验不提供跨源发起者身份，因此不能放宽为任意 `blob:`。CDP 不能改写下载策略；Playwright 连接时发送的下载行为设置请求仅获协议兼容应答，不会跳过产品下载策略。

Agent 网站规则区可按精确 HTTP/HTTPS origin 管理读取和交互的 `ask`、`allow`、`block`；删除整站规则一次性撤销两类授权并增加策略 revision。规则仅属于 Agent Browser Use，不改变手动网页访问、设备权限、外部 Playwright CDP 或网络隔离。当前产品路由已接入 `list`、`snapshot`、`read`、`navigate`、`interact` 和 `submit`：打开 Agent Browser Use 后可列出登记的标签；读取须按目标站点规则授权，导航须针对规范化后的完整目的 URL 独立授权，审批卡区分来源网页与目的站点。点击、输入和提交均须逐次 HIL 确认；持久交互规则不能代替一次动作的批准。批准、拒绝、撤销、标签重建和外部导航都受会话/轮次、目标实例及策略 revision 约束；已发出动作后若结果不确定，记为 `unknown`，不会自动重试。上述路由和确定性测试不等于真实模型回合与 HIL 已验收。**current（源码）**：macOS 与 Windows 使用同一套 Desktop 同步策略持久化。每次授权读盘，读写按 home 身份共用互斥锁，写入在锁内检查 revision 并在已验证的目录中原子替换。macOS 写入同时持有旧版目录锁。**required（真机验收）**：在两平台验证设置读写、重启保留和即时撤销，在 Windows 安装态验证 Agent 实际授权行为。

Agent `snapshot`/`read` 输出是**受限、脱敏的主框 AX 暴露内容**，不是屏幕截图或“仅肉眼可见文字”。屏幕阅读器可访问的透明、离屏或同色文字仍可能出现在输出中；DOM `hidden`/`inert`、AX ignored、敏感输入和跨框来源被过滤，密码值不能回读。网页内容始终是不可信数据，不能成为 Agent 的操作指令；审批卡会提示读取风险。Agent 导航使用独立的非持久网页 Session，不继承手动标签的登录状态，始终禁止该 Session 下载；其他手动标签继续使用原有 Session，下载不因 Agent 导航而关闭。该隔离和迟到下载拒绝已有确定性测试，仍需 macOS/Windows 的真实 Agent 产品流程验证。

主框 AX 读取不按固定深度截断；返回树仍受节点、字节和快照预算限制。一次快照内可共享相同 DOM 节点的描述，后续读取和每个动作阶段仍重新检查实时授权、目标、AX 与 DOM。动作不把 `class`、`style` 展示属性变化视为目标替换；其余属性比较、隐藏/敏感/跨框过滤及 AX 身份检查不变，聚焦后的样式调整不能跳过这些检查。失效引用须重新获取快照并正常审批；已派发动作的未知结果不能自动重试。原生批准尚未登记时，执行端仅等待同一已准备动作的批准，取消、撤销及到期仍使其失效。

动作结果与效果收敛分开：已发动作引起导航时，旧引用立即失效且不能继续发 Input，业务结果仍可为 unknown；原生传输仅保留到被动观察完成。收敛须确认同一网页实例、debugger 与主框的网络/加载结束及静默期，不依赖旧文档 origin/generation 恒定，也不授予新文档读取或执行权。撤销、detach、实例/主框替换、溢出、超时及仍在加载都会阻止收敛；仅业务错误不污染已证实结束的屏障。后续轮次仍经原 scope/end、重放和审批边界。

Registry 失效通知区分原生文档导航与权限撤销原因，仍保留原有 target/external 归属判断。导航同步废弃旧 grants、快照和预备动作，只在已有副作用观察时保留原传输；没有观察器则立即释放。明确取消、清数据、关闭、手动导航及调试器丢失不走该被动保留路径，仍完整撤销。

效果收敛失败后，普通操作及后续scope保持冻结；当前合法轮次仍可通过`browser/close`撤销本会话持有的私有目标。关闭使用原认证loopback通道、独立有界重放分区及同实例单调身份校验，不清理旧冻结记录，不恢复读取/执行或自动重试提交。共享Host故障标记仍保留；产品禁用、通道缺失、手动及其他会话目标继续拒绝。关闭成功只证明资源撤销，不证明旧提交成功。

作用域收尾的局部未收敛与通道失败分开：Main在原scope仍被冻结且宿主可确认时，针对本地排空计时器或明确副作用fence返回HTTP408、`scope_unsettled`及固定阶段`requests`/`effects`/`leases`。Serve仅对匹配scope/end、状态码和阶段的响应保持共享client可用；原scope仍由Main拒绝，不恢复其授权或未知动作。未知异常、取消、响应丢失、宿主退出及无效响应继续失败关闭。阶段等待后复验原scope身份和transport状态；Agent退出后不能签发“局部未收敛”的证明。

原生点击将布局中心取整后进行主框命中校验，实际鼠标派发使用同一坐标；取整后命中邻接节点仍拒绝，不以跳过命中检测兼容小数布局。

快照的固定预算失败分别返回 `browser_snapshot_too_large`、`browser_snapshot_timeout`，说明本次读取未派发网页动作，不将读取失败误报为提交结果未知。任意异常内容仍折叠为安全错误；权限变化或断开后的迟到结果不透传。快照预算、审批与清理机制不变。

普通读取和快照的引用陈旧、读取授权失效分别返回 `browser_stale_ref`、`browser_read_authority_invalid`。仅当前身份有效且通道未断开时透传固定安全分类；超时、中断与已派发交互的未知结果不改写。指引要求重新观察时仍须遵守当前站点授权与审批，不能恢复已撤销权限、复用旧动作或自动重放。

Agent Browser Use 的 Serve→Main 通道由 [Main transport](../src/main/agenttransport.ts)
仅绑定本机 `127.0.0.1` 并为受管理 backend 生命周期生成独立随机密钥；
[backend 启动](../src/main/backend.ts)只将端口和密钥传给该子进程，
[Serve client](../../serve/service/chat/service/browserhost.py)启动时即从环境移除两者。
它不复用 Main→Serve 的宿主密钥，也不是供外部 Playwright 使用的 CDP 端点。
变更该边界须同时检查来源认证、会话/轮次、重放与撤销，不以回环地址本身代替授权。

## 浏览历史展示

### 下载偏好

- **current（源码）**：浏览器设置的下载卡展示实际目录及“更改”；仅自定义目录展示“恢复默认”。“下载前询问保存位置”对缺少偏好文件的新配置默认关闭，已有显式选择与旧配置缺省语义不覆盖；损坏或无法读取的偏好保持询问。
- **current（源码）**：自动保存仍要求原生安全发布和目录能力探测通过。目录不可用或平台不支持时强制询问并禁用关闭开关，不因产品默认值改变安全降级。macOS 与 Windows 共用偏好合同，Windows 安全自动发布仍不可用，不能宣称默认自动保存已在 Windows 验收。

- **current（源码）**：更多菜单“清除浏览数据”进入浏览历史并打开与列表清除按钮共用的确认对话框，不再显示独立浏览数据模块。对话框提供历史时间范围以及历史、Cookie 和网站存储、缓存三组选项；默认不勾选，未选择时禁止提交。Cookie 与网站存储组合为同一选项。
- **current（源码）**：一次 `clear-selected` 请求可携带仅针对历史的 `since`，没有历史类型时拒绝携带时间范围。Main 沿既有会话回收和清除 fence 执行，Cookie、网站存储和缓存不按该时间过滤；失败/部分清除不自动重放。
- **gap**：macOS 隔离原生回归已验证历史时间截断与 Cookie 清除互不混用；未在用户真实配置中执行破坏性清除，Windows 原生与安装包验收未完成。

- **current（源码）**：更多菜单的“历史记录”和设置中的“管理”共用浏览历史页面；面包屑返回浏览器设置。查询继续由历史 Owner 按访问时间倒序分页，展示层按本地日期分组并可折叠，搜索变化返回第一页。记录支持点击打开、行内打开/移除及勾选移除。
- **current（源码）**：批量移除沿既有单记录删除合同串行执行，共用 mutation lease；遇到失败或未知结果停止，不自动重放，随后刷新权威列表并显示错误。换页、搜索、刷新清空选择，迟到结果仍受 surface epoch 与请求代次保护。
- **gap**：本轮 macOS 已检查入口、面包屑、分组、行内菜单、搜索空态与内置重新打开；未删除用户已有历史，真实删除及 Windows 原生验收仍待补充。

## 主密码库：源码接线与验收边界

本节描述显式开启高级能力后的行为；产品默认不初始化密码库或其固定存储 helper。

- **current（源码）**：浏览器设置的密码库卡通过无秘密普通 bridge 打开独立本地可信视图。创建、解锁、主动锁定和受保护删除确认由 Main `VaultOwner` 消费同一个固定 Store consumer 的代次 port；普通 renderer、网页、菜单及 Python helper 不取得主密码、密钥或明文条目。
- **current（源码）**：v1 使用完整原始 60-byte header 作为 AES-256-GCM AAD，固定 async scrypt N=131072/r=8/p=1、32-byte salt/key、192MiB maxmem；每次加密新 12-byte nonce，16-byte tag，完整文件上限 8MiB。认证完成后才进行有界 UTF-8/JSON/schema 解析。进程级 KDF 单槽仅在原生 callback 结束后释放，失焦逻辑取消不能物理取消 scrypt。
- **current（源码）**：新建主密码至少 12 个 Unicode code points、最多 1024 个 UTF-8 bytes，拒绝孤 surrogate，保留空格和字符组合。已有库解锁不套新建最小长度。错误口令、坏库和未知存储结果不重建；删除绑定 fresh observation digest，取消零写、冲突保留胜者。
- **current（源码）**：正常公开 dev/build 在 Electron 启动前生成独立 `out/protected/<generation>` renderer/preload/字体及清单，与 Main 编译 literal 绑定；Main/普通 preload 的源码加载使用同次冻结 bytes，加载、转换和输出 inventory 校验拒绝混合 revision，独立 overlay/menu preload 也使用该快照。`package.json` 等构建输入同样纳入精确源码清单和字节摘要，冻结后的数据变更仍拒绝编译，不放开其他未登记本地依赖。缺失、额外、hash 不匹配或旧 generation 拒绝输入能力。受保护源不热更新，修改后停止并正常重启；显式 build watch 仅拒绝受保护能力，普通 HMR/watch 不变。
- **current（源码）**：初始固定库的只读可用性观察被普通锁定撤销时，同一 live Store 至多补一次 fresh observation；同 Store 探测去重，恢复焦点可重新受治理观察。恢复只投影 locked/uninitialized，不恢复 key/metadata/旧 prompt；unknown mutation、debug/资产失效和 retired Store 不走自动恢复。
- **required**：无全局、Node 或产品调试的正常入口才能使用密码库。实际 Node inspector、产品/受保护 DevTools/debugger 在操作及每次等待后重核；普通网页受限 CDP 保留。窗口 blur/hide/minimize、锁屏/suspend/resign、renderer crash/navigation、backend/window 撤销和 before-quit（含更新阻塞提前返回）均同步锁定。JS/IPC/OpenSSL 副本无法保证可靠擦除，不承诺检测恶意同用户 native 注入。
- **gap（验收）**：确定性 crypto、真实隔离文件 helper、IPC admission 和 standalone builder 不是产品验收。macOS/Windows 正常无调试用户设置→创建→锁定→错误口令→重启解锁→删除的真实 UI、焦点/锁屏、打包/native 文件恢复及最终截图仍待验证。T9 凭据 Session、T10 导入/管理/填充、T11 系统对话框衔接尚未实现；未显示其占位操作。

### 平台语义

| 行为 | macOS | Windows |
| --- | --- | --- |
| Main crypto/进程单槽/代次 | 同固定 Node crypto 合同；纯 Node 测试不等于 Electron 实机 | 同合同；不能用 macOS 测试代替 |
| 固定库文件与 CAS | 复用现 T7a no-follow/稳定锁/settlement helper | 复用现 T7a handle-relative/no-reparse/DACL/sharing helper；不承诺目录强断电最新提交 |
| protected 资源/打包 | 同代次本地闭包；实际产品包待验 | 同代次闭包与平台路径；NSIS/实机待验 |
| 自动锁定与真实 UI | BrowserWindow 和 powerMonitor 实际事件；产品截图待验 | 实际窗口、系统锁屏与 DPI/焦点流待验 |

## 原生网页与产品浮层：开发设计约束

### 工作台布局

- **current**：浏览器复用唯一工作台页签，可按其他普通页签的悬停关闭方式关闭；再次从新标签页选择“内置浏览器”时重新打开或激活该页签。浏览器视图共享项目工作区的标签可见性，顶部“＋”创建的普通新标签及已打开文档不会被过滤；不增加浏览器内部标签栏。

- **current（源码）**：浏览器 viewer 通过 `conversationLayout: 'native-floating'` 声明原生对话呈现。普通视图沿用分栏，完整视图将原对话 React 树 Portal 到非模态原生视图；视图仅占对话及其嵌套浮层的矩形范围，同源无脚本 iframe 保持主窗口坐标系，网页不隐藏、不缩放且继续更新。主窗口主 frame 独占生命周期与几何桥，子文档不暴露业务桥。设置保持上层；创建失败明确提示并恢复分栏，不回退为覆盖网页的 DOM 层。
- **current**：原生网页的模态、菜单与交互浮层遮挡保护保持不变，不通过忽略 `aside` 或缩小原生网页模拟浮层覆盖。
- **gap**：本轮 macOS 原生合成验收与 Windows 验收分别记录，不能互相替代。

### 网页标题与搜索入口

- **current（源码）**：浏览器工作台页签跟随活动网页标题更新，无标题时显示已提交网址，空白页回退为“浏览器”；异步初始快照不能覆盖较新的事件。资料搜索的网页结果在浏览器可用时经原 typed dispatch 内置打开，保留项目和会话；失败显示错误，不自动外部打开或重放。browser 关闭时保留原外部打开行为。

### 静态 HTML 浏览

- **current（源码）**：HTML/XHTML 文档在原工作台文档标签中默认渲染，与网页共用导航工具栏组件。地址栏显示原文件定位结果；刷新通过文档 workspace 重新读取，失败保留当前内容并显示原因和重新打开/授权提示。未保存修改时禁用刷新。更多菜单可在原文件的源码编辑器与渲染页面间切换、复制文件路径。
- **current（安全边界）**：第一阶段为静态 HTML，使用无脚本、无同源权限的 Chromium sandbox iframe；DOMPurify 清理主动内容，独立 CSP 阻止脚本、网络、表单提交、嵌套框架和任意本地资源。支持内联样式和内嵌 data 图片，不自动授予文件父目录。超过 5 MiB 的文件显示限制说明，仍可查看源码。
- **gap**：此静态文档视图不是原生网页 WebContentsView；尚未接入 HTML 页内查找、系统打印、网页分档缩放及相邻文件资源授权。Windows 实机、真实 Agent 打开与搜索完整生命周期须另行验收，不以静态 fixture 或 macOS 结果代替。

### 设置首页

- **current（源码）**：默认首页仅提供浏览历史管理入口和下载设置；只有显式启用产品高级能力才显示“高级设置”。完整历史列表只在浏览历史子页挂载，关闭设置仍回到原工作台。下载设置通过同步 ref 和 Main mutation slot 防止重复提交；选择器迟到结果不能写入已退休的设置表面，返回首页重新读取真实偏好。

- **current（macOS 观察，2026-10-29）**：真实开发实例以保留的 Home/profile 重启，打开已有会话 HTML 报告，观察到渲染、源码、返回和刷新；打开关联 HTML 时地址栏显示本地绝对路径。手动域名补全 HTTPS 后网页标题同步到工作台标签；完整视图展示会话入口，点击后原会话与网页恢复分栏。账户菜单和网页更多菜单均进入设置中心浏览器首页，“管理”可读回重启前的分组历史。
- **gap（范围与验收）**：用户提供的交互原型是脚本生成 DOM 的 React 页面，不属于第一阶段静态渲染范围。会话产物仅显示其逻辑文件路径，尚无该来源的外部打开与绝对路径定位。当前未调用模型，搜索与 Agent 新开网页的真实生命周期未验收；Windows 暂无主机，不能宣称跨平台通过。静态源码/回归检查及 macOS 局部流程不替代这些验收。

### 外部打开（文件权限）

- **current**：网页导航工具栏提供外部打开图标，提示“用外部浏览器打开”，打开活动网页已提交的 URL，而不是地址栏未提交的输入；空白页禁用。操作失败显示错误，不重放，不关闭工作台标签或切换对话。
- **current**：项目 HTML/XHTML 文档工具栏复用文档保存、定位与系统文件打开路径；关联文件通过后端定位到本地原文件并登记精确文件授权，不授权其父目录。系统按本地 HTML 文件关联打开应用；若用户将 HTML 关联到编辑器，打开目标会遵循该系统设置。
- **gap**：macOS 已用真实网页和用户指定的关联 HTML 验证；Windows 与非浏览器 HTML 默认关联场景未完成实机验收。

### 普通历史管理

- **current（源码）**：更多菜单的固定无参数“历史记录”动作复用 Main 的 `MenuActionRegistry` 与 close-before 机制。无活动网页时仍可进入管理页；产品 browser 开关关闭时不登记动作或恢复入口。普通用户主动进入设置继续使用既有业务模态遮挡策略，不改变网页浮层的 viewport fence。
- **current（源码）**：设置宿主只接受 `overview` / `history` 两个 section。历史页替换完整正文，提供独立标题、搜索、分页、删除、重新打开与返回设置；概览和历史页互斥使用同一个 `History`，没有第二查询 owner、缓存或工作台标签。未知 section 恢复为 overview；关闭、其他设置及 off 状态归 null，捕获与恢复沿既有导航链。
- **current（源码）**：`History` 唯一持有筛选、页码、查询结果、局部刷新与请求代次。Settings 仅协调成功清除的 invalidation generation 和 ref 权威的单 mutation lease；清除、删除、重新打开同步互斥，清除失败不显示成功。清除成功先推进 generation ref，旧查询在 React effect 清理之前也不能提交；保留筛选并按真实 total 校正末页，不用 key-remount 丢筛选。
- **current（源码）**：设置导航 owner 在接受有效 page/section 意图时同步退休 surface；epoch 仅内存存在，不持久化、不授权操作。迟到结果不污染新 section/重开实例或触发导航，旧 mutation 真实 settle 后才释放自己的 slot。重新打开成功仍只走现账户设置关闭 → browser / preserveProject 的一次回调。
- **required / gap**：macOS 与 Windows 均须用真实 Desktop 菜单验证独立管理页、搜索/分页、清除刷新、删除、重新打开、重启恢复、off，以及浅深主题、窄窗、键盘/焦点和最终合成截图。本轮纯 Node 与 headless Chromium 的真实 React 开发测试不替代产品验收；macOS 当前锁屏和 Windows 未接入的验收仍 pending。清除确认新协议、下载 catalog、安全发布与凭据清除属于后续任务，没有提前注册空页面。

| 导航与协调语义 | macOS | Windows |
| --- | --- | --- |
| overview/history / off / unknown | 同一导航合同；实际 Desktop 流待验 | 同一导航合同；DPI/窗口与恢复待验 |
| query / mutation / surface retirement | 同一 Promise 与 ref/epoch 合同；真实关闭焦点待验 | 同一合同；真实关闭焦点待验 |
| 历史持久化与 reopen | 原 SQLite / typed bridge 保持不变；真实重启待验 | 原 owner 保持不变；真实重启待验 |

### 验证入口分类

`node --test` 不代表纯 Node。`src/preload/menu.test.ts` / `src/preload/menureact.test.ts` 与部分 `src/main/browser.test.ts` 用例会启动真实 Electron / 原生窗口；执行前必须读取测试和 import chain，并确认原生流程已获授权。它们不属于锁屏期间只允许的源码开发检查，不以临时 profile 或 `show:false` 免除原生启动授权。

普通历史的允许开发层是导航/policy、`src/menu.test.ts`、`src/main/menuhost.test.ts`、`src/main/history.test.ts`、`src/main/browseripc.test.ts` 的纯 Node 合同，以及 history/browser render 的 headless Chromium + Vite 实际 React consumer。mock bridge 仅控制开发层 Promise 竞态，不是 Electron 产品验收。测试必须释放自己持有的 server/socket/timer；不能用 `--test-force-exit` 掩盖挂起并称全套通过。

### 为什么不能只调 CSS

浏览器网页由 main 的 `WebContentsView` 承载，不是主 renderer 内的 DOM。`z-index`、React portal 或绝对定位只能改变主 renderer 的绘制顺序，不能跨越原生子视图层级。地址建议、Tooltip 等产品浮层与网页相交时，需要同一窗口内更高层的可信原生视图；不能把网页隐藏、缩小、移动或替换为截图来模拟覆盖。

2026-10-08 的真实缺陷说明了此边界：左侧“文献全览”提示底部为 155 CSS px，网页顶部为 152 CSS px，仅重叠 3 px。`viewport.ts` 将相交 Tooltip 视为整体遮挡，发送 `visible: false`，main 因而隐藏整张网页。网站加载和网页内容本身并未失效。改变提示位置、加入重叠阈值或忽略全部 Tooltip 都不能解决这类合成问题。

### 所有权与不变量

- **required**：共享展示模型由 Desktop contract 校验；main 的浮层 owner 负责 sender/frame 身份、隔离 Session、本地资源白名单、原生层级、缩放裁剪和销毁。renderer 负责提示文本、主题、语言与锚点测量，不传 HTML、脚本、任意 URL 或系统操作。
- **required**：地址建议与纯展示提示使用独立生命周期和 revision，提示出现或消失不得撤销地址建议、选项映射或焦点请求。原生提示不主动取得焦点，不含可聚焦操作，不属于浏览器标签、历史、下载、Agent 或受限 CDP 目标。
- **required**：只有符合原生展示契约的非交互纯文本提示可以从整体遮挡判断中排除，并同步请求原生呈现。不能等待异步呈现完成后才恢复网页，否则首次悬停仍会隐藏一帧网页。呈现失败须报告错误并保留 DOM 提示，不能声称重叠部分已正确显示；不能全局删除 dialog/menu/listbox 或复杂提示的遮挡保护，模态弹窗仍须阻止原生网页盖住产品交互。
- **required**：区分提示的内容矩形和包括主题阴影的绘制矩形：原生视图覆盖绘制矩形，内部内容仍定位在原来的内容矩形，不用透明全窗遮罩。原生背景及提示 renderer 的页面背景须同时透明，否则圆角和阴影周围会露出矩形底色。Electron `WebContentsView` 没有 `BrowserWindow.setIgnoreMouseEvents` 的鼠标穿透能力；小范围阴影边界也可能命中鼠标，不能宣称 `pointer-events: none` 能穿透到另一个原生视图，更不能重放底层网页点击来补偿，以免触发非预期操作。
- **required**：移出触发器、切换模块/标签、窗口失焦、隐藏和销毁时撤销对应提示；迟到加载或 IPC 回调不能让旧提示复活。保留主 renderer 的无障碍描述关系，复用产品 Tooltip 主题语义，不在网页中注入产品 UI。

### 新增浮层时的检查路径

**current（源码）**：对话引用序号的预览和来源列表通过 `hosted` 显式选择
`PortalProvider.renderOverlay`，由 Workspace 复用有界原生对话宿主，只转移弹窗内容。
会话、输入草稿和网页仍留在原位置；其他弹窗不自动迁移，遮挡安全栅栏保持不变。
跨文档浮层跟随原锚点滚动，并处理 Escape、外部点击及焦点恢复；首次取消 hover
也完成隐藏态的宿主绘制确认，不能让迟到加载重新显示弹窗。

**current (source)**: Citation previews and source lists explicitly opt into
`PortalProvider.renderOverlay` with `hosted`. Workspace reuses the bounded native
conversation host for popup content only, leaving conversation state, drafts and
web pages in place. Other popups and the occlusion safety fence remain unchanged.
Cross-document overlays track their original anchors and support Escape, outside
clicks and focus restoration. Cancelled initial hovers finish the hidden host's
paint handshake without reviving stale content.

**current（源码）**：浏览器 `operation_failed` 与更多菜单失败复用全局 Toast，
不再插入工具栏下的 Alert。与网页相交的纯标题 Toast 通过既有原生提示 owner
投影，复用 UI Toast 外观；关闭和悬停/焦点暂停只回传到原 Toast，计时、去重和队列仍由
原 UI owner 持有。包含描述、业务动作或复杂内容的 Toast 不进入此纯数据投影，
原有遮挡保护不放宽。

**current（源码）**：主窗口停靠 DevTools 时，窗口 content size 不等于产品 renderer
viewport。菜单 owner 在独立 isolated world 有界读取产品实际 viewport，核验当前
frame、窗口尺寸、zoom、租约代次和投影尺寸，保留 sender、target 与焦点校验；
不以增大误差或允许任意较小 viewport 绕过校验。未开启 DevTools 时继续使用原生窗口尺寸。
确定性回归不替代 macOS / Windows 的真实窗口验收。

先确认浮层是否与原生网页矩形相交，再决定它是非交互提示、可交互建议还是模态面板。复用现有浮层 owner 和 `components/ui`，不要为单个入口建立 CSS 特例或另一个浏览器窗口。改动必须同时检查共享协议、main/preload 身份边界、renderer 生命周期与 `viewport.ts` 的遮挡分类。

回归须通过真实 Desktop 的入口悬停/键盘焦点操作，比较浮层前后网页原生 `bounds`、`visible`、页面 `innerWidth/innerHeight` 与滚动位置，并检查移出和连续切换时无残留。截图必须是同一窗口的原生合成画面；主 renderer 或网页单独截图不能证明二者正确叠放。macOS 结果不等于 Windows 已验收，平台状态及未完成项单独记录。

复用 Tooltip 的视觉组件时，main 已确定原生视图的绝对位置，浮层内部不能再套用组件的锚点位移。Tailwind 4 的 `translate` 是独立 CSS 属性，`transform: none` 不会清除它；本次截图复核发现 68 px 宽的提示仍左移 34 px，导致文字被裁切。必须同时清零内层位移并检查内容矩形完全落在原生视图内，不能用改变视图宽度、等待更多帧或只断言文本存在掩盖此问题。

`getBoundingClientRect()` 不包含 `box-shadow`。仅按提示内容的 68×30 px 创建原生视图会裁掉主题阴影，导致下边缘看似被网页挡住；增加绘制边界必须来自实际主题阴影，不能添加网页 padding 或改动内容锚点。验收不仅要看到完整文字，还必须检查四边圆角、阴影、透明区域及窗口边缘裁剪。截图期间若窗口失焦或原生 owner 撤销，应标记无效，不得用截图前的一次 visible 断言替代截图时状态；无失焦的真实窗口取证与普通行为回归是两类证据。

### 可交互菜单：单业务源与绘制确认

**current（源码）**：浏览器启用时预加载无菜单模型的隔离容器；已加载的浏览器更多菜单在正常关闭后隐藏并清空模型，重新展开复用容器，但重新签发 session/revision 并等待本次绘制和焦点确认。缓存不保留动作权限；导航、身份/目标失效、崩溃、超时或窗口销毁仍释放容器。加载失败不降级或放宽资源清单，后续打开可以重试。`resources-ready`、`renderer-created`、`loaded` 和 `renderer-acquired.warm` 日志区分初始化成本与复用；未完成预加载时仍可能等待加载。

**Current (source)**: With the browser enabled, an isolated container preloads without a menu model. Normal dismissal of a loaded browser menu hides the container and clears its model. Reopening reuses the container, but issues a fresh session/revision and requires a new paint/focus acknowledgement. Cached rendering grants no action authority. Navigation, identity/target invalidation, crashes, timeouts and window disposal release it. Loading failures retain resource restrictions and permit a later retry. Lifecycle diagnostics distinguish initialization from warm reuse; opening before preload finishes can still wait for loading.

菜单不是纯文本 Tooltip，也不能在原生网页可见时直接沿用产品 DOM Popover。`src/main/menuhost.ts` 持有交互浮层及真实窗口资格，`src/menu.ts` 校验有界模型与固定动作，preload 只提供窄菜单通道。Main 的 `presentation()` / `subscribePresentation()` 按实际网页可见性投影单调 revision；只有明确的 inline 资格才能挂普通菜单，seed、publish 或焦点失败不能自动降级为被网页遮挡的 DOM 菜单。

`components/primitive/presenter.ts` 是共享 coordinator 的真实 owner。浏览器与账户消费者持各自的 surface-scoped handle；卸载、更新、撤销只影响自己的 lease。不要为新菜单建立另一个全局 presenter，否则旧消费者的 dispose 或迟到失败可能关闭新消费者的菜单。替换、导航、身份变更和窗口生命周期都必须阻止旧 lease 复活。

账户数据只在原业务宿主请求：`components/business/AccountMenuPanel.tsx` 接收脱敏纯 view，不取账户 API、不读取 Store。普通菜单与 native renderer 消费同一 Panel。身份卡片和操作行复用 UI Menu 的键盘语义，语言是同文档子菜单；子菜单先消费 Esc，第二次 Esc 才关闭根菜单。登录、设置、反馈及云端导航先关闭菜单再调用原宿主，退出失败保持错误与重试能力；dirty editor 的语言确认仍走原 Store 防护。

**paint ACK 不是 view 已同步的证明。** native seed、初次加载和绘制确认都是异步的，此间积分、busy/error、语言或主题可能变化。宿主须保存最新 desired snapshot，首次 ACK 与后续更新 ACK 后，对同一有效 lease 串行合并并去重；不能仅在 `presenter.current()` 非空时更新后就忽略此前变化。补发前后都检查当前 opening、身份与菜单代次，避免 A 的迟到结果覆盖 B；不要用重开菜单或制造业务状态变化掩盖 race。

**current（菜单绘制调度）**：菜单文档加载后，以原生隐藏状态挂接到所属窗口，再同步关闭背景节流，使 Windows 的隐藏文档也能获得渲染调度。挂接不等于显示或授权：paint ACK 前保持 `getVisible() === false`，不聚焦、不执行动作；有效 ACK 后仍须复核窗口、目标、几何和代次，才显示并确认原生焦点。失败或撤销沿既有生命周期移除视图。不能用提前显示、强制聚焦、伪造 ACK 或延长超时替代该状态转换。两平台编译菜单原生契约不代替真实产品菜单、主题和窗口交互验收。

**current（资源布局）**：Main 的 `applicationRenderer()` 统一解析普通 renderer 与原生菜单、提示浮层的资源根：开发版使用 checkout 的 `out/renderer`，安装版使用应用资源下的 `renderer`，Windows 不使用独立 Electron 引擎的 resources。浮层继续使用封闭文件清单和隔离 preload，不恢复已从 app.asar 移除的重复 renderer，也不放宽网络或导航权限。

确定性回归必须涵盖 deferred seed、首 paint 与后续 paint ACK 前的业务更新，以及 replace/dispose 后旧结果不补发。它们只证明代码交错，不证明原生合成、焦点/DPI 或真实账户安全。账户 renderer epoch 也不证明 Main/Serve 凭据隔离；认证 owner 的条件清除与真实两平台验收属于独立门禁。

边界索引：[所有权规范](architecture/ownership.md)；真实验证要求：[测试与验收规范](quality/testing.md)。历史提案中的目标和探针不证明当前产品验收；以下迁移边界仍须单独闭合。

### 原生呈现与凭据能力的未完成边界

- **required**：原生浮层必须覆盖实时网页而不改变网页 bounds、滚动、表单及运行状态。CSS 层级不能跨越 WebContentsView；隐藏网页、静态截图、卸载浮层或等待超时均不能替代正确的呈现及输入终态。未获适用原生宿主的普通弹窗仍保留遮挡安全栅栏，不全局关闭检测。
- **current（源码）**：普通设置与对话浮窗由 `src/main/portal.ts` 管理同窗口透明原生视图；设置使用模态全窗口策略，对话使用有界非模态策略。`shell/Settings.tsx` 将原 React 子树 Portal 到同源、无脚本子文档，保留同一 Store、草稿与业务回调，不启动第二份应用，不转发业务 IPC 或凭据。专用 preload 不暴露桥；主窗口主 frame 独占 reserve/paint/close，子文档禁止导航、webview 与再开窗口。绘制前透明且 inert，绘制确认后才接收输入；关闭排空按键，导航、崩溃及销毁撤销 lease。UI PortalProvider 将嵌套浮层、Toast、焦点和复制能力绑定到所属文档；没有该 Provider 的原控件仍使用主文档。
- **required / gap**：上述源码及确定性测试不证明两平台真实合成、DPI、失焦和输入终态全部通过；普通设置需要最终构建截图与交互验收。任务中心原生入口仍未交付，`src/taskcenter.ts` 及任务呈现协议不是 Main 宿主、秘密通道、生命周期和产品验收。任务中心仍由原 Provider/registry 持有业务；跨宿主只传最小显示投影和具名 cancel/retry，不复制全局 Store 或任务执行服务。未适配普通弹窗继续保留原遮挡保护。
- **required / gap**：未来凭据网页从创建起与普通、Agent、产品 Session 分离，永久不进入外部 CDP/Agent/DevTools 目标；不能原地换 Session 或完成后迁回普通会话。现主密码库接线不等于凭据标签、Cookie 导入或自动填充已实现；完整实现及验收缺口见主密码库章节。网页自身仍可读取填入值，不承诺防恶意网站或同用户原生进程。
- **required**：外部受限 CDP、Agent 操作审批和手动浏览是不同主体，不能互相复用 token、站点允许规则或调试租约。独立 Chromium 探针不证明现产品同一标签具有完整 CDP；不得借历史探针接入 sidecar、全局调试或把受限协议改名完整协议。

### 页面动作：目标身份、查找与缩放精度

`src/main/page.ts` 的页面 controller 挂在现有 BrowserEntry，BrowserRegistry 仍是唯一标签与 WebContents 身份源。动作捕获 `tabId/instanceId/navigationId` 及活动代次，执行、异步回调和投影都重核；A→B→A 不能复活旧请求。同 URL 导航、staged 替换和 crash 也必须失效，不能只比较 URL 或当前 tabId。

查找复用同一 `menuhost`、受限 preload 与封闭 `browser-find` 场景，不是 MenuItem 内嵌输入框或另一个全权 renderer。FindPanel 复用公共 Popover/Input/IconButton，展开/关闭保持网页原生位置、尺寸与运行状态；执行查找可以滚动到匹配项。outside 首击只关闭，不透传或重放网页点击；Esc 按入口返回原网页或更多按钮，失焦和 outside 不抢焦点。初次 paint/focus ACK 与后续结果更新分开，计数或主题重绘不能重挂输入或抢回第一项焦点。

查找框左侧手柄使用 Pointer Capture 拖动，复用 Popover 的视口边界夹取，拖动只更新浮层内部位置，不改变网页原生 bounds。结果计数与前后项、关闭按钮同排展示；零匹配显示 `0 / 0`，关闭或 Escape 沿原生 owner 的 `stopFindInPage('clearSelection')` 清除高亮并保留网页。相同查找会话的结果/主题更新保留位置，新会话重置到工具栏锚点。

真实结果由 `found-in-page` 回报，按 target、lease、querySequence 与 Electron requestId 过滤；空词先失效再 stop，waiting 不冒充零匹配。锁定 Electron 44.3.0 的 `findNext` 映射新查询会话：新词为 true，同词前后项为 false。升级时重新核对锁定版本与真实匹配行为，不按字段名称推测。

缩放首导航前设置 `isolated`，同源标签可共享 Session，但不共享比例。staged 创建继承旧页比例，promotion 再读取旧页最新值，仅按 tab 内存保存。`src/browser.ts` 的 `pageZoomSteps` 是档位选择的单一 owner：factor→level→factor 往返存在浮点误差，窄近档比较仅用于前后档、重置和边界判断，不写回比例、不改变真实读回显示、不把任意表外值四舍五入到档。Main 仍只接受配置表中的精确 factor。回归覆盖全档正负转换噪声、上下边界、重置与真正表外值，防止重复选中自身或在 500% 误启用放大。

系统打印提交后使用独立页面 operation，不依赖菜单短结果 lease。精确取消原因与失败分开；正常 OS 对话框失焦不假装取消已提交工作。导航、销毁或 crash 只使旧 UI 结果失效并释放本地等待，不宣称能撤回物理打印或纸张已输出。

以上是已进入源码并完成定向复核的设计约束，不是产品验收证明。查找 IME/焦点、横向缩放 keep-open、真实同源双页全档读回、打印及 DevTools/CDP 互斥须在最终 macOS/Windows Desktop 中操作并检查原生合成截图。组件或纯 port 测试不能替代；设备工具栏与截图安全发布仍是独立待闭合能力。

### 固定浏览器存储：权限与恢复边界

固定产品文件与用户选定的外部文件是两种不同授权，不能共用任意路径写入 IPC。`service.paths` 声明用户级浏览器目录并加入 Agent 文件访问拒绝范围；`service.cli.browser` 只接受 `vault`、`downloads` 两个 kind。Main 的 `vaultstorage` 使用实际 backend 的 Python、cwd、环境和 profile 投影启动二进制管道 helper，不经过 Serve HTTP，不向普通 renderer 返回密文或路径。浏览器关闭配置在 factory 前阻止全部存储副作用，旧数据既不读取也不删除；attach 缺本机受信投影时明确不可用。

Main 每次异步等待后重核窗口、backend 与 owner 代次；退出、替换 backend 或 helper EOF 撤销 availability，迟到结果不能恢复旧 owner。Python owner 通过握手投影版本化预算，Main 校验严格字段类型、重复键、预算与独立硬上限后采用；数组不能通过字符串转换冒充协议状态。此消费目前仅建立存储可用性，**不表示密码库或下载目录业务已迁移**。

并发写入采用稳定 OS 锁和 expected-digest CAS，保护合作产品 writer，不声称能阻止同用户恶意进程任意改盘。每 kind 至多一个 active 事务，attempting 落盘后才能执行文件变更；持久化终态后才允许下一事务。有限终态记录配合退休水位，旧 cleanup 只处理绑定对象，不按新 final 文件重判旧操作；删除通过绑定 tombstone 恢复。损坏或未知状态保留并失败关闭，不能自动重试发布、删除陌生文件或回滚较新的成功提交。

macOS 使用钉住目录、no-follow、私有权限与目录同步；Windows 使用 RootDirectory 相对句柄、reparse-point 拒绝、受限 DACL 和明确的 native/CRT 所有权。Windows 文件 flush 不等同目录强断电持久性。恢复测试以 test-side 管道 checkpoint 暂停真实操作，避免把 POSIX `select`/`SIGSTOP` 当跨平台机制；测试控制逻辑不进入生产 helper。

上述源码和定向合同已独立复核；Windows 原生、构建后产品 off/on/off、attach/重启及最终截图仍待验收。截图和下载的外部发布是独立后续边界，不能以固定 Store 通过测试代替它，也不能以此宣称完整浏览器存储功能交付。

### 受保护输入的资源 custody

`main/vaultipc.ts` 在同一个 owner 内区分可用的 presentation capability 与仍归其负责的 view/session：撤销先清除 prompt、请求权限和计时器，逐监听、隐藏、移除、关闭、网络拒绝、权限拒绝、连接与存储清理独立尝试。调用 `close()`、隐藏或 `current=null` 都不是销毁证据；真实 destroyed 与全部清理成功前，残留保持 quarantine。Main 在窗口替换前接管 retired owner，完整库存继续参与 debug 检查和新的 secret 操作准入；合法 active prompt 不阻自己的输入。

固定清理报告只含 owner、随机 revoke ID、revision、状态、资源数与固定代码；现有普通 vault status 显示 generic unavailable，日志不记录路径、URL 或原异常正文。`SECRET_CLEANUP_LIMIT.reportMilliseconds=5000` 是有限报告期限，不是原子关闭或内存擦除保证；超时后任务仍被持有且处理 rejection。当前失败不能由另一 owner 的迟到成功覆盖。治理清理成功后可进行新的用户操作，但旧输入权限和已撤销的 key 不会复活；成功提交也必须确认受保护表面清理完成，否则锁定并拒绝成功回复。

此为 T9a 的源码与确定性合同，尚非产品验收；不引入凭据网页、地址复制、导入、下载或设备宿主策略，不改变 KDF、AEAD 或固定 Store。macOS 与 Windows 使用相同 Electron 生命周期和失败关闭规则；两个平台的真实产品清理、焦点/恢复和截图均仍为 required，不能以 Node mocks 或单平台结果替代。

## 平台状态

| 行为 | macOS | Windows |
| --- | --- | --- |
| 与网页相交的非交互纯文本提示 | 网页可见性、bounds、页面尺寸及滚动位置已有两主题行为回归；原 E2E 截图会使窗口失焦并撤销原生提示，不能作为完整合成证据。无失焦截图和提示阴影绘制边界正在复核 | 相同原生 owner 与缩放契约；尚需 Windows 实机验收 |
| 工作台内原生网页、标签、DevTools、受限 CDP | 已有确定性和真实 Desktop/Playwright 测试，已检查工作台与 DevTools 截图 | 相同 Electron 实现；尚需 Windows 实机验收 |
| 历史记录、重启持久化与清理 | 真实 Desktop 重启/清理流程与截图已检查；同实例外部 Playwright 在清理前后验证 Cookie 消失 | 尚需 Windows 实机验收 |
| 下载目录、另存为与自动保存 | 真实 Desktop 已验证系统另存为与取消；隔离用户配置下自动下载两份同内容 gzip，重名不覆盖。原生目录选择器可打开，但系统钥匙串提示遮挡最终截图；自选目录持久化及跨卷的真实产品验收仍待补充 | 原生另存为须 Windows 实机验收；自动模式失败关闭，Windows 句柄相对打开与无重解析点发布边界尚未实现 |
| Agent Browser Use 的列举、受控读取与动作 | `list`、`snapshot`、`read`、`navigate`、`interact`、`submit` 已接入产品路由并通过确定性测试；真实模型回合、逐次审批和 Agent Session 下载隔离尚待产品验收 | **current（源码）**：与 macOS 共用安全策略持久化和产品路由。**required**：Windows 安装态验证规则读写、重启保留和真实 Agent 授权。 |
| 窗口隐藏/恢复与托盘 | 隐藏/恢复按原有 macOS 窗口生命周期；仍须可见桌面验收 | 必须验证真实关闭确认、托盘隐藏/恢复与 CDP 地址失效/恢复，不能用 macOS 结果替代 |
| 打包 | macOS 开发构建与测试 | 必须执行 Windows NSIS 构建并核对 `release-result.json`；构建通过也不代替实机验收 |

验收命令、截图和未完成项见[测试与验收规范](quality/testing.md)。

Windows 自动保存需要独立原生文件发布边界：从卷根逐段以目录句柄相对打开并拒绝 reparse point，使用独占句柄写入同目录私有临时文件、`FlushFileBuffers`，再以 `FILE_LINK_INFO.RootDirectory` 指向钉住的目录执行无覆盖硬链接发布，遇重名重新选择文件名，最后按句柄删除临时文件。单纯先 `realpath`/`lstat` 再 `setSavePath`、`rename` 或检查目标路径均有 junction/覆盖竞态，不可作为替代。该实现、Windows 打包和真机验收均为 gap，因此 Windows 设置开关保持禁用。
