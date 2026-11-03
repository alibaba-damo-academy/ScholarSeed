# precise 集成测试（不在 run_all 门禁内）

本目录**未注册**进 `apps/serve/tests/run_all.py`，因此不在 CI 门禁内。原因：目录内仍有
既有失败（见下），直接注册会让门禁恒红。要入门禁请先修完这些失败并在
`apps/serve/tests/run_all.py` 登记套件名。

## 手动运行

四段 `PYTHONPATH` 缺一不可（最后一段是本目录；缺了它 `browser_pool_support` 等同目录
模块导入失败，会把本来 OK 的套件误报成 error）：

```bash
SK=skills/community/precise-literature-search
PYTHONPATH="$SK/scripts:$SK/modules/search:$SK/modules/search/tools:tests/integration/precise" \
  python3 -m unittest discover -s tests/integration/precise -p "test_*.py"
```

纯标准库即可，不需要仓库 venv。套件会起真实子进程与浏览器池槽位，全量约 40–60 秒。

## 基线（2026-09-28，`origin/shushen_release/mvp_v0.2_open_source` = `0623d28e2`）

71 tests，5 failures，均为既有失败（2026-09-27 以来多次基线一致，见工单 87299389）：

- `test_paid_pool_integration`：4 例（旧夹具缺少现行运行状态、授权和产品获取失败记录，未进入目标逻辑）
- `test_browser_pool::test_released_slot_with_executor_lock_uses_wait_path`：1 例

## 当前分支复核（2026-09-30，macOS）

付费下载测试改用当前运行状态与授权契约准备夹具后，4 例通过。完整套件在可读取浏览器
进程信息的环境中运行 118 项，仅上述浏览器池等待路径 1 例失败，另有 1 例平台跳过。
受限沙箱若禁止调用 `ps`，浏览器相关用例会额外失败，不能与正常环境结果混同。

## 历史

- `test_environment.py` 于 2026-09-28 删除（工单 87299389）：它测的
  `scripts/environment.py::download_environment()`（白名单 env，避免产品凭据进入
  Chrome / downloader 子进程）随 balance 重构 `d8e07d813` 被移除，测试未同步，成为恒红死测试。
- 上述子进程 env 净化能力**目前不在**技能边界：downloader / Chrome 子进程继承沙箱全量 env。
  现行控制面是沙箱出网与 deny-read（proposal 116 P4）以及 serve 不向沙箱注入桥凭据。
  是否恢复白名单 env 属独立安全加固议题（另开工单决策），本目录暂不承载该断言。
