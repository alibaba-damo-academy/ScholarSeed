<a id="codex-runtime-制品维护"></a>
# Codex Runtime Artifact Maintenance

<a id="macos-packaging-profile--macos-打包策略"></a>
## macOS Packaging Profile

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

The product supports macOS 13 and does not integrate Codex voice, so only the macOS packaging copy excludes `codex-resources/voice/`. The reviewed official archive and complete extraction cache remain unchanged; Windows continues to retain the complete payload and the byte-identical original resolution receipt.

The artifact's `resolve-receipt.json` lists exactly the files shipped in the package. Its `packaging` record contains the policy, reason, original receipt SHA-256, and each excluded file's path, SHA-256, mode, and size; the build checkpoint also records this projection. Other resources and upstream signature bytes remain unchanged. The full Mach-O minimum-version gate continues to run, and any other incompatible binary must fail; passing static checks is not macOS 13 device acceptance.

This directory stores the official Codex Runtime platform manifest bundled with Desktop. Artifacts are not committed to Git; builds download and verify them only from the fixed OSS HTTPS URLs in the manifest and do not access npm `latest`.

The version is currently pinned to `0.171.0`, the npm stable version queried on 2026-11-23. The original packages for all three platforms have been compared with npm SHA-512 integrity values and passed size and SHA-256 checks after complete anonymous downloads from OSS. The Windows component is also bound to the measured file tree and canonical ZIP digest for `0.171.0-r1`; that ZIP was generated on macOS using the existing packaging recipe and does not demonstrate a native Windows build, component publication, or product acceptance.
macOS and Windows are both pinned to `0.171.0`, which supports isolated text sampling for the current session.

This pin includes the upstream context-usage boundary fix: failed output remains in the native context estimate until usable sampling usage covers it. Automatic compaction stays in the Codex harness; the Adapter separately reports spending and does not add an output-error-specific compaction path. See the official [history implementation](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/core/src/context_manager/history.rs).

The Windows binding was computed on macOS from the verified official archive and the canonical reproducible packaging recipe. Its predicted receipt bytes do not replace the official executable's Windows version probe; native Windows builds must execute that probe and match the bound tree and ZIP digests. The component ZIP has not been published or accepted as an installed Windows runtime.

中文：当前三平台固定官方 0.171.0，包含失败输出的原生上下文估算边界修复；自动压缩由 Codex Harness 统一处理，适配层只负责消耗统计与事件投影。Windows 组件绑定来自已校验原包和可复现打包规则；macOS 静态生成的预期字节不替代 Windows 原生版本探测、安装或沙箱验收，组件 ZIP 尚未发布。
When a platform entry does not specify a version, the manifest's top-level version is used; cache identity and version probing both use the selected platform's version.
Windows upgrades also verify the complete official archive, the component content binding, and exact sandbox-version admission. macOS verification cannot be used to claim acceptance of the Windows native privilege helper or installed build.

The Windows sandbox resource interface retains the version compatibility reviewed in the Adapter. The currently packaged native helper accepts only `0.171.0` from the frozen manifest; the Adapter's compatibility with older interface versions does not expand helper admission. The helper must match the signed component for the requested version; path, entrypoint digest, Owner-only repair, and DACL checks remain unchanged. See [Adapter compatibility notes](../../../packages/adapters/codex/README.md#windows-01710-沙箱适配) for the official source comparison and boundaries.

**gap**: Windows device testing, component publication, installation, and real model/tool turns have not yet been accepted. macOS arm64 / x64 have passed complete Runtime extraction and version probing; these checks do not establish Desktop model or tool acceptance, which requires separate real-product evidence.

This changes build inputs; it does not install a client or migrate data. Do not let an older version directly open a user Home, SQLite database, or session file written by a newer version without compatibility verification. Real comparisons must use isolated directories; Windows packaging, component downloadability, and product flows still require separate acceptance.

The product accepts only official artifacts pinned in this manifest; it provides no custom native candidate source selection or compatible-version override.

<a id="当前平台"></a>
## Current Platforms

```text
codex-<version>-darwin-arm64.tgz
codex-<version>-darwin-x64.tgz
codex-<version>-win32-x64.tgz
```

<a id="官方来源"></a>
## Official Source

First query the official stable version:

```bash
npm view @openai/codex@latest version
```

For the currently pinned version `0.171.0`, the download URLs are:

