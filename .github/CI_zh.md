# GitHub CI 与打包

[English](CI.md) | 简体中文

## 工作流

| 工作流 | 触发方式 | 产物与校验 |
| --- | --- | --- |
| CI | PR、main 推送 | 编译公开源码并检查分发契约；独立检查工作流语法及制品筛选逻辑 |
| Package（已停用） | 无；配置改名为 `workflows/package.yml.disabled` | 保留开发包配置；恢复 `.yml` 扩展名后才会启用 |
| Package Sigend | main 推送自动执行，也可在 main 手动执行 | macOS ARM64 / x64 签名、公证及挂载校验；仅上传 Actions Artifacts |
| Release | 在 main 手动提供 Run ID、tag 和 channel | 校验指定成功构建的产物，创建 tag 与 GitHub Release，不重新构建 |

签名任务使用现有 `ops cd build release --stage installer` 入口，不调用私有分发仓库、不上传 OSS，也不将私有更新服务版本置为已发布。双架构产物保留在 Actions，供后续手动发布。原生租约检查、签名、公证和安装校验保持启用，但不等同于私有分发流程的完整冒烟验收。

macOS 采用原生构建矩阵：ARM64 使用 `macos-15`，x64 使用 `macos-15-intel`，分别完成签名、公证、挂载校验和上传。x64 构建报告使用项目架构名 `x86_64`，制品名称使用 `x64`。GitHub 已宣布 macOS 14 托管 runner 于 2026-11-02 退役，因此新任务使用 macOS 15。

