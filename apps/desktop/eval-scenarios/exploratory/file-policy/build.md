# 文件策略基线构建依据

当前资产修订：`file-policy/7`；本次澄清目标读取契约须实际核实，下文[当前制品复核](#当前制品复核)保留历史包依据，业务判据及需求版本不变。

## 202611121823 目标版本参考图

`window-20261112-1823.png` 是目标版本真实完整窗口原图的字节一致副本，来源 `tmp/test_snapshot/desktop/baseline-1823-batch4/dynamic-followup/evidence/file-policy.png`，2026-11-12 20:31:57 +0800，SHA-256 `7b09a052a1345a572ff9a9909696d0c55c6ab759114c4816beffeecf43d2cef6`。目标为 macOS arm64 `0.3.2 / 202611121823 / preview`，`app.asar` SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`；原始运行记录位于本机忽略目录。显示自然偏好和版本限制，图中数值为动态值，不证明策略保存或生效。参考图不替代本轮执行或判定；本次仅补图，不改变需求版本、判据和历史结果。

## 202611121823 正常展示沿用

依用户统一采用已核正常行为的记录及本页已采用快评分层，针对 macOS arm64 `0.3.2 / 202611121823 / preview` 有界沿用 FILE-OBS-001–003 的保存偏好、版本保留数量与大小正常展示子点。已核本页既有采用和后续记录，未发现该子范围被确认退役或更改；不证明完整变更史、源码制品同源、目标包入口可达或产品通过。原编号、需求版本、判据和历史裁决不变。

执行前按目标包实际契约核同一实例保存偏好和文件版本设置最小字段、读取时点及 KB/1024 换算；启动快照陈旧、设置读取失败或字段不足均保留缺口，不以画面或未证默认值自证。禁止 focus 数字输入或触发失焦保存、切换开关和迁移；保留策略生效、写入及迁移仍属专项。下文旧包读取契约仅是历史线索。

历史建库说明：修订：file-policy/3（仅补参考图，修订1判据不变）。用户本轮采用指定包现有功能；三项自动展示快评，首次纳入v`0.3`。

来源：macOS arm64 0.3.0 / 202610281438 / preview；`app.asar` SHA256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`。安装renderer `assets/index-C4-PYlXk.js`的FileVersionPage第78347行、loadFileVersionSettings第4346行、advanced常量第77665行；有界对照[AccountPanel.tsx](../../../src/renderer/src/components/business/AccountPanel.tsx)与[文件设置Owner](../../../src/renderer/src/features/resources/settings.ts)，不证明全仓映射。

| 要点 | 固定 / 动态 / 条件与来源 |
| --- | --- |
| 001 | autoSave/formatOnSave来自profile偏好，缺失默认true/false，不把默认值写成长久固定要求 |
| 002 | GET /api/serve/settings/file-versions；max_versions_per_file原值；max_file_size_kb除1024，保留两位后去无用0；saved读取前字段禁用 |
| 003 | migration_required才展示提示；读取失败toast；本包高级配置false，不要求模式、白/黑名单或扫描区出现 |

独立参照仅取上述只读设置字段与偏好白名单。数字输入onBlur可能自动保存，禁止focus/fill/Enter；开关立即写偏好，禁止操作。策略生效、迁移、扫描及保存冲突另行专项，不从展示符合推断通过。

reference.png为已检查原始library-files.png的未改动副本，版本/日期及动态边界见正文；SHA256 `d866a45e252348f0b9b3e84ffa8c5893e689650e379a41703f33df666b34e01c`。原冻结修订1不覆盖。

## 发布快评分层（2026-10-30）

本资产修订为file-policy/3；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为FILE-OBS-001–003的正文明确子要点；必要参照为当前文件设置最小字段；大小参照使用原build的KB→MB关系。未选范围为偏好修改、迁移确认、保留/清理与真实保存生命周期，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。


## 当前制品复核

当前资产修订：`file-policy/4`（2026-10-30）。本次仅增量更新制品定位与独立参照，不改变稳定ID、v`0.3`、完整判据或快评/专项边界；前文包号、旧源码行号、分层修订与结果均是历史记录，不作为本轮包绑定或通过结论。参考图仍保留原来源日期/构建。

本轮来源为已核安装包 `0.3.0 / 202610301343 / preview / macOS arm64`；app.asar SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。直接证据为实际松散发布目录 `renderer/assets/index-CddcCmKt.js`，SHA-256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`；下述编译函数/行号均指此文件，另名文件明确标出。引用的 `out/preload/index.js` SHA-256 `754a7f2fc34f7f1c6ac7f21c256c156f9c3b9dcf88c2c64a20b3d82bcb992219`，`out/main/index.js` SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`；偏好常量所在 `renderer/assets/AccountMenuPanel-CHQ1thBC.js` SHA-256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。源码提交未绑定；前文仓库Owner链接仅为辅助线索，不将checkout/远端HEAD等同本包。

- 固定/动态/条件：`FileVersionPage:80065` 仍从 renderer 偏好取 autoSave/formatOnSave；目标 chunk 的 `FILE_VERSION_ADVANCED_CONFIGURATION_ENABLED:79386` 为 false，不能因其他实现代码存在要求展示高级区。迁移提示只在读取结果 migration_required 时出现。
- 独立设置读取：`loadFileVersionSettings:4640` 使用 `fetch(window.scholarseed.getApiBase() + '/api/serve/settings/file-versions', {credentials:'include'})` 的 GET，成功响应 JSON 顶层只留 max_versions_per_file/max_file_size_kb/migration_required；不猜 settings/body 容器，不输出 include_patterns/ignore_patterns 或其他项目资料。非成功、解析失败/未就绪不能用临时默认数字代替。
- `fileVersionSizeMbText:4630` 仍为 KB/1024、toFixed(2) 后 Number 转换去无用0。偏好取 preload.preferences 的 autoSave/formatOnSave 启动白名单，默认 true/false 见 `AccountMenuPanel-CHQ1thBC.js:357`；需确认之后没有偏好修改，快照陈旧则缺参照，不调用 savePreferences 或 reconcilePreferences 补齐。
- 数字输入失焦可保存、开关立即修改偏好，仍禁止 focus/fill/Enter/切开关；本次只修订证据定位，不改变保存、迁移或保留策略预期。

本次只核提取制品与资产，未启动/连接产品、读取用户状态或发起请求；未产生新运行截图或产品验收结论。后续run仍须在获准实例取得同一时段独立参照；缺少、陈旧或失败参照不能从待判页面自证。
