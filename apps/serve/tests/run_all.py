"""Research 全套**契约**回归门 — 任一套非 0 即整体失败 (严格 gate)。

测试分层 (审查 #6):
- 本文件 = contract 层: 确定性、不烧 token、CI 每次跑 — **只证明机制自洽**,
  不得作为产品验收依据;
- acceptance_all = 真实产品链路 (真 LLM/真命令/真落盘, 烧 token):
  .venv/bin/python -m tests.acceptance_all

跑法: .venv/bin/python -m tests.run_all
(integration_serve 烧端口起真 serve, 默认含; --fast 跳过; --jobs N 调并发, 默认 min(8, CPU))

并发模型: 每套件是独立子进程 (各用自己的临时 workspace/DB), subprocess.run 等待期释放
GIL, 故线程池即可打满多核。串行 ~245s → 8 路 ~62s (实测 4/8/12 路全绿, 结果与串行一致)。

但「无共享可变态」只对纯 Python 套件成立: 少数套件会起**真的 codex CLI**, 它们共享同一个
二进制与这台机器的进程容量。实测 `codex login status` 的耗时随并发上升 (并发 1 约 0.7s,
并发 8 最慢 3.68s, 并发 16 最慢 10.79s), 会撞上 DamoAgent 侧 10s 的预检上限并被判成失败。
这类套件列在 RUNTIME_BINARY_EXCLUSIVE 里, 与并发批分开、逐个串行跑。
开关: --fast 跳过慢套件; --jobs N 调并发; --no-runtime-binary 整批跳过需要 runtime
二进制在 PATH 上的套件 (CI runner 用; 真产品验收仍要在有二进制的环境跑全集)。
"""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from service import brand

# 开源布局: tests/ 在 apps/serve/ 下, 仓库根再上两级。
SERVE_ROOT = Path(__file__).resolve().parents[1]
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
RUNTIME_SOURCE_ROOT = REPOSITORY_ROOT / "packages" / "runtime"
# serve 域契约套件的模块前缀。目录名按方案叫 `tests`, 与仓库根 `tests` 同名;
# 两者靠 _child_environment() 按归属切换 PYTHONPATH 隔开, 而不是靠改名避开。
SERVE_SUITE_PREFIX = "tests."
PYTHONPATH_ENV = "PYTHONPATH"
PYTHON_SAFE_PATH_ENV = "PYTHONSAFEPATH"

#: 单套件墙钟上限。这不是性能阈值而是**挂死兜底**: 全量 --fast 实测 ~2.5 分钟,
#: 最慢的单套件 (起真 serve 的 integration_serve) 在分钟量级, 留一个数量级余量,
#: 只在真的永不返回时才会触发, 不会误杀慢机器上的正常套件。
SUITE_TIMEOUT_SECONDS = 600

#: 超时套件的退码 (沿用 GNU timeout 约定, 与套件自身的 1 区分开)。
TIMEOUT_EXIT_CODE = 124

# 门必须与生产跑在同一个项目态目录名下, 否则断言的是 Agent 层默认 `.damoagent`
# 而产品实际落 `.scholarseed` —— “测试与生产不同源”。子进程继承 os.environ, 所以在
# spawn 前落一次即全套件生效; setdefault 语义保留运维/用户的显式覆盖。
#
# 只落项目态目录名, **不碰 SCHOLARSEED_HOME**: 家目录指向用户真实的 ~/.scholarseed 会让确定性
# 门耦合开发机环境数据 (实测过: contract_security_p0 的 /delete 断言会因此翻车)。
# 项目态目录是 per-workspace 的, 各套件用自己的临时 workspace, 因此安全。
os.environ.setdefault(brand.PROJECT_DIRNAME_ENV, brand.PROJECT_DIRNAME)

