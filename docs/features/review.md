# 文献综述工作区与产物边界

修改综述激活、检查点、产物读取或历史工作区兼容时读本页；具体执行流程只有
[产品 Skill](../../skills/community/literature-review/SKILL.md) 一份正文。
本页保留安全约束和兼容理由，不表示全文授权或双平台验收已通过。

## 激活与身份

使用成功任务激活返回的精确相对 `workspace`，不代入阶段目录或绝对路径。
绑定中的实际 Skill 身份和版本由真实工作区绑定提供，不从示例、旧记录或记忆猜测。
普通状态查询和脚本启动不等于当前产品 turn 的租约激活；缺少任务上下文时依原
绑定和受控激活入口恢复，不能伪造元数据或换工作区绕过拒绝。

[综述 API](../../apps/serve/service/literature/api/review.py) 校验 bridge 调用者及
publication turn；检索检查点校验租约类型、workspace 和运行身份。
涉及检查点变化时逐个核对其当前分支，不从检索分支推断全部阶段校验完全相同。
声明了 launcher manifest 的请求还需保持运行身份、manifest 与内容哈希的一致性；
模型工具的正常调用字段遵循 Skill，不因底层兼容字段存在就自行增加参数。

## 根目录兼容和文件读取

新综述使用独立相对目录。历史绑定会话根的综述使用 `workspace="."`，保留原文件，
不为新目录结构自动搬迁用户资产。[文献持久化边界](../../apps/serve/service/literature/persistence/files.py)
的 `scoped_workspace` / `scoped_workspace_path` 仅为这项兼容解释根目录；
它不是允许其他存储接口接受空路径、绝对路径或 `..` 的授权。

产物读取通过 `read_scoped_file` 和[平台存储 Owner](../../apps/serve/service/platform/storage.py)，
限定相对路径、普通文件与读取大小，拒绝链接逃逸。路径预检不能替代打开时的安全边界。

| 边界 | macOS 要求 | Windows 要求 |
| --- | --- | --- |
| 历史与新 workspace | 根兼容和实际激活绑定均正确 | 同左，盘符绝对路径不能作为 workspace |
| 文件打开 | 逐级安全打开，拒绝符号链接逃逸 | 原生句柄拒绝 junction / reparse point，正确转移和释放所有权 |
| 验收 | 根兼容、子目录、错误路径和真实全文授权流程 | 分别提供该平台证据，不由 macOS 结果替代 |

矩阵是安全与验收要求，不是各平台行为已通过的声明；macOS 结果不能替代
Windows 验收，也不降低产品既有 Windows 约束。

## 大纲确认与超时边界

`outline_review=timeout_auto` 使用 300 秒确认期限；`required` 不设置超时，
`auto`、已批准及已应用超时决定的 packet 不再创建确认问题。超时不是用户批准：
实际回复、暂停、修改与取消不能被改写成同意，全文授权仍由独立授权边界处理。

产品内由综述 bridge 与产品交互 Owner 等待，Skill 消费原样 confirmation receipt，
不能并行启动另一套 standalone 计时。当前期限以 HIL 记录的 `created_at` 为起点；
源码先发布卡片不等于已经证明用户屏幕实际显示时刻，不宣称渲染确认计时保证。
回包须保持 packet、snapshot、request 身份及原决定；等待后重新读取 packet，
内容变化拒绝旧决定，失败或取消不能静默转入自动续写。

receipt 由模型转交给 Skill；字段、身份和状态校验不是防篡改签名协议，
也不证明跨模型转交的答复逐字保真。修改转交机制需保留真实决定语义与原始证据，
不能以结构检查通过宣称具备端到端签名、客户端渲染回执或任意重启恢复保证。

独立宿主路径只有在实际展示当前 packet 后才开始等待，同 packet 重读不重置期限。
超时应用在锁内保存稳定决定与通知身份，并以 `timeout_default`、
`user_response: null` 区分真实答复；重复恢复不创建第二次决定或生成任务。
该机制没有给 CLI 安装后台调度器，也不表示进程退出后自动唤醒。
具体回复、通知与续写步骤仍只维护在产品 Skill，不在本页复制命令流程。

修改以上机制时核对 [确认投影](../../apps/serve/service/literature/service/confirmation.py)、
[产品交互](../../apps/serve/service/chat/runtime/interaction.py) 与
[Skill 决定状态](../../skills/community/literature-review/lib/review_timeout.py)。
策略投影单测不证明真实 5 分钟等待、卡片可见、取消、重启恢复或模型续写通过。

## 更新与停止条件

激活、绑定、检查点或安全打开机制变化时，由对应 Skill/Serve/平台 Owner 同步
契约与验证；不在通用 Skill 架构页复制业务流程。找到实际受影响分支后停止扩展阅读。
确定性测试与路径源码检查不证明真实全文授权、模型工具调用或产品产物展示已通过。
