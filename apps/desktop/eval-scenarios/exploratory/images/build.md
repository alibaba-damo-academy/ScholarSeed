# 图片查看需求构建依据

## 目标版本完整窗口参考：images/10

`window-20261112-1823.png` 是 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例于 2026-11-12 19:54:50 +0800 的完整窗口原图副本，源为 `tmp/test_snapshot/desktop/baseline-1823-batch2/supplement/evidence/image-fit.png`，对应该补采 index 的第 25 次截图；SHA-256 `5522c46c85f3bfe17f562f4d5aa2453f67102336ad01f8455a239d8b2ba95ecc`。批次计划记录目标 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`。图显示合成图片适应窗口状态，右侧文档分屏较窄；不证明缩放动作或运行通过，不改历史判据和冻结。

## 需求与运行进度分离：images/9

移除需求正文中笼统的历史“全部未实测”状态，运行进度与各轮结果以场景索引及运行记录为准；不改变稳定 ID、需求版本、采用范围、专项边界或历史冻结。

## 202611121823 正常快评沿用：images/8

依据用户统一采用记录及下文 images/4 已采用的 IMAGE-OBS-001–003 正常图片阅读，本页对 `0.3.2 / 202611121823 / preview` 按既有[发布快评层](./requirements.md#发布快评层)保留相同子点；已读本页后续构建记录未发现已确认退役或修改这些正常要求的决定。此为有界沿用，不以新包实现或单次画面批准新需求，也不证明已检查完整变更史、源码与制品同源或产品符合。极端缩放、编辑和异常仍按原专项与待确认边界处理，输入和独立尺寸须逐轮核实；原编号、版本、正文和历史运行不变。

## 共享示例输入对齐：images/7

当前快评使用 `evaluation/image`，其 SHA-256 `0830e69b8b3f1203bbefee47649f4de25bd78a4ea9e6ad82591c837e8241d2a2` 与下文 icon 原件逐字节一致；按本轮准备收据核项目及路径。准备不等于导入功能测试，导入由人工确认；下文其他输入及历史记录保留，目标包适用性待核，不代表实测通过。

## 当前参考图修订：images/6

`reference-20261112.png` 为 2026-11-12 macOS arm64 安装版 0.3.2 / 202611121104 / preview 隔离实例原图 `attempt-examples/evidence/image.png` 的未改动副本，SHA-256 `f9fe9e4aab2cbf56ee939bd8afa7b24ddf0e4cced4a53ce74783e86bd337a325`；仅展示一个缩放状态，不证明其它动作或异常。原始运行在 `tmp/test_snapshot/desktop/release-20261112-fresh/`，本修订不改判据及历史结果。

## 历史修订：202610301343包内静态复核

资产修订：`images/5`；本次只补指定新包来源、输入/独立参照与快评边界。原稳定ID、v`0.3`、采用规则、完整正文、参考图原版本/日期及历史结果保留；以下旧来源与修订记录均属历史，不代表本包绑定或本轮执行结论。

目标：macOS arm64 `0.3.0 / 202610301343 / preview`；ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。来源为本任务已提取的实际安装包与松散renderer payload；源码提交未知，当前checkout/remote HEAD仅可辅助定位，不声明同源。证据清单为忽略目录 `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`，包内定位均相对该根`package/`；不将临时提取目录当正式跨工作树资产。

包内`out/main/index.js` SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`：1338的applicationRenderer在packaged时取applicationResources下renderer，41203的无开发URL分支交给serveAssets。该链绑定本次分析的实际松散payload，不证明运行时未设置开发覆盖，也不把静态入口当产品观察。

