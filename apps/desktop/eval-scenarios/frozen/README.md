# Frozen input provenance

Repository splitting changes Git ancestry. Historical `sourceCommit` values remain
the original upstream identities, not promises that private source history is
available in this public repository.

Snapshots with `sourceArchive: "inputs"` retain the exact reviewed source bytes
under that directory, at their original relative paths. Every file is checked
against the existing SHA-256 in `sourceFiles`; manifest hashes, source revision,
case revisions, platform coverage and check denominators remain unchanged.
These archives record inputs only, never runtime authorization or evaluation success.

## 冻结输入来源

仓库拆分会改变 Git 历史；`sourceCommit` 保留原仓库身份，不表示公开仓可访问内部历史。
带有 `sourceArchive: "inputs"` 的快照保存原路径及原始字节，逐文件校验原有 SHA-256。
清单摘要、来源版本、用例版本、平台覆盖与检查分母保持不变。归档仅证明输入来源，
不授予运行权限，也不表示评测通过。
