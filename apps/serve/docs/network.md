# 模型表单预置接收方登记

[`providers.py`](../service/chat/service/providers.py) 是预置 ID、完整地址、协议与表单提示的执行真源。下表仅登记预置接收主机，供开发审查与 [`contract_model_profiles.py`](../tests/contract_model_profiles.py) 校验；不是运行时白名单或默认出网清单，也不替用户授权自定义端点。新增预置须同步登记并复核数据、凭据与协议边界；不得根据表中主机推导凭据。

| 表单预置 | 登记主机 |
| --- | --- |
| 阿里云百炼 | `dashscope.aliyuncs.com` |
| 百炼 Token Plan 个人版 / 团队版 | `token-plan.cn-beijing.maas.aliyuncs.com` |
| OpenAI | `api.openai.com` |
| Google Gemini OpenAI 兼容面 | `generativelanguage.googleapis.com` |
| DeepSeek | `api.deepseek.com` |
| Moonshot | `api.moonshot.cn` |
| 智谱 GLM | `open.bigmodel.cn` |
| OpenRouter | `openrouter.ai` |
| 本地 Ollama / vLLM 表单提示 | `127.0.0.1` |

这些是用户主动选择、提供凭据并启用连接后才可能请求的表单提示。回环地址同样保留登记，便于既有契约覆盖全部预置，但不计为外部网络依赖。契约只检查主机文本存在，不证明登记完整准确、实际请求获授权或运行时没有其他出网。
