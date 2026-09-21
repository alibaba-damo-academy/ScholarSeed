#!/usr/bin/env bash
# format.sh — Python 代码格式化 (isort + black; 全部规则配置在 pyproject.toml)
#
# 用法:
#   ./scripts/format.sh                # 原地格式化默认路径
#   ./scripts/format.sh --check        # 只检查不改动 (CI; 有未格式化代码则非零退出)
#   ./scripts/format.sh PATH [PATH...] # 只格式化/检查指定路径
#   VENV=/abs/.venv ./scripts/format.sh    # 覆盖 venv 位置 (默认 .venv)
#
# 默认路径覆盖 workspace Python 源码、scripts 与 tests。
# 这是 `npm run fmt` / `npm run fmt-check` 背后的唯一实现 (单一来源, 无并行复制)。
set -euo pipefail

# 仓库根 = 本脚本目录的上一级 (无论从哪里调用都正确定位)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

usage() { sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# ── 解析参数: --check 切换模式, 其余作为待处理路径 ──
CHECK=0
PATHS=()
for arg in "$@"; do
  case "$arg" in
    --check|-c) CHECK=1 ;;
    -h|--help)  usage; exit 0 ;;
    -*)         echo "ERROR: 未知选项 $arg (见 --help)" >&2; exit 2 ;;
    *)          PATHS+=("$arg") ;;
  esac
done

# 默认路径 (开源布局: 产品后端在 apps/serve/service, 跨包门禁在 tests/);
# 仅保留实际存在的, 避免 black/isort 报缺路径。
# 注: apps/serve/service/capabilities/skills 是 prebundle 生成物, 由
# check_import_position.py 的 SKIP_ROOTS 与 pyproject 的 black/isort extend-exclude 排除。
if [ ${#PATHS[@]} -eq 0 ]; then
  for p in apps/serve/service apps/serve/tests packages/runtime/scholarseed_runtime packages/damoatrace/damoatrace packages/adapters/codex/scholarseed_codex tests scripts; do
    [ -e "$p" ] && PATHS+=("$p")
  done
fi
[ ${#PATHS[@]} -gt 0 ] || { echo "ERROR: 没有可格式化的路径" >&2; exit 1; }

# ── 定位 python: 优先 .venv, 否则系统 python3 ──
VENV="${VENV:-.venv}"
PY="$VENV/bin/python"
if [ ! -x "$PY" ]; then
  echo "==> $PY 不存在, 回退系统 python3 (建议先 npm run install:python)" >&2
  PY="$(command -v python3 || true)"
  [ -n "$PY" ] || { echo "ERROR: 找不到 python 解释器" >&2; exit 1; }
fi

# ── 确保 isort + black 可用 (dev extra); 缺则按 uv.lock 同步一次 ──
# 使用统一安装入口，保留 desktop 依赖组和指定的隔离环境。
if ! "$PY" -m isort --version >/dev/null 2>&1 || ! "$PY" -m black --version >/dev/null 2>&1; then
  echo "==> isort/black 未安装, 按 uv.lock 同步 dev 依赖 (uv sync)"
  VENV="$VENV" UV="${UV:-uv}" PYTHON="$PY" npm run install:python
  PY="$VENV/bin/python"
fi

# ── 执行 ──
# import 位置守卫 (E402: 模块级 import 必须在文件头; 不能自动搬运, 故只检查) —— 两种模式都跑
import_check() {
  echo "==> import 位置检查 (E402: 模块级 import 必须在文件头)"
  "$PY" "$SCRIPT_DIR/check_import_position.py" "${PATHS[@]}"
}

if [ "$CHECK" -eq 1 ]; then
  echo "==> isort --check-only ${PATHS[*]}"
  "$PY" -m isort --check-only --diff "${PATHS[@]}"
  echo "==> black --check ${PATHS[*]}"
  "$PY" -m black --check --diff "${PATHS[@]}"
  import_check
  echo "✓ 格式检查通过 (无需改动)"
else
  echo "==> isort ${PATHS[*]}"
  "$PY" -m isort "${PATHS[@]}"
  echo "==> black ${PATHS[*]}"
  "$PY" -m black "${PATHS[@]}"
  import_check
  echo "✓ 格式化完成"
fi
