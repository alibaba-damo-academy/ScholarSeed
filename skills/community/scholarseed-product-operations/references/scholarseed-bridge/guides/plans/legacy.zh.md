# 旧版原生计划

[English](legacy.md) · **简体中文**

仅实际声明为 get/write 且要求 request 包装时读取。保留原包装：
get 传 request={}；write 传完整 PlanWrite，含 operation 和 item statuses。
纠错使用返回的 current state、transitions 与 request_schema。真实工作前记录 in_progress，完成后记 complete，
不伪造缺失开始。需对齐未记录工作时发现当前 scholarseed_bridge plan/action 契约并用 reconcile，
不向旧工具加入不支持的参数，不混用新扁平动作或发明别名改变工具。

保持稳定 ID、范围和父关系。被拒绝写入不推进 revision，使用返回状态和允许转换。
只有验证真实工作后才完成，结束前报告未结束、阻塞或失败阶段。宿主拥有计时；
不推断耗时、不用空组、不凭文件存在声称完成。需要 Bridge 对齐时先读[回退](fallback.zh.md)。
