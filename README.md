# 书深 ScholarSeed

书深是面向科研与研发的本地桌面 Agent 应用，提供 AI 对话、项目资料、文献阅读、文件工作台和科研技能。

## 获取与安装

需要 Git、Git LFS、Node.js 24.16.0、npm 11.13.0、uv 0.12.11 或更新版本，以及目标平台的构建工具。仓库包含经校验的 Python 与 Codex 运行时；不要自行替换其版本。

克隆仓库后在根目录执行：

```bash
git lfs install
git lfs pull
make install
make build
make config-template
make desktop
```

大文件通过 Git LFS 保存。仅下载源码 ZIP 可能缺少运行资源，应优先使用 Git 克隆并拉取 LFS 对象。`make config-template` 会更新配置；已有配置时请先备份。`make config` 提供交互式配置。

## 模型与账号配置

- **自备模型连接**：在应用设置中填写你有权使用的模型服务地址、模型名称和凭据；具体参数以服务商要求为准。
- **书深账号服务**：通过应用提供的登录入口连接对外服务，使用账号已开通的能力。账号授权与本机服务的访问模式是不同概念。

运行需要可用的模型连接和相应网络访问权限。文献检索等联网能力还需要对应服务可用。不要把 API Key、用户配置或会话数据提交到仓库。

论文卡片上传是独立的可选服务，需要显式设置 `UPLOAD_BASE_URL`；未配置时会明确报错，不连接历史内部地址。

默认用户数据位于 `~/.scholarseed`，可用 `SCHOLARSEED_HOME` 指定其他目录。产品 skills 位于 `skills/community/`，不是开发者协作工具，安装时会编译到产品中。

## 源码与检查

`apps/desktop/` 是 Electron 客户端，`apps/serve/` 是产品后端；`packages/` 包含 Runtime 契约与 Gateway、Codex/DeepSeek 适配边界及 ATrace。DeepSeek 适配器目前为预留能力，不代表已经可用。

```bash
make doctor
npm --prefix apps/desktop test
npm --prefix apps/desktop run typecheck
```

首版以 macOS 验收为目标；Windows 源码保留，但尚未完成公开环境验收。首次准备版本的实际验收仍在进行，不能把源码存在视为已验证。内部工作记录、开发者 skills、视觉规范门禁和私有历史不随本仓库交付。
