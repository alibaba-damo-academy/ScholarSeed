# 开发与验证

- 从仓库根目录运行 `npm ci`、`npm run prepare:python` 安装锁定依赖。
- 前端测试：`npm test`；后端契约测试：`.venv/bin/python -m apps.serve.tests.run_all`。
- `.github/workflows/desktop-package.yml` 手动调用 `npm run package`，提供三种原生平台安装包。
- 此工作流不读取签名凭据，不公证、不发布 Release；macOS 使用 ad-hoc 签名，Windows 不签名。
- 产物从 `package-result.json` 的 `artifacts` 获取，类型位于 `release.type`；上传前核对 SHA-256。
- 现有测试失败不得通过跳过或修改断言掩盖；本地静态检查不代表 GitHub 云端打包已成功。