# legacy research runtime (顶层 work/ + service/research/ + service/platform/events/) 已随
# bc6992e2 "refactor: remove legacy research runtime" 删除。依赖 work.scholar.* /
# service.research.* / ActionActor 的 42 个套件同批移除 —— 门不再挂不可导入的套件。
SUITES = [
    "contract_folder_names",
    "contract_runtime_components",
    "contract_oauth",
    "contract_oauth_bridge",
    "contract_subscriptions",
    "contract_pdf_analysis",
    "contract_figure_stream",
    "contract_pdf_failures",
    "contract_pdf_records",
    "contract_attachment_import",
    "contract_resource_ai",
    "contract_pdf_layout",
    "contract_pdf_materialize",
    "contract_history",
    "contract_recall_status",
    "contract_auth",
    "contract_cors",
    "contract_session_principal",
    "contract_ownership_axis",
    "contract_session_catalog",
    "contract_activation",
    "contract_product_events",
    "contract_resource_terminal",
    "contract_resource_activation",
    "contract_service_lifecycle",
    "contract_session_artifacts",
    "contract_codex_service",
    "contract_codex_watch",
    "contract_completion_bridge",
    "contract_content_source",
    "contract_community_auth",
    "contract_account_trust",
    "contract_auth_policy_switch",
    "contract_skill_credentials",
    "contract_desktop_handoff_local",
    "contract_session_align",
    "contract_product_boundaries",
    "contract_runtime_root",
    "contract_runtime_incidents",
    "contract_trace_evidence",
    "contract_detailed_diagnostics",
    "contract_runtime_transport",
    "contract_desktop_config",
    "contract_renderer_assets",
    "contract_feedback",
    "contract_permission_settings",
    # MVP 0.2 工作台三域: 资料库真实落盘/越界拦截/不永久删除, 文献
    # BIB·RIS 解析与去重, 未实现能力显式 501, 全局搜索跨域命中。
    "contract_workbench_domains",
    "contract_literature_store",
    "contract_literature_import",
    "contract_literature_zotero",
    "contract_literature_search",
    "contract_file_workbench",
    "contract_spreadsheet_processors",
    "contract_model_profiles",
    "contract_model_capabilities",
    "contract_session_model",
    "contract_session_listing",
    "contract_session_workspace",
    "contract_session_workspaces",
    "contract_projects",
    # proposal 47: content 域的项目身份、关联根授权、单一入口三道 guard。
    # 必须是裸名 —— 带点的模块名会被 SERVE_SUITE_PREFIX 那行静默剔除。
    "contract_content_identity",
    "contract_storage",
    "contract_content_authorization",
    "contract_content_boundary",
    "contract_content_events",
    "contract_content_migration",
    # 深度是 UI 的分页, 不是可见性上限: 截断必须可辨, 深层必须可续扫。
    "contract_content_tree",
    "contract_web_import",
    # 项目级业务库: 位置经 ContentPort.resolve 得到、惰性创建、不污染资料树,
    # 且 WAL/外键/事务回滚这些各域不再各写一遍的机制真的生效。
    "contract_project_database",
    # Project-local adaptive WHOLE/CHUNKED resource version CAS and ledger.
    "contract_resource_cas",
    "contract_resource_import",
    "contract_resource_versions",
    "contract_version_management",
    "contract_repository",
    "contract_resource_admission",
    "contract_snapshot_state",
    "contract_resource_evidence",
    "contract_review_boundary",
    "contract_pending_capture",
    "contract_review_batches",
    "contract_version_pair",
    "contract_resource_scan",
    "contract_resource_policy",
    "contract_resource_import_jobs",
    "contract_resource_eligibility",
    "contract_resource_finalization",
    "contract_resource_observation",
    "contract_resource_retention",
    "contract_resource_delivery",
    "contract_resource_recovery",
    "contract_resource_gc_restore_fk",
    "contract_artifact_snapshots",
    "contract_artifact_publications",
    "contract_review_migration",
    "contract_display_cards",
    "contract_resource_bridge",
    "contract_literature_bridge",
    "contract_literature_result",
    "contract_literature_review",
    "contract_fulltext_gate",
    "contract_task_lease",
    "contract_running_history",
    "contract_interrupt_barrier",
    "contract_serve_attachments",
    "contract_workbench_focus",
    "contract_assistant_context",
    "contract_citations",
    "contract_answer_sources",
    "contract_papercard",
    "contract_persistence",
    "contract_assistant_annotations",
    "contract_assistant_resources",
    "contract_resource_excerpts",
    "contract_assistant_turn",
    "contract_assistant_actions",
    "contract_invocation",
    "contract_context_provider",
    "contract_selection_actions",
    "contract_selection_stream",
    "contract_selection_context",
    "contract_selection_convergence",
    "contract_completion_results",
    # proposal 32 agent-id capability service.
    "contract_capabilities",
    "contract_skill_prebundle",
    "contract_skill_packages",
    "contract_skill_distribution",
    "contract_skill_runtime",
    "contract_skill_dependencies",
    "contract_skill_python",
    "contract_skill_admission",
    "contract_skill_install",
    "contract_todo_monitor",
    "contract_plan",
    "tests.contract_scheduler",
    "tests.contract_wake_driver",  # 52 M2 (A3): 主 agent 自主唤醒 driver 机制
    "tests.contract_running_input",  # running cut-in → next compose; workflow terminal wake
    # proposal 37: harness background wait + Bash read-only capability
    "tests.contract_wait_policy",
    "tests.contract_bash_readonly_capability",
    "tests.contract_user_tool_constraints",
    "tests.contract_background_monitor",
    "tests.contract_session_tool_isolation",
    # proposal 01 §6 (R7): FileSessionStorage per-session directory 骨架 + 向后兼容
    "tests.contract_session_layout",
    "tests.contract_session_relocation",
    "tests.contract_tool_runtime_dispatch",
    "tests.contract_glob_visibility",
    # proposal 58: 后台输出增量游标 (G1) + 任务生命周期 hook TaskCreated/TaskCompleted (G3a)
    "tests.contract_bg_incremental_and_hooks",
    "tests.contract_capability_prompt_waiting",
    # proposal 38: CC harness 复刻 (tool-error 契约 / 行为段 scoping / attachment)
    "tests.contract_harness_replication",
    "tests.contract_core_purity",
    "tests.contract_agent_catalog",
    "tests.contract_agent_launch",
    "tests.contract_path_namespace",
    # proposal 54 D0: 分层 core ← work ← sdk; work 不依赖 sdk (环切守卫)
    "tests.contract_work_sdk_direction",
    # proposal 54 R11/R13: sdk from_options (DamoAgentOptions → 单一 AgentConfig)
    "tests.contract_from_options",
    # proposal 56/61: substrate consts 纯度 (固定约定常量 + 公共 Enum, stdlib-only)
    "tests.contract_consts_purity",
    # proposal 68 D1/D2/D6: agent/serve→damoagent/damoagent/surface 重命名 + surface 纯传输中继
    # (零 core/work import; 零 get_capability("research"|"exploration"))
    "tests.contract_surface_layer_boundary",
    "tests.release.contract_package_boundary",
    "tests.release.contract_distribution",
    "tests.contract_surface_context",
    # proposal 57: service 单一边界 (service 业务面 → 仅 damoagent + consts; ext 真端口)
    "contract_service_sdk_only",
    # proposal 57 B1: can_use_tool native 端到端 (claude-agent-sdk parity 头号缺口闭合)
    "tests.contract_can_use_tool",
    # proposal 57 B2: SDK Message 形对齐 + cost 落地 (ThinkingBlock/total_cost_usd/claude alias)
    "tests.contract_message_shapes",
    "tests.contract_backends",  # proposal 57 §3.3/D: 可插拔后端注册表 + 平替性
    "tests.contract_worktree_mode",
    # proposal 59 P0: ProjectState 底座 (branch/HEAD/dirty/state_key) + git init 收口
    "tests.contract_project_state",
    # proposal 59 P1: ProjectStateWatcher 稀疏 checkout/HEAD 信号 (PreTurn, 仅变化时发)
    "tests.contract_state_watcher",
    # proposal 59 P2: LayeredMemory state-aware 召回/裁决 (核心 stale-memory bug 修复)
    "tests.contract_layered_memory",
    # /rewind: shared Git object store + agent-owned file delta
    "tests.contract_checkpointer",
    # proposal 59 P4: LayeredMemory durable⊕overlay 物理分层 + GC (B3)
    "tests.contract_overlay_memory",
    # proposal 59 P6: MemoryGit git-as-memory substrate + gh-aw 护栏 (重立 16, 去孤儿)
    "tests.contract_memory_git",
    "tests.contract_memory_shutdown",
    # work/common memory p09: MemoryProgramImpl/NoOpMemoryProgram 可实例化 (abstract component_id 已实现)
    # + assemble_runtime→build_work_agent 不抛 (回归: first-turn 每轮抽象类实例化崩)
    "tests.contract_memory_program_buildable",
    # work/common memory p09: custom memory_programs loader 扫用户级 + 项目级扩展, 坏扩展不阻断。
    "tests.contract_memory_program_loader",
    # proposal 09 (work/common memory p09): 证据图 12 套件 (支柱一/二/三机制 + Unit 8 接线)。
    # schema/store = 底座; diffuse/mirror/distill/lift/propagate/bridge/recall/attribution = S0-S6
    # 机制; version = 支柱三 blob 锚 (F1 写侧现已 live); wiring = live turn→pipeline 接线证明。
    "tests.contract_memory_graph_schema",
    "tests.contract_memory_graph_store",
    "tests.contract_memory_graph_diffuse",
    "tests.contract_memory_graph_mirror",
    "tests.contract_memory_graph_distill",
    "tests.contract_memory_graph_lift",
    # proposal 09 §8.4/§8.8b: S3 依据边生产接缝 (relate: 账本出处→LiftContext) + justify/uses 溯源
    # + A 类 HEAD 信号 (read_head_commit)。断言 basis 边真落盘且出处可解引用真实账本 source_item_id。
    "tests.contract_memory_graph_relate",
    "tests.contract_memory_graph_propagate",
    "tests.contract_memory_graph_bridge",
    "tests.contract_memory_graph_recall",
    "tests.contract_memory_graph_attribution",
    "tests.contract_memory_graph_version",
    "tests.contract_memory_graph_wiring",
    # proposal 09 Wave-1c: 整理时段维护线 (MergeProposal 消费 / dormant 清扫 / 审计员落盘 /
    # compact+turn_end+session_end 三触发面接线)。
    "tests.contract_memory_graph_maintenance",
    # proposal 01/08/09 Slice T: surface owns CLI/external lifecycle; SDK ext is not a lazy
    # forwarding layer; p09 SideMemoryProgram/pipeline/events/version guards stay wired.
    "tests.contract_surface_memory_architecture",
    # proposal 67/69: system prompt 是 context channel — base persona + 能力分片经通道渲染/透出
    "tests.contract_system_prompt_channel",
    # Product-use help is an on-demand internal context channel, never user memory.
    "tests.contract_product_guide_channel",
    # core context: every work agent inherits a local-clock system channel at each model-call boundary.
    "tests.contract_time_channel",
    # compact trigger policy + post-compact history ledger and compose projection must agree.
    "tests.contract_compaction_context",
    # proposal 06: 推理策略声明面 (Strategy/Trigger/Directive proto + core scheduler; trigger 声明
    # 数据化取代 reminder 硬编码节奏; directive one-shot + ComposeSnapshot.used_directive_refs 追溯)
    "tests.contract_reasoning_directives",
    "tests.contract_reasoning_feedback",
    # proposal 05 task harness: TaskFocusLedger 事实源 + InterruptionRecord/ResumeCue +
    # TodoProjection turn-boundary reconcile (todo 是投影非事实源); Goal 双机制
    # (GoalConditionLoop turn-loop / GoalPersistedRun durable run) + GoalState⊥PlanState 分离
    "tests.contract_task_focus",
    "tests.contract_goal_mode",
    # proposal 03 D1: 异步 reminder (memory 召回 / nudge / 状态信号 / bg 通知) 经 ReminderChannel
    # 在 user-message 边界被 ContextPlane drain 到下一轮 compose (修生产无人 take() 的断线)
    "tests.contract_reminder_drain",
    # proposal 00-vision H1 / 02 §1.9 接线断点修复: constraints producer 快照重放 (System-B 版
    # contract_constraints_channel 补位) / WorkingSetProgram 注册 / attachment runner 进 live
    # turn 路径 / stdio hello small_model 同 serve 口径
    "tests.contract_context_wiring",
    "tests.contract_context_channel_ingest",
    "tests.contract_kernel_history_ingest",
    "tests.contract_output_directive",
    "tests.contract_skill_channel_owner",
    "tests.contract_skill_invocation",
    "tests.contract_shell_command",
    "tests.contract_grep_backend",
    "tests.contract_workflow_mode",
    # proposal 69: System-A StandingStore 投影桥 / recall-worker 测试已随 StandingStore 删除移除
    # (contract_context_channel_projection / contract_recall_worker)。System-B 等价 =
    # ContextPlane surface/drain + Constraints/MemoryProgram (constraints 已由
    # contract_context_wiring 覆盖)。
    "tests.contract_codex_alignment",
    # proposal 66 W1+W3: suspension 挂起原语 + hook 执行边 CC 对齐 (exit-code/并行/去重/超时/permission_mode)
    "tests.contract_suspension_hooks",
    "tests.contract_toolsearch_deferred",
    "tests.contract_mcp_client",
    "tests.contract_lsp_tool",
    "tests.integration.contract_provider_config",
    "tests.contract_openai_reasoning_content",
    # proposal 69: 新栈架构守卫 + hard-flip 就绪门 (harness 能力 + research 面 + 入口切换)
    "tests.contract_proposal69_arch",
    "tests.contract_newstack_readiness",
    # proposal 07: evolve 控制面对象链 + 授权链 (触发声明式评估/节奏闸/聚合 + 七档 apply mode gate)
    "tests.contract_evolve_triggers",
    "tests.contract_evolve_controller",
    # 注: 账号管理后台 (account/) 属企业控制面, 不在开源仓库内, 其契约套件随之移出。
    # (带点模块名原样注册; runner 按 sys.executable -m <module> 执行)
    # 三套件均跑真 PostgreSQL (存储层只有 PG 一个实现), 跑前需 `npm run pg-up`。
    # 管理员短信找回口令：手机号绑定（验码自证归属）+ 未登录凭码重置。
    # 重点是四条安全边界：目的隔离（终端用户的 reset 码不得提权重置管理员口令）、
    # 免鉴权发码端点不泄露「哪些号是管理员」、手机号库层唯一、重置即清锁 + 全端下线。
    # 管理员手机号登录：手机号+口令 / 手机号+验证码 两条入口。重点是 admin_login 码与
    # 终端用户 login 码、绑定码、找回码四者互不通用（否则同号用户的登录码可换管理台
    # 会话），以及验证码登录不计入账号锁定。
    # proposal 39: 存储层并发原子性（邀请码不超发 / 锁闸不被突发超额 / 幂等写）
    # proposal 40: 库层不变量与数据寿命（枚举 CHECK / 设备收敛 / 复合外键 / prune 边界）
    # proposal 41: API Key 长期凭据（一次性明文 / 机器面解析 / 失败恒定形状 / 凭据不互串）
    # 双 token 续期：轮转 / 重放检测整族吊销 / typ 隔离 / 吊销传导 / 失败恒定形状
    # 交互式 API 文档不得默认挂在公网（/openapi.json 曾被扫为 Swagger 信息泄漏）
    # 网关控制面反代：管理台「网关」区经账号服务同源转发（鉴权收口 / 字节透传 / 降级形态）
    # 口令 KDF 并发闸：免鉴权口令面的 PBKDF2 是 CPU 放大面，过载必须降级成 429 而不是把
    # 服务拖到探针翻脸。同时钉住三条不得回归的边界：闸不波及鉴权面与 /healthz、闸满时
    # 「号码存在/不存在」不可区分、/healthz 必须是 async 路由（同步 def 会重新排线程池）。
    "tests.e2e_workflow_gates",
]

