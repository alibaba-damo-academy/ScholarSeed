# Markdown与代码需求构建依据

## Markdown 选区参考图：editor/16

`selection-20261113.png` 是 `tmp/test_snapshot/desktop/markdown-selection-observe-20261113/selection.png` 原字节副本，SHA-256 `d06f9f9ce7e2ee8226a20053a2f3b581675c8a6250df73c817146061158079d1`；2026-11-13 17:20 在 macOS arm64 `0.3.2 / 202611121823 / preview` 隔离实例获得，1280×840 完整视口已打开检查。图示合成 Markdown 的只读模式选区及工具栏，未点击工具栏；静图不证明选区添加、引用、发送或只读行为。隔离副本与 `examples/projects/evaluation/files/sample.md` 的采前后 SHA-256 均为 `a77fec4534bce0994a47e17a2bc4f862839a295ccfa82c08555180afb55ec1e0`；界面未显示脏态，但未读取内部编辑器状态，不能证明绝对无脏态。实例、公开版本、操作和副作用见忽略目录的 `observation.md`；首次附着误选 `about:blank` 的失败记录保留。未编辑、保存或发送；需求版本、采用状态及历史冻结不变。

## Markdown 预览选区候选：editor/15

新增 `EDITOR-SELECTION-CAND-001`，不改变已有稳定 ID、需求版本、采用范围或历史冻结。依据设计映射的用户截图及确认及[历史验收记录](../../../docs/design/mastergo/progress.md#2026-10-14-markdown-预览选区)：历史 macOS Desktop / Serve 曾观察拖选、悬停、添加到对话、取消选区及预览只读；记录中的本机忽略截图不证明目标包或 Windows。目标为 macOS arm64 `0.3.2 / 202611121823 / preview`，但该历史依据未绑定目标包；产品需求版本、适用与采用均待确认，目标包完整窗口参考图缺失，不以现有阅读图替代。

静态源码分析基点 `acce09fa42ddf234d84b02dde34b2ab4be570215`，相关三个文件无未提交差异；不声明源码与目标包同源或真实入口可达。[MarkdownDocument.tsx](../../../src/renderer/src/features/workbench/MarkdownDocument.tsx) SHA-256 `8df859b381e840c5de028fe815e68ec7e0e6568b50b255d313acb074dd53f5f1`：正文允许原生选字，`captureSelection` 检查正文选区并映射源文本、文档身份和修订，无法精确映射时标为 stale；[Selection.tsx](../../../src/renderer/src/features/workbench/Selection.tsx) SHA-256 `4d8ec82fcb5cd571246acb2669f4ef183e7933b9f1a4963bed0887756c378db3`：工具栏仅对可见且精确的选区提供操作，并调用添加上下文入口；[context.ts](../../../src/renderer/src/features/workbench/context.ts) SHA-256 `1ea6da8f020433dd5c82ff948e3d454233adbd6879c009b80eb5c3229fa4c377`：按来源和选区构造候选并加入输入上下文，成功后打开面板和聚焦输入器，不执行发送；项目文档脏态时会先尝试保存。源码只是实现线索，不作为采用或产品通过依据。

正常子链使用共享 `sample.md` 获准隔离副本，事前记录源文件摘要、项目及路径、可区分的普通正文片段和干净状态；核引用与原文及文档对应，不以页面自显内容作为唯一参照。打开可能更新最近文件，添加改变输入草稿；分别核读取、状态写入及草稿授权，脏态停止而非隐式授权保存。真实引用、目标包截图、跨平台和选区异常均未核；不触发发送或模型调用，不以对话混合引用展示或 PDF 选区替代该链。

## 需求与运行进度分离：editor/14

移除需求正文中笼统的历史“全部未实测”状态，运行进度与各轮结果以场景索引及运行记录为准；不改变稳定 ID、需求版本、采用范围、专项边界或历史冻结。

历史资产修订：`editor/13`；源码依据见[开发分支增量复核](#开发分支增量复核2026-11-04)。需求版本及判据不变，不回写已冻结运行。

## 202611121823 参考截图：editor/12

三张图是 2026-11-12 macOS arm64 安装版 `0.3.2 / 202611121823 / preview` 隔离实例的原图副本；目标 ASAR SHA-256 `0111fd20bd58bf72517a1255d2d1bbf7ef2a3d4281898baed50d250f13c9d91a`，均使用合成文档。`typescript-20261112.png` 对应 `EDITOR-OBS-003` 的文档展示子点，SHA-256 `612842dd80cd9f36527461e957dbdecc047567797602cac4140c32331e750615`；`find-first-20261112.png` 和 `find-second-20261112.png` 对应 `EDITOR-OBS-004` 的可视查找两个命中状态，SHA-256 分别为 `3dc7763ac336fb5f5e31f2d935f124abc2b49b451e1e9ac8ff30c329e891db2e`、`b982ef6787a7cfb847339b1a16203f09cfbc20e919b0f89ade4d01f42fb8818a`。截图为参考，不代替动作记录、独立参照或其他分支的验收；历史冻结和原始证据保留。

原始运行目录为 `tmp/test_snapshot/desktop/baseline-1823-batch2/`：上述三张副本依次对应 `supplement/evidence/editor-typescript.png`、`visual-find-driver/evidence/find-next.png`、`visual-find-driver/evidence/find-second.png`，均经逐字节核对一致。原始截图是忽略的运行证据，仅本机可回查，不作为永久可用链接。

## 202611121823 正常快评沿用：editor/11

依据用户统一采用记录及下文 editor/5 已采用的 EDITOR-OBS-001–004 正常阅读、模式和查找，本页对 `0.3.2 / 202611121823 / preview` 按既有[发布快评层](./requirements.md#发布快评层)保留相同子点；已读本页后续构建记录未发现已确认退役或修改这些正常要求的决定。此为有界沿用，不以新包实现或单次画面批准新需求，也不证明已检查完整变更史、源码与制品同源或产品符合。005目录仍待确认，006–007写入仍为专项；输入与查找参照须逐轮核实，原编号、版本、正文和历史运行不变。

## 共享示例输入对齐：editor/10

当前快评使用 `evaluation/document` 与 `evaluation/code`；其 SHA-256 分别为 `a77fec4534bce0994a47e17a2bc4f862839a295ccfa82c08555180afb55ec1e0`、`c9c2d80c1237488275599617c80a9d6f3aeb881847fa25ae6fd674d3a4dba2e8`，与下文 `research` 原件逐字节一致，项目身份与准备收据不能互换。准备不等于导入功能测试，导入由人工确认；目标包适用性待核，不代表实测通过。

## 202611121104参考图

`reference-20261112.png` 是 2026-11-12 macOS arm64 安装版 0.3.2 / 202611121104 / preview 的真实隔离实例截图，原图 `attempt-examples/evidence/editor-markdown.png`，SHA-256 `b72a4fa5a6ecc8d5eaf9975c200ae74897bd1d898ea7423bb98e33b296e6a577`；仅供阅读页面上下文，不证明编辑或其它未显示要求。原始运行在忽略目录 `tmp/test_snapshot/desktop/release-20261112-fresh/`。

## 历史修订：202610301343包内静态复核

资产修订：`editor/6`；本次只补指定新包来源、输入/独立参照与快评边界。原稳定ID、v`0.3`、采用规则、完整正文、参考图原版本/日期及历史结果保留；以下旧来源与修订记录均属历史，不代表本包绑定或本轮执行结论。

目标：macOS arm64 `0.3.0 / 202610301343 / preview`；ASAR SHA256 `1de63a11e99c47836053f546963db121ff0298c87b678dfb6d33b0855f2566ee`。来源为本任务已提取的实际安装包与松散renderer payload；源码提交未知，当前checkout/remote HEAD仅可辅助定位，不声明同源。证据清单为忽略目录 `tmp/test_snapshot/desktop/baseline-refresh-20261030-build1343/target.json`，包内定位均相对该根`package/`；不将临时提取目录当正式跨工作树资产。

包内`out/main/index.js` SHA256 `921baf36722c44629451c89048a9658727efc5150546535fa5428242250b504c`：1338的applicationRenderer在packaged时取applicationResources下renderer，41203的无开发URL分支交给serveAssets。该链绑定本次分析的实际松散payload，不证明运行时未设置开发覆盖，也不把静态入口当产品观察。

- `renderer/assets/index-CddcCmKt.js`：SHA256 `1b6e44c4557e06929bb82900f6147a456167e2f95b0173bacf561dd65bc668d3`。
- `renderer/assets/AccountMenuPanel-CHQ1thBC.js`：SHA256 `d8770acf89b086f5876c04d741dbf539d5b1b463d1c4a30ed82a2e311fa74e54`。
- `renderer/assets/MarkdownDocument-vxerKaIo.js`：SHA256 `f372fc42e0501afd5d2b071225341db7833cb64a64e32ea7bbe422232b822952`。
- `renderer/assets/MonacoDocument-D4UmyngX.js`：SHA256 `5036a2bf2f27aea00dbdbb88046a85a85db31c33ca910955e5c7b336bddafbf2`。

包内Markdown:857 markdownTextMatches仍按文本块匹配，1350–1382 runFind按当前selection选下一个match并派发TextSelection及scrollIntoView；2179/2235限制visual及preview只读。原sample.md反斜杠公式、两次普通正文EDITOR-NEEDLE及sample.ts仍是独立原件，不改标记、结构或查询条件。004仍须实际从首处定位到末处，不以2次计数或代码中的scrollIntoView声明修复/通过；历史Next定位问题保留。005标题目录仍无新增正向采用依据；新包Monaco与视觉模式的完整历史/写入链留专项，不据普通阅读批准。

需求正文中的样本指仓库原件的获准隔离副本；执行前登记原件摘要→任务项目ID/导入后实际路径的映射，历史`eval-*-20261030`只是旧运行别名，不假定新安装中存在。项目/资源、列偏好及API最小投影尚需本轮获准独立取证；静态相容不证明正常UI已可达或实测通过。本次未启动、连接或操作产品，未读用户状态/凭据，未调用外部API；不改变运行状态，不缩减未就绪专项。

## 历史构建与分层记录


修订：editor/5。依据2026-10-30用户统一采用规则，以已绑定安装版v0.3.0 / 202610281438 / preview的已核实正常行为作为v`0.3`需求依据；复用现有源码、精确产物绑定及独立需求/数据Review。EDITOR-OBS-001–004正常模式/阅读/定位/查找及006–007已绑定的编辑、撤销重做、替换和保存时格式化已采用；006–007仍属未授权执行的写入专项。005标题目录继续待确认，标题格式/锚点/查找不替代；只读工具与视图一致性、错误/大文档的未明反馈及未核实独立全文格式化入口不由正常采用批准。全部未实测，不增加产品或写入权限。

修订3的005依赖与工具栏注入依据保留；本修订仅变更采用状态，七个ID、判据和需求版本不变。保存与关闭分别复用[saving](../saving/requirements.md)及[tabs008](../tabs/requirements.md)已采用的适用部分，未确认异常不因引用批准，不另建平行判据。

## 同精确制品绑定

目标已安装macOS 0.3.0 / 202610281438 / preview，已重核Info.plist及product.json。ASAR SHA256=`1e4c075a908ba990e54b6ccf173d3af3f811587a4436a9866042e46d8b4656d3`；`out/main/index.js:41022`的packaged serveAssets仍指向applicationResources(app)/renderer。只绑定所读文件/函数，不宣称整仓一致。

| Contents/Resources/renderer下文件 | 本轮重核SHA256 |
| --- | --- |
| assets/index-C4-PYlXk.js | `22fcb548da45b8fd2f549622e11fb6cf2e97d5d2196ec79c56160b6a74d0fa57` |
| assets/AccountMenuPanel-CZYu9yKi.js（workspace chunk） | `fe2d49b09ad2f7d3134775d006fd077653559d4476c7a7a6c1d90c09dd99aa00` |
| assets/MarkdownDocument-DOJpEUB5.js（Markdown chunk） | `6a720de9eb90695518e9dc986420d92a8ea0dd7b0242108fd55d529e74f39ebd` |
| assets/MonacoDocument-DuLjuy1W.js（Monaco chunk） | `3f34b35eb42d3fa38ec4ad3e8015995922f1072605d4d5acab71a83c5c6e9dfe` |
| assets/language-Dg2sX3_5.js | `2aaab07cb8984c45e2a21f1aa347882b31ced829dbdff0be27b1564eb2aba222` |
| assets/host-C3hHywqw.js | `73863cc075afde1d605e69f6ef419dca657bdd05040cc980253b579e11d4adbf` |
| assets/text-DENNjrt4.js | `1e67549842ad337039abb00fbd78a3c006f2e830d47598c6c6e23d0c61aba0f1` |
| monaco.html | `061c4300ef242a3b4fe51ef1c72e179c60720a535beacd71d1313cc9c3bdfbb2` |
| assets/monaco-73j06PWP.js | `a65e875337224f9df58e46cb29e00faccc411c482e76e941cb9fa1bd3540fdef` |
| assets/runtime-CWikByOe.js | `2528a25e90226d9a0199ec2158e638bffdcf47a247538196fc34feb6de0c81bf` |

index:64396/64399动态导入Markdown/Monaco；Markdown chunk:6又导入Monaco与formatTextOnSave。Monaco chunk开头导入host/language/text；[monaco/host.tsx](../../../src/renderer/src/features/workbench/monaco/host.tsx):24创建同源monaco.html，安装版HTML显式加载monaco-73j06PWP.js，其动态依赖runtime-CWikByOe.js。实际编辑宿主还有iframe runtime，不能只读外层React就断言语法能力完整。

后端限公开加载与能力：本轮逐文件比较仓库apps/serve与安装包backend/python/lib/python3.12/site-packages，`service/workbench/api/routes.py`两边SHA=`7a6ea90eea38c3a750c4b96eab3818000f65d1f35fd946b79f66862305348727`，`service/workbench/domain/model.py`两边SHA=`4b83232e05dd762b420f4743c2f55ba15c21742ea6ba7f32f332818c492b391e`。保存后端Owner与终态复用saving，不重复整链分析。

## 固定、动态、条件与真实入口

| 条目 | 当前源码与包映射、独立参照 |
| --- | --- |
| 001 条件 | [feature.tsx](../../../src/renderer/src/features/workbench/feature.tsx):65/101分别注册Markdown及code Viewer，不同于消息渲染。[MarkdownDocument.tsx](../../../src/renderer/src/features/workbench/MarkdownDocument.tsx):418的Header、:1803的visualDisabled/sourceActive与Markdown chunk:997/2179区分preview/edit/source；源码用Monaco，preview用只读视觉编辑器。:1810按lightweightText禁用视觉模式；[limits.ts](../../../src/renderer/src/features/workbench/limits.ts):6/38使大于10MiB Markdown走轻量源码路径，普通code也使用轻量模型。[workspace.ts](../../../src/renderer/src/features/workbench/workspace.ts):2089的setTabView仅服务Markdown、离开edit先prepare，切模式本身不证明保存。[MonacoDocument.tsx](../../../src/renderer/src/features/workbench/MonacoDocument.tsx):307/314把Markdown source与普通preview区分；其可写性仍取capabilities.can_edit。实际open投影与已知样本核身份，不以扩展名推断权限 |
| 002 固定输入/动态 | MarkdownDocument.tsx:983建立Crepe，:1182 setReadonly，:1187注入mathCompatibility/literalLatex/tableColumnInheritance；Markdown chunk:1676。[mathematics.ts](../../../src/renderer/src/features/workbench/mathematics.ts):33/76规范化正文反斜杠数学分隔符，保护代码/既有math等范围，chunk:271/399。样本因此使用反斜杠内联/块公式，而非凭空假设语法。代码块CodeMirror默认previewOnlyByDefault，:1013；代码块查看/编辑不等于程序执行。列表/表格来自已启用Crepe功能；样本原文为结构/公式参照，不固定CSS像素 |
| 003 动态/条件 | MonacoDocument.tsx:307创建editor，languageFor(path)来自[language.ts](../../../src/renderer/src/features/workbench/language.ts):4/14，language chunk:27；ts/tsx映射typescript，未知回退plaintext。[syntax.ts](../../../src/renderer/src/features/workbench/syntax.ts):11/30注册TypeScript tokenization，[monaco/runtime.ts](../../../src/renderer/src/features/workbench/monaco/runtime.ts):107创建模型，包含find/folding等模块而不是执行器。:623–641的goToLine校验行数、revealLineInCenter。:746的wrap写editorWordWrap偏好，非修改文本；工具栏readOnly仅看capabilities而editor还看viewKind，预览工具禁用一致性待真实验证 |
| 004 动态 | MarkdownDocument.tsx:238的markdownTextMatches只匹配各textblock直接文本子节点、不跨块，大小写折叠；chunk:857。:819/868/1556通过查找对话框、前后/Enter/Shift+Enter选择并scrollIntoView，chunk:1360；无结果显示独立文案。MonacoDocument.tsx:182/721调用原生actions.find，替换另列007；[find.ts](../../../src/renderer/src/features/workbench/find.ts)负责查找控件空间。用两次普通正文标记核范围，不把数学节点或表格跨单元匹配强行并入Markdown可视文本计数 |
| 005 未明 | 已读MarkdownDocument、feature注册及必要依赖，发现标题格式命令/菜单与片段定位，但未核到独立标题目录UI/生成链。MarkdownDocument.tsx:592的navigateFragment使用[anchors.ts](../../../src/renderer/src/features/workbench/anchors.ts):70解析显式锚点/参考文献锚点，不等于自动生成heading TOC。保留README原业务“标题目录”的需求/入口缺口，不编造按钮，不以标题样式菜单或查找替代；采用前需确认目标与真实可达路径 |
| 006 写入专项 | MarkdownDocument.tsx:725/779只在可写用户编辑时commitVisualEdit，:883使用Milkdown history undo/redo，chunk:对应runMarkdownShortcut；MonacoDocument.tsx:342/474/674按lightweight模型原生history或workspace.undo/redo处理。source和visual模式有不同编辑器历史，不能要求跨模式统一undo栈。以事前文本与本轮动作后的真实内容对比；保存另引SAVE-OBS-002，不以内部dirty/shared session自证成功 |
| 007 写入专项 | MonacoDocument.tsx:732的替换工具及code.replace走原生Monaco替换，capabilities不足时禁用按钮；实际editor readonly仍需模式核对。Markdown视觉格式动作在:1048–1176按标题/列表/代码/表格/数学组构造，非通用源码替换。全文件格式化只有[format.ts](../../../src/renderer/src/features/workbench/format.ts):63的formatTextOnSave路径，Monaco chunk:47216；Markdown/Monaco保存delegate按formatOnSave调用，失败warning不等于提交失败。未恢复出独立“格式化全文”工具栏入口，不将原生快捷猜成已开放功能 |

快捷动作按[shortcuts.ts](../../../src/renderer/src/shortcuts.ts):161–183及实际焦点/覆盖配置解析；Markdown只读时仅允许find/selectAll，其余写入命令不应借快捷键越权。Monaco原生控件/iframe与外层焦点需真实观察，不从注册表证明键盘链已通过。

## 数据与独立判据

[sample.md](../../../../../examples/projects/research/files/sample.md)为明确合成输入：首目标H1、三个H2区块，普通无序/有序列表、两行数据表、TypeScript代码块、内联和块公式、末目标。`EDITOR-NEEDLE`仅在首末普通正文各一次，供可视与源码基本字面查找；`EDITOR-END-OMEGA`唯一。公式期望表达式为a²+b²=c²及1至3求和等于6，不以当前页面公式反推原文答案。没有外部链接、图片或网络地址，不要求打开代码块程序。

[sample.ts](../../../../../examples/projects/research/files/sample.ts)仅TypeScript语法输入：类型、对象数组、纯函数声明及字符串，无导入、执行调用、网络、凭据或代码内联注释。`CODE-NEEDLE`出现两次，首末分别为`CODE-BEGIN-ALPHA`、`CODE-END-OMEGA`；文件文本与独立行序可作跳行/首末边界参照。它不是“程序运行结果”，不得执行或新增产品依赖/tsconfig来验证。所有输入尚未导入，不含预先保存/替换完成的答案；真实编辑在获准隔离副本进行。

本修订输入身份：sample.md为644字节，SHA256=`a77fec4534bce0994a47e17a2bc4f862839a295ccfa82c08555180afb55ec1e0`；sample.ts为466字节，SHA256=`c9c2d80c1237488275599617c80a9d6f3aeb881847fa25ae6fd674d3a4dba2e8`。后续若改输入，应更新摘要与独立预期，不覆盖已冻结运行的输入。

公开参照为同一项目/路径的GET `/api/workbench/open`顶层身份、viewer、revision、capabilities与GET content字节/ETag；这些不提供编辑器当前模式、游标、选区或命中视口。展示/跳转以事前样本内容、独立行序与真实UI前后位置共同判断，不能读取内部store或controller自证。编辑/替换的期望改动范围需执行前明确，格式化以预先约定结构与语义不变条件核，不将当前格式化输出自动采用为标准。

## 副作用、边界与未就绪

005有界补核：Markdown实际依赖`vendor-editor-g2OvD714.js`的SHA256为`3baa80d7576afaccea1422afc35e904c8cd1bd7034ec8865141e940bdd6b8a30`，:73234–73247的CrepeFeature枚举未给出TOC类型；依赖中的`outline`命中为CSS焦点轮廓，不是目录。Dock.tsx:137的工具栏贡献沿[features.ts](../../../src/renderer/src/contracts/features.ts):390汇总，当前源码注册仅[resources/feature.tsx](../../../src/renderer/src/features/resources/feature.tsx):58的`resource-agent-origin`；目标index chunk:69840–69846同样为来源任务动作，不是标题目录。以上消除将格式菜单、CSS或该工具栏注入误当目录的依据，但没有获得真实可达的目录正向证据，也不证明全产品绝无目录。005继续保留待确认，不以负面检索自动采用、退役或判失败；不再重复同范围扫描，下一步需要明确产品目标或获准真实入口证据。

正常打开沿store最近文件记录及偏好链写入MRU；Monaco换行开关经[store.tsx](../../../src/renderer/src/store.tsx):1877/2428持久editorWordWrap。模式切换会prepare尚未投影的视觉编辑并修改内存；外部focus/指针/窗口失焦可能触发已有autoSave，实际风险及授权沿saving。Markdown图片上传、外部链接、剪贴板和AI替换不属于本页轻量观察；样本未包含这些输入，不据此删除原业务。

已复用前批适用AGENTS、build-baseline/source、persistence及DESIGN/vibe。没有产品启动/观察或参考图，不造图；普通模式切换仅对已知干净副本执行，编辑/撤销/替换/格式化分支预先另核权限。当前缺真实UI可达性、标题目录能力依据、各模式readonly一致性、错误/大文档及完整编辑交互证据；小型样本不宣称覆盖所有语法、布局、编码和异常组合。无图、未导入或缺授权不改判产品，也不将完整专项删成仅预览。

## 发布快评分层（2026-10-30）

本资产修订为editor/5；按用户发布前快评目标和统一采用规则，在同一requirements追加快评层与专项层，复用本页已绑定源码、精确产物与既有Review，旧v`0.3`业务版本和完整判据不变。所选来源为EDITOR-OBS-001–004的正文明确子要点；必要参照为已有eval-editor-20261030.md/.ts及原件行参照；不敲正文，遇脏态停止。未选范围为全模式循环、跳行/换行偏好、全部查找选项、005目录待确认与006–007编辑/替换/格式/保存写入，缺依据部分仍待确认。

本次仅完成执行前分层，不产生产品通过结论，不覆盖历史完整运行；后续运行消费经独立Review冻结的子要点，不能将快评结果宣称覆盖原ID全量。当前构建未新增产品操作或数据写入权限。

## 开发分支增量复核（2026-11-04）

源码复核时资产修订：`editor/7`。本节为最新源码辅助记录；后续导航修订见文件顶部。前文安装包定位、修订及结果保持历史身份，不绑定本轮开发实例。原稳定ID、v`0.3`、需求正文、采用状态与快评/专项边界不变。

分析基点为 `shushen_release/mvp_v0.3.1.1_preview` 的提交 `d178f12d91ad3d82e797df6f9455ed49f13bbd2b`；复核时下列源码相对该提交无暂存或未暂存差异。[MarkdownDocument.tsx](../../../src/renderer/src/features/workbench/MarkdownDocument.tsx) 的实际 SHA-256 为 `9c27e37387ba09c47379455a1ed7784dc81050d1df685a61d57ff5ae05ac9cd6`。

- 查找链：第977–1017行的 `runFind` 以当前查询及selection选择匹配项，派发 `TextSelection`、查找标记和 `scrollIntoView`。相对前文旧包描述，第1011–1016行另定位当前host的直属 `.milkdown` 容器，通过匹配坐标调整 `scrollTop`；这只是当前实现事实，不证明历史Next定位问题已经修复。
- 独立参照不变：使用正文引用的共享原始 `sample.md`/`sample.ts` 的获准隔离副本，登记原始摘要与真实项目/路径映射；查找仍须比较实际正文前后位置，不能以命中计数、源码滚动调用或内部store代替终态证据。
- 动作边界不变：只在已知干净副本观察和查找，不向正文输入；脏态、意外写回或输入摘要漂移按执行规程停止。此记录不扩张编辑、保存、替换、全部模式或标题目录专项。

本次仅静态复核并追加来源，不执行产品。后续run须用本轮启动和实际构建来源绑定开发实例，另取真实查找终态；前文ASAR/编译chunk摘要、本节源码及历史截图均不能替代本轮运行证据。
