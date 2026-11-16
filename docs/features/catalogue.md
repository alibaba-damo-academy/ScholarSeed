# 文献分类与项目作用域

修改文献分类树、项目导航、归类或分类/标签删除时读取本页。这里保留当前 Owner、
必要决策理由与验证约束，不把旧提案的 implemented/active 状态作为今天的验收结果。

## Owner 与身份

- [Literature 仓储](../../apps/serve/service/literature/persistence/store.py) 拥有分类与文献关联；
  [Catalogue API](../../apps/serve/service/literature/api/catalogue.py) 校验项目作用域并投影导航。
- Content 拥有项目身份和实时项目目录。Literature 保存稳定项目 ID，不复制项目名称、
  路径或第二套项目注册表，不在文献域删除项目。
- 文献元数据可跨项目复用，分类关系按作用域隔离。空项目作用域表示全局分类；父子分类
  必须在同一作用域，改父节点还需拒绝环。分类 ID 与名称不等于项目身份。
- Desktop 的 [Collection](../../apps/desktop/src/renderer/src/features/literature/Collection.tsx)
  等调用方消费这套协议。写入目标须明确携带项目/父分类，不从当前列表筛选猜测权限。

## 导入条目身份与操作重放

[身份定义](../../apps/serve/service/literature/schema.py) 的 `new_item_id` 使用 UUID，
[题录转换](../../apps/serve/service/literature/service/metadata.py) 生成新身份，
[列表追加](../../apps/serve/service/literature/service/catalog.py) 不按 DOI、标题或字节摘要
合并既有条目。条目身份用于定位行，不是重复判定；重复导入不得覆盖用户已编辑的
题录、分类、标签或笔记。[仓储](../../apps/serve/service/literature/persistence/store.py)
按主键更新已有行仍用于显式编辑/视图回写，不因存在 upsert 就判定导入在去重。