# The generic runtime/SDK suites above now live in the DamoAgent repository and are run by
# that repository's own gate. Keep this runner scoped to ScholarSeed-owned service and business-work
# contracts. The explicit list also makes accidental ownership drift visible in review.
PRODUCT_ROOT_SUITES = (
    "tests.release.contract_lint",
    "tests.release.contract_dependencies",
    "tests.contract_codex_adapter",
    "tests.contract_failure_codes",
    "tests.contract_codex_isolation",
    "tests.contract_artifact_directives",
    "tests.contract_runtime_driver",
    "tests.contract_runtime_suspension",
    "tests.contract_codex_activity",
    "tests.contract_codex_suspension",
    "tests.contract_codex_admission",
    "tests.contract_codex_capacity",
    "tests.contract_runtime_gateway",
    "tests.release.contract_distribution",
    "tests.release.contract_package_boundary",
)
SUITES = [suite for suite in SUITES if not suite.startswith(SERVE_SUITE_PREFIX)]
SUITES.extend(PRODUCT_ROOT_SUITES)
SLOW = ["integration_serve"]

# 会起**真 runtime app-server** 的套件: 与并发批分开, 逐个串行跑。
# 入选依据是实测调用次数 (在 PATH 上放 runtime 打点脚本, 逐套件统计):
#   contract_skill_install  8 次 app-server (共 24 次 runtime 调用)
#   contract_capabilities   6 次 app-server (共 18 次)
#   integration_serve       2 次 app-server (共 20 次)
# contract_auth only probes readiness without starting app-server.
# contract_community_auth uses identity routes and rejects invalid CLI input before startup.
#
# 这也是「需要 runtime 二进制在 PATH 上」的套件集合 —— CI runner 上没有该二进制
# 时用 --no-runtime-binary 整批跳过, 新增同类套件只需动这一处数据。
RUNTIME_BINARY_EXCLUSIVE = frozenset(
    {
        "contract_skill_install",
        "contract_capabilities",
        "integration_serve",
        "tests.contract_codex_isolation",
    }
)


