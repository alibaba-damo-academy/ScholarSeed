# 浏览器操作

[English](browser.md) · **简体中文**

打开网页前读取，包括用户明确要求外部浏览器的情况。默认通过内置 Bridge 打开。
仅当用户明确要求外部或系统默认浏览器时才允许使用系统打开器；HTTP(S) URL
必须作为数据传递，不能拼成 Shell 语法。拒绝或不可用时报告失败，不换浏览器。

调用内置浏览器时遵循 [Bridge 协议](../README.md)，只读取
[浏览器契约](../contracts/browser.jsonl)中的目标操作。使用真实工具 Schema 和授权，
本指南不授予访问权限。Desktop 页面路由、来源及产物链接遵循
[前端指南](../../scholarseed-frontend/README.md)，不能用网页导航代替。
