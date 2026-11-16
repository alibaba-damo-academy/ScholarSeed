# 内置浏览器使用候选构建依据

## 建设状态

资产修订 `browser/6`。网页打开、查找及 Agent 授权为有界候选，历史 `BROWSER-HISTORY-01@1` 保留原稳定 ID；本修订补充网页缩放、截图及开发工具候选，不改变需求版本或采用状态。所有新增候选均未纳入已采用冒烟或任何冻结分母。产品需求版本、目标 `0.3.2 / 202611121823 / preview` 的适用与真实入口仍待确认；不得把 `@1` 历史资产修订解释为产品需求版本，也不能用当前源码直接批准目标包需求。

## 网页菜单候选依据

历史菜单计划记录用户确认的网页缩放、截图、开发者工具及设备工具栏；计划另区分同源标签缩放和两个开发工具的验收。历史计划不证明本安装包已支持或通过；设备工具栏方案、宿主及目标版本适用均待核。截图保存涉及原生输出和写入授权，不与评测证据截图混同。

## 网页打印依据

历史菜单计划记录用户再次确认的完整菜单包含打印，并明确取消打印不是失败；历史计划不证明目标安装包实际支持或已验收。当前 `features/browser/Browser.tsx` 提供活动网页的打印入口线索，但未与目标包建立同源关系；真实网页、原生对话框、目标平台和输出/取消终态须分别核实，打印与写入不由本候选自动授权。

## 合成网页输入：browser/4

[共享输入清单](../../../../../examples/projects/browser-navigation/project.json)登记两张原始静态网页：`index.html` 的标题及一级标题为 `SYNTHETIC-BROWSER-ALPHA`，正文中 `ORCHARD-NAV-NEEDLE` 出现两次；`second.html` 的标题及一级标题为 `SYNTHETIC-BROWSER-BETA`，两页互有相对链接。文件大小和 SHA-256 以清单为准。它们不含外部资源、脚本或预置产品结果；文件存在不提供网页服务，也不证明产品可访问、导航或历史生成。服务部署、地址、访问策略及副作用须另核授权，不能关闭安全策略凑测试。

## 浏览历史空态辅助参考：browser/3