def _parse_jobs(argv: list[str]) -> int:
    """从 --jobs N / --jobs=N 取并发度; 缺省 min(8, CPU)。

    上限 8: 实测本机 10 核下 jobs=8 已接近最优 (~62s), jobs=12 反而因超配变慢。
    """
    for index, arg in enumerate(argv):
        raw = ""
        if arg == "--jobs" and index + 1 < len(argv):
            raw = argv[index + 1]
        elif arg.startswith("--jobs="):
            raw = arg.split("=", 1)[1]
        if raw:
            try:
                return max(1, int(raw))
            except ValueError:
                pass
    return min(8, os.cpu_count() or 4)


def _child_environment(*, product_root: bool) -> dict[str, str]:
    """子进程环境: 按套件归属只放它自己的根, 两个同名 ``tests`` 包互不可见。

    开源布局下有两个 ``tests`` 包 —— ``apps/serve/tests``(serve 域契约) 与仓库根
    ``tests``(跨包 integration/acceptance/release gate)。若把两个根同时放进
    PYTHONPATH, Python 只会解析到先命中的那一个, 另一批套件就会静默 import 错包。
    因此这里按归属二选一: 跨包套件只看仓库根, serve 套件只看 serve 包根。
    """

    env = os.environ.copy()
    owner_root = REPOSITORY_ROOT if product_root else SERVE_ROOT
    source_path = os.pathsep.join((str(RUNTIME_SOURCE_ROOT), str(owner_root)))
    inherited = env.get(PYTHONPATH_ENV, "")
    env[PYTHONPATH_ENV] = os.pathsep.join((source_path, inherited)) if inherited else source_path
    env[PYTHON_SAFE_PATH_ENV] = "1"
    # Each child owns runtime state even if a test forgets its own home override.
    isolated_home = Path(tempfile.mkdtemp(prefix="scholarseed-contract-home-"))
    env[brand.HOME_ENV] = str(isolated_home)
    env[brand.TRACE_HOME_ENV] = str(isolated_home)
    env[brand.TRACE_LEDGER_ROOT_ENV] = str(isolated_home / brand.PROJECTS_DIRNAME)
    env[brand.CODEX_HOME_ENV] = str(isolated_home / brand.CODEX_DIRNAME)
    return env


