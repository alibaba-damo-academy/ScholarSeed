# CSV与表格需求构建依据

## 需求与运行进度分离：tables/13

移除需求正文中笼统的历史“全部未实测”状态，运行进度与各轮结果以场景索引及运行记录为准；不改变稳定 ID、需求版本、采用范围、专项边界或历史冻结。

## 202611121823 工作表参考图：tables/12

`main-20261112.png` 和 `secondary-20261112.png` 是 2026-11-12 macOS arm64 安装版 `0.3.2 / 202611121823 / preview` 隔离实例的真实原图副本，分别展示合成工作簿 Main 和 Secondary；对应原始运行 `baseline-1823-batch2/supplement/evidence/table-secondary.png`（实际为 Main）及 `table-secondary-selected.png`。截图 SHA-256 分别为 `ce31bbc3b865be8cfef004e2191d4fc40d9e939645b5740d3ba64ad63aa291fc` 和 `4333291b5c7cab872bc937038c07fc08ee6a8c1517b67282e900066c540e86f9`，目标 `app.asar` SHA-256 为 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。图仅对应 TABLE-OBS-003 的两个可见状态，动作及其他分支不由静图证明；需求版本、判据及历史冻结不变。

## 共享输入去重：tables/11

原页面目录的合成输入已迁至字节一致的共享 `examples/projects/evaluation/files/`，原路径与内容可按历史提交 `137af4c0bd`（CSV/TSV）和 `473e3962bb`（XLSX） 回查；仅整理输入引用，不更改需求版本、判据或冻结记录。

## 202611121823 正常快评沿用：tables/10

