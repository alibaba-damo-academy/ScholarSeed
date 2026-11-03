# Third-party notices and corresponding source / 第三方声明与对应源码

本目录随 ScholarSeed 源码及 Desktop 安装包分发，覆盖 certifi、tqdm、lightningcss、Pillow、pypdf 和 pycparser。
项目自有代码的 Apache-2.0 不替代这些组件的许可。构建依赖 lightningcss 也包含在内。

Office 图片兼容使用 emf-converter 4.20.3（Apache-2.0）、UTIF 3.1.0（MIT）及
pako 1.0.11（MIT / Zlib）。[emf-converter 随附第三方声明](emf-converter/THIRD_PARTY_NOTICES.txt)
按原文分发，包含其内联图片解码器和依赖的版权、许可及相关说明；不以主包 Apache-2.0
替代这些条款。精确源码提交归档、制品与声明摘要记录在 manifest.json。
本目录不是全产品 SBOM，不代表未列出的组件已完成许可审查。

This directory accompanies the source distribution and Desktop packages. Third-party
components retain their own licenses; ScholarSeed's Apache-2.0 license does not
replace them. Build-only use is not a reason to remove lightningcss from this notice.
This is a scoped notice, not a complete product license clearance.

## Components and source / 组件与源码

| 组件 / Component | 许可 / License | 用途 / Use | 原始声明 / Notice | 源码 / Source |
| --- | --- | --- | --- | --- |
| certifi 2026.10.19 | MPL-2.0 | 运行依赖 / runtime dependency | [许可原文](certifi.txt) | [固定版本源码归档](https://files.pythonhosted.org/packages/a6/bd/1436c50cc46699de0230fbaacc1d1de7bfec413176099949e9d5112e88f2/certifi-2026.10.19.tar.gz) |
| tqdm 4.68.4 | MPL-2.0 AND MIT | 运行依赖 / runtime dependency | [许可原文](tqdm.txt) | [固定版本源码归档](https://files.pythonhosted.org/packages/ae/5f/57ff8b434839e70dab45601284ea413e947a63799891b7553e5960a793a8/tqdm-4.68.4.tar.gz) |
| pypdf 6.15.0 | BSD-3-Clause | 运行依赖 / runtime dependency | [许可原文](pypdf.txt) | [固定版本源码归档](https://files.pythonhosted.org/packages/17/17/ee75a92718ec7212de831e71454d702225aa5e474a805cce169806044453/pypdf-6.15.0.tar.gz) |
| pycparser 3.0 | BSD-3-Clause | 运行依赖 / runtime dependency | [许可原文](pycparser.txt) | [固定版本源码归档](https://files.pythonhosted.org/packages/1b/7d/92392ff7815c21062bea51aa7b87d45576f649f16458d78b7cf94b9ab2e6/pycparser-3.0.tar.gz) |
| pillow 12.3.0 | MIT-CMU | 运行依赖 / runtime dependency | [许可原文](pillow-darwin-arm64.txt) | [固定版本源码归档](https://files.pythonhosted.org/packages/1c/3d/bb7fca845737cf9d7dbde16ed1843984665ff2e0a518f5db43e77ec540b9/pillow-12.3.0.tar.gz) |
| lightningcss 1.32.0 | MPL-2.0 | 构建依赖 / build dependency | [许可原文](lightningcss.txt) | [固定版本源码归档](https://codeload.github.com/parcel-bundler/lightningcss/tar.gz/7f8a861bdee476fe90c89a8badeb3fd33a99c51a) |
| docx-preview 0.4.1 | Apache-2.0 | DOCX preview | [许可原文](docx-preview.txt) | [固定版本源码](https://codeload.github.com/VolodymyrBaydalka/docxjs/tar.gz/c533f383069008d4a1e05c6171ef8777fd078385) |
| ExcelJS 4.4.0 | MIT | XLSX preview | [许可原文](exceljs.txt) | [固定版本源码](https://codeload.github.com/exceljs/exceljs/tar.gz/ac96f9a61e9799c7776bd940f05c4a51d7200209) |
| @aiden0z/pptx-renderer 1.3.0 | Apache-2.0 | PPTX preview | [许可原文](pptx-renderer.txt) | [固定版本源码](https://codeload.github.com/aiden0z/pptx-renderer/tar.gz/0cf5c194b4db2cf9f2531b6a7e24a61338caabf1) |

PPTX renderer 的发布 bundle 内含 **mtx-decompressor 1.4.2**，适用 MPL-2.0；
与 npm 另行解析的包版本区分。保留上游的[第三方声明](pptx-renderer/THIRD_PARTY_NOTICES.md)、
[完整 MPL 文本](pptx-renderer/licenses/mtx-decompressor-MPL-2.0.txt)和
[对应源码归档](https://github.com/ChristopherVR/mtx-decompressor/archive/refs/tags/v1.4.2.tar.gz)。
本项目未修改该组件源文件。另保留机械派生几何定义的
[ECMA 版权声明](pptx-renderer/licenses/ECMA-text-copyright-notice.txt)及来源清单。
上述 Office 组件原始许可仍有效，不因打包而改为产品许可。

Pillow 上表许可文件是 macOS arm64 的完整副本；其他平台及差异见 [Pillow 核验](PILLOW.md)。
pypdf 和 pycparser 的 BSD-3-Clause 原文均保留版权声明、再分发条件和免责声明；
分发安装包时仍保留 Python 环境内原始 `.dist-info/licenses/LICENSE`。
MPL-2.0 全文随 [lightningcss 原始 LICENSE](lightningcss.txt) 提供，同时适用于 certifi
以及 tqdm 中受 MPL 覆盖的部分。tqdm 是 **MPL-2.0 AND MIT**，不是可以任选 MIT 的双许可。

The full MPL-2.0 text is included in lightningcss.txt. It also applies to the
MPL-covered portions of certifi and tqdm. tqdm's MIT notices must be retained as
well; the aggregate expression is AND, not OR.

## Obtain the corresponding source / 获取对应源码

上述公开 HTTPS 链接无需公司账户，分别指向 Python sdist 和 lightningcss 的固定提交归档。
lightningcss 的 npm tarball 主要是 JS 接口，不能代替 Rust 源码；这里的源码链接包含
Rust 源码、Cargo 配置及上游构建材料，提交号取自 npm 发布元数据 gitHead。
源码归档保留原许可，不是将第三方源文件重新许可为 Apache-2.0。

[manifest.json](manifest.json) 给出每个源码归档的完整 SHA-256，以及已核验制品 URL、
制品摘要、原始许可证成员路径、原始成员摘要与随包副本摘要。提取时将 CRLF 换行为 LF，
Office reader 的副本另统一为单个末尾换行（见 noticeNormalization），不改变许可文字；
原始成员仍以上游制品中的字节为准。下载源码后应先核对 SHA-256，再解压。
下载是普通公开获取，无需联系内部仓库管理员；不要以最新分支替代精确版本。

The source links above are public, version- or commit-specific archives. Download
the archive and verify its SHA-256 against manifest.json before extracting it.
For lightningcss, use the Rust source archive rather than the npm wrapper tarball.
For certifi, the source distribution includes the version's certificate data.

本说明对应 manifest 中标识的上游制品。若分发者修改了受 MPL-2.0 覆盖的文件，须按
MPL-2.0 提供实际分发版本（含修改）的对应源码及必要说明；原始上游链接不能代替
修改版源码，并应持续保障接收者能合理、及时获取。若链接失效，应提供相同版本的
公开归档或随包源码。BSD-3-Clause 不要求仅因再分发而公开修改后的源码，但要求
源码或二进制分发时按其条款保留版权声明、许可条件和免责声明。

These links cover the upstream artifacts identified in the manifest. Distributors
of modified MPL-2.0-covered files must provide the corresponding modified source
and preserve applicable notices. Maintain source availability for recipients;
replace unavailable upstream links with an accessible matching archive or bundled
source. BSD-3-Clause does not require publication of modified source merely for
redistribution, but its notices and disclaimer must be retained as specified.

## Pillow acknowledgements / Pillow 随附库署名

Pillow and PIL: Copyright © 1997–2011 Secret Labs AB; Copyright © 1995–2011
Fredrik Lundh and contributors; Copyright © 2010 Jeffrey 'Alex' Clark and contributors.

This product uses the FreeType Project (https://freetype.org/). The FreeType
portions included through Pillow are used under the FreeType License (FTL);
all applicable copyright notices and disclaimers are reproduced in the platform
license files. The FreeType authors provide no warranty for this product.

This software is based in part on the work of the Independent JPEG Group.

This software includes code from XZ Utils (https://tukaani.org/xz/).
The liblzma 5.8.3 [0BSD supplement](xz-0bsd.txt) and the upstream notice
discrepancy are explained in [Pillow review](PILLOW.md).

以上署名不暗示第三方作者或机构为 ScholarSeed 背书。完整平台声明保留其他组件的版权、
许可、免责声明和适用条款，不以摘要代替原文。

## Location / 随包位置

- macOS: `ScholarSeed.app/Contents/Resources/notices/`
- Windows: `<installation directory>/resources/notices/`
- Source tree: `apps/desktop/resources/notices/`

保留原始 Python wheel 中的 `.dist-info/licenses/`；本目录是便于接收者阅读的补充副本，
不是删除原始声明的理由。三份 Pillow 平台声明均随包保留，实际平台对应关系见 manifest。
