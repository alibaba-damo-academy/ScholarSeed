# 问题反馈与操作记录候选构建依据

## 建设状态

资产修订 `feedback/3`。`FEEDBACK-CAND-001/002`、`FEEDBACK-RECORD-CAND-001/002` 与 `FEEDBACK-STEP-NOTE-CAND-001` 是候选定位，均未冻结或纳入评测分母。用户对历史反馈与操作记录交互的确认、当前源码及旧测试只作为可追溯线索；本目标产品需求版本、目标包适用性及采用状态尚待确认。此建设未操作产品、未采集屏幕、未提交外部反馈，也不说明产品通过。

## 步骤说明依据

步骤提交记录与快捷键的用户截图要求成功提交说明绑定提交时的步骤、显示说明入口且可查看，Enter 提交并提示快捷键。失败、输入法和换行的完整语义需进一步核确认，不将源码行为直接作为已采用判据；须真实可区分步骤、内容与独立结果，并核外发授权。

## 合成附件输入：feedback/2

可分别复用 [evaluation 清单](../../../../../examples/projects/evaluation/project.json)的 `image`（`icon.png`，1024×1024、92265 字节，SHA-256 `0830e69b8b3f1203bbefee47649f4de25bd78a4ea9e6ad82591c837e8241d2a2`）及 [image-secondary 清单](../../../../../examples/projects/image-secondary/project.json)的 `secondary-image`（`secondary.png`，256×160、1180 字节，SHA-256 `2f98c21d4db76db99f98fe77623de32046572a13f4ad0e849dc82d106c23ac39`）。两份都是合成原始 PNG，作为可区分的人工附件输入，按各自清单与隔离副本核身份；不得称为产品截图或预置反馈状态。当前 [Feedback.tsx](../../../src/renderer/src/components/business/Feedback.tsx) 接受 PNG 且有单图及总大小限制，两图均小于当前源码所列限制；这仅是格式线索，不证明目标安装包同源或接受成功。

文件选择由人工确认；打开反馈表单可能触发自动截图，反馈草稿、截图采集、诊断内容及外部提交分别核实例、数据范围和授权。只准备输入不代表已操作产品或上传，需求版本、目标包适用及完整窗口图仍待核；本修订不改变采用状态、判据或历史冻结。

## 历史依据与边界

- 反馈图片预览及账户菜单反馈记录历史图片预览、关闭后保留草稿及附件，以及问题反馈入口；历史 macOS 真实验证与模拟结果各自保留，不能外推当前包、完整上传或 Windows。
- 操作记录交互及其后续用户批注记录暂停、截图标注、步骤、说明与检查提交等要求，并明确组件模拟上传不等于真实上传；最终反馈检查弹窗说明复核和失败保留的历史边界。最新入口文案为“记录操作”，旧标题中的“录制”不证明连续视频采集。
- 服务异常反馈记录历史隔离 macOS 真实服务异常反馈及部分诊断边界；历史回执不是本次输入或通过证据。
- 从现有冻结清单和 `sourceCommit` `539af079455cc821b976760728fc13dfedbb8b66` 的历史 catalog 有界检索反馈/操作记录，未恢复可确认对应本页的历史稳定 ID；负检不证明历史需求不存在。故使用候选标识，不覆盖历史条目，后续若找到唯一同义 ID 应先确认映射，不重写原冻结。

## 当前源码与副作用

源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`；以下文件相对此提交的未提交状态须在后续维护时重新核查，源码不是目标安装包同源或用户要求的证明。

- **入口/条件：** [ActivityRail.tsx](../../../src/renderer/src/shell/ActivityRail.tsx) 挂载反馈表单，[Recorder.tsx](../../../src/renderer/src/features/feedback-recorder/Recorder.tsx) 按录制能力、认证与当前阶段选择入口/快捷动作；[Feedback.tsx](../../../src/renderer/src/components/business/Feedback.tsx) 也承载异常恢复入口。历史设计中不同身份分支不能未经目标包核验便当固定预期。
- **自然展示与状态：** `Feedback.tsx` 管理描述、日志/会话诊断选择、自动或手动图片及预览，提交成功进入回执，失败返回编辑；`Recorder.tsx` 管理记录、暂停和检查阶段，[Capture.tsx](../../../src/renderer/src/features/feedback-recorder/Capture.tsx) 与 [Review.tsx](../../../src/renderer/src/features/feedback-recorder/Review.tsx) 展示操作及复核。描述、附件数、阶段与回执均依本轮输入和结果变化，不固化截图中的值。
- **实际副作用：** [store.tsx](../../../src/renderer/src/store.tsx) 的 `openFeedback` 会尝试采集当前窗口截图后再展示表单；`Recorder.tsx` 的开始路径创建记录并尝试采图，记录会收集页面操作，停止进入检查；[api.ts](../../../src/renderer/src/api.ts) 的 `submitFeedback` 将描述、可选图片及诊断交 Desktop bridge，[submission.ts](../../../src/main/submission.ts) 持有实际提交，录制提交也会携带记录报告和诊断。因此导航、自动采图、记录、截图标注及外部提交必须分开核权限和数据范围，不能称为一律只读。
- **本次源码摘要：** `Feedback.tsx` `d1a5e884365e10309e4de2076d68d28b93fc1e50c1f647eca46fd5a1722821ca`；`Recorder.tsx` `ac6e124ad451759e8a972f7f73e2787d605ed61230656fa772b2bce9367ae927`；`Capture.tsx` `938c3e9e4d700ee03ab04305d47872e2aca0b8a3ba74f7da6fb883312d130d29`；`Review.tsx` `795ef8234d5591e4293ddcba06d9b5332dc5059dc82be0bb86af70732e974535`；`ActivityRail.tsx` `b139dc7c17bbcb9677a507bbb03a1faa8df751b2d963451d72170e48fd9546c3`；`store.tsx` `ed81d7a9f13dd0f510ff4b079c267251ac6681341234a8d40615534f69b39342`；`api.ts` `6eaddf9622cd43ab5adebcc9511a4ecce763e1ca7877f5237f60f6cd13fbb2af`；`submission.ts` `0e4c4cc1703da0217a9ffa394690d74cabc579e938471adaf0590c4fd7808b77`。

## 数据、截图与执行交接

目标线索为 macOS arm64 安装版 `0.3.2 / 202611121823 / preview`，历史 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`；本次未核实时实例和目标包同源，后续执行须重核精确制品、实例及能力。`examples` 仅作获准合成附件来源，不预置反馈、截图记录或服务端回执；具体文件需在执行前选定并核身份、类型、摘要及隔离副本。手动导入按用户要求人工确认。

本工作区尚无经核可复用的该目标包反馈表单、操作记录和真实提交回执的完整窗口截图；不得将组件夹具、模拟回执、旧图或真实用户资料充作当前产品图。真实截图及回执、外部提交与诊断权限、账号条件、目标需求版本和适用性均保留缺口。四类评测中仅在用户明确范围和所需权限就绪后交执行 Skill 单独冻结，不因候选建库自动纳入冒烟或声明通过。
