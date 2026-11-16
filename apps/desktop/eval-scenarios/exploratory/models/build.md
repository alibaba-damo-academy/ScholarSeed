# 模型服务基线构建依据

当前资产修订：`models/9`；补充目标版本配置展示图，下文[当前制品复核](#当前制品复核)保留历史包依据，目标契约须实际核实；原业务判据及需求版本不变，模型配置、生效专项仅作候选。

## 目标版本模型配置参考：models/9

模型配置参考图为原始运行文件 `tmp/test_snapshot/desktop/baseline-1823-batch4/dynamic-followup/evidence/model-config.png` 的未裁切、未缩放字节副本，1280 × 840，SHA-256 `cfd2e729f93c59e4ea6c17897fd3d2dddb11dc27511caa8d637bd19440d688e7`。采集于 2026-11-12 20:32:26（UTC+8），`dynamic-followup/index.md` 第 36 项为截图命令；批次计划记录 macOS arm64 `0.3.2 / 202611121823 / preview` 及 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。完整窗口展示内置模型自然配置，名称与偏好随环境变化；不证明参数保存、生效或调用，不代表本轮通过。需求版本、判据及历史结果不变。

## 202611121823 目标版本参考图

`window-20261112-1823.png` 是目标版本真实完整窗口原图的字节一致副本，来源 `tmp/test_snapshot/desktop/baseline-1823-batch4/dynamic-followup/evidence/models.png`，2026-11-12 20:31:49 +0800，SHA-256 `40e7d0aec985ef3bb057772f330d9f675da22ecb34b826f48095bc79eab06f0c`。目标为 macOS arm64 `0.3.2 / 202611121823 / preview`，`app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`；原始运行记录位于本机忽略目录。仅展示未配置厂商的自然状态，不证明连接、配置或调用。参考图不替代本轮执行或判定；本次仅补图，不改变需求版本、判据和历史结果。

## 模型配置与生效候选：`models/6`

从[历史冻结](../../frozen/p2-20261025-539af0794/freeze.json)所记 `sourceCommit` `539af079455cc821b976760728fc13dfedbb8b66` 回查 `apps/desktop/docs/scenarios/catalog.json`（SHA-256 `e4a029cce1e58db658acb2643ea05621f48c288d12209eb0df41f5a4329ec45f`）与 `apps/desktop/eval-scenarios/exploratory/desktop-business/cases/settings.json`（SHA-256 `372aee4969f44a7e9caafc93bdf4d3ee57990a7ada48b7d0db867bf7405e2ff2`）。`MODEL-CONFIG-01@5`、`MODEL-REASONING-01@2`、`MODEL-CONTEXT-01@2` 为 `pending / exploratory`，对应主用例 `D6-SET-001/006/007` 均为 `candidate_unapproved`。历史 `MODEL-CATALOG-01@2` 为 `current / exploratory`，但其只读目录不能证明配置或调用；`D6-SET-003` 也为候选预期。`CHAT-MODEL-SWITCH-01@3` 为 `pending / exploratory`，历史 `cases/conversation.json` 的 `D4-CHAT-009` 为 `candidate_unapproved`。上述历史状态和 `@` 修订不是目标版本需求标记或采用依据，未改变原冻结或历史裁决。

上述 `cases/conversation.json` 的完整历史路径为 `apps/desktop/eval-scenarios/exploratory/desktop-business/cases/conversation.json`，SHA-256 `034378807220ff06781fcd00b0fb55ca35b44dcde4e37d3b9633f4216fc92080`。可使用 `git show 539af079455cc821b976760728fc13dfedbb8b66:<路径>` 回查这些历史文件，不恢复或改写冻结文件。

当前源码基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`：`AccountPanel.tsx`、`Composer.tsx`、`ModelMenu.tsx` 相对该提交无未提交差异，SHA-256 分别为 `478d2820a9400a4859e8e3e7fcf53add8faf0bc6850a86b692242252da9661a9`、`2f181db915be9085572213956854cf3bece80e8ceb9b7a139639d2f13869c236`、`775fa8ad4c878daa8ecd9a35712996e4689ef52b68d2dcf924ae803f2c4474ad`。前者负责服务/模型配置及推理偏好，后两者负责输入区模型选择和回合准备；这些是当前源码定位，不证明与安装包同源或正确需求。上下文值当前源码有 `contextOverrides` 局部状态，旧目标制品复核也曾记录保存行为疑点；候选坚持分别核控件与产品接收状态，不凭实现认定生效。

受控端点、专用凭据、可丢弃隔离配置及真实模型调用/费用尚未获准；现有截图只作展示参考，不证明新增服务、参数保存、下轮模型身份或真实输出。各专项的需求版本、目标 `0.3.2 / 202611121823 / preview` 适用性和真实完成态完整窗口图待核；候选不纳入冒烟或既有评测分母。外部联网、凭据、模型调用和配置写入必须分别授权。

## 202611121823 正常展示沿用

依用户统一采用已核正常行为的记录及本页已采用快评分层，针对 macOS arm64 `0.3.2 / 202611121823 / preview` 有界沿用 MODEL-OBS-001–004 的服务目录、自然详情与模型配置正常展示子点。已核本页既有采用和后续记录，未发现该子范围被确认退役或更改；不证明完整变更史、源码制品同源、目标包入口可达或产品通过。原编号、需求版本、判据和历史裁决不变。

执行前须按目标包实际契约核同一实例的公开厂商、连接、可用/隐藏模型与推理偏好最小安全投影，保留来源与时点；响应缺字段、连接状态变化或独立参照失败时留缺口。禁止输出密钥、令牌或完整认证信息，不新增连接、登录、探测、修改参数或调用模型；配置生效仍属专项。下文旧包路径与回退说明仅是历史线索，须先核目标包而非直接套用。

历史建库说明：修订：models/3（补参考图及目录组合说明，修订1判据不变）。用户本轮采用指定包现有功能；四项自动展示快评，首次纳入v`0.3`，不是连接或配置生效验收。

来源：macOS arm64 0.3.0 / 202610281438 / preview；`app.asar` SHA256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`。安装renderer `assets/index-C4-PYlXk.js`：ModelServicePage第79841行、ModelSettingsPage第80958行、ModelConfigurationPage第81062行、modelDefaultEffort第13866行。有界对照[AccountPanel.tsx](../../../src/renderer/src/components/business/AccountPanel.tsx)及[reasoning.ts](../../../src/renderer/src/reasoning.ts)，不证明全仓映射。

| 要点 | 固定 / 动态 / 条件与来源 |
| --- | --- |
| 001 | preset每项映射已有非OAuth连接，无连接保留一个空行；OAuth连接或一个ChatGPT订阅空行另加，最后追加未知preset的非OAuth连接。启用数仅为profiles中enabled项数，分母为上述全部行数；只读白名单对照，不写死厂商数 |
| 002 | 无连接显示引导；有连接自动选首项，API与OAuth分支不同；禁止为补覆盖选厂商、创建/探测连接或登录 |
| 003 | catalog.models加hiddenModels构成配置表；只核自然目录的模型行，名称/来源对照公开模型字段 |
| 004 | reasoningPreferences采用已保存有效档位，否则modelDefaultEffort按声明默认或最低可用档位回退；内置可见且禁用，自定义按隐藏集合。上下文滑杆是局部contextOverrides，保存仅setSaved，未接持久化；不得把滑杆当实际context_window或将未实现持久化当正确行为 |

安全独立参照：models/model-providers/model-profiles的公开名称、ID、source、能力与启用/认证类型投影，以及profile的reasoningPreferences。禁止保存API key/token或完整认证响应。目录、配置表若存在横纵滚动需采完整结构及必要行。不存在独立“默认模型”控件时不杜撰要求；Composer实际采用、连接授权与配置保存均属后续专项。

参考图为已检查原始PNG的未改动副本，来源版本/日期见正文：reference.png来自model-services.png（SHA256 `2c424ef609f32e6f139df1284aea543f475b2e25a62cf0c4f2c7fba4a532e174`），providers.png来自providers-bottom.png（`f7427ba7628a202fb2976fae08479f4cbe09e9ec7e55c59dcd6106495b5f77c4`），configuration.png来自model-configuration.png（`9a77c5b79a46083194c44956ba197bbfdc86c9efd897f71f65d92d0a78e5299c`），parameters.png来自model-configuration-right.png（`bb39bfaea035d8da98afdaf38d60ccb8d9b2fddd5433f2fd83db9beb457e7c3c`）。原冻结修订1保留，补图和取数说明不重标需求版本或改写裁决。

## 发布快评分层（2026-10-30）

本资产修订为models/3；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为MODEL-OBS-001–004的正文明确子要点；必要参照为当前服务/模型目录与无秘密的配置投影；无选中项按原002自然引导核对。未选范围为新增连接、OAuth/API凭据、连接测试、参数修改保存及模型调用，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。


## 当前制品复核

当前资产修订：`models/4`（2026-10-30）。本次仅增量更新制品定位与独立参照，不改变稳定ID、v`0.3`、完整判据或快评/专项边界；前文包号、旧源码行号、分层修订与结果均是历史记录，不作为本轮包绑定或通过结论。参考图仍保留原来源日期/构建。

本轮来源为已核安装包 `0.3.0 / 202610301343 / preview / macOS arm64`；app.asar SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。直接证据为实际松散发布目录 `renderer/assets/index-CddcCmKt.js`，SHA-256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`；下述编译函数/行号均指此文件，另名文件明确标出。引用的 `out/preload/index.js` SHA-256 `754a7f2fc34f7f1c6ac7f21c256c156f9c3b9dcf88c2c64a20b3d82bcb992219`，`out/main/index.js` SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`；偏好常量所在 `renderer/assets/AccountMenuPanel-CHQ1thBC.js` SHA-256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。源码提交未绑定；前文仓库Owner链接仅为辅助线索，不将checkout/远端HEAD等同本包。

- 固定/动态/条件：`ModelServicePage:81559`、`ModelConfigurationPage:82780`、`ModelSettingsPage:82676` 保留服务/配置结构、preset+profiles的列表组合、自然首项选择及API/OAuth分支；不固定数量。模型配置行来自可用+隐藏集合，builtin 可见且禁用；`ModelReasoningSetting:82544` 用有效 reasoningPreferences[model.key] 或 modelDefaultEffort 回退。
- 独立读取均为同实例 `window.scholarseed.getApiBase()` 加路径、GET、`credentials:'include'`（`apiFetch:1438` / `getJson:1472`）：`/api/serve/model-providers` 顶层 providers；`/api/serve/model-profiles` 顶层 profiles；`/api/serve/models` 顶层 available_models/hidden_models/service_instance_id（不是猜 models 容器）。不加 refresh=true，不用 POST 的 models/probe 来“读取目录”。
- 厂商投影 id/label/base_url/wire_api（地址仅无秘密公开形式）；profiles仅 id/name/preview_name/preset_id/authentication/enabled/has_api_key、必要脱敏地址和 selected_models 的 id/label/推理能力；禁止读出 api_key/token/credentials 或完整 profiles。模型只留 key/label/model_label/provider/provider_label/source/profile_id/model_id、reasoning_efforts/reasoning_options（只取kind/values/default）及必要能力字段；service_instance_id仅用于核当前服务归属，不能混用重启前目录。
- `applyModelCatalog:13735` 只接收 service_instance_id 与当前实例相同的目录，缺字段/不一致记缺参照，不从画面反推行。偏好从 preload.preferences.reasoningPreferences 启动快照按当前模型key投影；之后有修改则需独立当前参照，默认档位按reasoning_options中effort的有效default→最低支持档位→首项回退（modelDefaultEffort:14733）；默认回退不替代读取失败。
- 上下文滑杆仍为局部 contextOverrides，保存按钮仍仅 setSaved(true)，不据此证明容量或持久化。新包 ModelReasoningSetting 还有自定义档位编辑路径；本次不纳入快评、不操作保存，也不以实现自行批准新能力或修复旧疑点。

本次只核提取制品与资产，未启动/连接产品、读取用户状态或发起请求；未产生新运行截图或产品验收结论。后续run仍须在获准实例取得同一时段独立参照；缺少、陈旧或失败参照不能从待判页面自证。
