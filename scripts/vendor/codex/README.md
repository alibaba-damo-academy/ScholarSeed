# Codex Runtime 制品维护

本目录保存 Desktop 内置的官方 Codex Runtime 平台清单。制品不进入 Git；构建仅按清单中的固定 OSS HTTPS URL 下载并校验，不访问 npm `latest`。

当前固定为 `0.165.0`，对应 2026-10-29 查询的 npm 稳定版本。三平台原始包已与 npm SHA-512 integrity 比对，并通过 OSS 匿名完整下载的大小和 SHA-256 校验。Windows 组件同步绑定 `0.165.0-r1` 的实测文件树和规范 ZIP 摘要；该 ZIP 在 macOS 上按现有打包配方生成，不代表 Windows 原生构建、组件发布或产品验收通过。

Windows 沙箱资源接口已在本地增加 `0.165.0` 精确准入，Adapter 与原生 helper 的权限恢复同步适配；现有 `0.159.0` / `0.163.0` 资源准入及 `0.163.0` 恢复保持不变。helper 必须匹配请求版本对应的签名组件，路径、入口摘要、Owner-only 修复和 DACL 检查不变。官方源码对比与边界见 [Adapter 兼容说明](../../../packages/adapters/codex/README.md#windows-01650-沙箱适配)。

**gap**：Windows 真机、组件发布、安装与真实模型/工具回合尚未验收。macOS arm64 / x64 已通过完整 Runtime 解包和版本探针，真实 Desktop 模型及工具回合仍未验收。

这是构建输入调整，不执行客户端安装或数据迁移。禁止未经兼容性验证让旧版直接打开新版写入的用户 Home、SQLite 或会话文件；真实对照必须使用隔离目录，Windows 打包、组件可下载性和产品流程仍需分别验收。

产品仅接受本清单固定的官方制品，不提供定制原生候选选源或兼容版本覆盖。

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

以当前固定版本 `0.165.0` 为例，下载地址为：

```text
https://registry.npmjs.org/@openai/codex/-/codex-0.165.0-darwin-arm64.tgz
https://registry.npmjs.org/@openai/codex/-/codex-0.165.0-darwin-x64.tgz
https://registry.npmjs.org/@openai/codex/-/codex-0.165.0-win32-x64.tgz
```

也可以直接下载：

```bash
VERSION=0.165.0

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
VERSION=0.165.0
npm view "@openai/codex@${VERSION}-darwin-arm64" dist.integrity
npm view "@openai/codex@${VERSION}-darwin-x64" dist.integrity
npm view "@openai/codex@${VERSION}-win32-x64" dist.integrity
```

同时记录实际字节数和 SHA-256：

```bash
stat -f%z "scripts/vendor/codex/codex-${VERSION}-darwin-arm64.tgz"
shasum -a 256 "scripts/vendor/codex/codex-${VERSION}-darwin-arm64.tgz"
```

将 URL、字节数、SHA-256 和 npm SHA-512 integrity 一并写入 `manifest.json`。

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
4. 将原始平台包上传 OSS 并验证匿名下载，更新 manifest 中的 OSS URL、字节数、SHA-256、integrity 和固定版本。
5. 删除本地下载文件，确认其不会进入 Git。
7. 执行 Desktop 打包契约测试和两个平台的真实构建。
6. 提交 manifest、说明和代码变更，不提交 tgz。

## 验证

```bash
cd apps/desktop
node --test runtime/codex.test.cjs scripts/cd/__tests__/build.test.cjs

cd ../..
pnpm ops cd build local
```

Windows 制品按 [`scripts/BUILD.md`](../../BUILD.md) 的 Velopack 个人安装链路完成构建与实机验收；契约测试不替代安装验收。
