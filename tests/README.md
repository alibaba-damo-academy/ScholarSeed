# core/tests — 端到端测试

每个 `e2e_*.py` 都是独立可执行入口, 不走 pytest, 直接 `python -m` 跑。

## 一览

| 文件 | 验什么 | 依赖 |
|---|---|---|
| `e2e_backend.py` | ToolBackend (Local/Docker) + 6 工具 parity | Local: 无<br>Docker: colima/docker daemon + 一个 image |
| `e2e_opensandbox.py` | OpenSandboxBackend + 6 工具 parity | `opensandbox-server` 在 localhost 跑 + sandbox image |
| `e2e_agent.py` | AgentCore 真 LLM 多轮 turn loop + tool dispatch | `~/.scholarseed/config.json` (anthropic provider) |

## 运行

```bash
# Local backend
.venv/bin/python -m core.tests.e2e_backend local

# Docker backend (需要 colima 起着 / Docker Desktop)
export DOCKER_HOST=unix:///Users/humoro/.colima/default/docker.sock
.venv/bin/python -m core.tests.e2e_backend docker --image yum.tbsite.net/mirrors/python:3.12-slim

# OpenSandbox backend (需要 opensandbox-server 跑着, 见 vendor/OPENSANDBOX_QUICKSTART.md)
OPEN_SANDBOX_DOMAIN=127.0.0.1:8080 \
  .venv/bin/python -m core.tests.e2e_opensandbox --image yum.tbsite.net/mirrors/python:3.12-slim

# AgentCore live (真 LLM, 烧 token)
.venv/bin/python -m core.tests.e2e_agent
```

## 命名约定

- `e2e_*.py` — 端到端 / 集成测试, 跑真实外部依赖. 每个文件 main() 入口, 不被 pytest 收集
- `test_*.py` — (未来) 单元测试, 走 pytest, 不依赖外部服务