依据用户统一采用记录及下文 tables/6 已采用的 TABLE-OBS-001、003、005 普通工作簿阅读，本页对 `0.3.2 / 202611121823 / preview` 按既有[发布快评层](./requirements.md#发布快评层)保留相同子点；已读本页后续构建记录未发现已确认退役或修改这些正常要求的决定。此为有界沿用，不以新包实现或单次画面批准新需求，也不证明已检查完整变更史、源码与制品同源或产品符合。编辑、导出和异常仍按原专项与待确认边界处理，工作簿输入和独立矩阵须逐轮核实；原编号、版本、正文和历史运行不变。

## 共享示例输入对齐：tables/9

当前数据入口为 `evaluation/csv`、`evaluation/tsv` 与快评所用的 `evaluation/workbook`；其 SHA-256 分别为 `72131555255008d035f8846e237f5dc001bc65a682530084e04c9f3139b63cbe`、`3ac4f4fd61f3bd6b9c6da3a7efb762bd91d53e09f23a6b20f44ad3210f18162c`、`4cb12501e1a90ccf80851937f4ab8222407608e6f49aeb459954bec4dad0230e`，与下文历史样本逐字节一致。按本轮准备收据核项目及路径；准备不等于导入功能测试，导入由人工确认。目标包适用性待核，不代表实测通过。

## 长表原始输入：tables/14

新增独立 `table-long/long-csv`，不修改上述冻结输入或快评分层。文件 11520 字节，SHA-256 `038ecd75be1ac04a2ee861b58084075386b84865f85187cd5f0d82e1e61bb837`；UTF-8 无 BOM、LF 且末尾换行，逗号分隔，120 条记录各 12 个字段，字段按 `R` 加三位行号及 `C` 加两位列号生成，无表头。首、中、末及远列独立参照见需求正文；实际视口是否需要滚动及产品定位结果须另行观察。该输入仅供获准隔离准备，人工导入及产品操作分别确认，不证明导入、网格导航或评测通过。

## 当前参考图修订：tables/8

`reference-20261112.png` 为 2026-11-12 macOS arm64 安装版 0.3.2 / 202611121104 / preview 隔离实例原图 `attempt-examples/evidence/table-main.png` 的未改动副本，SHA-256 `b36d1f36ab4841acc22b51ebd86c1b7d7974e0e737a6d86e96aba82fbc2be38d`；仅展示合成工作簿网格，不证明 CSV 编辑或异常。原始运行在 `tmp/test_snapshot/desktop/release-20261112-fresh/`；不改变需求或历史裁决。

## 历史修订：202610301343包内静态复核

资产修订：`tables/7`；本次只补指定新包来源、输入/独立参照与快评边界。原稳定ID、v`0.3`、采用规则、完整正文、参考图原版本/日期及历史结果保留；以下旧来源与修订记录均属历史，不代表本包绑定或本轮执行结论。

目标：macOS arm64 `0.3.0 / 202610301343 / preview`；ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。来源为本任务已提取的实际安装包与松散renderer payload；源码提交未知，当前checkout/remote HEAD仅可辅助定位，不声明同源。证据清单为忽略目录 `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`，包内定位均相对该根`package/`；不将临时提取目录当正式跨工作树资产。

包内`out/main/index.js` SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`：1338的applicationRenderer在packaged时取applicationResources下renderer，41203的无开发URL分支交给serveAssets。该链绑定本次分析的实际松散payload，不证明运行时未设置开发覆盖，也不把静态入口当产品观察。

- `renderer/assets/index-CddcCmKt.js`：SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`。
- `renderer/assets/AccountMenuPanel-CHQ1thBC.js`：SHA256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。
- `renderer/assets/OfficeDocument-DVgtjClL.js`：SHA256 `4615f886cfdae604f473432f3ea78ced58f84ee3b280ecc55b46dd0aeac6d651`。
- `renderer/assets/TableViewer-B429rW67.js`：SHA256 `99b79a5ca6d04ddfdefedd159b47d6e5b2becf30e82fa531035eba41c458f07f`。

包内workspace:787/790区分xlsx preview与CSV；OfficeDocument:145068 Workbook按bytes装载、过滤visible表并维护选中表，145139/145221 Preview使用xlsx Workbook；145373 CsvDocument仅can_edit且edit时可写。TableViewer:12/48旧路径限制500记录，对xlsx/xls给Pending，不能拿这个旧二进制分支代替新正常XLSX Preview。原sample.xlsx的Main/Secondary及独立矩阵与普通预览链相容，快评仅观察资格并切一次表，不进入Office编辑。CSV/TSV及XLS的解析/引擎/写入不同，不泛化；原XLS内部内容、复杂格式/导出及异常缺口保留。

需求正文中的样本指仓库原件的获准隔离副本；执行前登记原件摘要→任务项目ID/导入后实际路径的映射，历史`eval-*-20261030`只是旧运行别名，不假定新安装中存在。项目/资源、列偏好及API最小投影尚需本轮获准独立取证；静态相容不证明正常UI已可达或实测通过。本次未启动、连接或操作产品，未读用户状态/凭据，未调用外部API；不改变运行状态，不缩减未就绪专项。

## 历史构建与分层记录


修订：tables/6。依据2026-10-30用户统一采用规则，以已绑定安装版v0.3.0 / 202610281438 / preview的已核实正常行为作为v`0.3`需求依据；复用现有源码、精确产物绑定及已完成Review。TABLE-OBS-001–005的正常CSV/TSV内容、工作表/网格与实际资格，以及006已绑定CSV编辑/序列化/保存流程已采用；006仍为未授权执行的写入专项。002特殊方言、空白记录/跨行/截断及误导计数，003–004未明确的复杂格式或公式重算、005未绑定来源/Office写入、007导出入口/产物、008异常反馈仍待确认，不以坏输出或接口注册自批。已恢复的隐藏表不列入可选标签语义属于003正常要求，缺样本只表示尚未实测。全部未实测；已采用正常自动要点参与默认选择，未确认及专项另列；采用不增加产品操作权限。

修订4的普通CSV/TSV和双可见工作表XLSX输入、独立内容参照保留；本修订仅变更采用状态，八个ID、判据和需求版本不变，不复制Office或保存/关闭标准。

## 目标制品与绑定

重新只读核对安装包`/Applications/ScholarSeed.app`：Info.plist与ASAR package.json均为0.3.0，Resources/product.json为build_number `202610281438`、update_channel `preview`。ASAR SHA256=`1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`。直接读取ASAR `out/main/index.js:41018–41023`：无开发renderer URL时，packaged serveAssets根是`applicationResources(app)/renderer`，因此以下旁置renderer具有产物来源绑定；未检查运行环境，也不宣称整仓同源。

`Contents/Resources/renderer/assets/`本批SHA256：

| 文件 | SHA256 |
| --- | --- |
| index-C4-PYlXk.js | `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57` |
| AccountMenuPanel-CZYu9yKi.js | `fe2d49b09ad2f7d3134775d006fd077653559d4476c7a7a6c1d90c09dd99aa00` |
| OfficeDocument-gRFtPced.js | `4d1e840887deed6555c50d2296bdfdca93da2ec1063ff602d84bca7fe52e6216` |
| TableViewer-CGsRFPfn.js | `077dcc040d23b936fcc13e760514c8f89156489355f0f14508b810f25a2256fa` |
| worker-DQMsDBs3.js | `23d0155e8c03c29d281aafc8921b0033f231e2ac52b482cb72ef3f440f24572f` |

index:64404–64411明确导入这两个文档chunk。OfficeDocument chunk:145923起优先按usesCsvDocument送CsvDocument，其次按usesOfficePreview送Preview，否则OfficeRuntime；:145283建立的Worker实际指向worker-DQMsDBs3.js。workspace chunk:776/779持有preview/CSV路由；已读函数与仓库对应链一致，不以懒加载声明代替真实正常入口。

仓库frontend源码摘要，均相对`apps/desktop/src/renderer/src/`：

| 路径 | SHA256 |
| --- | --- |
| features/workbench/viewers/TableViewer.tsx | `ed1f70319b596eb528346e17bacf7b5764c29fb8de11a06027e64af0139438b2` |
| features/workbench/OfficeDocument.tsx | `f5a86e10f19d3101f3b57fa23a67e773983ac3d434b2115e6fc3060407b33127` |
| features/workbench/csv/Document.tsx | `40c6e6df0362a126826f2b82a13852606e233608ce301a8cd624ecf907d82024` |
| features/workbench/csv/model.ts | `0de0a4e0ade509a281a8897569bcaf42db9d5e4232f7d4b1903f41955d16637a` |
| features/workbench/preview/routing.ts | `30d9984c0b2a1607ab4b2454d6beb0972c73c7f6e088214483849f071f82011f` |
| features/workbench/preview/Workbook.tsx | `887dc1a1943ced7f40a168df5436af6099113632cf4c2313cd6089929dd305d3` |
| features/workbench/preview/Grid.tsx | `ac9e70a7d9effaf74df87813f4be96544d25ee98063ee9270148485520b89f7b` |
| features/workbench/office/policy.js | `985a8076b2141105fb78d79e83844d392995d1e28a7113ba1639213ab49cde15` |
| features/workbench/office/runtime.tsx | `dea50bb98c57fa18c35dc58f793d0a1d0ae20a1407e33903c7e9128332953836` |

必要后端Owner逐文件比较仓库`apps/serve/`与安装包`Contents/Resources/backend/python/lib/python3.12/site-packages/`，以下字节及SHA256相同：

| 相对路径 | SHA256 |
| --- | --- |
| service/workbench/api/routes.py | `7a6ea90eea38c3a750c4b96eab3818000f65d1f35fd946b79f66862305348727` |
| service/workbench/domain/model.py | `4b83232e05dd762b420f4743c2f55ba15c21742ea6ba7f32f332818c492b391e` |
| service/content/service/port.py | `e04f6b582e536458136328f4f2a09bdeedac18982b2f6c037843d6ec670b20e0` |
| service/content/service/spreadsheet.py | `d84b512f6bad0d5de70afaeca554d24a44c411819da6e7a1a0083e6bf74c78e3` |
| service/content/service/xlsx.py | `d3372d242aad8bfa934685bee2c060e28944841d5a9e31936f0360abab80f0c7` |
| service/content/service/xls.py | `b4bb57cb661aeaafebe3c02ff03f930ae5c96fed818accb8f406967a95345d33` |

## 真实格式分流及重叠边界

注册真源是[model.py](../../../../serve/service/workbench/domain/model.py):76/77/107/108，不是不存在的registry.py。[routes.py](../../../../serve/service/workbench/api/routes.py):156的正常project open先snapshot、读字节和判断大小，再投影viewer、processor、capabilities、revision及源身份；[api.ts](../../../src/renderer/src/features/workbench/api.ts):385取得open和content，直接使用投影viewer。实际路径为：

| 来源/格式 | 当前实现，不等于已实测 |
| --- | --- |
| 项目.csv | SPREADSHEET→[feature.tsx](../../../src/renderer/src/features/workbench/feature.tsx):135→OfficeDocument:95→CsvDocument。后端spreadsheet.py的UTF-8-sig/引号安全检查决定can_edit，routes再与writable相交；[workspace.ts](../../../src/renderer/src/features/workbench/workspace.ts):369对可编辑且非xlsx的spreadsheet规范为edit，否则preview。故正常CSV并非旧TableViewer的只读CSV路径 |
| 项目.tsv | TABLE→feature.tsx:95→TableViewerHost，按[TableViewer.tsx](../../../src/renderer/src/features/workbench/viewers/TableViewer.tsx):65读取资料文本。Host从当前store补project；[resources/api.ts](../../../src/renderer/src/features/resources/api.ts):1104使用GET /api/resource/read。此旧链不是session.bytes渲染，跨项目/异步身份须实测，不假定与CSV完全一致 |
| 项目.xlsx | SPREADSHEET→OfficeDocument→preview/Preview→Workbook。model.py注册readonly=True，即使xlsx processor.inspect判可安全roundtrip，项目能力仍不可编辑/保存；api.ts不为xlsx请求兼容预览转换，传原字节给renderer。backend artifact_editable是独立来源资格，不推成项目文档可编辑 |
| 项目.xls | OFFICE且readonly→OfficeDocument→OfficeRuntime/Calc；不走旧TableViewer的二进制占位，不走XLSX的ExcelJS读取。具体字体/引擎/格式呈现需Office专项；文件类型身份不证明引擎已能打开 |

“CSV/表格”与README相邻的“Office与表格文档”共享OfficeDocument与部分工作簿Owner。本页正文集中持有表格内容、工作表/网格及资格语义，后续Office场景应引用TABLE-OBS-001/003/004/005/008适用部分，未确认异常不因引用批准；Office通用引擎、字体及格式特性仍单独建库，不复制两套XLS/XLSX标准。会话产物、版本快照、外部文件与文献各有来源投影，当前仅界定边界，不宣称全部绑定。

## 逐项固定、动态及条件来源

| 条目 | 恢复依据与独立参照 |
| --- | --- |
| 001 动态/条件 | OfficeDocument.tsx:87–112分流，CsvDocument:128起建立worker/source owner并清理旧实例；Office chunk:145373/145923起对应。XLSX [Workbook.tsx](../../../src/renderer/src/features/workbench/preview/Workbook.tsx):124起按bytes重载book/style并阻止过期Promise落入新文档；:160起加载/失败/空表分开。独立参照须有原文件摘要及预先解析单元格，不从UI回填答案 |
| 002 动态/格式条件 | CSV [model.ts](../../../src/renderer/src/features/workbench/csv/model.ts):73/87/139/209以fatal UTF-8解码、可选BOM、引号感知字节索引、逗号/分号/TAB/竖线候选探测；不执行单元格公式，内容按字符串。worker:3/105起对应。后端[spreadsheet.py](../../../../serve/service/content/service/spreadsheet.py):34/113/204维护同类delimiter打分与严格引号检查。TSV旧TableViewer:97先按物理LF/CRLF拆行并过滤空行，再parseRow处理单行引号；最多500条，首条用thead，其余body。限额提示传rows.length不是源总数，不能批准其冒充总行数；跨行引号/空记录等语义缺口保持未确认，不将旧解析器局限施加于新CSV |
| 003 动态/交互 | Workbook.tsx:155仅visible sheets可切换，:189/199切换清选区；[Sheets.tsx](../../../src/renderer/src/features/workbench/preview/Sheets.tsx):13从源名称建标签及左右箭头导航。Office chunk:145068起对应。CsvDocument:415起以去.csv文件名作唯一model.name，末尾Sheets只一个显示标签，不是工作簿元数据；XLS切表由Calc Owner持有，当前只恢复policy.js:69允许JumpToTable/PrevTable/NextTable，不据命令白名单断言正常UI可达 |
| 004 动态/条件 | [Grid.tsx](../../../src/renderer/src/features/workbench/preview/Grid.tsx):103按行列virtualizer窗口渲染，:329滚动host，:393–415键盘范围钳制及滚动；CSV在Document:452附近按window向worker读实际行列。Workbook:45起读取合并、隐藏行列、宽高、样式和drawing；[cells.ts](../../../src/renderer/src/features/workbench/preview/cells.ts):26的cellText显示cached formula.result而非计算引擎，浮点/日期可转源引用，不承诺Excel显示格式/公式重算完全一致。未知复杂格式须独立源值/显示预期，不自批当前输出 |
| 005 动态/条件 | model.py:244的processor.inspect与registration.readonly、routes.py:209的writable共同限定项目资格；[csv/Document.tsx](../../../src/renderer/src/features/workbench/csv/Document.tsx):99还要求viewKind edit。Office runtime.tsx:616向frame传editable，:797可restrictEditing；[office/policy.js](../../../src/renderer/src/features/workbench/office/policy.js):87按editable筛可用命令和工具条。后端能力不单独保证编辑UI可达；XLS/XLSX项目只读不是“所有来源永久不可编辑” |
| 006 写入专项 | CsvDocument:222–287的commitEditor与save delegate先提交活编辑器，再serialize；:604起Escape取消、Enter/Tab提交，Grid:383允许撤销/重做，粘贴为真实变更。model.ts:477原字节基础上仅重建被改记录，保留未改token/BOM/原分隔符及换行，字符串中分隔符/引号/换行由:181重新引用。不据这一实现宣称全方言无损；结果须独立重读/解析。api.ts:519的commitDocument以PUT+If-Match写真实源；通用saving当前已恢复依据主要为Markdown/Monaco，本批补CSV适配依据，未借此批准Office serialize链 |
| 007 条件/未知 | 当前CsvDocument/Workbook只读网格没有通用CSV/XLSX转换导出入口；Office policy.js:26 LIFECYCLE明确排除SaveAs/Export等原生命令，宿主save delegate与原生导出不同。现有SnapshotReview下载历史基线不能替代表格格式转换。实际导出能力与输出格式要求未绑定，正文保留待确认专项，不以未找到就退役需求 |
| 008 条件 | CsvDocument:121 reportError显示warning，末尾无model且failure才给重试，已有model操作失败则可保留网格；Workbook:165失败重试，Preview:53在新版本清旧状态，旧TableViewer:106失败显示unavailable。更外层ViewerBoundary亦有通用错误。不同阶段错误不能强制同文案，不把无model或异常清空当真实空表；worker错误/引擎错误及源读取失败均需授权前提 |

## 副作用与独立状态边界

正常open/content公开读可用于核project/path/revision/media_type/capabilities和字节摘要，不提供网格真实位置/工作表显示/解析正确性的答案；本批没有发出请求。TSV还走resource/read文本路径，不能把新workbench的原字节摘要当它已经用了同一代文本的证明。只读源码没有证明并发外部修改时两次读取同revision。

CSV读取/导航在worker建索引并由Grid维护选择、滚动、行列宽等运行内存，不写原文件；内容修改会setExternalDirty，触发已配置自动保存时可进入真实写入，因此edit模式下任何键入/粘贴不是无副作用观察。网格复制会写系统剪贴板，虽不改文件，也需执行范围明确。Workbook的views Map维护表间视口，不承诺跨重启恢复。store.tsx:3140/3196正常打开touchRecentFile，:1881偏好提交可持久化MRU；不能把只读查看称绝对零状态写。

XLS OfficeRuntime可能有引擎初始化/内存文件系统及宿主状态影响，本批不运行、不以静态健康或文件头证明实际能用。读取固定数据无须模型；旧TableViewer的“询问AI”只可视为另一路业务入口，未获授权，不纳入表格内容快评或自动触发。保存/自动保存/冲突与关闭只引用已有场景的适用部分，Office写入生命周期尚未完成绑定，不外推通过。

## 既有数据与缺口

仅核[selection-100-rows.xls](../../../e2e/fixtures/office-corpus/xls/selection-100-rows.xls)文件身份：13824字节，`file`识别Composite Document File V2 / Little Endian；SHA256=`9fa9ee7ef2d8382b566fdb05d6de479935b1a8d13bd5eec02f9b21fdda75ce5a`，与同目录上层[manifest.json](../../../e2e/fixtures/office-corpus/manifest.json)的selection-v1记录相同。该结论只证明与已登记复合文档字节一致，不证明内部工作簿合法、无宏、实际行数/工作表名称或安全可打开；未解析单元格、未复制、未导入产品。e2e/office.spec.ts:1460以它作为真实XLS选区自动滚动输入，但历史测试意图不充当本次独立内容答案。

普通合成输入[sample.csv](../../../../../examples/projects/evaluation/files/sample.csv)与[sample.tsv](../../../../../examples/projects/evaluation/files/sample.tsv)各116字节，UTF-8无BOM、LF且末尾LF，分别逗号/TAB分隔。独立标准库解析结果均为4记录×4字段，内容参照见需求正文；包含中文、空字段、0/负数与双引号转义，无跨行字段、公式、外链或凭据。CSV SHA256=`72131555255008d035f8846e237f5dc001bc65a682530084e04c9f3139b63cbe`；TSV SHA256=`3ac4f4fd61f3bd6b9c6da3a7efb762bd91d53e09f23a6b20f44ad3210f18162c`。仅作为原始输入，未导入或预置产品解析/保存结果，不代替运行截图。

普通工作簿[sample.xlsx](../../../../../examples/projects/evaluation/files/sample.xlsx)为4271字节，SHA256=`4cb12501e1a90ccf80851937f4ab8222407608e6f49aeb459954bec4dad0230e`。独立ZIP/XML解析确认可见工作表顺序Main、Secondary，内容参照见需求正文；Main的C2:C4为数值，其余已用单元格为字符串，包括B3空串。没有公式、外部关系、宏部件、超链接、合并、隐藏表或隐藏行列，不能以此声称覆盖这些能力。

三份输入提供普通表格身份、内容、基础方言/计数及双表切换的独立参照，尚未导入产品，不证明实际Viewer可用。当时长表输入尚未就绪，后续已补充 `tables/14` 的独立 CSV；隐藏sheet、公式缓存/合并等复杂数据，以及损坏/空表/其他方言/只读拒绝/编辑前后/导出预期仍未就绪；XLS缺独立内部内容清单。源文件名“100-rows”不是行数参照，不据它把004或任意专项标就绪。

## 发布快评分层（2026-10-30）

本资产修订为tables/6；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为TABLE-OBS-001、003、005的正文明确子要点；必要参照为已有eval-table-20261030.xlsx；标准库ZIP/XML独立矩阵、可见工作表Main/Secondary及build摘要。未选范围为CSV/TSV全部格式、键盘网格定位、特殊方言/复杂格式、006写入、007导出与008错误，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。
