# Developer Documentation

**English** · [中文](README_zh.md)

This directory contains documentation and offline pages for developers extending ScholarSeed.
Repository architecture, ownership, engineering decisions, and maintenance runbooks live in
[`docs/`](../docs/index.md); they are not a second copy of this developer guide.

- [Plugin guide](plugins.md) · [Offline page](plugins.html)
- [Plugin APIs](plugins/api.md)
- [Plugin testing](plugins/testing.md)

From the repository root, regenerate and verify both language variants with the development Python:

```sh
python developer-docs/plugins/build.py
python developer-docs/plugins/build.py --check
python developer-docs/plugins/test.py
```

The guide and its local assets can be read without an internal service or a running product backend.
