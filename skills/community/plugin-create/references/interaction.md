# 自定义交互：载荷与生命周期

本指南使用 schema 2 的既有语义，不授予能力或替代真实使用验收。

## 同一份 values，两层校验

组件的 input_schema 描述宿主传入的 data；动作 input_schema 描述用户提交的 values。
对于 interaction.answer，组件 output_schema 也校验同一份 values，不校验外层回答信封。
例如用户提交 `{ "feedback": "保持当前范围" }`：

```json
{
  "type": "object",
  "properties": { "feedback": { "type": "string" } },
  "required": ["feedback"],
  "additionalProperties": false
}
```

将该 schema 同时用于确认动作 input_schema 和组件 output_schema。
不要在 output_schema 要求 action，或在提交时偷偷添加未声明的 stage。
宿主返回给 AI 的回答才是 `{ "action": "confirm", "values": { "feedback": "保持当前范围" } }`。
预览场景添加 `"submissions": { "confirm": [{ "feedback": "保持当前范围" }] }`，保留该动作正常 responses。
样例检查不执行 JavaScript，不证明所有运行分支都合法；预览操作及实际运行仍需验证。

## 保存与提交

```javascript
try {
  const receipt = await window.plugin.save({ feedback });
  savedRevision = receipt.revision;
  savedDraft = receipt.state;
  showSaved();
} catch (error) {
  showUnsaved(error);
}
```

这些变量和展示函数由卡片实现。草稿是 JSON 对象；不能比较 receipt.state 与字符串。
保存失败保留本地输入。提交使用 `window.plugin.submit("confirm", { feedback })`，没有业务 Promise；
等待 onState 更新，不能自行宣告流程成功。恢复时使用宿主 draft，不用默认值覆盖已经保存的选择。

## 本地编辑不是宿主快照

维护独立的当前编辑模型；输入、增删项、排序和优先级操作立即写入该模型。保存和确认的事件处理器在点击时读取这个模型，
不要捕获上次 render 的 values 副本。用户选填的字段不能被校验器变成必填；移除最后一项是否允许必须由业务要求决定。

首次挂载从 draft 恢复（空数组、false 和空字符串也是有效选择），缺失字段才回退到 data/default。
onState 是宿主快照通知，不是“丢弃未保存修改”的指令。相同 data/draft 的状态、语言或主题变化不能清空本地编辑；
保存期间继续输入时，旧保存回执不能覆盖较新的输入。保存成功记录提交时的编辑修订，只有本地修订未变化才标记全部已保存。
真正的新流程数据或外部草稿变化应明确合并/冲突策略；不在每次 onState 开头无条件把编辑模型置空。
非 pending 时禁用回答提交，但已完成的展示卡仍可提供获准的只读查看操作。

交付前逐项操作：连续修改两个值、不失焦立即确认、增删项后确认、保存期间继续输入、失败重试、关闭重开恢复。
逐项核对宿主实际收到的 values，不能只检查界面文字变化或预览样例通过。

## 回答和宿主能力调用分开

`plugin.submit` 只用于回答等待中的交互，不能用来打开文献、导航、保存或入库；display 卡没有等待中的回答，
因此在 display 卡上调用 submit 不会获得导航结果。
宿主能力使用 `await plugin.request(actionId, values)`，动作须在包内声明且在当前调用上下文有实际处理器。
成功、取消、失败分别呈现；捕获拒绝并保留当前内容，不把“已发送”当“已打开”。

声明 `navigation.open` 或 `literature.read` 并不自动生成任意文献 API。
当前通用自定义组件的 plugin-call 只接通 skills.list、navigation.skills；文献查看等能力由对应公共文献卡的领域端口提供，
不能将公共卡中的 action 名复制到通用自定义卡就承诺它可用。需要当前未开放能力时说明缺口并与用户确定可用流程，
不要生成无效“打开原文”按钮、静默降级或绕隔离使用 window.open。

## 最小合法发布与载荷

`describe` 的 component_invocation_schema 是实际 request/display 请求 schema，bridge_request_max_bytes 是桥传输的字节上限。
生成的 Skill 应先从本会话 catalog 核实实际 slot，再发送包含 request_id、slot、data、title 的完整请求；
display 同样需要 title。prompt 用于说明要决定什么，不代替 title。
预先按 UTF-8 测量序列化请求体，不能用字符数或组件 data 的校验上限代替传输上限。
卡片仅携带当前步骤所需的结构化摘要、稳定条目 ID 和证据指针，不塞入整篇正文、重复长段或全量历史。
超过上限时按业务阶段拆分，保留完整证据在持久工作目录中；不要先反复发超大请求再逐个猜必填字段。
修订 data 或 title 后换新 request_id，相同参数的运输重试才沿用原 ID。

## 多阶段与修订

每一步写清输入、用户决定、返回值、后续动作和取消路径。范围确认后才选择材料，材料确认后才构建大纲；
依赖用户决定的步骤不得提前执行。请求 ID 由步骤和修订轮组成；同参数投递重试复用原 ID，
用户修改目标或大纲后用新修订轮 ID。失败保留输入、取消不推进、结果未知先核对，不盲目重复业务。

最终交付分别说明包检查、预览、安装和实际使用的证据；没有实际执行的环节明确未验证。
