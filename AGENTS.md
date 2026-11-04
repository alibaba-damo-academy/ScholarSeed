# 协作与验证

- GitHub CI、开发安装包和签名安装包分别由 `.github/workflows/` 中的 workflow 持有；配置见 `.github/README.md`。
- 使用 feature 分支提交改动，不直接改写 `main`。
- Node 版本以 `.node-version` 为准，npm 和 uv 与 workflow 的锁定版本保持一致。
- 修改 workflow 后运行 actionlint；修改产物整理逻辑后运行 `node --test .github/scripts/*.test.cjs`。
- 签名材料只从 Actions Secrets 注入 runner 临时目录，产物仅上传验证后的安装包、摘要和结果文件。
- 本地语法或契约检查不代表完成 Apple 签名、公证或 Windows 原生安装验收。
- macOS 签名入口统一使用 `apps/desktop/scripts/cd/osx-sign.cjs`：固定版本 osx-sign 扫描资源时并发开文件会触发 EMFILE，文件头检测须逐个完成；回归命令为 `node --test apps/desktop/scripts/cd/__tests__/osx-sign.test.cjs`。
- macOS 打包使用 `macos-15`（ARM64）与 `macos-15-intel`（x64）原生矩阵；`PACKAGE_ARCH=x64` 对应 `result.release.arch=x86_64`，产物整理时须校验这层映射。
- Intel 托管 runner 的 `/System/Volumes/Data` 可能为 root:wheel 0775；打包前仅在该临时 runner 移除组写权限，保留产品原生目录权限检查。
- GitHub Release 由签名 workflow 的发布 job 汇总同一提交的双架构产物；preview 使用带构建号的预发布 tag，release 使用版本 tag，拒绝覆盖已有 tag。Release 仅含 DMG 与各自 SHA256，result.json 留在 Actions。
- macOS 托管 runner 的 stapler 可能因 Apple CloudKit HTTP/3 连接中断失败（Intel 实测返回 68，ARM64 也出现票据附加失败）；按 actions/runner-images#14924 的官方方案仅在临时 runner 阻断 UDP/443，改走 HTTPS/TCP，保留 stapler validate 与 Gatekeeper 验收。
- 票据附加与 macOS 信任验证统一调用 verify.trustCommand；失败时保留退出码、stdout/stderr 尾部，避免 stapler 把网络原因写到 stdout 后丢失诊断。

- main 推送自动触发双架构签名与 preview Release；手动入口可选择 preview/release，push 事件没有 inputs.channel，渠道和并发组统一回退到 preview。
- Windows 打包暂时暂停，`package.yml` 的 Windows 矩阵项和构建步骤保留为注释。
