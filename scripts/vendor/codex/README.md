# Codex Runtime 制品维护

本目录保存 Desktop 内置的官方 Codex Runtime 平台包。制品使用 Git LFS 管理，构建时只读取并校验，不访问 npm `latest`。

## 当前平台

```text
codex-<version>-darwin-arm64.tgz
codex-<version>-darwin-x64.tgz
codex-<version>-win32-x64.tgz
```

## 官方来源

先查询官方稳定版本：

```bash
npm view @openai/codex@latest version
```

假设版本为 `0.155.1`，下载地址为：

```text
https://registry.npmjs.org/@openai/codex/-/codex-0.155.1-darwin-arm64.tgz
https://registry.npmjs.org/@openai/codex/-/codex-0.155.1-darwin-x64.tgz
https://registry.npmjs.org/@openai/codex/-/codex-0.155.1-win32-x64.tgz
```

也可以直接下载：

```bash
VERSION=0.155.1

curl -fL --retry 3 \
  "https://registry.npmjs.org/@openai/codex/-/codex-${VERSION}-darwin-arm64.tgz" \
  -o "scripts/vendor/codex/codex-${VERSION}-darwin-arm64.tgz"

curl -fL --retry 3 \
  "https://registry.npmjs.org/@openai/codex/-/codex-${VERSION}-darwin-x64.tgz" \
  -o "scripts/vendor/codex/codex-${VERSION}-darwin-x64.tgz"

curl -fL --retry 3 \
  "https://registry.npmjs.org/@openai/codex/-/codex-${VERSION}-win32-x64.tgz" \
  -o "scripts/vendor/codex/codex-${VERSION}-win32-x64.tgz"
```

## 完整性记录

从 npm 元数据读取官方 SHA-512 integrity：

```bash
VERSION=0.155.1
npm view "@openai/codex@${VERSION}-darwin-arm64" dist.integrity
npm view "@openai/codex@${VERSION}-darwin-x64" dist.integrity
npm view "@openai/codex@${VERSION}-win32-x64" dist.integrity
```

同时生成仓库侧 SHA-256 文件：

```bash
cd scripts/vendor/codex
shasum -a 256 "codex-${VERSION}-darwin-arm64.tgz" \
  > "codex-${VERSION}-darwin-arm64.tgz.sha256"
shasum -a 256 "codex-${VERSION}-darwin-x64.tgz" \
  > "codex-${VERSION}-darwin-x64.tgz.sha256"
shasum -a 256 "codex-${VERSION}-win32-x64.tgz" \
  > "codex-${VERSION}-win32-x64.tgz.sha256"
```

每个 `.sha256` 文件必须采用以下格式：

```text
<sha256>  <文件名>
```

## 内容检查

平台包必须包含完整 Runtime，不能只提取主程序：

```bash
tar -tzf "codex-${VERSION}-darwin-arm64.tgz"
tar -tzf "codex-${VERSION}-darwin-x64.tgz"
tar -tzf "codex-${VERSION}-win32-x64.tgz"
```

至少检查：

- `codex-package.json`；
- `bin/codex` 或 `bin/codex.exe`；
- code-mode host；
- command runner、sandbox 等平台辅助程序；
- manifest 中的 `target` 和 `entrypoint` 与文件名平台一致。

## 更新步骤

1. 查询 `@openai/codex@latest` 的稳定版本。
2. 下载 macOS arm64、macOS x64 和 Windows x64 官方平台包。
3. 核对 npm metadata 中的版本、平台和 SHA-512 integrity。
4. 生成三个 `.sha256` 文件。
5. 删除本目录中被替代的旧版本 tgz 和摘要文件。
6. 更新打包代码或 manifest 中记录的固定版本。
7. 执行 Desktop 打包契约测试和两个平台的真实构建。
8. 提交 tgz、摘要、版本配置和代码变更。

## Git LFS

`.gitattributes` 必须包含：

```gitattributes
scripts/vendor/codex/*.tgz filter=lfs diff=lfs merge=lfs -text
```

提交前检查：

```bash
git check-attr filter -- scripts/vendor/codex/*.tgz
git lfs status
```

新工作区检出后执行：

```bash
git lfs pull
```

如果 tgz 只有一百多字节，说明工作区拿到的是 LFS 指针，不能用于打包。

## 验证

```bash
cd apps/desktop
node --test runtime/codex.test.cjs scripts/build.test.cjs

cd ../..
scripts/build-desktop.py --type dev
```

Windows 制品还必须在 Windows x64 Runner 上生成 NSIS 并执行 package-check。
