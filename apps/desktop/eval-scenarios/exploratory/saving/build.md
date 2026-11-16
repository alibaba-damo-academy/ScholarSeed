# 文档保存需求构建依据

## 空内容输入：saving/10

`examples/projects/empty-document/project.json` 登记零字节合成 Markdown，文件 SHA-256 为 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`；共享 `resolveExample({ projectId: 'empty-document' })` 与 `readExampleFile` 读回 0 字节，清单内容摘要为 `b81e053914ee778f32c743f2b5ac0fd812a869b244bb135ba72788d69e380501`。它仅补 SAVE-OBS-006 的原始输入，不创建产品资源或预置保存结果；实际路径、隔离副本、编辑与保存终态仍须分别准备和验证，导入按人工确认。需求版本、采用范围和历史冻结不变。

## 需求与运行进度分离：saving/9

移除需求正文中笼统的历史“全部未实测”状态，运行进度与各轮结果以场景索引及运行记录为准；不改变稳定 ID、需求版本、采用范围、专项边界或历史冻结。

## 共享输入链接修正：saving/8

资料链接改为字节一致的共享 `examples`；原副本及来源提交见[资料构建依据](../resources/build.md)。仅修正引用，不改变需求、判据或历史结果。

## 202611121823 有界复核：saving/7

依据2026-10-30 用户统一采用规则和下方 saving/3 的已确认范围，SAVE-OBS-001–003 的项目 Markdown/Monaco 正常资格与保存、005 已绑定项目的覆盖/放弃/托管副本、006 有路径空内容文件正常编辑保存继续作为本目标的有界专项依据。004 失败恢复、005 异常终态及非 project 来源、006 无路径未命名入口仍待确认；不以正常分支批准异常，也不缩减原判据。已读记录未见上述正常子范围被明确退役或更改；未穷举全部需求变更史，不声称源码与目标包同源或产品已通过。

只读制品来源：macOS arm64 `0.3.2 / 202611121823 / preview`，ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。包内 `applicationRenderer` 的 packaged 分支指向 Resources/renderer；实际 `index-CerFLdm1.js`（SHA-256 `f31b1e723f5783fd0690bb323e2af2b144e2eee87241114767ca2855f17b2b27`）约24805、25208行可定位保存能力和焦点保存接线，`workbench-2GTFONdR.js`（SHA-256 `6a196e487c19c2f51803fce7223ef37768d7e46ab85a361e90c6dce3e98aa1c6`）约4848、7978–7989行可定位修订条件及保存会话处理。这些是包内实现线索，不证明入口可达、写入成功或已确认异常要求。

本页整体仍为写入专项：须分别取得可丢弃隔离副本、实际项目/路径及摘要、编辑保存与相关偏好/覆盖/放弃授权，并以真实同路径重新读取验证终态；导入测试由人工确认。失败/冲突不得靠预置结果或内部派发制造；其他 Viewer 与来源、外部修改及无路径文档仍留缺口。原 ID、v`0.3`、判据和历史冻结均不变。

## 共享示例输入对齐：saving/6

本修订仅将现行保存专项的两份原始输入指向 `examples/projects/evaluation` 的 `overview` 与 `detail`；2026-11-12 核对共享原件与原资料样本的 SHA-256 分别均为 `252d2a97beb5f1b8b786a961fbd12964e70d150700acb92a46d1a3ffa0f8b814` 和 `5ac03866d59c97942f7c2e1ff82441aa7e72abb1d437859d0952634122e67a11`。旧副本和下方记录保留历史溯源。执行须获准使用可丢弃隔离副本，并以本轮准备收据核项目身份、实际路径和原始摘要；数据准备不证明导入或保存成功，导入测试由人工确认，编辑保存及偏好、覆盖或放弃等写入须分别获准。原稳定 ID、需求版本、判据及历史结果不变；目标包适用性和专项前提仍需独立核实。

## 当前参考图修订：saving/5

`reference-20261112.png` 为 2026-11-12 macOS arm64 安装版 0.3.2 / 202611121104 / preview 隔离实例原图 `attempt-supplement/evidence/resources-notes.png` 的未改动副本，SHA-256 `1a90e0bc5d239fae1881f3882314684453b0572ba8a1774cfe43f5a588c438f2`；只提供编辑器上下文，未展示保存、失败或冲突终态。原始运行在 `tmp/test_snapshot/desktop/release-20261112-fresh/`；保存专项判据和授权不变。

## 历史修订：202610301343包内静态复核

资产修订：`saving/4`；本次只补指定新包来源、输入/独立参照与快评边界。原稳定ID、v`0.3`、采用规则、完整正文、参考图原版本/日期及历史结果保留；以下旧来源与修订记录均属历史，不代表本包绑定或本轮执行结论。

目标：macOS arm64 `0.3.0 / 202610301343 / preview`；ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。来源为本任务已提取的实际安装包与松散renderer payload；源码提交未知，当前checkout/remote HEAD仅可辅助定位，不声明同源。证据清单为忽略目录 `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`，包内定位均相对该根`package/`；不将临时提取目录当正式跨工作树资产。

包内`out/main/index.js` SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`：1338的applicationRenderer在packaged时取applicationResources下renderer，41203的无开发URL分支交给serveAssets。该链绑定本次分析的实际松散payload，不证明运行时未设置开发覆盖，也不把静态入口当产品观察。

