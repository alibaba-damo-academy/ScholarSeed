# MCP基线构建依据

当前资产修订：`mcp/6`；2026-10-31按用户明确的MCP入口语义更正验证归属，沿[连接器当前承载](../connectors/build.md#mcp承载映射)执行。本次按用户要求删除不再使用的旧界面参考图、链接当前连接器参考图；原业务判据、稳定ID及v`0.3`保留，不要求恢复旧布局。

历史建库说明：修订：mcp/3（仅补参考图，修订1判据不变）。用户本轮采用指定包现有功能；三项自动展示快评，首次纳入v`0.3`。

来源：macOS arm64 0.3.0 / 202610281438 / preview；`app.asar` SHA256 `1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`。安装renderer `assets/index-C4-PYlXk.js`的McpSettingsPage第75303行，有界对照当时的 `apps/desktop/src/renderer/src/components/business/McpSettings.tsx`（当前源码树已无该文件），不证明整仓映射。

| 要点 | 固定 / 动态 / 条件与来源 |
| --- | --- |
| 001 | status返回configuration.servers及servers状态；等待计数为connecting加pending_apply，其他分类按状态计数；unsupported/pending_apply/safe_error分别有提示 |
| 002 | 空态按configuration.servers长度；状态缺失时启用项回退pending_apply、禁用项回退disabled，tool_count未知不能当就绪 |
| 003 | AddServerForm自然HTTP显示URL，stdio显示command/args；loading/saving/unsupported禁用添加，必填校验在提交时执行，不要求空表单按钮禁用 |

独立参照走既有公开preload `mcpSettings({operation:'status'})`，只保留supported/state、server id/name/transport/enabled与state/tool_count等白名单。不得落完整headers、URL查询或命令参数等秘密。采到底部表单，不刷新/切transport/添加/启停/移除；工具实际调用及授权另行专项。

历史参考图为原始mcp.png的未改动副本，SHA256 `2f237b8626fb0eaa2cf5dd79d9df737b0af23fda792233dfe14cbbb427b57bf5`；旧界面已移除，本地参考副本按用户要求删除，历史冻结修订不回写。

## 发布快评分层（2026-10-30）

本资产修订为mcp/3；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为MCP-OBS-001–003的正文明确子要点；必要参照为同实例公开只读服务器状态最小字段，不取环境变量/秘密。未选范围为刷新、添加、传输方式切换、连接/授权及工具调用，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。


## 当前制品复核

历史资产修订：`mcp/4`（2026-10-30）。当时仅增量更新制品定位与独立参照，不改变稳定ID、v`0.3`、完整判据或快评/专项边界；包号、旧源码行号、分层修订与结果均为历史记录，不作为本轮包绑定或通过结论。

本轮来源为已核安装包 `0.3.0 / 202610301343 / preview / macOS arm64`；app.asar SHA-256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。直接证据为实际松散发布目录 `renderer/assets/index-CddcCmKt.js`，SHA-256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`；下述编译函数/行号均指此文件，另名文件明确标出。引用的 `out/preload/index.js` SHA-256 `754a7f2fc34f7f1c6ac7f21c256c156f9c3b9dcf88c2c64a20b3d82bcb992219`，`out/main/index.js` SHA-256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`；偏好常量所在 `renderer/assets/AccountMenuPanel-CHQ1thBC.js` SHA-256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。源码提交未绑定；前文仓库Owner链接仅为辅助线索，不将checkout/远端HEAD等同本包。

- 原入口与判据保留：本次核 `NAV_ITEMS:79428` / `visiblePage:79457` / `SettingsContent:83461`，其中未见旧独立 mcp 导航及旧 McpSettingsPage 渲染分支；有界检索已提取 renderer chunks 也未定位该旧组件。这是已核入口链的可达性缺口，不证明全部能力不存在，不能据此删除 MCP-OBS-001–003 或宣称迁移已获采用。
- 公共状态桥仍存在：preload `mcpSettings:293` → main `mcpSettingsRequest:27791` 的 operation=status → GET `/api/settings/mcp`，结果 `{status,body}`；200 解析 body 顶层 supported/state/configuration/servers。仅投影 configuration.servers 的 id/name/transport/enabled 及状态项 state/tool_count、必要 supported/pending_apply/safe_error；不保存配置正文、URL、headers、环境、命令及参数，状态和配置数组不可混为同一列表。
- `getMcpConfiguration:3323` 被 Connectors/CustomConnector 使用，并不证明旧独立页可达。后续 run 先核真实入口；不能用连接器自定义表单替代原页面、由桥响应伪造页面截图或把未到达当不适用跳过。入口恢复/移除/迁移的业务采用与适用版本待确认，保持原快评缺口。
- 因未绑定到当前旧页面组件，原计数回退、摘要及 AddServerForm 规则仅保留历史要求，不将旧行号冒充本轮实现定位；读取桥也不证明UI或工具调用已通过。

本次只核提取制品与资产，未启动/连接产品、读取用户状态或发起请求；未产生新运行截图或产品验收结论。后续run仍须在获准实例取得同一时段独立参照；缺少、陈旧或失败参照不能从待判页面自证。