```text
https://registry.npmjs.org/@openai/codex/-/codex-0.171.0-darwin-arm64.tgz
https://registry.npmjs.org/@openai/codex/-/codex-0.171.0-darwin-x64.tgz
https://registry.npmjs.org/@openai/codex/-/codex-0.171.0-win32-x64.tgz
```

You can also download directly:

```bash
VERSION=0.171.0

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

<a id="完整性记录"></a>
## Integrity Records

Read the official SHA-512 integrity values from npm metadata:

```bash
VERSION=0.171.0
npm view "@openai/codex@${VERSION}-darwin-arm64" dist.integrity
npm view "@openai/codex@${VERSION}-darwin-x64" dist.integrity
npm view "@openai/codex@${VERSION}-win32-x64" dist.integrity
```

Also record the actual byte count and SHA-256:

```bash
stat -f%z "scripts/vendor/codex/codex-${VERSION}-darwin-arm64.tgz"
shasum -a 256 "scripts/vendor/codex/codex-${VERSION}-darwin-arm64.tgz"
```

Record the URL, byte count, SHA-256, and npm SHA-512 integrity together in `manifest.json`.

For each macOS target, also record `receiptSha256`, the SHA-256 of the complete
resolver receipt. Derive it from the reviewed archive, including voice files,
before seeding the shared CI cache. The following command takes the platform
key and reads the archive identified by the updated manifest.

macOS 升级 Codex 时，还需从已审核的官方包计算各架构的 `receiptSha256` 并写入
`manifest.json`。清单涵盖完整运行时，包括打包时会排除的 voice 文件。在仓库根目录执行以下命令，
分别传入 `darwin-arm64` 和 `darwin-x64`。

```bash
python3 - darwin-arm64 <<'PYTHON'
import base64, hashlib, json, pathlib, sys, tarfile

vendor = pathlib.Path("scripts/vendor/codex")
manifest = json.loads((vendor / "manifest.json").read_text())
item = manifest["artifacts"][sys.argv[1]]
archive = vendor / item["file"]
with archive.open("rb") as stream:
    sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
with archive.open("rb") as stream:
    sri = "sha512-" + base64.b64encode(hashlib.file_digest(stream, "sha512").digest()).decode()
if archive.stat().st_size != item["bytes"] or sha256 != item["sha256"] or sri != item["integrity"]:
    raise SystemExit("Official archive integrity mismatch")
prefix = f'package/vendor/{item["target"]}/'
files = []
with tarfile.open(archive, "r|gz") as package:
    for member in package:
        if member.name.startswith(prefix) and member.isfile():
            name = member.name[len(prefix):]
            content = package.extractfile(member).read()
            files.append(dict(path=name, sha256=hashlib.sha256(content).hexdigest(), mode=0o755))
            if name == "codex-package.json":
                entrypoint = json.loads(content)["entrypoint"]
receipt = dict(archive_sha256=item["sha256"], reported_version=item.get("version", manifest["version"]),
               entrypoint=entrypoint, files=files)
print(hashlib.sha256(json.dumps(receipt, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest())
PYTHON
```

<a id="内容检查"></a>
## Content Checks

The platform package must contain the complete Runtime, not just the main executable:

```bash
tar -tzf "codex-${VERSION}-darwin-arm64.tgz"
tar -tzf "codex-${VERSION}-darwin-x64.tgz"
tar -tzf "codex-${VERSION}-win32-x64.tgz"
```

Check at least:

- `codex-package.json`；
- `bin/codex` or `bin/codex.exe`;
- code-mode host；
- platform helper programs such as the command runner and sandbox;
- `target` and `entrypoint` in the manifest match the platform in the filename.

<a id="更新步骤"></a>
## Update Steps

1. Query the stable version of `@openai/codex@latest`.
2. Download the official platform packages for macOS arm64, macOS x64, and Windows x64.
3. Verify the version, platform, and SHA-512 integrity in npm metadata.
4. Upload the original platform packages to OSS and verify anonymous downloads; update the OSS URL, byte count, SHA-256, integrity, and pinned version in the manifest.
5. Delete local downloads and confirm they will not enter Git.
7. Run Desktop packaging contract tests and real builds on both platforms.
6. Commit the manifest, documentation, and code changes; do not commit tgz files.

<a id="验证"></a>
## Verification

```bash
cd apps/desktop
node --test runtime/codex.test.cjs scripts/cd/__tests__/build.test.cjs

cd ../..
pnpm ops cd build local
```

Build and acceptance-test Windows artifacts on a device using the Velopack personal installation flow in the [build runbook](../../../docs/runbooks/build.md); contract tests do not replace installation acceptance.