[导入编排](../../apps/serve/service/literature/service/importer.py) 的 operation_id
标识一次可恢复操作：显式相同操作重试可读回旧收据，缺省则生成新操作身份。
内容 fingerprint 用于绑定来源，不能自动当作 operation_id，否则重新导入相同文件
会被误判为旧操作重放。检索结果池去重、条目追加、操作幂等与附件文件身份分开；
附件独占副本及历史共享路径限制见[附件资产边界](selections.md#托管附件删除与翻译输入故障)。
旧提案的清空数据库承诺不构成当前清库或迁移授权。

## 导入落点与列表更新

[Catalogue 状态 Owner](../../apps/desktop/src/renderer/src/features/literature/catalog.ts)
从明确的项目/分类筛选推导落点；“未整理”不是分类，不能携带分类 ID，标签也不参与
落点。后端仍校验实际作用域，不能以 UI 选中替代授权。常驻面板通过状态请求导入，
由重新挂载的列表消费，不依赖已卸载页面的 DOM 事件监听。

导入成功后的 `imported` 一次性失效列表/面板/标签缓存并更新 reload；
[LiteratureList](../../apps/desktop/src/renderer/src/features/literature/LiteratureList.tsx)
同时清理查询输入及标签筛选，避免旧搜索防抖再次写回。该刷新方法自身不会统一
重置所有排序或页码，不能照搬旧方案“所有新文献立即出现在第一页”的保证。
验证应分别观察落点、筛选、分页、计数、列表可见性与实际保存，不以刷新成功证明落库。

### 文献 PDF 文件拖放

文献列表的[文件拖放入口](../../apps/desktop/src/renderer/src/features/literature/LiteratureList.tsx)
仅在 `hasDraggedFiles` 为真时拦截拖拽，避免把表头列拖拽误作导入；嵌套进入计数
维持高亮，drop 复用当前查询推导的项目/分类落点和 `importPdfFiles` 的逐文件结果。
每个文件独立成功或失败，至少一项落地才清空旧搜索与标签并刷新目录；关闭导入结果
不应导航离开文献页。修改时核[列表契约](../../apps/desktop/src/renderer/src/features/literature/list.test.ts)
及[真实 Electron 拖放用例](../../apps/desktop/e2e/literature-drop-workbench.spec.ts)，
分别观察空态、混合文件、项目作用域和原生文件拖入；旧截图不是当前构建的证明。

## 题录元数据批量同步

[批量工作集](../../apps/desktop/src/renderer/src/features/literature/batch.ts)属于 Desktop
Renderer 进程，[同步接线](../../apps/desktop/src/renderer/src/features/literature/synchronization.ts)
复用单篇 `papermeta` 查询、文献更新 API 与 `literatureTasks` 的单篇互斥；后端没有独立的
批量任务或重启恢复。关闭进度对话框、卸载文献列表不终止进程内工作集，应用退出则不保留。
选中项按捕获的项目作用域逐条处理；批量只自动写回 DOI/arXiv 的唯一标识符查询，
标题模糊命中需要单篇确认，不能因进入批量流程而跳过确认或覆盖用户编辑。
请求串行且有间隔；配额错误使后续未开始项暂缓。取消只阻止未开始项，已发出的查询与
保存仍须收尾；失败、配额、暂缓和取消项可显式重试，成功及未命中不在重试集。

修改时先核[批量契约](../../apps/desktop/src/renderer/src/features/literature/batch.test.ts)
与 [papermeta 契约](../../apps/serve/tests/contract_literature_papermeta.py)，再在真实
Desktop 分别观察混合 DOI/arXiv/标题、落库、429、取消后的在途保存、面板关闭重开及
窄窗滚动；旧截图和曾经的四条样本不证明当前构建或 Windows 已通过。

## 为什么复用分类表

全局分类与项目分类共享树、CRUD 与文献关联机制，只增加作用域，不另建一套项目分类服务。
项目导航先读取 Content 的实时项目维表，再聚合 Literature 关系；因此空项目和改名也能
正确投影，不从当前文献页或分页结果反推项目清单。失效项目关系不进入此导航，但读侧
隐藏不授权删除历史关系或反向恢复项目。

当前唯一索引按作用域、父分类和名称约束同级重名，并用 `COALESCE` 处理空作用域/根节点。
不要恢复旧“两项 partial index 限制整个作用域同名”的描述；SQLite 的 `NULL` 语义也不能
靠普通 `UNIQUE(project_id,name)` 猜测。修改索引应以仓储声明及实际 schema 检查为准。

## 删除与资产保留

当前 `delete_collection` 按作用域选择根、递归列出同作用域子树，事务内从深到浅删除分类；
分类关联随所属外键语义解除，不删除文献条目。`delete_tag` 解除标签关联而非文献本身。
删除影响范围须在危险操作前清楚呈现；成功后失效筛选、树和计数应一致更新。
代码有删除函数不能证明真实 UI 已正确确认或资产在所有失败路径保留。

旧开发期“用户删除旧数据库”“不做 ALTER”不是当前操作授权。现行仓储具名检查 schema、
已知旧索引及增量 notes 字段；迁移必须按实际 Owner 与[持久化约束](../architecture/persistence.md)
保护用户资产，不因文档迁移重建数据库或清空分类。

## 验证选择

先定位[仓储契约](../../apps/serve/tests/contract_literature_store.py)与实际 API 契约入口；
用隔离数据库核验全局/A/B 分类隔离、同级重名、父子跨域/环拒绝、子树计数与筛选、
分类/标签删除后文献及其他项目关系保留、未知项目拒绝、重启后资产保留。
不能只检查表存在或健康接口就宣称业务通过。

真实 Desktop 另需创建多层分类、切换项目、过滤、确认父分类删除与标签删除，检查文献仍在；
鼠标/键盘、主题、错误与失效筛选分别取证。本知识治理不运行此产品流，未验收保持明确。
