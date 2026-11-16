# 开发者文档

[English](README.md) · **中文**

本目录面向扩展书深能力的开发者，存放开发指南和可离线阅读的页面。
仓库架构、模块归属、工程决策和维护手册仍在 [`docs/`](../docs/index.md)，
不在两个目录重复维护同一份开发指南。

- [插件指南](plugins.zh.md) · [离线页面](plugins.zh.html)
- [插件 API](plugins/api.zh.md)
- [插件测试](plugins/testing.zh.md)

从仓库根目录使用开发环境的 Python 生成并检查中英文页面：

```sh
python developer-docs/plugins/build.py
python developer-docs/plugins/build.py --check
python developer-docs/plugins/test.py
```

指南及本地素材可离线阅读，不依赖内部服务，也不需要启动产品后端。
