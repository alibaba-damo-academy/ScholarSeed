# GitHub CI 与打包

## 工作流

| 工作流 | 触发 | 产物和验证 |
| --- | --- | --- |
| CI | Pull request、推送 main | 公开源码编译、发行契约；独立检查 workflow 语法和工件筛选逻辑 |
| Package（已停用） | 无；配置改名为 `workflows/package.yml.disabled` | 保留开发包配置，恢复 `.yml` 后重新启用 |
| Package Sigend | 推送 main 自动运行，也可在 main 上手动运行 | macOS ARM64 / x64 签名、公证、挂载验收，成功后发布 GitHub Release |

签名任务使用现有 `ops cd build release --stage installer` 直接发行入口，不调用私有分发仓库，不运行 OSS 上传，两个架构通过后发布 GitHub Release；不把私有更新服务的版本变更为 published。它保留原生 lease 检查和构建器的签名、公证、安装验收；不等同于私有 distribution 工作流的完整冒烟集。

macOS 使用原生构建矩阵：ARM64 对应 `macos-15`，x64 对应 `macos-15-intel`；每个平台独立签名、公证和挂载验收，上传独立 artifact。x64 的构建结果使用项目架构名 `x86_64`，工件名称使用 `x64`。GitHub 已公告 2026-11-02 退役 macOS 14 托管 runner，故新任务使用 macOS 15。

macOS 签名 job 按 [GitHub runner 官方临时方案](https://github.com/actions/runner-images/issues/14924) 阻断当前临时 runner 的 UDP/443，使 Apple 票据查询从不稳定的 HTTP/3 回退到 HTTPS/TCP。Intel 已实测 `stapler validate` 返回 68，ARM64 也出现 Accepted 后附加票据失败，因此两个架构统一使用 TCP；票据附加与验证均记录有限长度的 stdout/stderr 诊断；签名、票据和 Gatekeeper 检查仍必须全部通过。

## macOS 签名配置

在 Settings → Secrets and variables → Actions 添加 Repository secrets：

| Secret | 内容 |
| --- | --- |
| MACOS_CERTIFICATE_P12_BASE64 | 包含 Developer ID Application 证书和私钥的 `.p12` 文件的 Base64 |
| MACOS_CERTIFICATE_PASSWORD | `.p12` 导出密码 |
| APPLE_ID | 具有该开发者团队公证权限的 Apple 账号 |
| APPLE_APP_SPECIFIC_PASSWORD | 同一账号生成的 App 专用密码，不是 Apple 登录密码 |
| APPLE_TEAM_ID | 证书所属的 Apple Developer Team ID |

五项值只在检查和凭证导入步骤注入；构建步骤只接收 Team ID 和钥匙串 profile 名称。临时钥匙串、导出的证书和公证凭证存放在 GitHub 托管 runner 的临时目录，结束时执行清理。整个工作区和签名上下文不作为 artifact 上传。

更新服务地址取 `apps/desktop/resources/product.json` 的 `update_base_url`；更新授权公钥取 `signing/activation-public-keys.json`，沿用已有分发使用的公钥。该文件只含 Ed25519 公钥，不含私钥；服务端轮换授权密钥时需同步审阅更新。`preview`/`release` 选择的是包内更新渠道，两者都执行正式签名和公证。

推送或合并到 main 后自动执行签名打包，并发布 preview 预发布版本。需要正式 release 时，在 Actions → Package Sigend → Run workflow，选择 main 和 release 渠道。该 workflow 必须先合入默认分支才能通过页面触发。只有 main 能运行签名 job；PR 和其他分支不运行该 job。能修改 main/workflow 的维护者能够使用仓库 Secrets，应保护 main 的写入和评审权限；需要独立签名审批时，由仓库管理员迁移到带审批和分支限制的 Environment。

## Release 下载与版本

成功后从仓库 [Releases](https://github.com/alibaba-damo-academy/ScholarSeed/releases) 下载安装包：每个架构一个 `.dmg` 和一个同名 `.dmg.sha256`。下载后将两者放在同一目录，执行 `shasum -a 256 -c <安装包文件名>.sha256`。GitHub 自动提供的 Source code 压缩包是源码，不是安装程序。

- `preview`（main 推送默认渠道）：发布预发布版本，tag 为 `v<版本>-preview.<构建号>`，不替换 Latest。
- `release`：发布正式版本，tag 为 `v<版本>`；已有 tag 拒绝覆盖，发布新版前先更新应用版本号。
- 构建号沿用源码提交时间生成的北京时间 `YYYYMMDDHHMM`，两个架构必须一致。
- 发布 job 等待两个架构全部成功，复核提交、渠道、版本、签名、公证、挂载验收和下载后的摘要，只上传四个安装/校验文件。
- `result.json` 单独保留在 Actions 的 `build-report-*` 工件中；Actions 内的安装包和校验文件也可直接下载，无额外 ZIP 包装，保留 14 天。
- 仅发布 job 授予 `contents: write`，使用内置 `GITHUB_TOKEN`，无需新增 PAT 或 Secret；构建 job 维持只读权限。
- 上传中断时 GitHub CLI 可能留下未发布草稿；检查并清理该次草稿后重跑发布 job，避免覆盖已发布版本。

## Windows

Windows 开发包矩阵项及构建步骤已注释，暂不运行 Windows 打包；恢复时取消对应注释。正式 Windows 包还需要项目专用签名客户端、可访问的签名服务、更新载荷签名与组件分发配置；Apple 的五项 Secrets 不提供这些能力。本次没有把 Windows 开发包标记为正式签名包。

## 本地检查

```bash
actionlint .github/workflows/*.yml
node --test .github/scripts/*.test.cjs
node --test apps/desktop/scripts/cd/__tests__/osx-sign.test.cjs
```

完整源码编译和发行契约命令见 `workflows/ci.yml`。语法、单元测试或编译通过均不代表 Apple 已接受公证；正式成功证据以签名 workflow 的真实运行及其 `result.json` 为准。

2026-11-03 首次接入验证：CI 运行 `41651926527` 源码编译及 346 项测试通过；签名运行 `41651924504` 完成 Developer ID 签名、Apple 公证、DMG 挂载验收及 Artifacts 上传。首次试跑临时开放的 feature 分支入口已移除。本次在双架构签名流程之后接入 GitHub Releases，开发包仍仅保留 Actions Artifacts。
