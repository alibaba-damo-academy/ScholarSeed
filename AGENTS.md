# 协作与验证

- GitHub CI、开发安装包和签名安装包分别由 `.github/workflows/` 中的 workflow 持有；配置见 `.github/README.md`。
- 使用 feature 分支提交改动，不直接改写 `main`。
- Node 版本以 `.node-version` 为准，npm 和 uv 与 workflow 的锁定版本保持一致。
- 修改 workflow 后运行 actionlint；修改产物整理逻辑后运行 `node --test .github/scripts/package.test.cjs`。
- 签名材料只从 Actions Secrets 注入 runner 临时目录，产物仅上传验证后的安装包、摘要和结果文件。
- 本地语法或契约检查不代表完成 Apple 签名、公证或 Windows 原生安装验收。
- macOS 签名入口统一使用 `apps/desktop/scripts/cd/osx-sign.cjs`：固定版本 osx-sign 扫描资源时并发开文件会触发 EMFILE，文件头检测须逐个完成；回归命令为 `node --test apps/desktop/scripts/cd/__tests__/osx-sign.test.cjs`。
