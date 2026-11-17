# 任务 Canvas

[English](canvas.md) · **简体中文**

先读[交互规则](interaction.zh.md)，了解操作外层、真实决策和失败边界；Canvas 不需普通展示指南。
生成或修改 Canvas 时用[设计指南](../DESIGN.md)选择布局与控件，发布前按实际源码检查首屏、窄布局和宿主动作。

Canvas 是任务页面，不是普通回答、Markdown 或图表的包装。读取随包 [Canvas 签名](../canvas.md)。
缺失/不匹配时通过 component/catalog 请求 {slot:"canvas.ui",include_ui:true,ui_mode:"canvas"}，
确需完整 Schema 才加 ui_detail:"schema"。优先 OpenUI，只有无法表达的行为才使用 HTML/CSS/JavaScript。

请求外层为 {request_id,title,slot:"canvas.ui",data}。data 包含 format（openui-lang 或 html）、version:1、source，
可选 initial_state、interaction。Interaction 有 actions（rollback、cancel、submit）和 output_schema；
非阻塞展示省略 interaction 并用 component/display，等待决定则声明 interaction 并用 component/request。
动作必须含 submit 或 cancel，按钮由宿主拥有。内容变化需新 request ID，request_file 同其他组件。

多行源码宜由脚本写完整 JSON 请求并传 request_file，避免嵌套转义。
HTML 脚本作用域用模块或立即执行函数，不覆盖 history、location 等浏览器全局。

OpenUI 用 root = Stack([...]) 和具名字段。绑定和派生值保持本地；
不用 Query、Mutation、@Run、@ToAssistant、@OpenUrl 或宿主工具。
提交解包 {componentType,value}，绑定映射字段名而非 $ 局部变量名，保留嵌套、空值、false、零；
output_schema 必须匹配该 JSON。Rollback 本地恢复旧状态，不通知 Agent。

HTML 在不透明沙箱运行，无网络、文件系统、原生 API 或父 DOM 访问。
注册 window.canvas.register({onRestore(state),onRollback(),onCancel(),onSubmit()})。
onRestore 收初始/保存状态；canvas.save(json) 保存 JSON 草稿；
onRollback 本地更改页面并返回恢复状态；onSubmit 返回当前 JSON 或 Promise；
onCancel 本地清理但不提交值，处理失败保留输入供重试。绝不伪装宿主消息。

会话和工作台共享一个实例，移动不重跑脚本。重开恢复保存 JSON，不恢复 JavaScript 闭包。
只有通过 Schema 且后端确认的提交恢复 Agent；取消返回 cancelled，不带未保存值。
失败、到期、未知不算确认，应恢复已有交互而非另建一个。
