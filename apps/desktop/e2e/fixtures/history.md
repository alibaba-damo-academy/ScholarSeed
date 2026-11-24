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

## Profile 100,000 events / 10 万事件桌面基准

Use the binaries and `run_history` function above with a new fixture on a free loopback port. The two cold runs independently copy the same prepared profile. This measures a real click on the newest answer’s source button and checks the oldest answer’s source list after scrolling back.

沿用上文的可执行文件与 `run_history` 函数，在空闲的回环端口生成新样本。两次冷启动分别复制同一份已预选会话的配置，首屏显示后点击最新回答的来源按钮，随后回滚并打开最早回答的来源列表。

```bash
case_dir=$(mktemp -d /private/tmp/ss-history-100k.XXXXXX)
"$fixture_python" -I -B apps/desktop/e2e/fixtures/history.py "$case_dir" \
  --turns 400 --events-per-turn 250 --port 18941
run_history --prepare --output "$case_dir/prepare-run"
run_history --profile-history --rounds 2 --check-old-sources \
  --max-sources-before-heartbeat 20 --output "$case_dir/cold-runs"
```

The cold profile requires one history request before the transcript becomes visible, with a decoded response, a projection, and a React commit recorded under the `startup_resume` caller.

冷启动分析要求正文可见前只发出一次历史请求，并记录 `startup_resume` 对应的响应解码、历史投影和 React 提交。

Each round’s `summary.json` reports the native `Response.json()` read-and-decode time for each history caller, the synchronous `projectHistorySnapshot` duration, and the interval from projection end to the matching Stream layout effect in the React commit. That interval includes scheduling and render work. The runner records the first visible tail answer independently, then measures from the trusted click timestamp to the first frame observing the visible source entry. It captures the screen after closing the source panel. The oldest source request is matched to the DEBUG Serve log by its response ID. The summary gives offsets from the start of scrolling to the first message row, browser request, Serve ingress and headers, browser headers, click and visible source panel. `bodyVisibleMs` records when the runner confirms the first message row of the target turn intersects the viewport. In this fixture that row is the question. To time the first visible text of the answer, observe the rendered answer text separately. Process RSS is sampled approximately every 250 ms from Desktop launch to the end of the scroll-back check. The renderer peak is the largest concurrent sum across renderer children of this Electron instance. The report also gives per-process peaks and the Serve and renderer peaks through the first click response.

每轮的 `summary.json` 按历史调用方给出原生 `Response.json()` 读取与解码耗时、`projectHistorySnapshot` 同步耗时，以及投影结束到对应聊天视图 React 提交阶段布局回调的间隔。该间隔包含调度和渲染时间。末轮回答首次可见单独记录。点击响应从真实点击事件时间戳算到首次观测到来源条目可见的动画帧，来源弹层收起后保存截图。最早一轮的来源请求依靠响应 ID 关联 Serve 的 DEBUG 日志，报告给出从开始滚动至首条消息出现、浏览器发起请求、Serve 入站及发出响应头、浏览器收到响应头、真实点击及来源面板可见各时点的偏移。`bodyVisibleMs` 记录脚本确认目标轮次的首条消息已进入视口的时间。在这份样本中，首条消息是提问。要测量回答正文首次可见的时间，需单独观察渲染后的回答文字。从 Desktop 启动到旧来源校验结束，约每 250 毫秒采样进程 RSS。渲染器峰值取同一时刻该 Electron 实例所有渲染器子进程的 RSS 之和。报告也列出各进程峰值及截至首次点击响应时的 Serve 与渲染器峰值。

## Reading Serve stall samples / 解读 Serve 停顿取样

In the Serve DEBUG log, group `loop_stall`, `loop_stall_sample` and `loop_recovered` by `loop_stall_id`. The watchdog captures the event-loop thread at detection and can sample again after 2, 10 and 30 seconds of lag. A repeated stack refers to the earlier `sample_index` via `stack_sample_index`. The recovery record reports the sample count, distinct stacks and longest unobserved interval within this stall (`watchdog_max_gap_ms`). A long gap can occur when the whole process is paused. Its cause needs independent evidence.

在 Serve 的 DEBUG 日志中，按 `loop_stall_id` 对照上述三类记录。看门狗在发现停顿时采集事件循环线程栈，延迟跨过 2、10、30 秒时还可再次采样。重复的栈通过 `stack_sample_index` 指向先前样本。恢复记录汇总样本数、不同栈数，以及本次停顿内最长的观测空窗 `watchdog_max_gap_ms`。整个进程暂停时也可能出现长空窗，原因需结合其他证据判断。
