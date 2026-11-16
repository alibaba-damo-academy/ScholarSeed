# 数据存储基线构建依据

当前资产修订：`storage/7`；本次澄清目标读取契约须实际核实，下文[当前制品复核](#当前制品复核)保留历史包依据，业务判据及需求版本不变。

## 202611121823 目标版本参考图

`window-20261112-1823.png` 是目标版本真实完整窗口原图的字节一致副本，来源 `tmp/test_snapshot/desktop/baseline-1823-batch4/dynamic-followup/evidence/storage.png`，2026-11-12 20:32:06 +0800，SHA-256 `0198e9f113df2810b13409af0613540ed88d1ff6c79c2d88f53bf2a6ce0b777a`。目标为 macOS arm64 `0.3.2 / 202611121823 / preview`，`app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`；原始运行记录位于本机忽略目录。展示隔离实例的数据根与项目根，含本机用户名及隔离路径；路径为动态值，不证明迁移或修改。参考图不替代本轮执行或判定；本次仅补图，不改变需求版本、判据和历史结果。

## 202611121823 正常展示沿用

依用户统一采用已核正常行为的记录及本页已采用快评分层，针对 macOS arm64 `0.3.2 / 202611121823 / preview` 有界沿用 STORAGE-OBS-001–003 的当前数据根、默认项目位置与生效边界正常展示子点。已核本页既有采用和后续记录，未发现该子范围被确认退役或更改；不证明完整变更史、源码制品同源、目标包入口可达或产品通过。原编号、需求版本、判据和历史裁决不变。

执行前按目标包实际契约核独立启动数据根、同实例存储配置及默认项目根的 `root` / `configured` 最小投影和时点；默认项目根与当前项目真实路径不同不能互相替代。缺失或读取失败留缺口，不能以页面路径自证。禁止打开目录选择器、改变位置或重启；迁移与生效仍属专项。下文旧包读取契约仅是历史线索。

历史建库说明：修订：storage/3（仅补参考图，修订1判据不变）。用户本轮采用指定包现有功能；三项自动展示快评，首次纳入v`0.3`。

来源：macOS arm64 0.3.0 / 202610281438 / preview；`app.asar` SHA256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`。安装renderer `assets/index-C4-PYlXk.js`的DataStoragePage第77884行及loadWorkspaceRoot第5542行；有界对照[AccountPanel.tsx](../../../src/renderer/src/components/business/AccountPanel.tsx)、[storage Owner](../../../src/main/storage.ts)与[持久化契约](../../../../../docs/architecture/persistence.md)，不证明全仓映射。

| 要点 | 固定 / 动态 / 条件与来源 |
| --- | --- |
| 001 | storageConfig().home为本次实际data home，独立启动记录绑定实例；运行期无修改home按钮 |
| 002 | GET /api/serve/workspace-root；展示configured或root，按ready/busy限制更改入口。configured与root可能不同，完整原值分别保留 |
| 003 | platform与canChangeDataHome决定安装/首启脚注；当前实现restart/failed notice发生于修改流程，本轮未修改不要求制造该提示 |

独立参照只取home/canChangeDataHome及root/configured/restartRequired，绑定独立启动记录；路径截断须采完整实际页面文字。禁止打开选择器或改变项目位置；迁移/重启生效另行专项。

reference.png为已检查原始storage.png的未改动副本，版本/日期及动态边界见正文；SHA256 `4e86160817855083ada8ae0828abe097f03d1e1c664d748d938e76636cbde927`。原冻结修订1不覆盖。

## 发布快评分层（2026-10-30）

本资产修订为storage/3；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为STORAGE-OBS-001–003的正文明确子要点；必要参照为隔离任务启动数据根和公开默认项目根配置；不读其他目录内容。未选范围为目录选择/打开/复制、迁移、更改与重启，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。


## 当前制品复核

当前资产修订：`storage/4`（2026-10-30）。本次仅增量更新制品定位与独立参照，不改变稳定ID、v`0.3`、完整判据或快评/专项边界；前文包号、旧源码行号、分层修订与结果均是历史记录，不作为本轮包绑定或通过结论。参考图仍保留原来源日期/构建。

本轮来源为已核安装包 `0.3.0 / 202610301343 / preview / macOS arm64`；app.asar SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。直接证据为实际松散发布目录 `renderer/assets/index-CddcCmKt.js`，SHA-256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`；下述编译函数/行号均指此文件，另名文件明确标出。引用的 `out/preload/index.js` SHA-256 `754a7f2fc34f7f1c6ac7f21c256c156f9c3b9dcf88c2c64a20b3d82bcb992219`，`out/main/index.js` SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`；偏好常量所在 `renderer/assets/AccountMenuPanel-CHQ1thBC.js` SHA-256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。源码提交未绑定；前文仓库Owner链接仅为辅助线索，不将checkout/远端HEAD等同本包。

- 固定/动态/条件：`DataStoragePage:79602` 分别读取数据根及默认项目根，独立loading/error/ready；配置路径优先 `configured || root`，不把未生效配置当当前已用根。更改入口按workspace就绪与busy限制，重启提示仍只来自本页修改流程。
- 数据根公开桥 `window.scholarseed.storageConfig()`（preload :543；main IPC :40215）直接返回对象，无ok/body包装。仅取 home/configured/canChangeDataHome，必要 firstLaunchEligible；runtimeStore 与本页路径展示无关不采集。home由 desktopHome() 取得，必须对照本轮独立启动数据根；安装目录、userData、默认项目根都不能替代它。
- 项目根读取为 `loadWorkspaceRoot:5843` → `readJson:5780`，GET `window.scholarseed.getApiBase() + '/api/serve/workspace-root'`、`credentials:'include'`，成功JSON顶层 root/configured/restartRequired。分别保留当前root及configured原值，configured为空才用root；不猜workspace/body包装，不列目录、不读项目内容。
- 平台来自 preload.platform，安装包本轮仅绑定darwin/arm64，main本轮 canChangeDataHome=true不外推Windows实现或验收。缺启动记录或读取失败须留缺参照，不能拿页面路径自证；不调用pickDir、commitDataHome、saveWorkspaceRoot、openPath或重启。

本次只核提取制品与资产，未启动/连接产品、读取用户状态或发起请求；未产生新运行截图或产品验收结论。后续run仍须在获准实例取得同一时段独立参照；缺少、陈旧或失败参照不能从待判页面自证。