def _run_suite(suite: str) -> tuple[str, int, str, str]:
    """跑单套契约 (独立子进程); 返回 (套件名, 退码, 末行摘要, 失败时的输出尾部)。

    带点的名字 (如 ``tests.contract_distribution``) 是仓库根的跨包套件, 原样执行;
    裸名是 serve 域套件, 补上 ``tests.`` 前缀并在 serve 包根下解析。

    超时是**门必须自己有**的兜底: 套件里任何一个无超时的 ``await`` 撞上回归就会
    永不返回, 而没有这道闸时整个门禁跟着无限期静默挂住 —— 实测有三组门禁进程
    这样存活了十天, 既不报错也不退出。挂死必须表现成一条 FAIL。

    子进程独立成组 + 超时杀组: 套件可能起真 serve / runtime app-server 这类孙进程,
    只杀直接子进程会把它们留成孤儿, 继续占端口与句柄。
    """

    product_root = "." in suite
    mod = suite if product_root else f"{SERVE_SUITE_PREFIX}{suite}"
    proc = subprocess.Popen(  # pylint: disable=consider-using-with
        [sys.executable, "-P", "-m", mod],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=_child_environment(product_root=product_root),
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=SUITE_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            proc.kill()
        stdout, stderr = proc.communicate()
        summary = f"超时 {SUITE_TIMEOUT_SECONDS}s 未结束, 已杀进程组"
        return suite, TIMEOUT_EXIT_CODE, summary, f"{summary}\n{stdout[-2000:]}{stderr[-2000:]}"
    tail = (stdout or stderr).strip().splitlines()[-1:] or ["(no output)"]
    return suite, proc.returncode, tail[0], stdout[-2000:] + stderr[-2000:]


def main() -> int:
    fast = "--fast" in sys.argv
    # CI runner 上没有 runtime 二进制 (codex 等), 起真 app-server 的套件必然失败。
    # 这不是“跳过不过的测试”而是分层: 无二进制环境跑约束层, 真产品验收另跑。
    no_runtime_binary = "--no-runtime-binary" in sys.argv
    jobs = _parse_jobs(sys.argv)
    planned = SUITES + ([] if fast else SLOW)
    if no_runtime_binary:
        planned = [suite for suite in planned if suite not in RUNTIME_BINARY_EXCLUSIVE]
    failed: list[str] = []
    err_output: dict[str, str] = {}

    def record(result: tuple[str, int, str, str]) -> None:
        suite, returncode, tail, err = result
        print(f"[{'OK ' if returncode == 0 else 'FAIL'}] {suite}: {tail}", flush=True)
        if returncode != 0:
            failed.append(suite)
            err_output[suite] = err

    exclusive = [suite for suite in planned if suite in RUNTIME_BINARY_EXCLUSIVE]
    concurrent = [suite for suite in planned if suite not in RUNTIME_BINARY_EXCLUSIVE]
    # 并发批: 纯 Python 子进程之间确实无共享态。按完成顺序流式打印, 失败列表最后按
    # planned 顺序回放。起真 codex app-server 的套件不在这里 —— 它们抢同一个二进制与
    # 机器的进程容量, 并发会把 codex 预检拖过超时上限。
    with ThreadPoolExecutor(max_workers=jobs) as pool:
        futures = {pool.submit(_run_suite, suite): suite for suite in concurrent}
        for future in as_completed(futures):
            record(future.result())
    for suite in exclusive:
        record(_run_suite(suite))
    if failed:
        failed.sort(key=planned.index)
        for suite in failed:
            sys.stderr.write(err_output[suite])
        print(f"\nREGRESSION FAILED: {failed}")
        return 1
    print("\nALL GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
