# Codex Adapter

先读 [README.md](README.md) 和仓库根 [AGENTS.md](../../../AGENTS.md)。

- 本包只依赖 Runtime 的公开契约，不引入 Serve 或 Desktop 依赖。
- 保留官方 Codex 可执行文件；更新功能不依赖定制 app-server 接口。
- 持久运行目录准备、认证访问和真实进程启动必须遵守宿主注入的资源租约。
  隔离临时目录中的版本探测不代表持久数据兼容或会话恢复通过。
- 契约测试使用根 `tests/contract_codex_adapter.py`；实际桌面验收另行进行。
