# GitHub CI 与打包

## 工作流

| 工作流 | 触发 | 产物和验证 |
| --- | --- | --- |
| CI | Pull request、推送 main | 公开源码编译、发行契约；独立检查 workflow 语法和工件筛选逻辑 |
| Package | 推送 main、v 开头的 tag、手动 | macOS ARM64 开发 DMG、Windows x64 开发 EXE，不使用签名凭证 |
| Signed macOS package | 在 main 上手动运行 | macOS ARM64 Developer ID 签名、公证、挂载启动验收后的 DMG |

签名任务使用现有 `ops cd build release --stage installer` 直接发行入口，不调用私有分发仓库，不运行 OSS 上传，不创建 GitHub Release，也不把服务端版本变更为 published。它保留原生 lease 检查和构建器的签名、公证、安装验收；不等同于私有 distribution 工作流的完整冒烟集。

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

在 Actions → Signed macOS package → Run workflow，选择 main 和渠道。该 workflow 必须先合入默认分支才能通过页面触发。只有 main 能运行签名 job；PR 和其他分支不运行该 job。能修改 main/workflow 的维护者能够使用仓库 Secrets，应保护 main 的写入和评审权限；需要独立签名审批时，由仓库管理员迁移到带审批和分支限制的 Environment。

成功后下载本次 run 的 `scholarseed-<channel>-darwin-arm64-signed-<run_id>` artifact，内含 DMG、`SHA256SUMS` 和 `result.json`。工件整理会复核当前提交、渠道、签名/公证证据、挂载验收与实际文件摘要，再上传这三类文件。下载后可执行 `shasum -a 256 -c SHA256SUMS`。

## Windows

现有 Package 继续构建未签名 Windows 开发包。正式 Windows 包还需要项目专用签名客户端、可访问的签名服务、更新载荷签名与组件分发配置；Apple 的五项 Secrets 不提供这些能力。本次没有把 Windows 开发包标记为正式签名包。

## 本地检查

```bash
actionlint .github/workflows/*.yml
node --test .github/scripts/package.test.cjs
```

完整源码编译和发行契约命令见 `workflows/ci.yml`。语法、单元测试或编译通过均不代表 Apple 已接受公证；正式成功证据以签名 workflow 的真实运行及其 `result.json` 为准。
