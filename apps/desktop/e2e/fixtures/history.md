# Desktop cold recovery fixture / Desktop 冷恢复夹具

The generator creates one synthetic session with 400 turns, 50 stored events per turn, and a readable local Markdown source. The setup pass uses the built Desktop to skip the welcome screens, open the synthetic task, and persist the last location. No model or sign-in is required.

默认生成 400 轮、每轮 50 条事件及可打开的本地 Markdown 来源。初始化流程由真实 Desktop 跳过首次引导、打开合成任务并保存最后位置，无需配置模型或登录。

Run from the checkout root on macOS. The example uses the Python and Codex binaries shipped with the installed app, plus the checkout's built Electron Desktop.

在 macOS 从仓库根执行。示例使用已安装应用随附的 Python、Codex 与当前源码构建的 Electron Desktop。

```bash
case_dir=$(mktemp -d /private/tmp/ss-history.XXXXXX)
app_resources=/Applications/ScholarSeed.app/Contents/Resources
fixture_python="$app_resources/backend/python/bin/python3"
desktop_dir="$PWD/apps/desktop"
fixture_electron="$desktop_dir/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

"$fixture_python" -I -B apps/desktop/e2e/fixtures/history.py "$case_dir"
pnpm --dir apps/desktop exec electron-vite build

run_history() {
  node apps/desktop/e2e/history.mjs --source "$PWD" --desktop "$desktop_dir" \
    --electron "$fixture_electron" --python "$fixture_python" \
    --codex "$app_resources/backend/codex-runtime/bin/codex" \
    --fixture "$case_dir/history.json" --revision "$(git rev-parse HEAD)" "$@"
}

run_history --prepare --output "$PWD/tmp/$(basename "$case_dir")-prepare"
run_history --check-old-sources --max-sources-before-heartbeat 20 \
  --output "$PWD/tmp/$(basename "$case_dir")-run"
"$fixture_python" -I -B apps/desktop/e2e/fixtures/history.py --verify "$case_dir/history.json"
```

The runner copies the isolated home, profile, and Codex directories. Keep the workspace at the location where the generator created it because the product catalogs persist physical workspace paths. Use a new generation for a different workspace. `--verify` reads the catalogs and checks the workspace contents. The run requires a first heartbeat and complete renderer observations. It fails if the renderer sends more than 20 source requests before that heartbeat. For a short smoke run, generate at least eight turns with `--turns 8 --events-per-turn 8`.

跑测时复制独立的 home、profile 和 Codex 目录。产品登记库保存 workspace 的物理路径，需要保留生成时的位置。如需更换 workspace，请重新生成。`--verify` 只读核对登记库和工作内容。验收要求观测到首个心跳并完整记录渲染器请求。若渲染器在首心跳前发出超过 20 个来源请求，验收失败。轻量烟测可用 `--turns 8 --events-per-turn 8`。
