# scholarseed — 一键构建 / 配置 / 启动（开源 monorepo）
#
# 仓库布局（开源方案 §2）:
#   apps/desktop/     ScholarSeed Electron 桌面端 (主产品入口)
#   apps/serve/       FastAPI 产品后端与 composition root (import namespace: service.*)
#   packages/         runtime / damoatrace / adapters (各自独立可构建)
#   skills/           随仓库开源的一方技能源码 + registry/lock
#   tests/            跨包 integration / acceptance / release gate
#
# 常用:
#   make all          python deps + ScholarSeed Electron build + 首次配置
#   make install      按 uv.lock 同步 workspace 全部 python 包到 .venv (editable)
#   make dependency-wheels  构建 runtime / damoatrace / adapters wheels
#   make build        构建 apps/desktop Electron 前端
#   make config       交互式写 ~/.scholarseed/config.json
#   make run          启动 ScholarSeed Electron 应用
#   make desktop      桌面 app (专用 launcher: 仓库 Codex + 最新代码 + 后台后端)
#   make desktop-dev  桌面端本地开发测试 (electron-vite dev / vite HMR)
#   make health       --health-check 测 LLM 连通
#   make skills-install  从仓库内 skills/ 预制技能 pack (离线, 不联网)
#   make skills-verify   只读校验技能 pack 与 skills/ 源码一致
#   make trace-ui     打开 trace web UI
#   make install-cmd  装成全局命令 (任何目录跑 scholarseed)
#   make clean        删 .venv / apps/desktop/node_modules / dist
#   make distclean    clean + 清掉 ~/.scholarseed (危险, 丢 session)
#
# 覆盖默认值:
#   make install                       # same Python/SQLite as the Desktop package
#   make install PYTHON=3.12            # non-Desktop library/CI environment only
#   SCHOLARSEED_HOME=/tmp/mw make config

SHELL          := /bin/bash
PYTHON         ?=
VENV           ?= .venv
# uv sync 默认固定装到项目内 `.venv`, 不认 Makefile 的 VENV; 用
# UV_PROJECT_ENVIRONMENT 把覆盖传下去, 否则 `make install VENV=/other` 会装到 .venv
# 而后续 $(PY) 去找 /other/bin/python 报 No such file or directory。
VENV_BIN       := $(VENV)/$(if $(filter Windows_NT,$(OS)),Scripts,bin)
PY             := $(VENV_BIN)/python$(if $(filter Windows_NT,$(OS)),.exe)
UV             ?= uv
export UV
# 把本机 pip 的镜像源转发给 uv。
#
# uv 不读 pip.conf。在只能访问内网镜像的机器上，`uv sync` 会直连 PyPI 超时，
# 而 pip 却是好的 —— 表现为「明明能装包，就 make install 卡住」。这里显式取
# pip 已配的 index-url 并以环境变量形式传给 uv；未配时为空，不影响默认行为。
# 手动覆盖: make install UV_DEFAULT_INDEX=https://mirror.example/simple
UV_DEFAULT_INDEX ?= $(shell command -v pip3 >/dev/null 2>&1 && pip3 config get global.index-url 2>/dev/null)
# 转发前去掉尾斜杠: 环境变量优先级高于 pyproject, 而 uv 把索引 URL 逐字写进 uv.lock 的
# source.registry —— 本机 pip 常配成 .../simple/, 原样转发就把同一镜像变成"另一个索引",
# 表现为 `make install` 的 `uv sync --locked` 报 lock 过期, 手跑 `uv lock` 则重写上百行。
# 与 pyproject 的 [[tool.uv.index]] 取同一种写法(不带尾斜杠)。
UV_DEFAULT_INDEX := $(patsubst %/,%,$(strip $(UV_DEFAULT_INDEX)))
UV_INDEX_ENV   := $(if $(strip $(UV_DEFAULT_INDEX)),UV_DEFAULT_INDEX="$(UV_DEFAULT_INDEX)")
UI_DIR             := apps/desktop
SERVE_PROJECT      := apps/serve
RUNTIME_PROJECT  := packages/runtime
DAMOATRACE_PROJECT := packages/damoatrace
CODEX_ADAPTER_PROJECT := packages/adapters/codex
DSH_ADAPTER_PROJECT   := packages/adapters/dsh
RUNTIME_DIST_DIR := dist/runtime
DAMOATRACE_DIST_DIR := dist/damoatrace
ADAPTERS_DIST_DIR  := dist/adapters
BUN            ?= $(shell command -v bun 2>/dev/null || echo $(HOME)/.bun/bin/bun)
SCHOLARSEED_HOME ?= $(HOME)/.scholarseed
SCHOLARSEED_DEVTOOLS  ?= 1

