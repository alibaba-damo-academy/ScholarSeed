# 账号与开发者候选构建依据

## 建设状态

资产修订 `account/1`。本页记录历史编号和当前源码线索，不自动成为目标版已采用基线；产品需求版本、Owner、入口可达性及 `0.3.2 / 202611121823 / preview` 适用性均待确认。普通展示、真实登录与恢复、云端资料、密钥创建/轮换等不能互相代替；无目标版本真实完整窗口图。

## 历史需求与确认边界

[P2 冻结](../../frozen/p2-20261025-539af0794/freeze.json)记载 `sourceCommit` `539af079455cc821b976760728fc13dfedbb8b66`；从该提交回查 `apps/desktop/docs/scenarios/catalog.json` 与 `apps/desktop/eval-scenarios/exploratory/desktop-business/cases/settings.json`，SHA-256 分别为 `e4a029cce1e58db658acb2643ea05621f48c288d12209eb0df41f5a4329ec45f` 和 `372aee4969f44a7e9caafc93bdf4d3ee57990a7ada48b7d0db867bf7405e2ff2`。可通过 `git show <sourceCommit>:<路径>` 回查，不恢复或改写冻结文件。

- `ACCOUNT-LOGIN-01@3`：目录为 `pending/exploratory`，目标是专用账户真实登录后客户端显示对应身份，并按获准重开范围确认状态；历史主用例 `D6-SET-002` 为 `candidate_unapproved`。`@3` 是历史资产修订，不是产品需求版本。
- `ACCOUNT-STATE-01@1`：目录为 `current/exploratory`，是当前账号菜单状态只读展示，与登录/恢复分开；历史 `D6-SET-004` 仍为 `candidate_unapproved`。目录的 `current` 不证明目标包已采用或已评测。
- 设计映射中登录交接与头像菜单是历史设计/实现线索；外部登录网页与云端资料不因此成为本仓库内页面或已验证能力。独立账户设置页当前源码导航隐藏，不能仅凭 `AccountPage` 组件认定入口可达。
- 本次用户已明确指出“开发者 → API 密钥”是产品功能，不因页面标题视为敏感；该确认不等于授权创建、复制、撤销或轮换密钥，也不证明所有页面状态均不显示明文。目标版本语义及适用仍须核。

## 当前源码与副作用

分析基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；本次检查的以下文件相对该提交无未提交差异，未与目标安装包证明同源：

- [accountview.ts](../../../src/renderer/src/components/business/accountview.ts) 组装登录/身份、可用额度和其他菜单动作，按当前动作可用性及退出状态控制入口；SHA-256 `ff0a35476157fac0967e7ffc7199c6b042d985e46e27691860e787f2e57379f7`。身份脱敏属于可观察呈现，不把用户姓名或手机号复制到基线。
- [AccountMenu.tsx](../../../src/renderer/src/components/business/AccountMenu.tsx) 持有菜单动作、个人资料及额度的云端入口；SHA-256 `9262bfcd271655b5cb00eb67237bb74b93ed38b111f1913cb8ba8ae8f150dfdd`。[Landing.tsx](../../../src/renderer/src/components/business/Landing.tsx) 调用登录交接；SHA-256 `ca908ae97a7042483496c2c45f781144ffb09911ba0c7c77a99da206fb80c1fd`。登录、退出和云端访问不属于无副作用的状态投影。
- [AccountPanel.tsx](../../../src/renderer/src/components/business/AccountPanel.tsx) 包含 `DeveloperPage`：加载先调用 `ensureSkillCredential`，再读取 API key 列表；创建、撤销、托管轮换分别调用写操作，`FreshKeyCard` 会显示新建结果的 `token`。文件 SHA-256 `478d2820a9400a4859e8e3e7fcf53add8faf0bc6850a86b692242252da9661a9`。当前源码证明此副作用风险及明文分支，不证明目标包同源、该分支可达或本次需要获取凭据。

## 数据与交接

目标身份线索为 macOS arm64 `0.3.2 / 202611121823 / preview`，既有 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`；后续操作仍需核当时运行实例及制品。没有获准的目标版账号菜单、登录或开发者设置完整窗口参考图；不能复用真实用户身份、密钥或组件夹具代替。

交接需明确需求 Owner、产品需求版本、目标适用性及已采用范围，准备专用测试账户、脱敏参照与必要授权。普通页面导航、真实登录/退出、云端资料、托管凭据准备和创建/复制/轮换/撤销分别核副作用；截图仅保留授权内容，不记录完整凭据。缺少前提则保留候选及截图缺口，不将本页纳入冒烟或宣称通过。
