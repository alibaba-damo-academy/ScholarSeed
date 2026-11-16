# 共享示例项目

这里保存 PDFE、自动化测试和评测共用的可重建原始输入，不保存数据库、凭据、运行
工作空间、参考答案或截图。原则和边界见[共享示例设计](../docs/architecture/examples.md)。

## 当前入口

- `manifest.json` 的 `defaultProjectId` 是默认项目唯一真源；README 不参与解析。
- `projects/research/project.json` 描述基础项目，三个文件是合成输入，不是执行结果。
  `sample.md`、`sample.ts` 从原评测输入原样迁移，原有摘要保持不变。
- `projects/evaluation/project.json` 集中发布快评使用的合成原始资料，按已审阅的
  仓库样本逐字节复制并校验摘要；不改变 `research` 默认项目或历史冻结输入。
- `projects/connector-preview/project.json` 保存连接器 JSON 预览的合成输入；通过
  `resolveExample({ projectId: 'connector-preview' })` 和 `readExampleFile` 校验并读取，
  由人工复制到获准的隔离实例。`.invalid` 地址不代表可用服务，不自动创建项目、
  保存连接器或发起连接；预览前仍需确认读取配置的副作用。
- `projects/browser-navigation/project.json` 登记两张无外部资源的合成网页，仅供
  浏览器导航及查找准备；文件不提供站点服务，不证明目标产品可访问或产生浏览历史。
- `projects/skill-import/project.json` 登记技能导入专项的合成 `SKILL.md`；读取文件作为
  人工导入输入，不自动准备项目、安装技能或调用模型。导入前须核隔离目标、重名及授权。
- `projects/literature-ris/project.json` 登记文献导入专项的合成 RIS 题录；仅作为
  人工确认的原始输入，不自动导入或生成文献目录，导入前须核隔离目标及授权。
- `projects/pdf-multipage/project.json` 登记十页合成 PDF 原始输入，供多页阅读和查找；
  样本不是产品结果，导入须人工确认并核隔离目标及授权。
- `projects/pdf-image-only/project.json` 登记单页图片型无文本层合成 PDF，供条件专项
  准备；不承诺 OCR 或产品查找结果，导入须人工确认并核隔离目标及授权。
- `projects/image-secondary/project.json` 登记可与评测项目图片区分的合成图片；
  仅作为原始输入，文件选择须人工确认，不自动生成草稿或发送。
- `projects/resource-conflict/project.json` 登记资料冲突专项两份同名不同内容输入；
  分别用于隔离目标前态和人工确认的后续导入，样本不预置冲突或产品结果。
- `projects/resource-pagination/project.json` 登记同层 101 个合成文件，供资料树
  分页专项准备；准备器尚未真实运行此项目，人工导入和产品操作须分别确认授权。
- `projects/empty-document/project.json` 登记零字节 Markdown 原始输入，供有路径空文档
  保存专项准备；文件存在不代表已导入、编辑或保存，相关操作须分别授权。
- `projects/table-long/project.json` 登记 120 行、12 列的合成 CSV，供网格定位专项
  准备；文件不是产品结果，导入须人工确认并核隔离目标及授权。
- `workspaces/empty.json` 显式零项目，`workspaces/pair.json` 复用模板创建两个逻辑实例。
- `workspaces/scope-pair.json` 引用 `research` 与 `evaluation` 两份不同的合成项目，
  供跨项目范围检查准备；创建隔离实例和验证切换仍须分别授权。
- 公共读取能力位于 `scripts/shared/examples.cjs`；`resolveExample()` 选默认项目，
  `resolveExample({ workspaceId: 'pair' })` 选配方；`readExampleFile(file)` 重核后返回字节。

返回清单不可变，`contentDigest` 不含本机源目录，项目和文件通过 `key`、`id` 定位。
绝对 `sourcePath`、`sourceRoot` 只用于当前机器读取，不得固化进其他机器的配置。
`expectedDigest` 用于拒绝冻结输入变化，不提供自动恢复旧文件的能力。

## 评测使用

评测需要项目资料时，沿[评测执行规程](../apps/desktop/docs/architecture/evaluation.md)
以 `resolveExample({ projectId: 'evaluation' })` 调用公共清单和
`scripts/shared/preparation.cjs` 的 `prepareExample`，不再手写项目
或文件清单。先核真实目标API基址、任务隔离workspace和本轮授权，冻结内容摘要后
准备一次；API/目录匹配校验不能代替调用前的实例归属核验。

`empty` 配方通过公开项目目录的 `includeArchived=true` 查询校验真实登记；仅目录格式、
项目身份和工作空间有效且没有任何项目实体时返回就绪。已有默认项目或归档项目均明确
失败，不删除、归档或隐藏项目来制造空状态。默认项目和 `pair` 配方只新增对应实体，
不承诺整个工作空间的项目总数；存在的其他项目保持不变。

收据将模板key/文件id映射到真实项目ID及产品返回资料路径；准备仅证明原始输入就绪，
不证明评测通过。首条搜索→打开Markdown链由真实UI执行，准备阶段不先搜索或打开。
失败保存部分receipt及首错，不自动重跑创建。完整原始身份和独立判据留控制侧，Driver
只接收必要任务定位；静态接线不等于实际 Skill 调用或原生验收，实际结果查开发计划。
准备器通过正式项目与资料 API 准备并读回文本和已校验的二进制输入；这不代替导入
功能测试，导入行为由人工专项确认。题录原件存在于资料库不等于已导入文献中心。

## 状态与维护

当前已实现基础解析、完整性校验及空/双项目配方；本机 PDFE、真实项目 API/E2E 和
指定搜索评测链已消费同一输入。精确版本、截图与限制见
[开发计划](../work-records/proposals/2026-11-02/examples/plan.md)。本次用户明确仅要求本机
验收；跨运行电脑及 Windows 未验证，不据本机结果推定其兼容性。
远程资产获取、任务生成和历史恢复服务未实现，未知字段或能力不静默降级。

修改资料后使用公共 `fileMetadata(path)` 生成大小与摘要，更新对应修订及必要引用，
不要删除完整性校验。输入身份还须绑定仓库提交和未提交变化；摘要不能恢复原件。
需验证默认源目录无关性、实例隔离和实际消费，而不只检查 JSON。

聚焦契约测试：`node --test scripts/shared/__tests__/examples.test.cjs`，在仓库根运行。
公共模块本身不创建产品项目、不写原始输入、不启动程序、不联网，生产入口不得导入。