签名任务遵循 [GitHub runner 官方临时处理办法](https://github.com/actions/runner-images/issues/14924)，仅在临时 runner 阻断 UDP/443，使 Apple 票据查询从不稳定的 HTTP/3 改走 HTTPS/TCP。既有 Intel 验证中 `stapler validate` 返回 68，ARM64 也曾在 Accepted 后附票失败，因此两个架构均使用 TCP；附票和校验保留有界 stdout/stderr 诊断，签名、公证票据及 Gatekeeper 仍须全部通过。

## macOS 签名配置

在 Settings → Secrets and variables → Actions 中添加 Repository secrets：

| Secret | 内容 |
| --- | --- |
| MACOS_CERTIFICATE_P12_BASE64 | 含 Developer ID Application 证书及私钥的 `.p12` 文件的 Base64 |
| MACOS_CERTIFICATE_PASSWORD | `.p12` 导出密码 |
| APPLE_ID | 对该开发团队具有公证权限的 Apple 账号 |
| APPLE_APP_SPECIFIC_PASSWORD | 同一账号生成的应用专用密码，不是 Apple 登录密码 |
| APPLE_TEAM_ID | 证书所属 Apple Developer Team ID |

五项值只注入检查与凭据导入步骤；构建步骤仅接收 Team ID、钥匙串配置名。临时钥匙串、导出的证书及公证凭据存于 GitHub 托管 runner 的临时目录，任务结束时清理，不上传工作区或签名上下文。

更新服务地址来自 `apps/desktop/resources/product.json` 的 `update_base_url`；更新授权公钥来自 `signing/activation-public-keys.json`，沿用已有分发公钥。该文件只有 Ed25519 公钥，没有私钥；服务端轮换密钥时须同步评审公钥更新。`preview` / `release` 选择包内更新渠道，两者均执行生产签名和公证。

推送或合并到 main 自动构建 preview 渠道签名包，不创建 tag 或 Release。需要生产渠道安装包时，在 Actions → Package Sigend → Run workflow 中选择 main 和 release；该操作也只构建、不发布。工作流须先进入默认分支，才可从界面手动触发。只有 main 可执行签名任务，PR 和其他分支不会执行。有权修改 main 或工作流的维护者可使用仓库 Secrets，因此应保护 main 的写入和评审权限；如需独立签名审批，管理员应迁移到带审批及分支限制的 Environment。

## 下载自动构建的安装包

打开 Actions → Package Sigend → 对应运行 → Artifacts，下载所需架构的 `.dmg` 及匹配的 `.dmg.sha256`。公开仓库的普通访问者登录 GitHub 后即可下载，无需写权限；未登录用户不能直接从 Actions 页面下载。参见 [GitHub 制品下载权限说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)。

安装包、校验文件及独立的 `build-report-*` 报告保留 14 天；安装包不额外包裹 ZIP。需要长期或匿名下载时，手动发布到 Release。

## 手动发布已有构建

1. 在 Package Sigend 中选择完全成功的 main 构建，下载试用并确认版本。运行页面 URL 中 `actions/runs/` 后的数字即 Run ID。
2. 打开 Actions → Release → Run workflow，选择 main。
3. 输入构建的 `run_id`、新 `tag` 和包内 `channel`。例如 preview 使用 `v0.3.1-preview.1`，release 使用 `v0.3.1`。不要提前创建 tag，工作流会将其指向所选构建的源码提交。
4. 成功后从仓库 [Releases](https://github.com/alibaba-damo-academy/ScholarSeed/releases) 下载同一安装包，不重新构建或签名。

- preview 只能发布预发布版本，tag 须以 `v<包内版本>-preview.` 开头，不替换 Latest；release 使用正式 tag `v<包内版本>`。改 tag 名不能改变包内更新渠道。
- 所选运行必须来自本仓库 main 的 `signed-macos.yml`，由 push 或手动触发且完全成功。过期或缺失制品不能发布；须在 14 天内发布，否则重新构建并验收。
- 发布前审核双架构的提交、渠道、版本、构建号、签名、公证、挂载校验及下载后 SHA256；tag 指向构建提交，Release 正文链接原构建报告。
- Release 仅包含两个 `.dmg` 及匹配的 `.dmg.sha256`，不包含 `result.json`。GitHub 自动附加的 Source code 归档是源码，不是安装包。
- 下载后将 DMG 与校验文件置于同一目录，运行 `shasum -a 256 -c <安装包文件名>.sha256`。
- 仅手动 Release job 具有 `contents: write`、`actions: read`，默认使用内置 `GITHUB_TOKEN`；签名构建为只读权限。
- 当所选历史提交的 `.github/workflows/` 与当前默认分支不同时，GitHub 创建 Release 额外要求 Workflows write，内置 `GITHUB_TOKEN` 无法取得此权限。此时配置仓库 Secret `RELEASE_TOKEN`：仅授权本仓库的 fine-grained PAT，具有 Contents: write 和 Workflows: write（组织可能要求审批），发布步骤优先使用它。不要改 tag 指向来规避限制。参见 [GitHub Release API 权限说明](https://docs.github.com/en/rest/releases/releases#create-a-release)。
- 不覆盖已有 tag。上传中断可能留下未发布草稿，重跑前检查并清理该草稿，不覆盖已发布版本。

## Windows

Windows 开发包矩阵及构建步骤当前已注释，不执行 Windows 打包；取消注释后才会恢复。正式 Windows 包仍需项目专用签名客户端、可达签名服务、更新载荷签名及组件分发配置；Apple 的五项 Secrets 不提供这些能力。本次回流不将 Windows 开发包认定为生产签名包。

## 本地检查

```bash
actionlint .github/workflows/*.yml
node --test .github/scripts/*.test.cjs
node --test apps/desktop/scripts/cd/__tests__/osx-sign.test.cjs
```

完整源码编译与分发契约命令见 `workflows/ci.yml`。语法、单测或编译通过不代表 Apple 公证通过；实际签名工作流及其 `result.json` 才是成功证据。

上游记录的 2026-11-03 首轮验证：CI 运行 `41651926527` 完成源码编译并通过 346 项测试；签名运行 `41651924504` 完成 Developer ID 签名、Apple 公证、DMG 挂载校验及制品上传。首轮试运行的临时 feature 分支入口已移除，后续已拆分签名构建与手动 Release 发布。这些是上游历史记录，不代表本次回流已重新完成签名验收。