`history-empty-20261113.png` 为原始运行 `tmp/test_snapshot/desktop/baseline-1823-browser-clear-20261113/supplement/evidence/before.png` 的未裁切、未缩放原字节副本，1280×840，SHA-256 `0bd9d1ec555b87e5a2d1191a41a637037c94fab570160e93b18e439fd719fb5d`；采集于 2026-11-13 11:50:59 +0800，运行 `supplement/index.md` 第 5 项为截图命令。同轮 `freeze.md` 与准备记录绑定 macOS arm64 `0.3.2 / 202611121823 / preview` 和 `app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。已打开核对：完整窗口展示隔离实例的浏览历史空态、搜索及清理入口，无可见凭据或历史条目。此图仅作历史页空态辅助参考，不证明非空历史检索、网页浏览、清理或候选采用；同轮清理展示补证与不符合裁决保留在浏览器设置构建依据，不由本图覆盖。需求版本、采用状态和历史冻结不变。

## 历史证据与边界

- [历史 P2 冻结](../../frozen/p2-20261025-539af0794/freeze.json)记录 sourceCommit `539af079455cc821b976760728fc13dfedbb8b66`。从该提交的 `apps/desktop/docs/scenarios/catalog.json` 回查 `BROWSER-HISTORY-01@1`：历史入口为设置→浏览器→浏览历史，目标为按时间或站点检索和管理历史，需使用本轮公开合成页面历史并对清理另核授权；该点 `reviewState=pending`、`coverageEligibility=exploratory`。目录 SHA-256 为 `e4a029cce1e58db658acb2643ea05621f48c288d12209eb0df41f5a4329ec45f`，与冻结清单一致。
- 同提交的 `apps/desktop/eval-scenarios/exploratory/desktop-business/cases/settings.json` 中 `D6-SET-011` 对应该点，`expectedStatus=candidate_unapproved`；只观察过历史空态和入口、未建立历史或执行清理，结果证据缺失；P2 冻结明确将此点列在选定 74 点范围之外。该文件 SHA-256 `372aee4969f44a7e9caafc93bdf4d3ee57990a7ada48b7d0db867bf7405e2ff2`，与冻结清单一致。可通过 `git show 539af079455cc821b976760728fc13dfedbb8b66:<路径>` 回查原文，不恢复或改写历史文件。
- 浏览器访问确认设计映射记录用户确认的待处理访问卡片及后续授权状态要求，也记载历史 macOS 开发客户端观察；目标包适用、真实请求及完整截图仍须独立核实。该历史确认不自动授予模型请求、网站访问或操作授权。
- 普通设置原生层级的历史记录记载过真实网页上的查找切换、加载失败和设置层叠观察；这是历史观察线索，不是本目标包产品判据或跨平台验收。

## 当前源码定位

源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；以下被分析文件相对该提交无未提交差异。当前源码未与目标安装包建立可信同源绑定，组件或注册存在不证明目标版入口可达、采用或正确。

- **入口与条件**：[新标签](../../../src/renderer/src/features/project/NewTab.tsx) 在 `availabilityPolicy.browserEnabled` 时提供浏览器选项；[可用策略](../../../src/renderer/src/app/policy.ts)依公开 `window.scholarseed.browserEnabled` 投影，[组合注册](../../../src/renderer/src/app/composition.tsx)按能力注册 browser feature。真实入口和开关必须以待测实例观察为准，不能为凑基线主动启用。
- **页面、导航与状态**：[浏览器 feature](../../../src/renderer/src/features/browser/feature.tsx) 将浏览器作为工作台 viewer 管理页签与页面归属；[Browser](../../../src/renderer/src/features/browser/Browser.tsx) 从 bridge snapshot 与订阅取得 tab、地址和状态，用户导航经 `dispatch`；成功结果须对应实际显示的目标网页。地址建议可调用 history，不能假定输入地址零读写。
- **历史与权限**：[History](../../../src/renderer/src/features/browser/History.tsx) 按搜索和分页查询浏览历史，单项打开或删除分别走 bridge 操作；历史页自然挂载即可读取条目，先确认隔离归属。`apps/desktop/src/browser.ts` 定义 history、下载、站点策略、页面及命令的公开 bridge 形状；不能以 API 响应、标签名或 fixture 代替真实 UI。
- **历史检索的歧义**：上述历史要求写“按时间或站点检索”，但当前 [History](../../../src/renderer/src/features/browser/History.tsx) 按 `visitedAt` 的本地日期分组，向 bridge 传搜索文本及分页；[history.ts](../../../src/main/history.ts) 的现有 SQLite 查询对 URL 与标题做文本匹配，并按访问时间倒序。日期分组不是日期筛选，不能由源码推断历史需求已被满足或删除该要求；目标包与需求 Owner 均须核实。常规 Electron 路径的 [browser.ts](../../../src/main/browser.ts) 对符合条件的 HTTP(S) 成功导航记录历史并可随后更新标题，实际数据和策略随执行路径而变，不能对其他引擎或全部失败导航外推。
- **样本可达性与意外联网**：[navigation.ts](../../../src/main/navigation.ts) 对私网和本机资源实施访问条件；本地服务并非必然可由产品加载，不能以关闭策略补齐测试。当前 [Browser](../../../src/renderer/src/features/browser/Browser.tsx) 由地址文本查询历史并可能展示外部搜索项；选中外部项会导航到外部搜索服务，因此准备合成样本不自动授予对外发送查询的权限。
- **隔离与安全**：当前目标运行记录中的本机远程调试及临时下载探针授权只针对先前任务和对应实例，不能扩为任意网页、Agent、数据清理、安装、配置或历史内容权限。不得更改产品或安全策略来使基线可执行。

源码 SHA-256：`NewTab.tsx` `096bc5f88cab2107941fd51dee2c462f36c4cc7c4469a60fe3baa425b4566830`；`policy.ts` `25615324e3b08dcba47fe05585a5a3eb170fa78a59d53927166a38ea4c2a7dbe`；`feature.tsx` `d81dd8143c0457d01e4dbac5a1a9d168047e63bcf5958c83b9b46781d16ae7a2`；`Browser.tsx` `b8031f9f2007bf0320b686fcc8c1c621b159f6fb91a88c65a2db907889b8552b`；`History.tsx` `98dcbe058f80d0f0f3440b8b4b8fb8db136a033b98241f13d01fe54e57ef22a9`。

补核源码 `history.ts` SHA-256 `b245abb6437cce2403c973d62e6ea320a5109de3fc20745629bdda455e8a6cc3`、`browser.ts` `4671c6c12136e8488085525f3673d17df48836b43144884f09b62bf6e98d93fc`、`navigation.ts` `5e73f9050c99efe3d4eafba054d98c12c2534c7a71e6c98f67f838f59a876756`；三者相对上述源码基点无未提交差异。

## 制品、输入与截图缺口

待核目标为 macOS arm64 `0.3.2 / 202611121823 / preview`；既有运行曾记录 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`，不凭该历史记录声称当前实例或源码同源。`examples` 中的合成网页尚未确认为可直接访问的浏览器测试站点，不能冒充网页服务或历史结果；需额外确认测试站点来源、网页内容、导航/联网及历史副作用权限。

历史设计记录提到 `tmp/test_snapshot/browser-settings-overlay/find-user-opened.png` 和 `navigation-failure.png`，本工作区未找到这些文件；不得凭历史路径宣称可复用或用测试 fixture 冒充真实完整窗口。现有[浏览器设置图](./../browser-settings/requirements.md)只证明其所展示的设置窗口，不是网页浏览或授权结果。本页缺目标版本真实网页、查找及授权完整窗口参考图；条件未满足时明确保留缺口，不重启、登录、授权、下载或调用模型凑图。