.PHONY: all install dependency-wheels agent-wheel ui-deps ui-build build desktop-test desktop-e2e-mr desktop-e2e-live ui-find config config-template run desktop desktop-dev health fmt fmt-check lint typecheck check serve serve-dev trace-ui trace-ui-stop install-cmd uninstall-cmd snapshot logs logs-errors clean distclean check-bun check-uv help wiki wiki-check skills-install skills-verify check-symlinks

help:
	@grep -E '^[a-zA-Z_-]+:.*##' $(MAKEFILE_LIST) | sed -E 's/:.*## /	/' || \
	  echo "see Makefile header for targets"

all: install build config ## 一键: python deps + ScholarSeed UI build + 配置 LLM
	@echo
	@echo "✓ scholarseed ready. run: make run"

# ─── python deps ───
# uv 项目模式: `uv.lock` 是唯一事实源, `uv sync` 自建 .venv 并按 lock **精确**同步
# (环境里多出来的包会被剪掉)。改了任何 pyproject 依赖后跑 `uv lock` 并把 uv.lock
# 一起提交。
#
# 五个 workspace 成员都装成 editable; 其中四个本地包要的 editable_mode=compat 由根
# pyproject 的 [tool.uv.config-settings-package] 声明 —— 写在那里而不是命令行上,
# 是因为 uv 会按 [tool.uv.sources] 在解析 scholarseed 依赖时顺带重装 runtime/
# damoatrace, 命令行 flag 挡不住那一步, compat 形态会被静默冲掉。
check-uv:
	@if ! command -v $(UV) >/dev/null 2>&1; then \
	  echo "==> uv not found ($(UV))"; \
	  echo "   install: brew install uv"; \
	  echo "        or: curl -LsSf https://astral.sh/uv/install.sh | sh"; \
	  echo "        or: pip install uv"; \
	  echo "   then restart shell or set UV=/abs/path/to/uv"; \
	  exit 1; \
	fi
	@set -eu; \
	  expected="$$(sed -nE 's/^[[:space:]]*required-version[[:space:]]*=[[:space:]]*">=([0-9]+\.[0-9]+\.[0-9]+)"[[:space:]]*$$/\1/p' pyproject.toml)"; \
	  actual="$$($(UV) --version | awk '{print $$2}')"; \
	  if [ -z "$$expected" ] || [ "$$(printf '%s\n' "$$expected" "$$actual" | sort -V | head -n1)" != "$$expected" ]; then \
	    echo "ERROR: uv $$actual; requires >=$$expected from pyproject.toml." >&2; exit 1; \
	  fi; \
	  $(UV) cache dir >/dev/null

install: check-uv ## 按 uv.lock 同步 workspace 全部 python 包到 .venv (editable)
	@echo "==> uv sync (workspace 全部成员 + serve/dev extras + desktop group)"
	@set -eu; \
	  runtime="$(PYTHON)"; \
	  if [ -z "$$runtime" ]; then node scripts/toolchain.cjs check; runtime="$$(node scripts/python.cjs prepare)"; fi; \
	  $(UV_INDEX_ENV) UV_PROJECT_ENVIRONMENT="$(VENV)" $(UV) sync --locked --all-packages --extra serve --extra dev --group desktop --no-python-downloads --python "$$runtime"; \
	  if [ -z "$(PYTHON)" ]; then node scripts/python.cjs check "$(VENV)"; fi
	@$(MAKE) skills-install

