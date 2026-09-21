<div align="center">

# 书深 ScholarSeed

**面向科学研究与研发全周期的本地桌面 Agent 平台。**

[English](README.md) · [简体中文](README_zh.md)

[![License](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
![macOS](https://img.shields.io/badge/macOS-arm64%20%7C%20x86__64-black)
![Windows](https://img.shields.io/badge/Windows-x86__64-0078D4)
![Electron](https://img.shields.io/badge/Electron-React%20%2B%20TypeScript-47848F)
![Python](https://img.shields.io/badge/Python-FastAPI-3776AB)

</div>

书深 ScholarSeed 是一款本地优先的科研与研发桌面 Agent 应用。它将 Electron 桌面产品、Python 服务、中立的 Agent 运行时契约、可插拔运行时适配器、科研技能和可审计的执行记录组合在一起。

## 核心功能

<!-- 产品团队：在此补充审核后的核心功能列表。 -->

## 产品截图

<!-- 产品团队：在此补充审核后的产品截图。 -->

## 技术架构

ScholarSeed 采用多包单仓结构。根目录 `pyproject.toml` 负责编排 uv workspace，各应用与包独立拥有源码、依赖和发行边界。

```text
Electron / React
      │ HTTP + SSE
      ▼
ScholarSeed Serve
      │ 命令 + 事件
      ▼
Runtime Gateway ──► Codex Adapter ──► Codex App Server
      │
      └────────────► DamoATrace 证据记录
```

| 目录 | 职责 |
| --- | --- |
| `apps/desktop/` | Electron + React 桌面应用 |
| `apps/serve/` | FastAPI 产品后端与 `scholarseed` 发行包 |
| `packages/runtime/` | 中立运行时契约、Provider 发现和事件驱动 Gateway |
| `packages/adapters/codex/` | Codex App Server 进程接入与原生协议转换 |
| `packages/damoatrace/` | 独立的 trace 契约、记录、存储、查询与 CLI |
| `skills/community/` | 随产品编译的科研技能源码 |
| `tests/` | 跨包契约、集成测试、验收测试与发行门禁 |

ScholarSeed 当前包含的可执行 Agent Provider 是 Codex。Runtime 通过 `scholarseed_runtime.providers` entry point 发现 Provider，产品通过 `product.json` 控制启用范围。已经移除的自研 Harness 和历史 `damoagent` 命名空间不属于本仓库。

## 环境要求

- Git 与 Git LFS
- Node.js `24.16.0`
- npm `11.13.0`
- Python `3.12+`
- uv `0.12.11+`
- 目标平台对应的原生构建工具

安装包需要分别在 macOS arm64、macOS x86_64 或 Windows x86_64 原生环境构建，不支持跨平台打包。

## 从源码运行

请使用 Git 克隆而不是直接下载源码 ZIP，以确保 Git LFS 资源完整：

```bash
git clone <repository-url>
cd Scholarseed
git lfs install
git lfs pull
npm ci
npm run dev
```

`npm run dev` 会先准备仓库锁定的 Python 运行时和开发环境，再启动 Electron。通常不需要手动安装 workspace 中的 Python 包。

在 macOS 和 Windows 上，`npm run dev` 默认启用 DevTools 和复制会话 ID 按钮。设置 `SCHOLARSEED_DEVTOOLS=0` 可关闭这些开发功能。

## 模型与服务配置

ScholarSeed 需要配置你有权使用的模型连接。请在应用设置中填写 Provider 地址、模型名称和凭据。本地 HTTP 鉴权和模型授权是不同概念：本地服务健康不代表模型账号已经获得授权。

可选的开发和服务变量见 [`.env.example`](.env.example)。不要把 API Key、访问令牌、用户配置、会话数据、证书或私钥提交到仓库。

`UPLOAD_BASE_URL` 用于启用可选的论文卡片上传服务。未配置时，ScholarSeed 会明确提示配置缺失，不会连接内部或历史服务地址。

## 本地数据与隐私

默认用户数据目录为 `~/.scholarseed`，可通过 `SCHOLARSEED_HOME` 指定其他位置。

- 用户级配置、凭据、项目注册表、会话目录和文献数据由 `SCHOLARSEED_HOME` 管理。
- 项目自有数据保存在 `<project>/.scholarseed/`，会随项目目录一起迁移。
- Codex 状态默认隔离在 ScholarSeed 用户目录下，除非显式配置来源目录。
- DamoATrace 记录产品可见的诊断事件，供开发者排障；这不代表它能够读取执行器未公开的内部信息。

请勿将用户数据和凭据放进代码仓库；分享诊断包前应先检查其中内容。

## 开发与验证

常用仓库命令统一由根目录 `package.json` 暴露：

```bash
# 构建桌面应用
npm run build

# 运行桌面确定性测试
npm run desktop:test

# 检查 Python 类型
npm run python:typecheck

# 检查格式与 import 规则
npm run fmt-check

# 检查本机工具链和运行时
npm run doctor
```

`npm run check` 只代表静态检查，不能替代真实 Electron、后端、模型和工具链路验收。

## 构建安装包

安装包必须在对应的原生操作系统上构建：

```bash
# 构建并验证 unpacked App，不签名、不生成安装包
npm run package:check

# 构建本机开发安装包
npm run package

# 构建正式安装包；签名和公证凭据由 CI 注入
npm run package:dist
```

| 目标 | 原生构建环境 | 安装包 |
| --- | --- | --- |
| macOS arm64 | Apple Silicon macOS | DMG |
| macOS x86_64 | Intel macOS | DMG |
| Windows x86_64 | Windows x64 | NSIS EXE |

正式发布凭据必须通过受保护的 CI 变量或本机安全凭据存储提供。证书、私钥、公证凭据和内部上传地址不得进入仓库。

## 社区与支持

<!-- 产品团队：在此补充审核后的社区、问题反馈和支持渠道。 -->

## 许可证

ScholarSeed 的原创源码采用 [Apache License 2.0](LICENSE) 授权。

第三方软件、素材和随包运行时继续遵循各自的许可证，不会被 Apache-2.0 替代。现有声明包括：

- [Desktop 依赖及对应源码声明](apps/desktop/resources/notices/README.md)
- [Office Viewer 第三方声明](apps/desktop/src/renderer/public/office/THIRD_PARTY_NOTICES.md)
- [`paper-fulltext-dl` 第三方声明](skills/community/precise-literature-search/vendor/THIRD_PARTY_NOTICES.md)
