# 已审核的 python-build-standalone 运行时

[English](README.md)

Desktop 构建通过 `apps/desktop/scripts/cd/build.cjs` 将可重定位 CPython 放入应用，
运行时不依赖开发仓库或 `.venv`。原包来自官方
[python-build-standalone](https://github.com/astral-sh/python-build-standalone)。

归档不提交 Git。`manifest.json` 冻结 HTTPS 来源、字节大小和 SHA-256；开发准备及
打包复用 `scripts/shared/artifacts.cjs` 的校验缓存。精确 Python、上游 release、SQLite
及平台路径以该清单为准；`scripts/shared/python.cjs` 验证归档与实际解释器身份。

默认 `pnpm ops pre install python` 将同一原包解至 Git 忽略的
`.python/<sha256>/`，作为 `.venv` 的基解释器；
`pnpm ops pre doctor --scope interpreter` 核对实际版本和来源。更换环境前必须停止
使用它的进程并取得现有写租约，不能热改运行中的对话环境。

## 当前候选

本升级分支冻结 **3.14.10 标准 GIL**、上游 release **20261026**，官方 GitHub 原包已逐字节镜像至
`oss://deep-rd/scholarseed-vendor/vendor/python-build-standalone/`。三个清单 URL 均在匿名完整下载、
核对冻结字节大小和 SHA-256 后切至 OSS。修改清单不表示已完成所有原生平台验收或获准发布。
内部库的 `requires-python >=3.12` 兼容承诺与产品自带版本分别维护。

| 平台 | triple | 归档 |
| --- | --- | --- |
| macOS arm64 | aarch64-apple-darwin | cpython-3.14.10+20261026-aarch64-apple-darwin-install_only.tar.gz |
| macOS x86_64 | x86_64-apple-darwin | cpython-3.14.10+20261026-x86_64-apple-darwin-install_only.tar.gz |
| Windows x86_64 | x86_64-pc-windows-msvc | cpython-3.14.10+20261026-x86_64-pc-windows-msvc-install_only.tar.gz |

每个 triple 只选择一个精确原包。缺失、损坏或身份不符须明确失败，不回退系统 Python。
新增目标须同时登记清单和 Desktop `target.cjs` 安装器策略。

## 更新原包

```bash
cd scripts/vendor/python-build-standalone
SERIES=3.14
TRIPLE=aarch64-apple-darwin
REL=20261026
ASSET="cpython-3.14.10+${REL}-${TRIPLE}-install_only.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${REL}/${ASSET/+/%2B}"
curl -fL --retry 3 "$URL" -o "$ASSET"
stat -f%z "$ASSET"
shasum -a 256 "$ASSET"
```

核验实际 SQLite 与解释器后更新清单。本地候选可使用经过验证的官方 HTTPS URL；
若发布需要 vendor 镜像，须另外获准上传，并匿名读回逐字节校验后才修改 URL，不能
指向尚不存在的镜像。三平台分别做原生验收，最终应用仍核对实际引擎。

`fetch-vendor.sh` 仅为旧 macOS 上游获取辅助；正常开发和打包通过清单及
`scripts/shared/artifacts.cjs`，不把旧脚本视为新的来源或权限。
