# Browser Operations

**English** · [简体中文](browser.zh.md)

Read before opening a webpage, including an explicit external-browser request.
Open webpages via built-in Bridge. Only an explicit external or system-default
browser request permits the OS opener; pass the HTTP(S) URL as data, not shell
syntax. If denied or unavailable, report failure; never switch browsers.

For built-in browser calls, follow the [Bridge protocol](../README.md) and read
only the selected operation from the [browser contracts](../contracts/browser.jsonl).
Use actual tool schemas and authorization; this guide grants no access.
Desktop routes and source or artifact links use the
[frontend guide](../../scholarseed-frontend/README.md), not browser navigation.
