# Codex Runtime 制品维护

## macOS packaging profile / macOS 打包策略

The product supports macOS 13 and does not expose Codex voice. The macOS bundle
therefore excludes only `codex-resources/voice/` from its staging copy. The
reviewed upstream archive and complete extraction cache remain unchanged;
Windows retains the complete payload and byte-identical resolution receipt.

The staged `resolve-receipt.json` lists exactly the shipped files. Its `packaging`
record contains the policy, reason, original receipt SHA-256 and every excluded
file's path, SHA-256, mode and byte count. The build checkpoint also records this
projection. Other resources and upstream signatures remain unchanged. Full
Mach-O minimum-version validation still runs: another incompatible binary must
fail. Static inspection does not establish macOS 13 device acceptance.

产品支持 macOS 13，未接入 Codex 语音，因此仅从 macOS 打包副本排除
`codex-resources/voice/`。受审官方原包和完整解包缓存保持原样；Windows 继续保留
完整载荷及逐字节相同的原解析收据。

产物 `resolve-receipt.json` 精确列出实际随包文件，`packaging` 记录策略、原因、原收据
SHA-256，以及每个排除文件的路径、SHA-256、模式和大小；构建检查点也记录该投影。
其他资源及上游签名字节不变。完整 Mach-O 下限门禁继续运行，其他不兼容二进制必须
失败；静态检查通过不等于 macOS 13 真机验收。

本目录保存 Desktop 内置的官方 Codex Runtime 平台清单。制品不进入 Git；构建仅按清单中的固定 OSS HTTPS URL 下载并校验，不访问 npm `latest`。

当前固定为 `0.165.0`，对应 2026-10-29 查询的 npm 稳定版本。三平台原始包已与 npm SHA-512 integrity 比对，并通过 OSS 匿名完整下载的大小和 SHA-256 校验。Windows 组件同步绑定 `0.165.0-r1` 的实测文件树和规范 ZIP 摘要；该 ZIP 在 macOS 上按现有打包配方生成，不代表 Windows 原生构建、组件发布或产品验收通过。
macOS 与 Windows 统一固定为 `0.165.0`，支持当前会话的隔离文本采样。
平台条目未指定版本时使用清单顶层版本；缓存身份和版本探测均使用选中平台的版本。
Windows 升级同时核对完整官方归档、组件内容绑定和精确沙箱版本准入；
不能凭 macOS 验证宣称 Windows 原生提权助手或安装版验收通过。

Windows 沙箱资源接口保留 Adapter 已评审的版本兼容；当前打包原生 helper 仅接受冻结清单中的 `0.165.0`，不以 Adapter 的旧版本接口兼容性扩大 helper 准入。helper 必须匹配请求版本对应的签名组件，路径、入口摘要、Owner-only 修复和 DACL 检查不变。官方源码对比与边界见 [Adapter 兼容说明](../../../packages/adapters/codex/README.md#windows-01650-沙箱适配)。

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
