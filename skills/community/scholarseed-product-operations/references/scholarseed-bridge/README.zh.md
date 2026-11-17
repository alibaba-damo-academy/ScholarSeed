# ScholarSeed Bridge

[English](README.md) · **简体中文**

Bridge 调用前读取；本地执行和原生计划工具不需要本协议。
使用模型工具 scholarseed_bridge，不使用 Shell 可执行程序或直接 HTTP。
外层格式为 `{"capability":"…","operation":"…","request":{…}}`；较大或多行请求
使用会话相对 request_file 代替 request。外层 operation 选端点，内层 request.operation（若有）选变更。

从 [contracts/](contracts/) 中只取顶层 capability、operation 与目标调用都匹配的完整 JSON 记录。
每个 <capability>.jsonl 的一行代表一个操作，不整份读取能力文件，不误匹配内层变更操作。
有 JSON 选择工具时精确选择；否则定位目标记录后完整读取该行，必要时分块读取。
不得截断 Schema、guidance 或 prerequisites；不为选择契约额外安装工具。选择只是本地读取，不是 Bridge 调用。

使用记录中的请求/响应 Schema、指导和前提。同发行版本的随包契约足够，不先调用帮助。
仅当操作缺失、版本可能不一致或宿主报告契约过期时，对目标操作调用 contract/describe：

```json
{"capability":"contract","operation":"describe","request":{"target_capability":"artifact","target_operation":"publish"}}
```

使用真实标识并检查结果。Schema 或发现结果不授予权限、不跳过确认，也不是回执。
不得读取凭据、私有状态、设置文件或数据库来替代产品操作。工具不可用、操作失败或契约未读完时
报告实际缺口，不猜测、不绕过，也不宣称成功。