- `renderer/assets/index-CddcCmKt.js`：SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`。
- `renderer/assets/AccountMenuPanel-CHQ1thBC.js`：SHA256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。
- `renderer/assets/MarkdownDocument-vxerKaIo.js`：SHA256 `f372fc42e0501afd5d2b071225341db7833cb64a64e32ea7bbe422232b822952`。
- `renderer/assets/MonacoDocument-D4UmyngX.js`：SHA256 `5036a2bf2f27aea00dbdbb88046a85a85db31c33ca910955e5c7b336bddafbf2`。

包内workspace:1755/1766加载公开open/content；3302起的编辑与保存控制受capabilities约束，4293保存前检查dirty/can_save；Markdown:2179/2235按lightweightText、can_edit及preview限制编辑。保存UI存在不证明实际写盘，SAVE-OBS-002仍要求同项目/路径重新读取已知改动；并发修订、失败与冲突不能由脏点清除证明。仅补新包前端来源，不把旧后端逐文件比对沿用成新包绑定，服务端写入/失败终态须专项另核。本页仍整体写入专项，无默认保存成功链；不因其它页只读资格观察将002–006纳入默认快评。

需求正文中的样本指仓库原件的获准隔离副本；执行前登记原件摘要→任务项目ID/导入后实际路径的映射，历史`eval-*-20261030`只是旧运行别名，不假定新安装中存在。项目/资源、列偏好及API最小投影尚需本轮获准独立取证；静态相容不证明正常UI已可达或实测通过。本次未启动、连接或操作产品，未读用户状态/凭据，未调用外部API；不改变运行状态，不缩减未就绪专项。

## 历史构建与分层记录


修订：saving/3。依据2026-10-30用户统一采用规则，以已绑定安装版v0.3.0 / 202610281438 / preview的已核实正常行为作为v`0.3`需求依据；复用现有源码、精确产物绑定及独立Review。SAVE-OBS-001–003的项目Markdown/Monaco正常资格与保存、005已绑定的项目覆盖/放弃/托管副本操作流程、006有路径空内容文件正常编辑保存已采用；全部仍属未授权执行的写入专项，未实测。004失败反馈/恢复、005异常终态及非project适用性、006无路径未命名保存，以及并发编辑/不确定失败等边界保持待确认，不由正常采用一并批准。

修订2的来源与Viewer边界保留；本修订仅变更采用状态，六个ID、判据和需求版本不变。关闭保护唯一判据复用[多标签008](../tabs/requirements.md)的适用部分，未确认异常不因引用批准；不加入默认只读快评，不扩产品、偏好、编辑、覆盖或放弃权限。

## 精确产物身份

本轮目标为已安装macOS 0.3.0 / 202610281438 / preview。只读重核`/Applications/ScholarSeed.app/Contents/Resources/app.asar` SHA256为`1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`。ASAR `out/main/index.js:41021–41028`的`serveAssets`链在packaged分支使用`applicationResources(app)/renderer`；不是因旁置文件存在就假定被加载。

| Contents/Resources/renderer/assets下文件 | 重核SHA256 |
| --- | --- |
| index-C4-PYlXk.js（下文index） | `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57` |
| AccountMenuPanel-CZYu9yKi.js（下文workspace chunk） | `fe2d49b09ad2f7d3134775d006fd077653559d4476c7a7a6c1d90c09dd99aa00` |
| MarkdownDocument-DOJpEUB5.js | `6a720de9eb90695518e9dc986420d92a8ea0dd7b0242108fd55d529e74f39ebd` |
| MonacoDocument-DuLjuy1W.js | `3f34b35eb42d3fa38ec4ad3e8015995922f1072605d4d5acab71a83c5c6e9dfe` |

index:64396/64399显式动态导入上述Markdown/Monaco chunks。本次只绑定所读函数与文件，不声称整仓同源。以下后端Owner逐文件比较仓库与安装包`Contents/Resources/backend/python/lib/python3.12/site-packages/`，两边SHA256一致：

| 相对apps/serve及site-packages的路径 | SHA256 |
| --- | --- |
| service/workbench/api/routes.py | `7a6ea90eea38c3a750c4b96eab3818000f65d1f35fd946b79f66862305348727` |
| service/resources/service/history.py | `2c87b921440a4b037a0f7fc25be181f1747db6b280f57e1e9afc35a7952616c5` |
| service/resources/service/observe.py | `fb16a3f62c14956eabe86a92483ba78982886bf9fe430aa1c843611898673dc9` |
| service/content/service/port.py | `e04f6b582e536458136328f4f2a09bdeedac18982b2f6c037843d6ec670b20e0` |

## 逐项源码恢复

| 条目与分类 | 当前源码、打包定位与判读边界 |
| --- | --- |
| 001 条件 | [api.ts](../../../src/renderer/src/features/workbench/api.ts):385加载project公开open投影，workspace chunk:1739；不是由扩展名独自决定能力。[routes.py](../../../../serve/service/workbench/api/routes.py):156–212按内容/大小/注册Viewer及snapshot.writable裁决can_edit/can_save。[workspace.ts](../../../src/renderer/src/features/workbench/workspace.ts):1306的restrictEditing还可在运行中关闭能力。MarkdownDocument.tsx:1862的preview或无can_edit为只读，MonacoDocument.tsx:编辑器创建处约319同样检查视图与能力；[Dock](../../../src/renderer/src/features/workbench/Dock.tsx):277及index:63837附近控制保存显示/禁用，Monaco chunk:47988为源码视图保存入口。公开能力不是实际UI已可达的证明 |
| 002 动态/条件 | workspace.ts:2388的save串行化同session请求，:2444的commitSession执行prepare/beforeSave/serialize，只有commit成功且changeVersion未再变化才clean；workspace chunk:4232/4277。api.ts:519的commitDocument对project发送PUT content与If-Match，412为conflict，成功仍需ETag；chunk:1854。MarkdownDocument.tsx:864/1225对应Markdown chunk:1392/1710，保存前收集视觉编辑并按偏好格式化/编码；MonacoDocument.tsx:474/491对应Monaco chunk:47683，轻量模型的序列化delegate与普通updateText路径不同。格式化失败有警告而不等于磁盘写失败，格式化与写盘结果分开核 |
| 003 动态/条件 | [preferences.ts](../../../src/preferences.ts):185默认autoSave=true，:573清洗非法值后回退默认，workspace chunk:351/548。[store](../../../src/renderer/src/store.tsx):830/1875/2422初始化、提交和更新该偏好，index:8671/9236/9717。[Preferences](../../../src/renderer/src/components/business/Preferences.tsx):274及index:74452有开关；[AccountPanel](../../../src/renderer/src/components/business/AccountPanel.tsx):1352/5169及index:78497为文件设置组合。Dock.tsx:736/767及index:64228/64255将偏好交workspace，并在文档区外focusin/pointerdown/window blur调用saveFocused；被保留选择的目标不触发。未恢复出“普通切标签必保存”或固定延时保存依据，不能把开关解释成每次输入立即落盘。Markdown最后引用关闭的特殊先保存路径仍归tabs008 |
| 004 条件 | workspace.ts:2477–2524在序列化失败、覆盖前读取失败或commit失败时保持当前编辑并标error/conflict；index DocumentToolbar对应Dock.tsx:244显示saving/externalChange/saveFailed。Monaco自己的toolbar不保证同样展示文字，真实反馈覆盖待观察。api.ts成功无ETag也判失败，网络异常也可能晚于落盘；故错误提示不是“磁盘未变”的独立证据。序列化抛异常等未完整捕获路径保留待验证，不把当前异常实现写成正确规范 |
| 005 条件 | Dock.tsx:429及index:63978附近提供overwrite/discard/copy；workspace.ts:1741/1756/1763与chunk:3704/3717/3723分别读取最新版本后CAS保存、重载磁盘、序列化当前内存创建托管副本。api.ts:573的createManagedCopy仅project可用，非project冲突可能显示按钮但返回unavailable，属可达性/反馈缺口，不能要求所有文档都支持另存。副本成功后重载原目标并打开新路径，不是给原目标任意改名 |
| 006 固定结构/条件 | [shell Workspace](../../../src/renderer/src/shell/Workspace.tsx):431调用newProjectTab，[tabs](../../../src/renderer/src/features/workbench/tabs.ts):276、workspace chunk:4829产生kind=new_tab的工作台标签，未生成DocumentSession或文件路径。[ResourcePanel](../../../src/renderer/src/features/resources/ResourcePanel.tsx):626说明新建后只定位树节点；[resources api](../../../src/renderer/src/features/resources/api.ts):1162经node mutation新建真实资源，不等于未命名内存文档。后续可用获准空内容合成文件正常导入/打开验证保存，但不能推断“空白新标签→另存文件”已实现 |

以上行号定位供源码恢复，不是执行脚本；实际入口和可见反馈须由后续授权产品观察核实。设计读取以[DESIGN](../../../DESIGN.md)及[vibe](../../../docs/design/vibe-coding.md)为约束，内部编辑器滚动与保存/冲突操作须可达，不将源码布局或门禁当视觉验收。

## 后端写入与独立终态参照

[routes.py](../../../../serve/service/workbench/api/routes.py):340的workbench_commit要求二进制Content-Type和If-Match，将payload交[history.py](../../../../serve/service/resources/service/history.py):576的commit_working，automatic_version=true；超限或Git管理目标走content.commit_bytes，其余走产品版本写入流程。保存成功不等于所有来源都生成相同的历史版本，本页不扩成版本管理全流程。

history.py:820附近通过Content apply_bytes比较expected_revision/target_revision、完成working mutation，再读最终snapshot；[port.py](../../../../serve/service/content/service/port.py):1342/1390的commit_bytes/_replace_stream持有文件系统写入：安全解析父目录、同文件锁、内容revision比较、受限暂存、flush/fsync、发布前再比较、身份替换与失败清理。权限、冲突、写入及超限等错误由routes.py:错误映射转成HTTP；前端412单独显示conflict。该链路不能替代真实OS故障与内容验证。

另存沿routes.py:374的managed-copy要求Idempotency-Key，交[observe.py](../../../../serve/service/resources/service/observe.py):847的create_managed_copy，从资源根及destination决定新路径、检查大小与版本准入，创建独立托管资源。需核实际返回的新project/path/revision以及重新打开内容，不把按钮点击或任意另存标题当成功。

可独立参照为同一获准合成目标的GET `/api/workbench/open?project=…&path=…`顶层project_id/path/asset_id/revision/viewer/content_kind/capabilities，及GET `/api/workbench/content`重新取得的字节与ETag。以事前已知原内容、真实编辑记录和获准格式化预期比较；冲突先独立记磁盘B与内存A，处理后分别核原路径与新路径。不得通过内部store、controller或预先PUT生成被测结果；页面已有认证会话可用时沿公开读接口，不抽取Token。

偏好独立参照沿[main/preferences.ts](../../../src/main/preferences.ts):18/37/67的实际storage.userData下renderer-preferences.json，由Owner加载/提交；只对获准隔离profile投影autoSave及必要formatOnSave，不读真实用户完整偏好，不拿启动快照冒充操作后的已持久化值。未开启自动保存也不保证其它操作零写入；每次保存都须按实际触发条件与目标确认。

## 数据、副作用与缺口

可复用未导入的[overview.md](../../../../../examples/projects/evaluation/files/overview.md)、[detail.txt](../../../../../examples/projects/evaluation/files/notes/detail.txt)、[summary.md](../../../../../examples/projects/evaluation/files/notes/summary.md)、[appendix.md](../../../../../examples/projects/evaluation/files/notes/methods/appendix.md)。只从获准隔离副本开始，不改仓库原样本或将其当已存在产品资源；本轮不新增保存完成夹具。

尚需获准项目/资源副本、有路径的隔离空内容文档、两个独立已知版本与编辑标记、真实失败及恢复前提、外部修改来源。偏好开关与保存时格式化需预先记录并分别授权变更；覆盖、放弃、另存和全部保存应明确目标范围。真实失败/冲突不得靠假provider、内部dispatch或改变生产代码制造；没有安全故障前提则保留专项未完成。

正常打开可更新MRU/导航，编辑、自动保存与手动保存会改文件及适用版本元数据；另存会新增资源/版本并打开文档，偏好切换会落盘。自动保存开启时点击文档区外可能已经写入，后续Driver需先核已有脏态与授权目标，不能把导航归类为绝对无写入。

未明条件包括真实文件设置导航层级、各Viewer的错误反馈、非project冲突另存的UI适用性、无路径未命名文档保存、保存中并发编辑与不确定失败的真实终态。文献附件/会话产物写入虽在前端commit路由联合类型中，但其后端Owner未在本轮绑定，不外推该专项已覆盖它们；产品行为尚无实测、无参考图，不造图或机器三件套。条件不足不删项，关闭矩阵仍由tabs008持有。