.PHONY: check-python
check-python: ## 校验开发 Python/SQLite 与安装包归档一致
	@node scripts/python.cjs check "$(VENV)"

skills-install: ## 从仓库内 skills/ 离线预制技能 pack (无 Skillhub, 无网络)
	@$(PY) -m service.cli.prebundle --build

skills-verify: ## 只读校验已安装技能 pack 与 skills/ 源码逐字节一致
	@$(PY) -m service.cli.prebundle --verify-source

dependency-wheels: install ## 构建可发布的 runtime / damoatrace / adapters wheels
	@mkdir -p "$(RUNTIME_DIST_DIR)" "$(DAMOATRACE_DIST_DIR)" "$(ADAPTERS_DIST_DIR)"
	@$(PY) scripts/wheel.py --project "$(RUNTIME_PROJECT)" --outdir "$(RUNTIME_DIST_DIR)"
	@$(PY) scripts/wheel.py --project "$(DAMOATRACE_PROJECT)" --outdir "$(DAMOATRACE_DIST_DIR)"
	@$(PY) scripts/wheel.py --project "$(CODEX_ADAPTER_PROJECT)" --outdir "$(ADAPTERS_DIST_DIR)"
	@$(PY) scripts/wheel.py --project "$(DSH_ADAPTER_PROJECT)" --outdir "$(ADAPTERS_DIST_DIR)"

agent-wheel: dependency-wheels ## 兼容旧的本地构建 target

# ─── ScholarSeed Electron UI ───
check-bun:
	@if [ ! -x "$(BUN)" ]; then \
	  echo "==> bun not found at $(BUN)"; \
	  echo "   install: curl -fsSL https://bun.sh/install | bash"; \
	  echo "   then restart shell or set BUN=/abs/path/to/bun"; \
	  exit 1; \
	fi

ui-deps:
	@node scripts/toolchain.cjs ensure

.PHONY: doctor check-toolchain
doctor: ## 输出开发工具链、Python、Electron 与仓库 Codex 的版本和来源
	@VENV="$(VENV)" node scripts/toolchain.cjs doctor

check-toolchain: ## 校验 Node/npm/uv 精确版本
	@node scripts/toolchain.cjs check

ui-build: ui-deps
	@echo "==> npm run build ($(UI_DIR))"
	@cd $(UI_DIR) && npm run build

build: ui-build ## 构建 apps/desktop Electron 前端

desktop-test: ui-deps ## 桌面确定性门禁（含设计系统复用棘轮 scripts/reuse.test.mjs）
	@cd $(UI_DIR) && npm test

desktop-e2e-mr: ui-deps ## 桌面真实启动烟测（隔离 SCHOLARSEED_HOME，不调用真实 LLM）
	@cd $(UI_DIR) && npm run test:e2e:mr

desktop-e2e-live: ui-deps ## 桌面真实 LLM / HIL / 恢复验收（需 SCHOLARSEED_REAL_HOME）
	@cd $(UI_DIR) && npm run test:e2e:live

# ─── 配置 ───
config: ## 交互式写 ~/.scholarseed/config.json (api_key etc)
	@echo "==> scholarseed config setup"
	@SCHOLARSEED_HOME=$(SCHOLARSEED_HOME) $(PY) scripts/setup_config.py

config-template: ## 只生成 config 模板, 不交互
	@SCHOLARSEED_HOME=$(SCHOLARSEED_HOME) $(PY) scripts/setup_config.py --non-interactive

# ─── 启动 ───
run: check-python ui-deps ## 启动 ScholarSeed Electron 应用
	@$(VENV_BIN)/scholarseed

