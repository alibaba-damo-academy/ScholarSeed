# Serve 工作约定

本目录拥有 `scholarseed` distribution 与 `service` namespace。先读
[README.md](README.md) 和仓库根 [AGENTS.md](../../AGENTS.md)。

- `bootstrap.py` 是产品组合根；跨域协议与进程级服务放在 `service/platform/`，由组合根注入，不能使用跨应用实例的可变全局单例。
- Runtime、Adapter、Trace 保持独立发行边界；产品路径与认证、持久化、HTTP/SSE 属于 Serve。
- 后台任务的生命周期必须覆盖真实执行与收尾；请求返回、客户端断开或协程取消均不证明线程、外部进程或供应商任务结束。
- 契约测试位于 `tests/`，新增套件登记 `tests/run_all.py`；确定性契约不替代真实 Desktop 产品验收。
- 修改产品行为后运行受影响契约与实际产品路径；未完成全域覆盖的维护/排空能力不得作为安全重启许可。