- `renderer/assets/index-CddcCmKt.js`：SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`。
- `renderer/assets/AccountMenuPanel-CHQ1thBC.js`：SHA256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。
- `renderer/assets/ImageDocument-6egkRQv3.js`：SHA256 `05ed5a6ee7e233ec89ba6bb8e91057f5c94bad65dab26a542348d973e11d3bb2`。

包内ImageDocument:25 fitImage取natural与viewport比例最小值并居中；52起组件从session.bytes构造Blob，onLoad取得naturalWidth/Height，ResizeObserver量当前视口，ready控制查看操作。固定工具含义、动态自然尺寸/几何和条件ready仍与001–003相容。使用原icon.png独立1024×1024与已知图案参照，不固定当前窗格fit百分比；不把缩放状态当文件写入。004极端fit/限幅和005边缘手势、006失败资格仍保留缺口，未核实际可达性。

需求正文中的样本指仓库原件的获准隔离副本；执行前登记原件摘要→任务项目ID/导入后实际路径的映射，历史`eval-*-20261030`只是旧运行别名，不假定新安装中存在。项目/资源、列偏好及API最小投影尚需本轮获准独立取证；静态相容不证明正常UI已可达或实测通过。本次未启动、连接或操作产品，未读用户状态/凭据，未调用外部API；不改变运行状态，不缩减未就绪专项。

## 历史构建与分层记录


修订：images/4。依据2026-10-30用户统一采用规则，以已绑定安装版v0.3.0 / 202610281438 / preview的已核实正常行为作为v`0.3`需求依据；复用现有源码、精确产物绑定及独立需求/数据评审。IMAGE-OBS-001–005正常加载、自然尺寸、适应/实际大小、手动缩放限幅与拖动/复位已采用；004极端fit与手动限幅跳变、005拖动边缘/移出程度/手势、006错误后操作资格及未知格式/旋转裁剪编辑能力仍待确认，不批准异常输出。全部未实测；已采用正常自动要点参与默认选择，未确认及专项另列；采用不增加产品操作权限。

修订2的数据导航及图片编辑边界澄清保留；本修订仅变更采用状态，六个ID、判据和需求版本不变。

## 精确制品与有界来源

本批重新只读核对已安装macOS `0.3.0 / 202610281438 / preview`：Info.plist的短版本、ASAR package.json版本及Resources/product.json构建号/渠道一致。`/Applications/ScholarSeed.app/Contents/Resources/app.asar` SHA256为`1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`。直接读取ASAR `out/main/index.js:41018–41023`：无开发renderer URL分支时，packaged serveAssets以`applicationResources(app)/renderer`为根；这绑定旁置renderer，不据版本号假设整仓同源，也未检查运行进程环境。

重核`Contents/Resources/renderer/assets/`：

| 文件 | SHA256 |
| --- | --- |
| index-C4-PYlXk.js | `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57` |
| AccountMenuPanel-CZYu9yKi.js | `fe2d49b09ad2f7d3134775d006fd077653559d4476c7a7a6c1d90c09dd99aa00` |
| ImageDocument-AsNT2KAx.js | `17a5a711e9b14887bb0e650c5e676ac2bc4c33b465d773132ad34649a4e16aab` |

index:64407–64408显式懒加载此ImageDocument chunk，:64467投影documentSessionId/tabId。图片chunk:9起包含几何工具，:51起为ImageDocument，:3从workspace chunk取得上下文；对应下述已读函数的实现一致，不宣称整个renderer与工作树逐文件同源。

仓库renderer源码SHA256（位置均为`apps/desktop/src/renderer/src/`）：

| 相对路径 | SHA256 |
| --- | --- |
| features/workbench/ImageDocument.tsx | `2e3b3b8fa81b5320bde0b9e37873cd807e7dbf2c3a64782eb4159a9e4c36b340` |
| features/workbench/image.ts | `2be3c3aede20e20511c676cf9d0b373151cdf922b83d36942bc516a831708cf0` |
| features/workbench/feature.tsx | `5c1284781a0b6ff73ec37ef0d45211122ce2ac9cb4265737eb50e4c274bdcaec` |
| features/workbench/api.ts | `80b4302d95cfa262453d7ef7b74a50a82827c00fd8f3cc9c4bbb9953d472f8bd` |
| features/workbench/workspace.ts | `f79b28ba9713d9bc988b55be8772fdbc5ef66dd8bf00555e73c4a2ee549a89fe` |
| store.tsx | `bc1f750a17bb72280ffac98ee616908eb8d5666b950f93753e4094c8b3102a9c` |

必要后端Owner逐文件比较仓库`apps/serve/`与安装包`Contents/Resources/backend/python/lib/python3.12/site-packages/`，以下字节及SHA256一致：

| 相对路径 | SHA256 |
| --- | --- |
| service/workbench/api/routes.py | `7a6ea90eea38c3a750c4b96eab3818000f65d1f35fd946b79f66862305348727` |
| service/workbench/domain/model.py | `4b83232e05dd762b420f4743c2f55ba15c21742ea6ba7f32f332818c492b391e` |
| service/content/service/port.py | `e04f6b582e536458136328f4f2a09bdeedac18982b2f6c037843d6ec670b20e0` |
| service/workbench/service/images.py | `9e836204fad561f8bd0e1f10199f7473f40c047a1555682ccd22aa6eb3f28f2a` |

## 逐项恢复与状态参照

| 条目 | 分类、源码链及独立判断 |
| --- | --- |
| 001 | 动态/条件。[feature.tsx](../../../src/renderer/src/features/workbench/feature.tsx):111注册image，session/tab缺失走UnavailableViewer；[api.ts](../../../src/renderer/src/features/workbench/api.ts):385的project路径先open再content并投影身份和字节。[ImageDocument.tsx](../../../src/renderer/src/features/workbench/ImageDocument.tsx):48–62在session ready时从bytes建立Blob URL，旧URL清理；:164–175由浏览器onLoad取得naturalWidth/Height，ready前隐藏图像。chunk:74起同链。标签名和alt来自session标题，不能作为内容正确的唯一参照。正常资料入口运行未观察，格式注册不证明UI可达 |
| 002 | 动态。ImageDocument.tsx:127–131仅ready时显示原生宽高；image.ts:54按已有image MIME优先，否则按png/jpg/jpeg/webp/gif/svg后缀回退。尺寸必须与源文件独立解码比较，不拿natural字段与自身文本互证；当前两份静态栅格样本不覆盖EXIF方向、SVG、动画和其它格式 |
| 003 | 动态/轻量。ImageDocument.tsx:43按mode选择fit；:65–74由ResizeObserver测clientWidth/Height，:110–125为适应/实际大小；image.ts:30的fit取两个视口比值最小值并清零位移，可能放大小图；实际大小设manual/1/0/0。chunk:23与:146起对应。适应几何和CSS像素可见结果须独立测量，不能用data-scale、data-pan或内部store充当答案 |
| 004 | 固定限值+动态。image.ts:1–4/38，手动缩放因子1.25、范围0.01–32，按比例更新偏移以保持中心对应的图像点；ImageDocument.tsx:85–108按钮按ready与边界禁用，输出四舍五入百分比。图片chunk:9–31/116起。正常手动1%–3200%限幅已按统一规则采用；正文不另新增精确步长要求。fit不走限幅，极端图/视口可超出手动边界，随后按钮可能跳变，仍待确认，不归为正确行为 |
| 005 | 动态/条件。ImageDocument.tsx:146–160仅ready、主指针且无现有drag时捕获指针；:155–157以起点差累计平移，:77–84/159–164释放或丢失捕获时清理。image.ts:45仅叠加dx/dy，无边缘钳制；视口overflow-hidden且touch-action:none，没有图片滚轮监听。chunk:169起对应。无钳制是实现事实，不批准无限拖动；使用可见图案和动作前后几何核拖动，适应/实际大小可复位 |
| 006 | 条件。ImageDocument.tsx:174–175解码出错或无正尺寸设failed；:184–190在failed、session缺失或loadState error时显示图片错误，其余未ready显示Spinner。chunk:202–219同链；更外层[viewer.tsx](../../../src/renderer/src/app/viewer.tsx):19/39/70还有ViewerFailure及懒加载等待。session先前已ready又转error时可能保留natural，ready仅检查natural/failed而未检查loadState，是待验证操作资格缺口，不批准旧尺寸/可用工具继续代表已成功加载 |

后端[model.py](../../../../serve/service/workbench/domain/model.py):125/268的image默认可预览、不可编辑/保存/选择/批注；[routes.py](../../../../serve/service/workbench/api/routes.py):156按ContentService.snapshot、大小上限、注册格式与字节决定viewer/capabilities，:207还以writable约束编辑/保存，并可能由版本服务投影版本能力，不能硬写所有图片永不可版本化。open返回项目、路径、revision、media_type、size和能力；image不走PDF的identify，asset_id可能为空，不要求虚构ID。content路由:235提供ETag与原字节；[port.py](../../../../serve/service/content/service/port.py):895/1141分别受控读字节与snapshot。将来获准公开读取可核摘要/身份，但本批没有发出这些请求，也不从GET成功推断解码成功。

## 工具栏、写入与状态Owner

本版image Viewer注册未声明`toolbar: 'viewer'`；具体工作台外壳组合与图片自带工具栏的真实呈现仍须观察，不能从注册推断菜单必可达。ImageDocument本体真实工具只有缩放、适应和实际大小；本次有界检索当前Desktop renderer TS/TSX、workbench API及Serve workbench/resources Owner，未找到独立图片rotate/crop/transform调用链或名为toolbars的当前文件。旧名称或Office图片命令不证明独立图片编辑入口；若Coordinator有具体历史定位，应保留待补来源，不宣称已恢复完整图片编辑。

[api.ts](../../../src/renderer/src/features/workbench/api.ts):795的POST `/api/workbench/images`不是变换当前图片，而是Markdown插图；routes.py:435调用[images.py](../../../../serve/service/workbench/service/images.py):101的persist_image，仅接受Markdown文档并通过ContentService.commit_optional_bytes创建`.assert/<文档名>/img/<uuid>`。同文件的Office临时图片lease也是文件写入/清理，不归只读查看。PDF区域crop是内存证据图生成，不是独立图片文件裁剪。未来若旋转裁剪调用真实字节提交，必须作为写入专项核授权、内容前后及失败保护，不假扮只读；本批不批准、不退役该业务。

查看不改原图不代表零状态写入：[workspace.ts](../../../src/renderer/src/features/workbench/workspace.ts):2080的setTabViewState只publish当前标签的mode/scale/x/y，workspace chunk:3988对应，不据此承诺重启持久恢复；[store.tsx](../../../src/renderer/src/store.tsx):3140/3196打开资料可touchRecentFile，:1881起纳入偏好提交链，文献另有:1813 recentLiterature。项目原文件、进程内viewState和用户级MRU/偏好分属不同Owner；执行时须授权适用状态影响，不把“只读”文案当绝对零写。

已读取[DESIGN](../../../DESIGN.md)及[vibe](../../../docs/design/vibe-coding.md)的滚动、Required、Enforced by、Stop condition；图片是工作台画布/工具栏，视口裁切由查看区负责，真实支持窗口内关键操作可达、主题、键盘及分屏仍无截图与操作证据，静态检查不代替它们。

## 输入与覆盖缺口

复用以下仓库现有资产及其独立输入属性；它们不是UI截图或空态占位，尚未导入：

| 原图 | 独立属性与已知内容 | SHA256 |
| --- | --- | --- |
| [icon.png](./../../../resources/icon.png) | PNG/RGBA，1024×1024，1帧，92265字节；白圆角底、绿色书页/芽图案 | `0830e69b8b3f1203bbefee47649f4de25bd78a4ea9e6ad82591c837e8241d2a2` |
| [banner1.webp](./../../../src/renderer/src/assets/banner1.webp) | WEBP/RGBA，640×520，1帧，25854字节；绿色房形纸片、几何图形及勾画手臂 | `5f7603294a62dbed3f5feb937b0908a40679cac7ab5d0ac3236fd9e03551c3d3` |

两图可支持身份、静态内容、独立尺寸、非方形比例及部分缩放/平移；透明区不得假定固定背景色。640×520不天然保证在任意窗格fit后小于/大于100%，须按真实视口核几何。缺大图、极端长宽比、独立损坏图、读取失败前提、GIF/SVG/JPEG方向样本；未就绪不删项，也不通过制造失败响应、内部store/预置坐标完成动作来替代真实输入。更完整图片编辑、变换API、自然入口、错误恢复以及fit与限幅冲突均待补。

## 发布快评分层（2026-10-30）

本资产修订为images/4；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为IMAGE-OBS-001–003的正文明确子要点；必要参照为已有eval-image-20261030.png及原图独立尺寸/内容；透明区域不假定固定背景。未选范围为实际大小往返、手动1%–3200%限幅、拖动/边缘、极端fit、瞬态、006错误及图像编辑，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。