desktop: config-template check-python ui-deps ## 启动 ScholarSeed 桌面 app (仓库固定 Codex 制品)
	@$(PY) -m service.cli.desktop

desktop-dev: config-template check-python ui-deps ## 桌面端本地开发 (仓库固定 Codex; vite HMR)
	@set -eu; \
	  codex="$$(node scripts/toolchain.cjs codex)"; \
	  export SCHOLARSEED_CODEX_EXECUTABLE="$$codex"; \
	  $(PY) -m watchfiles --filter python --target-type command \
	    'scripts/serve-dev.sh $(VENV_BIN)/scholarseed-serve --port $(or $(PORT),8770) $(if $(CASES),--cases-root $(CASES),)' \
	    apps/serve/service packages/runtime/scholarseed_runtime packages/adapters & \
	  backend_pid=$$!; \
	  trap 'kill $$backend_pid 2>/dev/null || true; wait $$backend_pid 2>/dev/null || true' EXIT INT TERM; \
	  SCHOLARSEED_PYTHON="$(abspath $(PY))" SCHOLARSEED_DEVTOOLS=$(SCHOLARSEED_DEVTOOLS) node scripts/toolchain.cjs npm run dev

health: check-python ui-deps ## 通过真实桌面对话验证 Codex runtime 连通
	@$(VENV_BIN)/scholarseed-desktop --say "请只回复 HEALTH_OK"

FMT_PATHS ?= apps/serve/service apps/serve/tests packages/runtime/scholarseed_runtime packages/damoatrace/damoatrace packages/adapters/codex/scholarseed_codex packages/adapters/dsh/scholarseed_dsh scripts tests
fmt: ## isort + black 格式化 (实现在 scripts/format.sh; 配置在 pyproject.toml)
	@VENV=$(VENV) ./scripts/format.sh $(FMT_PATHS)

fmt-check: ## 只检查格式不改动 (CI 用)
	@VENV=$(VENV) ./scripts/format.sh --check $(FMT_PATHS)

LINT_PATHS ?= apps/serve/service packages/adapters scripts
lint: ## Pylint 检查 ScholarSeed 自有 Python 代码
	@$(PY) scripts/lint.py $(LINT_PATHS)

typecheck: ## mypy 检查 ScholarSeed 自有 Python 代码
	@$(PY) -m mypy

check: fmt-check lint typecheck ## 格式、lint 与类型检查

serve: check-python check-toolchain ## 起单机 Agent Serve backend; 默认 :8770 (依赖由 make install 的 serve extra 保证)
	@set -eu; codex="$$(node scripts/toolchain.cjs codex)"; SCHOLARSEED_CODEX_EXECUTABLE="$$codex" $(VENV_BIN)/scholarseed-serve --port $(or $(PORT),8770) $(if $(CASES),--cases-root $(CASES),)

serve-dev: check-python check-toolchain ## 后端开发模式: Python 代码变更后自动重启 serve
	@set -eu; \
	  codex="$$(node scripts/toolchain.cjs codex)"; \
	  export SCHOLARSEED_CODEX_EXECUTABLE="$$codex"; \
	  $(PY) -m watchfiles --filter python \
	    --target-type command \
	    '$(VENV_BIN)/scholarseed-serve --port $(or $(PORT),8770) $(if $(CASES),--cases-root $(CASES),)' \
	    apps/serve/service packages/runtime/scholarseed_runtime packages/adapters

logs: ## tail -f 系统运行日志 (人读, 排查业务报错; LOG=$$SCHOLARSEED_HOME/logs/scholarseed.log)
	@touch "$${SCHOLARSEED_HOME:-$$HOME/.scholarseed}/logs/scholarseed.log" 2>/dev/null || true
	@tail -f "$${SCHOLARSEED_HOME:-$$HOME/.scholarseed}/logs/scholarseed.log"

logs-errors: ## 只看最近的 WARNING/ERROR (快速定位报错)
	@grep -E " (WARNING|ERROR) " "$${SCHOLARSEED_HOME:-$$HOME/.scholarseed}/logs/scholarseed.log" 2>/dev/null | tail -50 || echo "(no log yet)"

