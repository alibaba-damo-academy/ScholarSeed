<a id="模型表单预置接收方登记"></a>
# Preset Model Form Recipient Registry

[`providers.py`](../service/chat/service/providers.py) is the execution source of truth for preset IDs, complete addresses, protocols, and form hints. The table below registers preset recipient hosts only, for development review and validation by [`contract_model_profiles.py`](../tests/contract_model_profiles.py); it is not a runtime allowlist or default outbound-network list, and it does not authorize custom endpoints on the user's behalf. New presets must be registered here in sync and reviewed for data, credential, and protocol boundaries; credentials must not be inferred from hosts in the table.

| Form preset | Registered host |
| --- | --- |
| Alibaba Cloud Bailian | `dashscope.aliyuncs.com` |
| Bailian Token Plan Personal / Team | `token-plan.cn-beijing.maas.aliyuncs.com` |
| OpenAI | `api.openai.com` |
| Google Gemini OpenAI-compatible surface | `generativelanguage.googleapis.com` |
| DeepSeek | `api.deepseek.com` |
| Moonshot | `api.moonshot.cn` |
| Zhipu GLM | `open.bigmodel.cn` |
| OpenRouter | `openrouter.ai` |
| Local Ollama / vLLM form hint | `127.0.0.1` |

These are form hints for hosts that may be requested only after the user actively selects them, provides credentials, and enables the connection. The loopback address is also registered so existing contracts can cover every preset, but it does not count as an external network dependency. The contract checks only that host text is present; it does not prove that the registry is complete or accurate, that an actual request is authorized, or that runtime has no other outbound network access.