trace-ui: ## 启动 / 打开 trace 浏览 UI (本地, idle 自动退出)
	@DAMOATRACE_HOME=$(SCHOLARSEED_HOME) $(VENV_BIN)/damoatrace serve

trace-ui-stop: ## 关掉 trace UI server
	@DAMOATRACE_HOME=$(SCHOLARSEED_HOME) $(PY) -c 'from damoatrace.server.launcher import stop; raise SystemExit(0 if stop() else 1)'


# ─── 把 scholarseed 装成全局命令 ───
# 把 ScholarSeed 产品命令及 trace 工具 symlink 到 PATH 里第一个
# 可写目录 (优先 /opt/homebrew/bin → /usr/local/bin → ~/.local/bin → ~/bin).
# Editable install + symlink 组合: .venv 在原仓库,之后再 make install / make build
# 不需要重做 install-cmd.
SCHOLARSEED_BINS := scholarseed scholarseed-desktop scholarseed-serve damoatrace

install-cmd: install build ## 装成全局命令 (之后任何目录直接跑)
	@DEST=""; \
	for d in /opt/homebrew/bin /usr/local/bin "$$HOME/.local/bin" "$$HOME/bin"; do \
	  if [ -d "$$d" ] && [ -w "$$d" ]; then DEST="$$d"; break; fi; \
	  if [ ! -e "$$d" ] && mkdir -p "$$d" 2>/dev/null; then DEST="$$d"; break; fi; \
	done; \
	if [ -z "$$DEST" ]; then \
	  echo "==> no writable bin dir on PATH; manually symlink each binary:"; \
	  for n in $(SCHOLARSEED_BINS); do echo "    ln -sf $(PWD)/$(VENV_BIN)/$$n /usr/local/bin/$$n"; done; \
	  exit 1; \
	fi; \
	for n in $(SCHOLARSEED_BINS); do \
	  if [ -x "$(PWD)/$(VENV_BIN)/$$n" ]; then \
	    ln -sf "$(PWD)/$(VENV_BIN)/$$n" "$$DEST/$$n"; \
	    echo "    $$n    -> $(PWD)/$(VENV_BIN)/$$n"; \
	  fi; \
	done; \
	echo "==> linked to $$DEST"; \
	case ":$$PATH:" in *":$$DEST:"*) : ;; \
	  *) echo ""; echo "WARNING: $$DEST not on PATH. add to your shell rc:"; \
	     echo "    export PATH=\"$$DEST:\$$PATH\"" ;; \
	esac; \
	echo ""; \
	echo "✓ now run \`scholarseed\` from anywhere."

uninstall-cmd: ## 移除全局命令 symlink
	@for d in /opt/homebrew/bin /usr/local/bin "$$HOME/.local/bin" "$$HOME/bin"; do \
	  for n in $(SCHOLARSEED_BINS) scholarseed-account mowoker mowoker-ui moderwork moderwork-ui; do \
	    if [ -L "$$d/$$n" ]; then rm -v "$$d/$$n"; fi; \
	  done; \
	done

# ─── 清理 ───
clean: ## 删 venv 和 ScholarSeed UI 构建产物
	@echo "==> removing $(VENV), $(UI_DIR)/node_modules, $(UI_DIR)/out"
	@rm -rf $(VENV) $(UI_DIR)/node_modules $(UI_DIR)/out
	@find . -type d -name __pycache__ -prune -exec rm -rf {} +

distclean: clean ## clean + 清掉 ~/.scholarseed (危险, 丢 session)
	@echo "WARNING: this will delete $(SCHOLARSEED_HOME) including sessions/logs/config."
	@read -p "type 'yes' to confirm: " ans && [ "$$ans" = "yes" ] && rm -rf "$(SCHOLARSEED_HOME)" || echo "aborted."
