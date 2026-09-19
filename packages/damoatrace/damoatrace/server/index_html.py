"""damoatrace trace UI — 单文件内嵌 HTML/CSS/JS 资产 (从 http.py 抽出, P2-01).

纯前端资产, 与 server 逻辑零共享状态; http.py 只在 do_GET 返回它一次。
"""

from __future__ import annotations

INDEX_HTML = r"""<!doctype html>
<html lang="zh" data-theme="light" data-density="cozy">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TraceSystem · AI 调用追踪</title>
  <style>
  /* TraceSystem — design tokens & base styles (ported 1:1 from design styles.css) */
  :root {
    --bg: oklch(0.992 0.002 250);
    --surface: oklch(1 0 0);
    --surface-2: oklch(0.975 0.003 250);
    --surface-hover: oklch(0.965 0.004 250);
    --surface-active: oklch(0.95 0.008 250);
    --border: oklch(0.92 0.005 250);
    --border-strong: oklch(0.85 0.008 250);
    --text: oklch(0.22 0.012 250);
    --text-2: oklch(0.42 0.012 250);
    --muted: oklch(0.58 0.01 250);
    --muted-2: oklch(0.72 0.008 250);
    --accent: oklch(0.55 0.14 255);
    --accent-bg: oklch(0.96 0.025 255);
    --accent-border: oklch(0.88 0.05 255);

    --hue-llm: oklch(0.62 0.13 255);
    --hue-llm-bg: oklch(0.96 0.025 255);
    --hue-tool: oklch(0.6 0.12 165);
    --hue-tool-bg: oklch(0.96 0.025 165);
    --hue-user: oklch(0.65 0.13 75);
    --hue-user-bg: oklch(0.97 0.03 75);
    --hue-retrieval: oklch(0.6 0.13 305);
    --hue-retrieval-bg: oklch(0.97 0.025 305);
    --hue-error: oklch(0.6 0.16 25);
    --hue-error-bg: oklch(0.97 0.03 25);
    --hue-system: oklch(0.55 0.02 250);
    --hue-system-bg: oklch(0.96 0.005 250);
    --hue-root: oklch(0.42 0.012 250);
    --hue-root-bg: oklch(0.95 0.004 250);
    --hue-subagent: oklch(0.6 0.16 350);
    --hue-subagent-bg: oklch(0.97 0.03 350);
    --hue-worker: oklch(0.6 0.12 165);
    --hue-workflow: oklch(0.6 0.14 40);
    --hue-turn: oklch(0.5 0.06 255);
    --hue-turn-bg: oklch(0.965 0.008 255);
    --hue-ok: oklch(0.62 0.12 150);

    --font-ui: "Manrope", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;

    --row-h: 30px;
    --row-pad: 10px;
    --radius: 8px;
    --radius-sm: 6px;
    --radius-lg: 12px;

    --shadow-sm: 0 1px 2px oklch(0.2 0.01 250 / 0.04);
    --shadow-md: 0 4px 16px oklch(0.2 0.01 250 / 0.06), 0 1px 2px oklch(0.2 0.01 250 / 0.04);
    --shadow-lg: 0 12px 40px oklch(0.2 0.01 250 / 0.1);
  }

  [data-theme="dark"] {
    --bg: oklch(0.16 0.008 250);
    --surface: oklch(0.195 0.008 250);
    --surface-2: oklch(0.22 0.009 250);
    --surface-hover: oklch(0.25 0.01 250);
    --surface-active: oklch(0.29 0.012 250);
    --border: oklch(0.28 0.01 250);
    --border-strong: oklch(0.36 0.012 250);
    --text: oklch(0.96 0.004 250);
    --text-2: oklch(0.82 0.008 250);
    --muted: oklch(0.62 0.012 250);
    --muted-2: oklch(0.48 0.01 250);
    --accent: oklch(0.75 0.14 255);
    --accent-bg: oklch(0.28 0.05 255);
    --accent-border: oklch(0.42 0.08 255);

    --hue-llm: oklch(0.78 0.13 255);
    --hue-llm-bg: oklch(0.28 0.06 255);
    --hue-tool: oklch(0.75 0.13 165);
    --hue-tool-bg: oklch(0.27 0.05 165);
    --hue-user: oklch(0.8 0.13 75);
    --hue-user-bg: oklch(0.3 0.06 75);
    --hue-retrieval: oklch(0.78 0.13 305);
    --hue-retrieval-bg: oklch(0.28 0.06 305);
    --hue-error: oklch(0.78 0.16 25);
    --hue-error-bg: oklch(0.3 0.07 25);
    --hue-system: oklch(0.72 0.015 250);
    --hue-system-bg: oklch(0.26 0.01 250);
    --hue-root: oklch(0.82 0.008 250);
    --hue-root-bg: oklch(0.24 0.008 250);
    --hue-subagent: oklch(0.78 0.15 350);
    --hue-subagent-bg: oklch(0.3 0.06 350);
    --hue-worker: oklch(0.75 0.13 165);
    --hue-workflow: oklch(0.78 0.14 40);
    --hue-turn: oklch(0.8 0.06 255);
    --hue-turn-bg: oklch(0.25 0.015 255);
    --hue-ok: oklch(0.78 0.13 150);

    --shadow-sm: 0 1px 2px oklch(0 0 0 / 0.3);
    --shadow-md: 0 4px 16px oklch(0 0 0 / 0.35), 0 1px 2px oklch(0 0 0 / 0.25);
    --shadow-lg: 0 12px 40px oklch(0 0 0 / 0.45);
  }

  [data-density="compact"] { --row-h: 26px; --row-pad: 8px; }
  [data-density="cozy"] { --row-h: 30px; --row-pad: 10px; }
  [data-density="comfortable"] { --row-h: 36px; --row-pad: 12px; }

  * { box-sizing: border-box; }
  html, body, #root { height: 100%; margin: 0; }
  body {
    font-family: var(--font-ui);
    background: var(--bg);
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  button { font-family: inherit; }

  .app { display: grid; grid-template-rows: 48px auto 1fr; height: 100vh; background: var(--bg); }

  .topbar {
    display: grid; grid-template-columns: 240px 1fr auto;
    align-items: center; gap: 16px; padding: 0 14px 0 16px;
    border-bottom: 1px solid var(--border); background: var(--surface);
  }
  .brand { display: flex; align-items: center; gap: 9px; font-weight: 600; letter-spacing: -0.01em; font-size: 13.5px; }
  .brand-mark { width: 22px; height: 22px; border-radius: 6px;
    background: linear-gradient(135deg, var(--text) 0%, var(--text-2) 100%);
    position: relative; flex-shrink: 0; }
  .brand-mark::before, .brand-mark::after { content: ""; position: absolute; background: var(--surface); }
  .brand-mark::before { left: 5px; top: 5px; width: 8px; height: 1.5px; }
  .brand-mark::after { left: 5px; top: 9px; width: 12px; height: 1.5px; box-shadow: 0 4px 0 var(--surface); }
  .brand-env { font-family: var(--font-mono); font-size: 10.5px; color: var(--muted);
    padding: 2px 7px; border: 1px solid var(--border); border-radius: 4px; margin-left: 4px; }

  .search { display: flex; align-items: center; gap: 8px; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: 7px; padding: 0 10px; height: 30px;
    max-width: 520px; width: 100%; justify-self: center; transition: border-color .15s, background .15s; }
  .search:focus-within { border-color: var(--accent); background: var(--surface); }
  .search input { flex: 1; border: 0; outline: 0; background: transparent; color: var(--text);
    font-family: var(--font-ui); font-size: 12.5px; }
  .search input::placeholder { color: var(--muted-2); }
  .search-kbd { font-family: var(--font-mono); font-size: 10.5px; color: var(--muted);
    padding: 1.5px 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); }

  .topbar-right { display: flex; align-items: center; gap: 4px; }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px;
    border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--text-2);
    cursor: pointer; transition: all .12s; }
  .icon-btn:hover { background: var(--surface-2); color: var(--text); }
  .icon-btn[data-active="true"] { background: var(--surface-2); border-color: var(--border); color: var(--text); }
  .icon-btn.spin svg { animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .avatar { width: 26px; height: 26px; border-radius: 50%;
    background: linear-gradient(135deg, oklch(0.7 0.12 75) 0%, oklch(0.6 0.13 25) 100%);
    display: inline-flex; align-items: center; justify-content: center; color: white; font-size: 11px;
    font-weight: 600; margin-left: 6px; }

  .main { display: grid; grid-template-columns: 240px minmax(0, 1fr) 420px; overflow: hidden; min-height: 0; }
  .app[data-context-view="true"] .main { grid-template-columns: 240px minmax(0, 1fr); }
  .app[data-context-view="true"] .detail { display: none; }

  .sidebar { border-right: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; min-height: 0; }
  .sidebar-section { padding: 14px 12px 6px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .section-title { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); white-space: nowrap; }
  .section-action { font-size: 11px; color: var(--muted); cursor: pointer; padding: 2px 6px; border-radius: 4px; white-space: nowrap; flex-shrink: 0; }
  .section-action:hover { background: var(--surface-2); color: var(--text); }
  .session-group-label { padding: 12px 4px 8px; font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; }
  .session-group-label.first { padding-top: 0; }

  .session-list { padding: 0 8px 12px; overflow-y: auto; flex: 1; min-height: 0; }
  .session-row { display: grid; grid-template-columns: 8px 1fr auto; gap: 8px; align-items: center;
    padding: 7px 8px; border-radius: var(--radius-sm); cursor: pointer; margin-bottom: 1px; }
  .session-row:hover { background: var(--surface-hover); }
  .session-row[data-active="true"] { background: var(--surface-active); }
  .session-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--hue-ok); }
  .session-dot[data-status="error"] { background: var(--hue-error); }
  .session-dot[data-status="running"] { background: var(--accent); animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .session-meta { min-width: 0; }
  .session-id { font-family: var(--font-mono); font-size: 11.5px; color: var(--text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: -0.01em; }
  .session-sub { font-size: 10.5px; color: var(--muted); display: flex; align-items: center; gap: 6px;
    margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .session-sub-sep { width: 2px; height: 2px; border-radius: 50%; background: var(--muted-2); flex-shrink: 0; }
  .session-count { font-family: var(--font-mono); font-size: 10.5px; color: var(--muted);
    padding: 1px 6px; border: 1px solid var(--border); border-radius: 4px; }

  .sidebar-footer { border-top: 1px solid var(--border); padding: 10px 12px; display: flex; gap: 8px;
    align-items: center; font-size: 11px; color: var(--muted); }

  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--border); border-bottom: 1px solid var(--border); }
  .stat { background: var(--surface); padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }
  .stat-label { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; }
  .stat-row { display: flex; align-items: baseline; gap: 8px; }
  .stat-value { font-family: var(--font-mono); font-size: 19px; font-weight: 500; letter-spacing: -0.02em; color: var(--text); }
  .stat-unit { font-family: var(--font-mono); font-size: 11px; color: var(--muted); }
  .stat-delta { font-family: var(--font-mono); font-size: 10.5px; color: var(--hue-ok); display: inline-flex; align-items: center; gap: 2px; }
  .stat-delta[data-dir="down"] { color: var(--hue-error); }
  .spark { height: 22px; margin-top: 2px; }

  .center { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--bg); }
  .center-toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; flex-wrap: wrap; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 9px; font-size: 11.5px; color: var(--text-2);
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 5px; cursor: pointer; white-space: nowrap; }
  .chip:hover { background: var(--surface-hover); color: var(--text); }
  .chip[data-active="true"] { background: var(--accent-bg); border-color: var(--accent-border); color: var(--accent); }
  .chip-dot { width: 6px; height: 6px; border-radius: 2px; }
  .tabbar { display: flex; gap: 4px; margin-left: auto; }
  .tab { font-size: 12px; padding: 4px 10px; border-radius: 5px; color: var(--muted); cursor: pointer; border: 1px solid transparent; }
  .tab[data-active="true"] { color: var(--text); background: var(--surface-2); border-color: var(--border); }

  .trace-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; min-height: 0; }
  .empty-note { padding: 40px; color: var(--muted); text-align: center; font-size: 12.5px; }

  .trace-card { border-bottom: 1px solid var(--border); background: var(--surface); }
  .trace-head { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto auto auto auto; gap: 12px;
    align-items: center; padding: 10px 14px; cursor: pointer; border-left: 2px solid transparent; }
  .trace-head:hover { background: var(--surface-2); }
  .trace-card[data-open="true"] .trace-head { border-left-color: var(--accent); }
  .chev { width: 14px; height: 14px; color: var(--muted); transition: transform .15s; }
  .trace-card[data-open="true"] .chev { transform: rotate(90deg); }
  .trace-name { font-size: 13px; font-weight: 500; color: var(--text); display: flex; align-items: center; gap: 8px; min-width: 0; }
  .trace-name-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .trace-id { font-family: var(--font-mono); font-size: 11px; color: var(--muted); padding: 1px 6px;
    border: 1px solid var(--border); border-radius: 4px; flex-shrink: 0; }

  /* agent identity badge — 区分 main / subagent / worker / workflow / peer */
  .agent-badge { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-mono); font-size: 10.5px;
    font-weight: 500; padding: 1px 7px; border-radius: 4px; border: 1px solid; white-space: nowrap; flex-shrink: 0;
    color: var(--hue-system); background: var(--hue-system-bg); border-color: color-mix(in oklch, var(--hue-system), transparent 72%); }
  .agent-badge[data-role="main"] { color: var(--hue-llm); background: var(--hue-llm-bg); border-color: color-mix(in oklch, var(--hue-llm), transparent 72%); }
  .agent-badge[data-role="subagent"] { color: var(--hue-subagent); background: var(--hue-subagent-bg); border-color: color-mix(in oklch, var(--hue-subagent), transparent 72%); }
  .agent-badge[data-role="worker"] { color: var(--hue-worker); background: var(--hue-tool-bg); border-color: color-mix(in oklch, var(--hue-worker), transparent 72%); }
  .agent-badge[data-role="workflow"] { color: var(--hue-workflow); background: var(--hue-user-bg); border-color: color-mix(in oklch, var(--hue-workflow), transparent 72%); }
  .child-pill { display: inline-flex; align-items: center; gap: 3px; font-family: var(--font-mono); font-size: 10px;
    padding: 1px 6px; border-radius: 4px; cursor: pointer; flex-shrink: 0;
    color: var(--hue-subagent); background: var(--hue-subagent-bg); border: 1px solid color-mix(in oklch, var(--hue-subagent), transparent 65%); }
  .child-pill:hover { filter: brightness(1.05); text-decoration: underline; }
  .jump-link { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; color: var(--hue-subagent);
    font-size: 12px; padding: 7px 11px; border: 1px solid color-mix(in oklch, var(--hue-subagent), transparent 65%);
    border-radius: var(--radius-sm); background: var(--hue-subagent-bg); margin-bottom: 8px; }
  .jump-link:hover { filter: brightness(1.04); }
  .link-kv { font-family: var(--font-mono); font-size: 11px; color: var(--text-2); }
  /* sidebar: parent link line for subagent sessions */
  .session-parent { font-size: 10px; color: var(--hue-subagent); font-family: var(--font-mono); margin-top: 1px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .badge { display: inline-flex; align-items: center; gap: 5px; font-family: var(--font-mono); font-size: 10.5px;
    font-weight: 500; padding: 2px 7px; border-radius: 4px; border: 1px solid; white-space: nowrap; }
  .badge-ok { color: var(--hue-ok); background: var(--hue-tool-bg); border-color: color-mix(in oklch, var(--hue-ok), transparent 70%); }
  .badge-error { color: var(--hue-error); background: var(--hue-error-bg); border-color: color-mix(in oklch, var(--hue-error), transparent 70%); }
  .badge-running { color: var(--accent); background: var(--accent-bg); border-color: var(--accent-border); }
  .badge-muted { color: var(--muted); background: var(--surface-2); border-color: var(--border); }

  .trace-metric { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2); display: inline-flex; align-items: baseline; gap: 4px; }
  .trace-metric-unit { color: var(--muted); font-size: 10.5px; }

  .waterfall { border-top: 1px solid var(--border); display: grid; grid-template-columns: minmax(280px, 0.9fr) 1fr; background: var(--surface); }
  .wf-head { display: contents; font-size: 10.5px; color: var(--muted); }
  .wf-head > div { padding: 6px 14px; background: var(--surface-2); border-bottom: 1px solid var(--border);
    font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; }
  .wf-axis-ticks { position: relative; height: 24px; background: var(--surface-2); border-bottom: 1px solid var(--border); overflow: hidden; }
  .wf-tick { position: absolute; top: 0; bottom: 0; border-left: 1px dashed var(--border); padding-left: 4px;
    font-family: var(--font-mono); font-size: 10px; color: var(--muted); display: flex; align-items: center; }

  .span-row { display: contents; cursor: pointer; }
  .span-name-cell { display: flex; align-items: center; gap: 6px; padding: 6px 14px; border-bottom: 1px solid var(--border); background: var(--surface); min-width: 0; }
  .span-row:hover .span-name-cell, .span-row:hover .span-bar-cell { background: var(--surface-2); }
  .span-row[data-active="true"] .span-name-cell, .span-row[data-active="true"] .span-bar-cell { background: var(--accent-bg); }
  .span-row[data-active="true"] .span-name-cell { box-shadow: inset 2px 0 0 var(--accent); }
  .span-tree-toggle { width: 14px; height: 14px; color: var(--muted); cursor: pointer; flex-shrink: 0;
    display: inline-flex; align-items: center; justify-content: center; }
  .span-tree-toggle.invisible { visibility: hidden; }
  .span-tree-toggle svg { transition: transform .15s; }
  .span-type-dot { width: 8px; height: 8px; border-radius: 2px; flex-shrink: 0; }
  .span-type-llm { background: var(--hue-llm); }
  .span-type-tool { background: var(--hue-tool); }
  .span-type-user { background: var(--hue-user); }
  .span-type-retrieval { background: var(--hue-retrieval); }
  .span-type-error { background: var(--hue-error); }
  .span-type-system { background: var(--hue-system); }
  .span-type-root { background: transparent; border: 1.5px solid var(--text-2); border-radius: 50%; }
  .span-type-subagent { background: var(--hue-subagent); }
  .span-type-turn { background: transparent; border: 1.5px solid var(--accent); border-radius: 2px; }
  .span-label { font-size: 12px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1; }
  .span-label .mono { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2); }
  .span-tag { font-family: var(--font-mono); font-size: 10px; color: var(--muted); padding: 0 5px; border: 1px solid var(--border); border-radius: 3px; flex-shrink: 0; }
  .span-error-mark { width: 14px; height: 14px; color: var(--hue-error); flex-shrink: 0; }

  .span-bar-cell { position: relative; padding: 6px 14px; border-bottom: 1px solid var(--border); border-left: 1px solid var(--border);
    background: var(--surface); display: flex; align-items: center; min-height: calc(var(--row-h) - 2px); }
  .span-bar-track { position: relative; height: 14px; width: 100%;
    background: linear-gradient(to right, var(--border) 1px, transparent 1px); background-size: 10% 100%;
    background-repeat: repeat-x; background-position: 0 50%; }
  .span-bar { position: absolute; top: 2px; bottom: 2px; border-radius: 2px; display: flex; align-items: center;
    padding: 0 5px; font-family: var(--font-mono); font-size: 10px; color: var(--text); min-width: 4px; }
  .span-bar-llm { background: color-mix(in oklch, var(--hue-llm), transparent 55%); border-left: 2px solid var(--hue-llm); }
  .span-bar-tool { background: color-mix(in oklch, var(--hue-tool), transparent 55%); border-left: 2px solid var(--hue-tool); }
  .span-bar-user { background: color-mix(in oklch, var(--hue-user), transparent 55%); border-left: 2px solid var(--hue-user); }
  .span-bar-retrieval { background: color-mix(in oklch, var(--hue-retrieval), transparent 55%); border-left: 2px solid var(--hue-retrieval); }
  .span-bar-error { background: color-mix(in oklch, var(--hue-error), transparent 55%); border-left: 2px solid var(--hue-error); }
  .span-bar-system { background: color-mix(in oklch, var(--hue-system), transparent 60%); border-left: 2px solid var(--hue-system); }
  .span-bar-root { background: color-mix(in oklch, var(--text-2), transparent 75%); border-left: 2px solid var(--text-2); }
  .span-bar-subagent { background: color-mix(in oklch, var(--hue-subagent), transparent 55%); border-left: 2px solid var(--hue-subagent); }
  /* turn 是容器: 空心描边条, 读作"这一轮的时间窗", 不与内部实心条抢视觉 */
  .span-bar-turn { background: color-mix(in oklch, var(--accent), transparent 92%);
    border: 1px solid color-mix(in oklch, var(--accent), transparent 60%); border-left: 2px solid var(--accent); }
  /* turn 行 = 分组带: 微底色 + 加粗; hover/选中态优先 */
  .span-row[data-type="turn"]:not([data-active="true"]):not(:hover) .span-name-cell,
  .span-row[data-type="turn"]:not([data-active="true"]):not(:hover) .span-bar-cell {
    background: var(--hue-turn-bg); }
  .span-row[data-type="turn"] .span-label { font-weight: 600; }
  .turn-summary { font-family: var(--font-mono); font-size: 10.5px; color: var(--muted); font-weight: 400; margin-left: 8px; }
  .span-bar-duration { margin-left: 6px; color: var(--text-2); font-family: var(--font-mono); font-size: 10.5px; white-space: nowrap; }

  .detail { border-left: 1px solid var(--border); background: var(--surface); display: flex; flex-direction: column; min-height: 0; }
  .detail-empty { flex: 1; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px;
    color: var(--muted); font-size: 12px; padding: 40px; text-align: center; }
  .detail-empty-mark { width: 36px; height: 36px; border-radius: 50%; border: 1px dashed var(--border-strong);
    display: inline-flex; align-items: center; justify-content: center; color: var(--muted-2); }
  .detail-head { padding: 14px 16px 12px; border-bottom: 1px solid var(--border); flex-shrink: 0; }
  .detail-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .detail-title { font-size: 14.5px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4px; display: flex; align-items: center; gap: 8px; word-break: break-all; }
  .detail-id { font-family: var(--font-mono); font-size: 11.5px; color: var(--muted); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .copy-btn { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px;
    border: 0; background: transparent; color: var(--muted); border-radius: 3px; cursor: pointer; }
  .copy-btn:hover { background: var(--surface-2); color: var(--text); }

  .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--border); border-bottom: 1px solid var(--border); }
  .detail-grid-cell { background: var(--surface); padding: 9px 16px; }
  .detail-grid-label { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; margin-bottom: 2px; }
  .detail-grid-value { font-family: var(--font-mono); font-size: 12px; color: var(--text); }

  .detail-tabs { display: flex; gap: 2px; padding: 8px 12px 0; border-bottom: 1px solid var(--border); flex-shrink: 0; flex-wrap: wrap; }
  .detail-tab { font-size: 12px; padding: 6px 10px; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent;
    margin-bottom: -1px; display: flex; align-items: center; gap: 5px; }
  .detail-tab[data-active="true"] { color: var(--text); border-color: var(--accent); }
  .detail-tab-count { font-family: var(--font-mono); font-size: 10px; padding: 1px 5px; background: var(--surface-2); border-radius: 3px; color: var(--muted); }

  .detail-body { flex: 1; overflow-y: auto; min-height: 0; padding: 14px 16px; }
  .detail-section { margin-bottom: 18px; }
  .detail-section-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
  .detail-section-title { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; }
  .detail-note { color: var(--muted); font-size: 12px; }

  .message-block { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; margin-bottom: 8px; background: var(--surface); }
  .message-head { padding: 7px 11px; background: var(--surface-2); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; justify-content: space-between; font-size: 11px; }
  .message-role { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; font-size: 10.5px; }
  .message-role[data-role="user"] { color: var(--hue-user); }
  .message-role[data-role="assistant"] { color: var(--hue-llm); }
  .message-role[data-role="system"] { color: var(--hue-system); }
  .message-role[data-role="tool"] { color: var(--hue-tool); }
  .message-body { padding: 10px 12px; font-size: 12.5px; white-space: pre-wrap; word-break: break-word; line-height: 1.55; color: var(--text); }
  .message-body.mono { font-family: var(--font-mono); font-size: 11.5px; }

  .json { font-family: var(--font-mono); font-size: 11.5px; line-height: 1.55; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; overflow-x: auto; color: var(--text); }
  .json-row { display: flex; align-items: flex-start; min-height: 18px; }
  .json-key { color: var(--accent); }
  .json-string { color: var(--hue-tool); white-space: pre-wrap; word-break: break-word; }
  .json-number { color: var(--hue-retrieval); }
  .json-bool { color: var(--hue-user); }
  .json-null { color: var(--muted); }
  .json-bracket { color: var(--text-2); }
  .json-toggle { width: 12px; height: 12px; display: inline-flex; align-items: center; justify-content: center;
    color: var(--muted); cursor: pointer; flex-shrink: 0; margin-right: 2px; }
  .json-toggle.placeholder { visibility: hidden; }
  .json-toggle svg { transition: transform .12s; }
  .json-collapsed-summary { color: var(--muted); margin: 0 4px; }

  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-family: var(--font-mono); font-size: 11.5px;
    border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; background: var(--surface-2); }
  .kv dt { color: var(--muted); }
  .kv dd { margin: 0; color: var(--text); word-break: break-all; }

  /* ===== Logs view (new) ===== */
  .log-aggregate { display: flex; gap: 16px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--border);
    background: var(--surface); flex-wrap: wrap; font-size: 11.5px; color: var(--muted); }
  .agg-pill { display: inline-flex; align-items: center; gap: 6px; font-family: var(--font-mono); }
  .agg-count { color: var(--text); }
  .log-table { display: flex; flex-direction: column; }
  .log-row { display: grid; grid-template-columns: 96px 14px 130px 1fr; gap: 10px; align-items: baseline;
    padding: 6px 14px; border-bottom: 1px solid var(--border); cursor: default; }
  .log-row:hover { background: var(--surface-2); }
  .log-time { font-family: var(--font-mono); font-size: 10.5px; color: var(--muted); }
  .log-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted-2); align-self: center; }
  .log-row[data-level="warning"] .log-dot, .log-row[data-level="warn"] .log-dot { background: var(--hue-user); }
  .log-row[data-level="error"] .log-dot { background: var(--hue-error); }
  .log-row[data-level="info"] .log-dot { background: var(--accent); }
  .log-row[data-level="debug"] .log-dot { background: var(--muted-2); }
  .log-logger { font-family: var(--font-mono); font-size: 11px; color: var(--hue-retrieval); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .log-event { font-size: 12px; color: var(--text); }
  .log-event .lk { color: var(--muted); }
  .log-event .lv { font-family: var(--font-mono); color: var(--text-2); }
  .log-sid { font-family: var(--font-mono); font-size: 10px; color: var(--muted-2); margin-left: 6px; }

  /* ===== Metrics view (new) ===== */
  .metrics-wrap { padding: 14px; display: flex; flex-direction: column; gap: 20px; }
  .metrics-block-title { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; margin-bottom: 8px; }
  .mtable { width: 100%; border-collapse: collapse; font-size: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .mtable th { text-align: right; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted);
    font-weight: 600; padding: 7px 12px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
  .mtable th:first-child, .mtable td:first-child { text-align: left; }
  .mtable td { padding: 6px 12px; border-bottom: 1px solid var(--border); font-family: var(--font-mono); color: var(--text); }
  .mtable tr:last-child td { border-bottom: 0; }
  .mtable td.name { font-family: var(--font-mono); color: var(--text); }
  .mtable .barcell { position: relative; }
  .mtable .bar { position: absolute; left: 0; top: 3px; bottom: 3px; background: color-mix(in oklch, var(--hue-llm), transparent 78%); border-radius: 2px; }
  .mtable .slow { color: var(--hue-error); }

  /* ===== Context view ===== */
  .context-wrap { padding: 14px; display: flex; flex-direction: column; gap: 18px; }
  .context-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
  .context-stat { min-width: 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); }
  .context-stat-label { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; }
  .context-stat-value { margin-top: 3px; color: var(--text); font-family: var(--font-mono); font-size: 17px; }
  .context-section-title { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.07em; font-weight: 600; margin-bottom: 8px; }
  .context-channels { display: flex; flex-wrap: wrap; gap: 6px; }
  .context-channel { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface-2); color: var(--text-2); font-family: var(--font-mono); font-size: 11px; }
  .context-channel[data-channel="research"] { color: var(--accent); background: var(--accent-bg); border-color: var(--accent-border); }
  .context-channel-count { color: var(--muted); }
  .context-list { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; background: var(--surface); }
  .context-row { display: grid; grid-template-columns: 88px minmax(96px, 0.8fr) minmax(72px, 0.45fr) minmax(180px, 1.4fr) minmax(0, 1.25fr); gap: 10px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 11.5px; }
  .context-row:last-child { border-bottom: 0; }
  .context-row[data-trace-span] { cursor: pointer; }
  .context-row[data-trace-span]:hover { background: var(--surface-2); }
  .context-time, .context-ref { color: var(--muted); font-family: var(--font-mono); font-size: 10.5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .context-op { color: var(--text-2); font-family: var(--font-mono); }
  .context-items { color: var(--text); font-family: var(--font-mono); }
  .context-op[data-channel="research"] { color: var(--accent); }
  .context-head { color: var(--muted); background: var(--surface-2); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 600; cursor: default; }
  .context-snapshot { grid-template-columns: 88px minmax(86px, 0.8fr) minmax(112px, 0.8fr) minmax(170px, 1.25fr) auto; }
  .context-actions { display: inline-flex; align-items: center; gap: 5px; }
  .context-inspect { border: 1px solid var(--border-strong); border-radius: 4px; padding: 4px 7px; background: var(--surface); color: var(--text-2); font: 10.5px var(--font-mono); white-space: nowrap; cursor: pointer; }
  .context-inspect:hover { color: var(--text); background: var(--surface-2); border-color: var(--accent-border); }
  .context-detail { margin: 0 10px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); overflow: hidden; }
  .context-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 11px; border-bottom: 1px solid var(--border); color: var(--text-2); font: 10.5px var(--font-mono); }
  .context-detail-body { padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .visible-entry { border: 1px solid var(--border); border-radius: 4px; background: var(--surface); overflow: hidden; }
  .visible-entry-head { display: flex; align-items: center; gap: 7px; padding: 8px 10px; font: 10.5px var(--font-mono); color: var(--text-2); flex-wrap: wrap; }
  .visible-entry-label { color: var(--text); }
  .visible-entry-channel { color: var(--accent); }
  .visible-entry-head .context-inspect { margin-left: auto; }
  .context-content { border-top: 1px solid var(--border); }
  .context-content summary { cursor: pointer; padding: 7px 10px; color: var(--muted); font: 10.5px var(--font-mono); }
  .context-content pre { max-height: 270px; overflow: auto; margin: 0; padding: 10px; border-top: 1px solid var(--border); background: var(--surface-2); color: var(--text); font: 11.5px/1.55 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  .context-section-note { margin: -2px 0 8px; color: var(--muted); font-size: 11px; }
  .context-modebar { display: inline-flex; margin-bottom: 10px; padding: 2px; border: 1px solid var(--border); border-radius: 5px; background: var(--surface-2); }
  .context-mode { border: 0; border-radius: 3px; padding: 5px 9px; background: transparent; color: var(--muted); font: 10.5px var(--font-mono); cursor: pointer; }
  .context-mode[data-active="true"] { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }
  .context-item-grid, .channel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 9px; align-items: start; }
  .context-item-card, .channel-card { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); overflow: hidden; }
  .context-item-card[data-status="open"] { border-top: 2px solid var(--accent); }
  .context-item-card[data-status="closed"] { border-top: 2px solid var(--border-strong); }
  .context-item-card-head, .channel-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 10px 7px; }
  .context-item-channel, .channel-card-name { color: var(--accent); font: 11px var(--font-mono); }
  .context-item-kind, .channel-card-count { margin-left: 6px; color: var(--muted); font: 10px var(--font-mono); }
  .context-item-status, .channel-card-visible { color: var(--muted); font: 10px var(--font-mono); white-space: nowrap; }
  .context-item-preview { min-height: 34px; margin: 0 10px; color: var(--text); font-size: 12px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .context-item-meta { display: flex; flex-wrap: wrap; gap: 4px 9px; padding: 8px 10px; color: var(--muted); font: 10px var(--font-mono); }
  .context-item-card > .context-inspect { margin: 0 10px 10px; }
  .lifecycle-list { position: relative; display: flex; flex-direction: column; gap: 8px; }
  .lifecycle-list::before { content: ""; position: absolute; left: 6px; top: 7px; bottom: 7px; width: 1px; background: var(--border-strong); }
  .lifecycle-event { position: relative; display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 7px; }
  .lifecycle-marker { position: relative; z-index: 1; width: 8px; height: 8px; margin: 5px 0 0 2px; border: 2px solid var(--surface-2); border-radius: 50%; background: var(--accent); }
  .lifecycle-event[data-kind="not_visible"] .lifecycle-marker { background: var(--muted); }
  .lifecycle-event[data-kind="retained_after_compaction"] .lifecycle-marker { background: var(--hue-ok); }
  .lifecycle-event[data-kind="replaced"] .lifecycle-marker, .lifecycle-event[data-kind="ended"] .lifecycle-marker, .lifecycle-event[data-kind="compacted"] .lifecycle-marker { background: var(--hue-warn); }
  .lifecycle-event-body { min-width: 0; padding: 7px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--surface); }
  .lifecycle-event-head { display: flex; flex-wrap: wrap; gap: 5px 8px; align-items: center; font: 10px var(--font-mono); }
  .lifecycle-kind { color: var(--text); }
  .lifecycle-time, .lifecycle-turn, .lifecycle-note { color: var(--muted); }
  .lifecycle-preview { margin-top: 5px; color: var(--text-2); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lifecycle-content { margin-top: 6px; border-top: 1px solid var(--border); }
  .lifecycle-content summary { padding-top: 6px; color: var(--muted); cursor: pointer; font: 10px var(--font-mono); }
  .lifecycle-content pre { max-height: 240px; overflow: auto; margin: 6px 0 0; padding: 8px; background: var(--surface-2); color: var(--text); font: 11px/1.55 var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  .channel-event-list { display: flex; flex-direction: column; border-top: 1px solid var(--border); }
  .channel-event { display: grid; grid-template-columns: 76px 72px minmax(0, 1fr) minmax(0, 1fr) auto; gap: 7px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--border); font: 10px var(--font-mono); }
  .channel-event:last-child { border-bottom: 0; }
  .channel-event-kind { color: var(--text); }
  .channel-event[data-kind="visible"] .channel-event-kind { color: var(--accent); }
  .channel-event[data-kind="not_visible"] .channel-event-kind { color: var(--muted); }
  .channel-event[data-kind="ended"] .channel-event-kind { color: var(--hue-warn); }
  .channel-event-time, .channel-event-turn, .channel-event-detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
  .item-timeline { border-top: 1px solid var(--border); background: var(--surface-2); }
  .item-timeline-head { padding: 10px; border-bottom: 1px solid var(--border); color: var(--text); font-size: 12px; font-weight: 600; }
  .item-timeline-subtitle { margin-top: 3px; color: var(--muted); font: 10.5px var(--font-mono); font-weight: 400; }
  .item-timeline-body { padding: 10px; display: flex; flex-direction: column; gap: 10px; }
  .context-muted { color: var(--muted); }
  .context-error { color: var(--hue-error); padding: 10px; font-size: 11px; }
  @media (max-width: 1100px) { .context-snapshot { grid-template-columns: 82px minmax(80px, 0.8fr) minmax(90px, 0.7fr) minmax(0, 1fr) auto; } }
  .context-head:hover { background: var(--surface-2); }
  .context-empty { padding: 24px 14px; color: var(--muted); font-size: 12px; }
  @media (max-width: 1100px) { .context-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); } .context-row { grid-template-columns: 82px minmax(82px, 0.8fr) 70px minmax(0, 1.1fr); } .channel-event { grid-template-columns: 70px 66px minmax(0, 1fr) auto; } .channel-event-turn { display: none; } }

  .tweaks { position: fixed; right: 16px; bottom: 16px; width: 248px; background: var(--surface);
    border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: 12px 14px 14px; z-index: 50; }
  .tweaks.collapsed { width: auto; padding: 0; }
  .tweaks-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; cursor: pointer;
    font-size: 11.5px; font-weight: 600; color: var(--text-2); }
  .tweaks-hd { font-size: 12px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .tweaks-x { cursor: pointer; color: var(--muted); border: 0; background: transparent; font-size: 13px; }
  .tweak-sect { font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); padding: 8px 0 4px; }
  .seg { display: flex; padding: 2px; border-radius: 8px; background: var(--surface-2); gap: 2px; }
  .seg button { flex: 1; border: 0; background: transparent; color: var(--text-2); font: inherit; font-size: 11.5px;
    padding: 4px 6px; border-radius: 6px; cursor: pointer; }
  .seg button[data-on="1"] { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); }
  .swatches { display: flex; gap: 6px; }
  .swatch { width: 100%; height: 26px; border-radius: 6px; border: 1px solid var(--border); cursor: pointer; }
  .swatch[data-on="1"] { box-shadow: 0 0 0 2px var(--accent); }

  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 10px; border: 2px solid var(--surface); }
  ::-webkit-scrollbar-thumb:hover { background: var(--border-strong); }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
  "use strict";
  // ===================== TraceSystem — vanilla JS, fed by the real damoatrace API =====================
  // 设计稿 (Claude Design handoff) 1:1 复刻为零依赖原生 JS; 数据来自 /api/* (真实 ~/.veda/logs)。

  const ICONS = {
    search: 'M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM11 11l3 3',
    chevron: 'M6 3l4 5-4 5',
    refresh: ['M14 8a6 6 0 0 1-10.5 4','M2 8a6 6 0 0 1 10.5-4','M2 2v4h4','M14 14v-4h-4'],
    sun: ['M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z','M8 1v1M8 14v1M1 8h1M14 8h1M3 3l.7.7M12.3 12.3l.7.7M3 13l.7-.7M12.3 3.7l.7-.7'],
    moon: 'M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5Z',
    settings: ['M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z','M12.5 8c0-.3 0-.6-.1-.9l1.4-1.1-1.5-2.5-1.7.6c-.4-.3-.9-.6-1.4-.8L9 1.5h-3l-.2 1.8c-.5.2-.9.5-1.4.8l-1.7-.6L1.2 6l1.4 1.1c0 .3-.1.6-.1.9s0 .6.1.9L1.2 10l1.5 2.5 1.7-.6c.4.3.9.6 1.4.8l.2 1.8h3l.2-1.8c.5-.2.9-.5 1.4-.8l1.7.6 1.5-2.5-1.4-1.1c.1-.3.1-.6.1-.9Z'],
    clock: ['M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z','M8 4.5V8l2.5 2'],
    bolt: 'M9 1 3 9h4l-1 6 6-8h-4l1-6Z',
    alert: ['M8 1.5 14.5 13H1.5L8 1.5Z','M8 6v4','M8 12v.5'],
    copy: ['M5 5h6v6H5z','M3 11V3h8'],
    check: 'M3 8.5 6.5 12 13 4',
    layers: ['M8 1 1 5l7 4 7-4-7-4Z','M1 11l7 4 7-4','M1 8l7 4 7-4'],
  };
  function icon(name, size, extraStyle) {
    const d = ICONS[name];
    const paths = (Array.isArray(d) ? d : [d]).map(p => '<path d="' + p + '"/>').join('');
    return '<svg width="' + (size||14) + '" height="' + (size||14) + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"' + (extraStyle ? ' style="'+extraStyle+'"' : '') + '>' + paths + '</svg>';
  }

  const SPAN_TYPE_LABEL = { root:'ROOT', llm:'LLM', tool:'TOOL', user:'USER', retrieval:'RAG', error:'ERR', system:'SYS', subagent:'SUB', turn:'TURN' };
  const ROLE_LABEL = { main:'主', subagent:'子', worker:'后台', workflow:'流程', background:'底噪' };
  function agentBadge(agent, role){
    if(!agent) return '';
    const prefix = role==='subagent' ? '↳ ' : '';
    return '<span class="agent-badge" data-role="'+esc(role||'main')+'" title="agent: '+esc(agent)+' ('+(ROLE_LABEL[role]||role)+')">'+prefix+esc(agent)+'</span>';
  }

  // ---------- formatters ----------
  function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function fmtMs(ms){ if(ms==null) return '—'; if(ms<1) return '<1ms'; if(ms<1000) return Math.round(ms)+'ms'; return (ms/1000).toFixed(2)+'s'; }
  function fmtTokens(n){ if(n==null) return '—'; if(n<1000) return String(n); if(n<1e6) return (n/1000).toFixed(1)+'k'; return (n/1e6).toFixed(2)+'M'; }
  function fmtCost(c){ if(c==null) return '—'; return '$'+Number(c).toFixed(4); }
  function fmtNum(n){ if(n==null) return '—'; if(n<1000) return String(n); if(n<1e6) return (n/1000).toFixed(1)+'K'; return (n/1e6).toFixed(2)+'M'; }
  // tracer 的 started_at 是 naive UTC (无时区后缀); JS 对无 offset 的 ISO 串按本地时区解析,
  // 会整体偏移 (UTC+8 显示 "8h 前")。无 Z/±hh:mm 后缀的一律补 Z 按 UTC 解析。
  function parseTs(s){
    if(!s) return null;
    let str=String(s);
    if(!/[zZ]$|[+\-]\d{2}:?\d{2}$/.test(str)) str+='Z';
    const t=Date.parse(str);
    return isNaN(t)?null:t;
  }
  function relTime(ts, now){ if(ts==null) return ''; const d=(now-ts)/1000; if(d<60) return Math.round(d)+'s 前'; if(d<3600) return Math.round(d/60)+'m 前'; if(d<86400) return Math.round(d/3600)+'h 前'; return Math.round(d/86400)+'d 前'; }
  function clockTime(ts){ if(ts==null) return '—'; const d=new Date(ts); const p=n=>String(n).padStart(2,'0'); return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds())+'.'+p(Math.floor(d.getMilliseconds()/10)); }
  function shortId(s){ if(!s) return ''; return s.length>14 ? s.slice(0,10)+'…' : s; }
  function projName(wd){ if(!wd) return 'session'; const parts = wd.split('/').filter(Boolean); return parts[parts.length-1] || wd; }

  // ---------- copy registry (avoids escaping huge payloads into attrs) ----------
  const COPY = {};
  let copyN = 0;
  function copyRef(text){ const id='c'+(copyN++); COPY[id] = (typeof text==='string')?text:JSON.stringify(text,null,2); return id; }
  function copyBtn(text){ return '<button class="copy-btn" data-action="copy" data-copy="'+copyRef(text)+'" title="复制">'+icon('copy',11)+'</button>'; }

  // ---------- state ----------
  const URLP = new URLSearchParams(location.search);
  const S = {
    theme: URLP.get('theme') || localStorage.getItem('ts.theme') || 'light',
    density: localStorage.getItem('ts.density') || 'cozy',
    accent: localStorage.getItem('ts.accent') || '#3b66e8',
    tweaksOpen: false,
    tab: (['traces','logs','metrics','context'].indexOf(URLP.get('tab'))>=0 ? URLP.get('tab') : 'traces'),  // traces | logs | metrics | context
    sessions: [], now: Date.now(),
    activeSessionId: URLP.get('session') || null,
    traces: [], openTraces: new Set(),
    activeTraceId: null, activeSpanId: null,
    query: '', filter: 'all', showNoise: false, showContext: false,
    collapsedSpans: {},        // traceId -> Set(spanId)
    jsonCollapsed: {},         // path -> true(collapsed)
    detailTab: 'input',
    overview: null,
    logs: null, logLevel: '',
    metrics: null,
    context: null,
    visible: null,
    contextItems: null,
    contextChannels: null,
    contextMode: 'items',
    visibleIndexDetails: {},
    activeVisibleIndexId: null,
    contextItemDetails: {},
    activeContextItemId: null,
    refreshing: false,
  };

  function applyChrome(){
    document.documentElement.dataset.theme = S.theme;
    document.documentElement.dataset.density = S.density;
    if (S.accent) document.documentElement.style.setProperty('--accent', S.accent);
  }

  async function api(path){ const r = await fetch(path); if(!r.ok) throw new Error(path+' '+r.status); return r.json(); }

  // ---------- data loads ----------
  async function loadOverview(){ try { S.overview = await api('/api/overview'); } catch(e){ S.overview=null; } renderStats(); }
  async function loadSessions(){
    const j = await api('/api/sessions'); S.sessions = j.sessions || []; S.now = Date.now();
    if (!S.activeSessionId && S.sessions.length) S.activeSessionId = S.sessions[0].session_id;
    renderSidebar();
  }
  async function loadTraces(sid){
    const j = await api('/api/sessions/'+encodeURIComponent(sid)+'/traces');
    S.traces = j.traces || [];
    S.context = null; S.visible = null; S.contextItems = null; S.contextChannels = null;
    S.visibleIndexDetails = {}; S.activeVisibleIndexId = null;
    S.contextItemDetails = {}; S.activeContextItemId = null;
    S.openTraces = new Set(S.traces.length ? [S.traces[0].id] : []);
    // auto-pick representative span of first trace
    if (S.traces.length){
      const t = S.traces[0];
      const pick = t.spans.find(s=>s.type==='llm' && !s.noise) || t.spans.find(s=>s.type==='root') || t.spans.find(s=>!s.noise) || t.spans[0];
      S.activeTraceId = t.id; S.activeSpanId = pick ? pick.id : null;
    } else { S.activeTraceId=null; S.activeSpanId=null; }
    renderCenter(); renderDetail();
  }
  // Logs / Metrics 是跨 session 的全局可观测视图 (日志检索聚合 / 长等待排查);
  // 左栏 session 选择只驱动 Traces 视图与每个 span 的关联日志 (Events tab)。
  let logTimer=null;
  async function loadLogs(){
    const qs = new URLSearchParams();
    if (S.query) qs.set('q', S.query);
    if (S.logLevel) qs.set('level', S.logLevel);
    try { S.logs = await api('/api/logs?'+qs.toString()); } catch(e){ S.logs=null; }
    renderCenter();
  }
  async function loadVisibleIndex(visibleIndexId){
    const sid=S.activeSessionId;
    if(!sid || !visibleIndexId) return;
    S.visibleIndexDetails[visibleIndexId]={loading:true}; renderCenter();
    try {
      S.visibleIndexDetails[visibleIndexId]={data:await api('/api/sessions/'+encodeURIComponent(sid)+'/context/visible/'+encodeURIComponent(visibleIndexId))};
    } catch(e) {
      S.visibleIndexDetails[visibleIndexId]={error:String(e)};
    }
    renderCenter();
  }
  async function loadContextItem(itemId){
    const sid=S.activeSessionId;
    if(!sid || !itemId) return;
    S.contextItemDetails[itemId]={loading:true}; renderCenter();
    try {
      S.contextItemDetails[itemId]={data:await api('/api/sessions/'+encodeURIComponent(sid)+'/context/items/'+encodeURIComponent(itemId))};
    } catch(e) {
      S.contextItemDetails[itemId]={error:String(e)};
    }
    renderCenter();
  }
  async function loadMetrics(){
    try { S.metrics = await api('/api/metrics'); } catch(e){ S.metrics=null; }
    renderCenter();
  }
  async function loadContext(){
    const sid=S.activeSessionId;
    if(!sid){ S.context={channels:{},ops:[],totals:{}}; S.visible={snapshots:[],totals:{}}; S.contextItems={items:[],totals:{}}; S.contextChannels={channels:[]}; renderCenter(); return; }
    try {
      const base='/api/sessions/'+encodeURIComponent(sid)+'/context';
      const data=await Promise.all([api(base),api(base+'/visible'),api(base+'/items'),api(base+'/channels')]);
      S.context=data[0]; S.visible=data[1]; S.contextItems=data[2]; S.contextChannels=data[3];
    } catch(e) { S.context=null; S.visible=null; S.contextItems=null; S.contextChannels=null; }
    renderCenter();
  }

  // ---------- selectors ----------
  function activeTrace(){ return S.traces.find(t=>t.id===S.activeTraceId) || null; }
  function activeSpan(){ const t=activeTrace(); if(!t) return null; return t.spans.find(s=>s.id===S.activeSpanId) || null; }
  function collapsedSet(traceId){ if(!S.collapsedSpans[traceId]) S.collapsedSpans[traceId]=new Set(); return S.collapsedSpans[traceId]; }

  // ============================ render: shell ============================
  function renderShell(){
    const root = document.getElementById('root');
    root.innerHTML =
      '<div class="app">' +
        '<header class="topbar">' +
          '<div class="brand"><div class="brand-mark"></div><span>TraceSystem</span><span class="brand-env">local</span></div>' +
          '<div class="search">' + icon('search',13,'color:var(--muted)') +
            '<input id="search" placeholder="搜索 traces、spans、payload / 日志内容…  (e.g. tool.bash, error, opus)" />' +
            '<span class="search-kbd">⌘K</span>' +
          '</div>' +
          '<div class="topbar-right">' +
            '<button class="icon-btn" id="refreshBtn" data-action="refresh" title="刷新">' + icon('refresh',14) + '</button>' +
            '<button class="icon-btn" data-action="toggle-theme" title="切换主题">' + (S.theme==='dark'?icon('sun',14):icon('moon',14)) + '</button>' +
            '<button class="icon-btn" data-action="toggle-tweaks" title="设置">' + icon('settings',14) + '</button>' +
            '<span class="avatar">AI</span>' +
          '</div>' +
        '</header>' +
        '<div id="stats" class="stats"></div>' +
        '<div class="main">' +
          '<aside id="sidebar" class="sidebar"></aside>' +
          '<section id="center" class="center"></section>' +
          '<aside id="detail" class="detail"></aside>' +
        '</div>' +
      '</div>' +
      '<div id="tweaks"></div>';

    const input = document.getElementById('search');
    input.value = S.query;
    input.addEventListener('input', e => {
      S.query = e.target.value;
      if (S.tab==='logs'){ clearTimeout(logTimer); logTimer=setTimeout(loadLogs, 220); }
      else renderCenter();
    });
  }

  // ============================ render: stats strip ============================
  function sparkSvg(data, color){
    if(!data || !data.length) data=[0,0];
    const max=Math.max.apply(null,data), min=Math.min.apply(null,data);
    const range=Math.max(1e-9, max-min); const W=100,H=22;
    const pts=data.map((v,i)=>{ const x=(i/(data.length-1||1))*W; const y=H-((v-min)/range)*(H-2)-1; return [x,y]; });
    const d=pts.map((p,i)=>(i===0?'M':'L')+p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
    const area=d+' L'+W+','+H+' L0,'+H+' Z';
    return '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" width="100%" height="'+H+'" style="display:block">' +
      '<path d="'+area+'" fill="'+color+'" opacity="0.12"/><path d="'+d+'" fill="none" stroke="'+color+'" stroke-width="1.2"/></svg>';
  }
  function statCard(label, value, unit, delta, spark, color){
    let deltaHtml='';
    if (delta!=null){ const dir=delta<0?'down':'up'; deltaHtml='<span class="stat-delta" data-dir="'+dir+'">'+(delta>=0?'▲':'▼')+' '+Math.abs(delta)+'%</span>'; }
    return '<div class="stat"><div class="stat-label">'+esc(label)+'</div>' +
      '<div class="stat-row"><span class="stat-value">'+esc(value)+'</span>' +
      (unit?'<span class="stat-unit">'+esc(unit)+'</span>':'') + deltaHtml + '</div>' +
      '<div class="spark">'+sparkSvg(spark,color)+'</div></div>';
  }
  function renderStats(){
    const el=document.getElementById('stats'); if(!el) return;
    const o=S.overview;
    if(!o){ el.innerHTML = statCard('Total Tokens','—','',null,[0],'var(--hue-llm)')+statCard('LLM 延迟','—','',null,[0],'var(--hue-tool)')+statCard('Total Cost','—','',null,[0],'var(--hue-user)')+statCard('Error Rate','—','',null,[0],'var(--hue-error)'); return; }
    const tk=o.tokens, lat=o.latency, cost=o.cost, err=o.errors;
    el.innerHTML =
      statCard('Total Tokens', fmtNum(tk.total), 'all', tk.delta, tk.spark, 'oklch(0.6 0.14 255)') +
      statCard('LLM 延迟 p50', (lat.p50_ms/1000).toFixed(2), 's', lat.delta, lat.spark, 'oklch(0.6 0.13 165)') +
      statCard('Total Cost (est.)', '$'+Number(cost.total).toFixed(2), 'USD', cost.delta, cost.spark, 'oklch(0.6 0.13 75)') +
      statCard('Error Rate', Number(err.rate).toFixed(1), '%', err.delta, err.spark, 'oklch(0.6 0.16 25)');
  }

  // ============================ render: sidebar (sessions, grouped by agent role) ============================
  function sessionRow(s){
    const active = s.session_id===S.activeSessionId;
    const st = s.errors>0 ? 'error' : 'ok';
    // 副标题优先显示该 session 里的 agent 身份 (区分 peer agent), 否则 workdir
    const agentTxt = (s.agents && s.agents.length) ? s.agents.join(' / ')
                   : (s.workdirs && s.workdirs.length ? projName(s.workdirs[0]) : (s.session_id==='_orphan'?'background':'session'));
    const spawnTag = (s.spawns && s.spawns.length) ? '<span class="child-pill" style="margin-left:5px;padding:0 4px">↗'+s.spawns.length+'</span>' : '';
    const parentLine = (s.role==='subagent' && s.parent_session)
      ? '<div class="session-parent" data-action="open-child" data-sid="'+esc(s.parent_session)+'" title="跳到父 session">↳ from '+esc(shortId(s.parent_session))+'</div>' : '';
    return '<div class="session-row" data-active="'+active+'" data-action="select-session" data-sid="'+esc(s.session_id)+'">' +
      '<span class="session-dot" data-status="'+st+'"></span>' +
      '<div class="session-meta"><div class="session-id">'+esc(shortId(s.session_id))+spawnTag+'</div>' +
      '<div class="session-sub"><span style="overflow:hidden;text-overflow:ellipsis">'+esc(agentTxt)+'</span><span class="session-sub-sep"></span><span>'+esc(relTime(parseTs(s.last_at), S.now))+'</span></div>'+parentLine+'</div>' +
      '<span class="session-count">'+(s.task_run_count||0)+'</span></div>';
  }
  const ROLE_GROUPS = [['main','主 Agent · Sessions'],['subagent','子 Agent · Subagents'],['worker','后台 Worker'],['workflow','Workflow · 顺序编排'],['background','底噪 · Background']];
  function renderSidebar(){
    const el=document.getElementById('sidebar'); if(!el) return;
    const prevList=el.querySelector('.session-list'); const savedTop=prevList?prevList.scrollTop:0;
    let body=''; let first=true;
    ROLE_GROUPS.forEach(g=>{
      // 有父链接的 session (subagent / resident memory worker) 已并入父 session 顶层视图, 不再单列
      let items=S.sessions.filter(s=>(s.role||'main')===g[0] && !s.parent_session);
      if(!items.length) return;
      body += '<div class="session-group-label'+(first?' first':'')+'">'+esc(g[1])+' ('+items.length+')</div>';
      first=false;
      body += items.map(sessionRow).join('');
    });
    if (!S.sessions.length) body = '<div class="empty-note">还没有 trace 数据<br/><span style="font-size:11px;color:var(--muted-2)">跑一次 veda 对话后刷新</span></div>';
    el.innerHTML =
      '<div class="sidebar-section"><span class="section-title">会话 · Sessions</span><span class="section-action" data-action="refresh">↻ 刷新</span></div>' +
      '<div class="session-list">'+body+'</div>' +
      '<div class="sidebar-footer"><span style="width:6px;height:6px;border-radius:50%;background:var(--hue-ok)"></span><span>'+S.sessions.length+' sessions · local</span><span style="margin-left:auto;font-family:var(--font-mono)">~/.veda/logs</span></div>';
    const nowList=el.querySelector('.session-list'); if(nowList) nowList.scrollTop=savedTop;
  }

  // ============================ render: center (toolbar + traces/logs/metrics) ============================
  function centerToolbar(){
    const chipsTraces =
      '<span class="chip" data-active="'+(S.filter==='all')+'" data-action="set-filter" data-v="all">全部 · All</span>' +
      '<span class="chip" data-active="'+(S.filter==='error')+'" data-action="set-filter" data-v="error"><span class="chip-dot" style="background:var(--hue-error)"></span>错误 · Errors</span>' +
      '<span class="chip" data-active="'+(S.filter==='llm')+'" data-action="set-filter" data-v="llm"><span class="chip-dot" style="background:var(--hue-llm)"></span>LLM</span>' +
      '<span class="chip" data-active="'+(S.filter==='tool')+'" data-action="set-filter" data-v="tool"><span class="chip-dot" style="background:var(--hue-tool)"></span>Tool</span>' +
      '<span class="chip" data-active="'+(S.filter==='slow')+'" data-action="set-filter" data-v="slow">慢调用 &gt; 3s</span>' +
      '<span class="chip" data-active="'+S.showContext+'" data-action="toggle-context" title="在瀑布图中显示 context.channel / context.op / context.compose span">Context spans</span>' +
      '<span class="chip" data-active="'+S.showNoise+'" data-action="toggle-noise" title="显示 hook/prompt 等高频底噪 span">全部 span</span>';
    const chipsLogs =
      ['','info','warning','error','debug'].map(lv =>
        '<span class="chip" data-active="'+(S.logLevel===lv)+'" data-action="set-loglevel" data-v="'+lv+'">'+(lv===''?'全部 · All':lv)+'</span>').join('');
    const itemTotals=(S.contextItems&&S.contextItems.totals)||{};
    const visibleTotals=(S.visible&&S.visible.totals)||{};
    const chipsContext =
      '<span class="chip" data-active="true">'+(itemTotals.items||0)+' item families</span>' +
      '<span class="chip" data-active="true">'+((S.contextChannels&&S.contextChannels.channels)||[]).length+' channels</span>' +
      '<span class="chip" data-active="true">'+(visibleTotals.model_calls||0)+' model snapshots</span>';
    let left = '';
    if (S.tab==='traces') left = chipsTraces;
    else if (S.tab==='logs') left = chipsLogs;
    else if (S.tab==='metrics') left = '<span class="chip" data-active="true">timing / counter 聚合</span>';
    else left = chipsContext;
    return '<div class="center-toolbar">' + left +
      '<div class="tabbar">' +
        '<span class="tab" data-active="'+(S.tab==='traces')+'" data-action="set-tab" data-v="traces">Traces</span>' +
        '<span class="tab" data-active="'+(S.tab==='context')+'" data-action="set-tab" data-v="context">Context</span>' +
        '<span class="tab" data-active="'+(S.tab==='logs')+'" data-action="set-tab" data-v="logs">Logs</span>' +
        '<span class="tab" data-active="'+(S.tab==='metrics')+'" data-action="set-tab" data-v="metrics">Metrics</span>' +
      '</div></div>';
  }

  function filteredTraces(){
    const q=S.query.trim().toLowerCase();
    return S.traces.filter(t=>{
      if(q){ const blob=(t.id+' '+t.name+' '+t.spans.map(s=>s.name+' '+(s.model||'')+' '+JSON.stringify(s.input||'')+' '+JSON.stringify(s.output||'')).join(' ')).toLowerCase(); if(blob.indexOf(q)<0) return false; }
      if(S.filter==='all') return true;
      if(S.filter==='error') return t.status==='error' || t.spans.some(s=>s.status==='error');
      if(S.filter==='llm') return t.spans.some(s=>s.type==='llm');
      if(S.filter==='tool') return t.spans.some(s=>s.type==='tool');
      if(S.filter==='slow') return t.duration>3000;
      return true;
    });
  }

  function statusBadge(status){
    if(status==='ok') return '<span class="badge badge-ok">● OK</span>';
    if(status==='error') return '<span class="badge badge-error">● ERROR</span>';
    if(status==='running') return '<span class="badge badge-running">● RUNNING</span>';
    return '<span class="badge badge-muted">'+esc(status)+'</span>';
  }

  // build visible tree honoring noise filter + re-parent to nearest visible ancestor
  function buildVisibleTree(trace){
    const byId={}; trace.spans.forEach(s=>byId[s.id]=s);
    const visible = trace.spans.filter(s=>(S.showNoise || !s.noise || s.type==='root') && (S.showContext || s.kind!=='context'));
    const visSet = new Set(visible.map(s=>s.id));
    const nodes = {}; visible.forEach(s=>nodes[s.id]={span:s, children:[]});
    const roots=[];
    visible.forEach(s=>{
      let p=s.parentId;
      while(p && !visSet.has(p)) p = byId[p] ? byId[p].parentId : null;
      if(p && nodes[p]) nodes[p].children.push(nodes[s.id]); else roots.push(nodes[s.id]);
    });
    return roots;
  }
  function flattenTree(roots, traceId){
    const collapsed=collapsedSet(traceId); const out=[];
    function walk(nodes, depth){ nodes.sort((a,b)=>a.span.start-b.span.start); nodes.forEach(n=>{ out.push({node:n, depth:depth}); if(n.children.length && !collapsed.has(n.span.id)) walk(n.children, depth+1); }); }
    walk(roots,0); return out;
  }

  function waterfall(trace){
    const total=Math.max(trace.duration,1);
    let ticks='';
    for(let i=0;i<=5;i++){ const pct=(i/5)*100; const lbl=i>0?fmtMs(total*i/5):''; ticks+='<div class="wf-tick" style="left:'+pct+'%">'+esc(lbl)+'</div>'; }
    // turn 多 (≥5) 时默认折叠成摘要行, 只在首次打开该 trace 时初始化, 不覆盖用户手动展开
    if(!S.collapsedInit) S.collapsedInit={};
    if(!S.collapsedInit[trace.id]){
      S.collapsedInit[trace.id]=true;
      const set=collapsedSet(trace.id);
      // 自有 turns 与嫁接进来的子 agent turns 分开计数, 各自 ≥5 才默认折叠
      // (否则后台 worker 的 2 个 turn 被连坐折叠, llm/policy 看起来"消失")
      const ownTurns=trace.spans.filter(s=>s.type==='turn' && !s.grafted);
      const graftTurns=trace.spans.filter(s=>s.type==='turn' && s.grafted);
      if(ownTurns.length>=5){ ownTurns.forEach(t=>set.add(t.id)); }
      if(graftTurns.length>=5){ graftTurns.forEach(t=>set.add(t.id)); }
      // memory 后台组默认收起 (一行摘要, 点开看明细)
      trace.spans.filter(s=>s.memGroup).forEach(m=>set.add(m.id));
    }
    const roots=buildVisibleTree(trace);
    const rows=flattenTree(roots, trace.id);
    const collapsed=collapsedSet(trace.id);
    let body='';
    rows.forEach(r=>{
      const n=r.node, s=n.span, depth=r.depth;
      const hasChildren=n.children.length>0;
      const isCol=collapsed.has(s.id);
      const active=(trace.id===S.activeTraceId && s.id===S.activeSpanId);
      const isErr=s.status==='error', isRun=s.status==='running';
      const left=(s.start/total)*100; const width=Math.max((s.dur/total)*100,0.4);
      const barCls = isErr ? 'span-bar-error' : ('span-bar-'+s.type);
      const toggle = hasChildren
        ? '<span class="span-tree-toggle" data-action="toggle-span" data-tid="'+esc(trace.id)+'" data-sid="'+esc(s.id)+'">'+icon('chevron',11,'transform:rotate('+(isCol?'0':'90')+'deg)')+'</span>'
        : '<span class="span-tree-toggle invisible"></span>';
      const model = s.model ? '<span class="mono" style="margin-left:8px">'+esc(String(s.model).replace('claude-',''))+'</span>' : '';
      const subInfo = s.subagentName ? '<span class="mono" style="margin-left:8px;color:var(--hue-subagent)">→ '+esc(s.subagentName)+'</span>' : '';
      const graftBadge = (s.grafted && s.type==='root' && s.agent) ? '<span style="margin-left:8px">'+agentBadge(s.agent, s.agentRole||'subagent')+'</span>' : '';
      // turn 分组行: 摘要 (llm 耗时 · tool 数 · 工具耗时), 折叠时也能一眼读出这一轮干了什么
      let turnSummary='';
      if(s.type==='turn'){
        const kids=n.children.map(c=>c.span);
        const llmMs=kids.filter(k=>k.type==='llm').reduce((a,k)=>a+(k.dur||0),0);
        const toolKids=kids.filter(k=>k.type==='tool');
        const toolMs=toolKids.reduce((a,k)=>a+(k.dur||0),0);
        const hil=kids.filter(k=>k.kind&&k.kind.indexOf('hil')===0).length;
        const parts=[];
        if(llmMs) parts.push('llm '+fmtMs(llmMs));
        if(toolKids.length) parts.push(toolKids.length+' tool '+fmtMs(toolMs));
        if(hil) parts.push('hil×'+hil);
        turnSummary = parts.length ? '<span class="turn-summary">'+parts.join(' · ')+'</span>' : '';
      }
      const errMark = isErr ? '<span class="span-error-mark">'+icon('alert',13)+'</span>' : '';
      const runDeco = isRun ? '<span style="position:absolute;right:-2px;top:-2px;bottom:-2px;width:6px;background:linear-gradient(90deg,transparent,var(--accent));animation:pulse 1.2s infinite"></span>' : '';
      body +=
        '<div class="span-row" data-active="'+active+'" data-type="'+esc(s.type)+'" data-action="select-span" data-tid="'+esc(trace.id)+'" data-sid="'+esc(s.id)+'">' +
          '<div class="span-name-cell" style="padding-left:'+(14+depth*16)+'px">' + toggle +
            '<span class="span-type-dot span-type-'+s.type+'"></span>' +
            '<span class="span-label">'+esc(s.name)+turnSummary+model+subInfo+graftBadge+'</span>' + errMark +
            '<span class="span-tag">'+(SPAN_TYPE_LABEL[s.type]||s.type)+'</span>' +
          '</div>' +
          '<div class="span-bar-cell"><div class="span-bar-track">' +
            '<div class="span-bar '+barCls+'" style="left:'+left+'%;width:'+width+'%;opacity:'+(isRun?0.85:1)+'">'+runDeco+'</div>' +
          '</div><span class="span-bar-duration">'+fmtMs(s.dur)+'</span></div>' +
        '</div>';
    });
    return '<div class="waterfall"><div class="wf-head"><div>Span</div><div style="padding:0"><div class="wf-axis-ticks">'+ticks+'</div></div></div>'+body+'</div>';
  }

  function childPill(t){
    if(!t.children || !t.children.length) return '';
    const live=t.children.filter(c=>c.session);
    if(live.length){ const c=live[0]; const label = live.length>1 ? ('↗ '+live.length+' subagents') : ('↗ '+esc(c.name||'subagent'));
      return '<span class="child-pill" data-action="open-child" data-sid="'+esc(c.session)+'" title="打开子 agent session">'+label+'</span>'; }
    return '<span class="child-pill" style="opacity:.6;cursor:default" title="子 agent 无 trace 数据 (未落盘/已清理)">↗ '+esc(t.children[0].name||'subagent')+'</span>';
  }
  function traceCard(t){
    const open=S.openTraces.has(t.id);
    return '<div class="trace-card" data-open="'+open+'">' +
      '<div class="trace-head" data-action="toggle-trace" data-tid="'+esc(t.id)+'">' +
        '<span class="chev">'+icon('chevron',13)+'</span>' +
        '<div class="trace-name">'+agentBadge(t.agent, t.agentRole)+'<span class="trace-name-text">'+esc(t.name)+'</span><span class="trace-id">'+esc(t.id)+'</span>'+childPill(t)+'</div>' +
        statusBadge(t.status) +
        '<span class="trace-metric">'+icon('clock',11,'color:var(--muted)')+fmtMs(t.duration)+'</span>' +
        '<span class="trace-metric">'+icon('bolt',11,'color:var(--muted)')+fmtTokens((t.tokensIn||0)+(t.tokensOut||0))+'<span class="trace-metric-unit">tok</span></span>' +
        '<span class="trace-metric">'+fmtCost(t.cost)+'</span>' +
      '</div>' + (open ? waterfall(t) : '') + '</div>';
  }

  function logEventText(r){
    const skip=new Set(['ts','level','logger','event','session_id','task_run_id','request_id','_sid']);
    const extra=Object.keys(r).filter(k=>!skip.has(k)).map(k=>'<span class="lk">'+esc(k)+'=</span><span class="lv">'+esc(typeof r[k]==='object'?JSON.stringify(r[k]):r[k])+'</span>').join(' ');
    return '<b>'+esc(r.event||'')+'</b>' + (extra?'  '+extra:'');
  }
  function renderLogs(){
    const lg=S.logs;
    if(!lg) return '<div class="empty-note">加载日志中…</div>';
    const lv=lg.by_level||{};
    const agg='<div class="log-aggregate">' +
      '<span class="agg-pill"><span class="agg-count">'+lg.total+'</span> 条匹配</span>' +
      Object.keys(lv).map(k=>'<span class="agg-pill"><span class="log-dot" style="background:'+(k==='error'?'var(--hue-error)':k==='warning'?'var(--hue-user)':'var(--accent)')+'"></span>'+esc(k)+' <span class="agg-count">'+lv[k]+'</span></span>').join('') +
      (lg.top_loggers&&lg.top_loggers.length?'<span style="margin-left:auto">top: '+lg.top_loggers.slice(0,6).map(t=>esc(t.logger)+'·'+t.count).join('  ')+'</span>':'') +
      '</div>';
    if(!lg.rows.length) return agg+'<div class="empty-note">没有匹配的日志</div>';
    const rows=lg.rows.map(r=>{
      const t=parseTs(r.ts); const lvl=r.level||'info';
      const sid=r.session_id?'<span class="log-sid">'+esc(shortId(r.session_id))+'</span>':'';
      return '<div class="log-row" data-level="'+esc(lvl)+'">' +
        '<span class="log-time">'+clockTime(t)+'</span>' +
        '<span class="log-dot"></span>' +
        '<span class="log-logger">'+esc(r.logger||'?')+'</span>' +
        '<span class="log-event">'+logEventText(r)+sid+'</span></div>';
    }).join('');
    return agg+'<div class="log-table">'+rows+'</div>';
  }

  function renderMetrics(){
    const m=S.metrics;
    if(!m) return '<div class="empty-note">加载指标中…</div>';
    const maxP95=Math.max.apply(null,(m.timings||[]).map(t=>t.p95).concat([1]));
    const timingRows=(m.timings||[]).map(t=>{
      const slow=t.p95>3000;
      const barw=(t.p95/maxP95*100);
      return '<tr><td class="name">'+esc(t.name)+'</td>' +
        '<td>'+t.count+'</td>' +
        '<td>'+fmtMs(t.p50)+'</td>' +
        '<td class="'+(slow?'slow':'')+'">'+fmtMs(t.p95)+'</td>' +
        '<td class="'+(slow?'slow':'')+'">'+fmtMs(t.max)+'</td>' +
        '<td class="barcell" style="min-width:120px"><div class="bar" style="width:'+barw+'%"></div>'+fmtMs(t.avg)+'</td></tr>';
    }).join('');
    const counterRows=(m.counters||[]).map(c=>'<tr><td class="name">'+esc(c.name)+'</td><td>'+fmtNum(c.sum)+'</td><td>'+c.calls+'</td></tr>').join('');
    return '<div class="metrics-wrap">' +
      '<div><div class="metrics-block-title">耗时 timing — p95 倒序 (排查长等待)</div>' +
        (timingRows? '<table class="mtable"><thead><tr><th>name</th><th>count</th><th>p50</th><th>p95</th><th>max</th><th>avg</th></tr></thead><tbody>'+timingRows+'</tbody></table>' : '<div class="detail-note">暂无 timing 数据</div>') +
      '</div>' +
      '<div><div class="metrics-block-title">计数 counter</div>' +
        (counterRows? '<table class="mtable"><thead><tr><th>name</th><th>sum</th><th>calls</th></tr></thead><tbody>'+counterRows+'</tbody></table>' : '<div class="detail-note">暂无 counter 数据</div>') +
      '</div></div>';
  }

  function contextStat(label, value, unit){
    return '<div class="context-stat"><div class="context-stat-label">'+esc(label)+'</div><div class="context-stat-value">'+esc(String(value))+(unit?'<span style="font-size:11px;color:var(--muted);margin-left:5px">'+esc(unit)+'</span>':'')+'</div></div>';
  }
  function contextRef(value){
    if(!value) return '<span class="context-ref">—</span>';
    return '<span class="context-ref" title="'+esc(value)+'">'+esc(shortId(value))+'</span>'+copyBtn(value);
  }
  function snapshotRow(snapshot){
    const visibleIndexId=snapshot.visible_index_id||'';
    return '<div class="context-row context-snapshot">'+
      '<span class="context-time">'+esc(clockTime(parseTs(snapshot.at)))+'</span>'+
      '<span class="context-op">模型调用</span>'+
      '<span class="context-items">used '+(snapshot.used||0)+' · excluded '+(snapshot.excluded||0)+'</span>'+
      '<span>'+contextRef(visibleIndexId)+'</span>'+
      '<span class="context-actions"><button class="context-inspect" data-action="open-visible-index" data-visible-index-id="'+esc(visibleIndexId)+'">查看内容</button></span>'+
      '</div>'+visibleIndexDetail(visibleIndexId);
  }
  function visibleIndexDetail(visibleIndexId){
    if(!visibleIndexId || S.activeVisibleIndexId!==visibleIndexId) return '';
    const state=S.visibleIndexDetails[visibleIndexId];
    if(!state || state.loading) return '<div class="context-detail"><div class="context-detail-body"><span class="context-muted">加载模型可见条目…</span></div></div>';
    if(state.error) return '<div class="context-detail"><div class="context-error">加载失败: '+esc(state.error)+'</div></div>';
    const index=state.data||{}, entries=index.entries||[];
    const body=entries.length ? entries.map(entry=>{
      const item=entry.item||{item_id:entry.item_id,channel:entry.channel_id,content:null};
      const active=S.activeContextItemId===entry.item_id;
      return '<div class="visible-entry"><div class="visible-entry-head">'+
        '<span class="visible-entry-label">#'+esc(String(entry.ordinal==null?'?':entry.ordinal))+'</span>'+
        '<span class="visible-entry-channel">'+esc(entry.channel_id||'?')+'</span>'+
        '<span class="context-muted">'+esc(entry.provider_slot||'?')+(entry.reason?' · '+esc(entry.reason):'')+'</span>'+
        '<span>'+contextRef(entry.item_id)+'</span>'+
        '<button class="context-inspect" data-action="open-context-item" data-item-id="'+esc(entry.item_id||'')+'">查看演变</button>'+
        '</div><details class="context-content"><summary>此快照输入模型的内容</summary><pre>'+esc(item.content==null?'内容在账本中不可用。':String(item.content))+'</pre></details>'+contextItemTimeline(entry.item_id,active)+'</div>';
    }).join('') : '<div class="context-muted">该模型可见索引没有条目。</div>';
    return '<div class="context-detail"><div class="context-detail-head"><span>Visible index '+esc(shortId(visibleIndexId))+' · '+entries.length+' items</span></div><div class="context-detail-body">'+body+'</div></div>';
  }
  const LIFECYCLE_LABEL={entered:'注入上下文',visible:'模型可见',not_visible:'本轮未进入',retained_after_compaction:'跨越压缩保持',replaced:'被新版本替换',compacted:'因压缩剔除',ended:'生命周期结束'};
  function turnLabel(turnId){ return turnId ? 'turn '+shortId(turnId) : '未关联 turn'; }
  function openTraceSpan(spanId){
    let targetTrace=null;
    for(const trace of S.traces){ if(trace.spans.some(span=>span.id===spanId)){ targetTrace=trace; break; } }
    if(!targetTrace) return;
    S.tab='traces'; S.showContext=true; S.openTraces.add(targetTrace.id); S.activeTraceId=targetTrace.id; S.activeSpanId=spanId; S.detailTab='attrs';
    renderCenter(); renderDetail();
  }
  function turnSpanButton(event){
    if(!event.turn_span_id) return '<span class="lifecycle-turn">'+esc(turnLabel(event.turn_id))+'</span>';
    const label=event.turn_index ? 'Turn '+esc(String(event.turn_index)) : esc(turnLabel(event.turn_id));
    return '<button class="context-inspect" data-action="open-trace-span" data-span-id="'+esc(event.turn_span_id)+'">打开 '+label+'</button>';
  }
  function turnNavigation(event){
    const previous=event.previous_turn_span_id ? '<button class="context-inspect" data-action="open-trace-span" data-span-id="'+esc(event.previous_turn_span_id)+'">前一 turn</button>' : '';
    const next=event.next_turn_span_id ? '<button class="context-inspect" data-action="open-trace-span" data-span-id="'+esc(event.next_turn_span_id)+'">后一 turn</button>' : '';
    const calls=(event.call_span_ids||[]).map((spanId,index)=>'<button class="context-inspect" data-action="open-trace-span" data-span-id="'+esc(spanId)+'">打开 call '+esc(String(index+1))+'</button>').join('');
    return previous+next+calls;
  }
  function lifecycleEvent(event){
    const kind=event.kind||'entered';
    const hasContent=event.content!=null && (kind==='entered'||kind==='replaced'||kind==='compacted'||kind==='ended');
    const content=hasContent ? '<details class="lifecycle-content"><summary>查看该状态下的内容</summary><pre>'+esc(String(event.content))+'</pre></details>' : '';
    const successor=event.successor_item_id ? '<span class="lifecycle-note">后续 item '+esc(shortId(event.successor_item_id))+'</span>' : '';
    const provider=event.provider_slot ? '<span class="lifecycle-note">'+esc(event.provider_slot)+(event.reason?' · '+esc(event.reason):'')+'</span>' : '';
    const run=event.compaction_run_id ? '<span class="lifecycle-note">compact '+esc(shortId(event.compaction_run_id))+'</span>' : '';
    const operation=event.operation_id ? '<span class="lifecycle-note">op '+esc(shortId(event.operation_id))+'</span>' : '';
    const contextSpan=event.trace_span_id ? '<button class="context-inspect" data-action="open-context-span" data-span-id="'+esc(event.trace_span_id)+'">打开 context span</button>' : '';
    const turn=turnSpanButton(event);
    const navigation=turnNavigation(event);
    const checkpoints=(event.checkpoint_item_ids||[]).map(itemId=>'<button class="context-inspect" data-action="open-context-item" data-item-id="'+esc(itemId)+'">查看 checkpoint '+esc(shortId(itemId))+'</button>').join('');
    return '<div class="lifecycle-event" data-kind="'+esc(kind)+'">'+
      '<div class="lifecycle-marker"></div><div class="lifecycle-event-body">'+
      '<div class="lifecycle-event-head"><span class="lifecycle-kind">'+esc(LIFECYCLE_LABEL[kind]||kind)+'</span><span class="lifecycle-time">'+esc(clockTime(parseTs(event.at)))+'</span>'+turn+provider+run+operation+successor+contextSpan+navigation+checkpoints+'</div>'+
      (event.content_preview&&hasContent?'<div class="lifecycle-preview">'+esc(event.content_preview)+'</div>':'')+content+
      '</div></div>';
  }
  function contextItemTimeline(itemId, active){
    if(!active || !itemId) return '';
    const state=S.contextItemDetails[itemId];
    if(!state || state.loading) return '<div class="item-timeline"><div class="item-timeline-body"><span class="context-muted">加载 item 的 context span 内容变化…</span></div></div>';
    if(state.error) return '<div class="item-timeline"><div class="context-error">加载失败: '+esc(state.error)+'</div></div>';
    const timeline=state.data||{};
    const events=(timeline.lifecycle||[]).map(lifecycleEvent).join('') || '<span class="context-muted">该 item 尚未写入生命周期证据。</span>';
    return '<div class="item-timeline"><div class="item-timeline-head">Item 生命周期<div class="item-timeline-subtitle">每个状态只展示一次；展开状态节点查看该时刻内容。</div></div><div class="item-timeline-body"><div class="lifecycle-list">'+events+'</div></div></div>';
  }
  function snapshotTable(rows){
    if(!rows.length) return '<div class="context-list"><div class="context-empty">此 session 尚未写入 visible snapshots。</div></div>';
    return '<div class="context-list"><div class="context-row context-snapshot context-head"><span>时间</span><span>阶段</span><span>组成</span><span>Visible index</span><span>查看</span></div>'+rows.join('')+'</div>';
  }
  function itemLifecycleCard(item){
    const active=S.activeContextItemId===item.item_id;
    const status=item.status==='open'?'进行中':(item.terminal_kind==='compacted'?'已被压缩移出':'已结束');
    const terminal=item.terminal_kind==='compacted'?'因压缩剔除':(item.ended_turn_id?'结束 '+turnLabel(item.ended_turn_id):'');
    const enteredTurn=item.entered_turn_span_id ? '<button class="context-inspect" data-action="open-trace-span" data-span-id="'+esc(item.entered_turn_span_id)+'">进入 '+esc(turnLabel(item.entered_turn_id))+'</button>' : '<span>'+esc(turnLabel(item.entered_turn_id))+'</span>';
    return '<article class="context-item-card" data-status="'+esc(item.status||'open')+'">'+
      '<div class="context-item-card-head"><div><span class="context-item-channel">'+esc(item.channel||'context')+'</span><span class="context-item-kind">'+esc(item.item_kind||'context')+'</span></div><span class="context-item-status">'+status+'</span></div>'+
      '<div class="context-item-preview" title="'+esc(item.content_preview||'')+'">'+esc(item.content_preview||'内容不可用')+'</div>'+
      '<div class="context-item-meta"><span>注入 '+esc(clockTime(parseTs(item.lifecycle_started_at)))+'</span>'+enteredTurn+'<span>模型可见 '+esc(String(item.visible_count||0))+' 次</span>'+(terminal?'<span>'+esc(terminal)+'</span>':'')+'</div>'+
      '<button class="context-inspect" data-action="open-context-item" data-item-id="'+esc(item.item_id||'')+'">'+(active?'收起过程':'查看过程')+'</button>'+contextItemTimeline(item.item_id,active)+'</article>';
  }
  function channelEvolutionEvent(event){
    const kind=event.kind||'entered';
    const itemIds=event.item_ids||[];
    const itemButton=itemIds.length===1 ? '<button class="context-inspect" data-action="open-context-item" data-item-id="'+esc(itemIds[0])+'">查看 item</button>' : '';
    const count=event.item_count==null ? itemIds.length : event.item_count;
    const kinds=(event.item_kinds||[]).join(' · ');
    const detail=(count ? count+' 个 item' : '')+(kinds ? ' · '+kinds : '');
    return '<div class="channel-event" data-kind="'+esc(kind)+'"><span class="channel-event-kind">'+esc(LIFECYCLE_LABEL[kind]||kind)+'</span><span class="channel-event-time">'+esc(clockTime(parseTs(event.at)))+'</span><span class="channel-event-turn">'+esc(turnLabel(event.turn_id))+'</span><span class="channel-event-detail">'+esc(detail)+'</span>'+itemButton+'</div>';
  }
  function channelEvolutionCard(channel){
    const events=(channel.events||[]).map(channelEvolutionEvent).join('') || '<span class="context-muted">尚无 channel 状态变化。</span>';
    return '<article class="channel-card"><div class="channel-card-head"><div><span class="channel-card-name">'+esc(channel.channel||'context')+'</span><span class="channel-card-count">'+esc(String(channel.item_count||0))+' items</span></div><span class="channel-card-visible">'+esc(String(channel.visible_calls||0))+' 次可见变化</span></div><div class="channel-event-list">'+events+'</div></article>';
  }
  function renderContext(){
    if(!S.context || !S.visible || !S.contextItems || !S.contextChannels) return '<div class="empty-note">加载 context evidence…</div>';
    const visible=S.visible, itemData=S.contextItems, channelData=S.contextChannels;
    const itemTotals=itemData.totals||{}, visibleTotals=visible.totals||{};
    const snapshots=(visible.snapshots||[]).slice().reverse().map(snapshotRow);
    const mode=S.contextMode==='channels'?'channels':'items';
    const evolution=mode==='items'
      ? '<div class="context-item-grid">'+((itemData.items||[]).map(itemLifecycleCard).join('') || '<div class="context-empty">尚未记录 context item。</div>')+'</div>'
      : '<div class="channel-grid">'+((channelData.channels||[]).map(channelEvolutionCard).join('') || '<div class="context-empty">尚未记录 channel 演变。</div>')+'</div>';
    return '<div class="trace-scroll"><div class="context-wrap">'+
      '<div class="context-summary">'+
        contextStat('Item families',itemTotals.items||0,'items')+
        contextStat('Channels',(channelData.channels||[]).length,'channels')+
        contextStat('Model-visible snapshots',visibleTotals.model_calls||0,'calls')+
        contextStat('Visible items',visibleTotals.used_total||0,'used')+
      '</div>'+
      '<section><div class="context-section-title">模型调用快照</div><div class="context-section-note">每条快照是一次真实模型调用看到的精确上下文。展开后可查看原始内容。</div>'+snapshotTable(snapshots)+'</section>'+
      '<section><div class="context-section-title">上下文演变</div><div class="context-modebar"><button class="context-mode" data-active="'+(mode==='items'?'true':'false')+'" data-action="set-context-mode" data-v="items">Item 生命周期</button><button class="context-mode" data-active="'+(mode==='channels'?'true':'false')+'" data-action="set-context-mode" data-v="channels">Channel 演变</button></div>'+evolution+'</section>'+
      '</div></div>';
  }

  function renderCenter(){
    const el=document.getElementById('center'); if(!el) return;
    const app=document.querySelector('.app'); if(app) app.dataset.contextView=S.tab==='context'?'true':'false';
    const prevScroll=el.querySelector('.trace-scroll'); const savedTop=prevScroll?prevScroll.scrollTop:0;
    let content='';
    if(S.tab==='traces'){
      const list=filteredTraces();
      content = list.length ? list.map(traceCard).join('') : '<div class="empty-note">没有匹配的 traces</div>';
      content = '<div class="trace-scroll">'+content+'</div>';
    } else if(S.tab==='logs'){
      content = '<div class="trace-scroll">'+renderLogs()+'</div>';
    } else if(S.tab==='metrics') {
      content = '<div class="trace-scroll">'+renderMetrics()+'</div>';
    } else {
      content = renderContext();
    }
    el.innerHTML = centerToolbar() + content;
    const nowScroll=el.querySelector('.trace-scroll'); if(nowScroll) nowScroll.scrollTop=savedTop;
  }

  // ============================ render: detail (span) ============================
  function jsonNode(name, value, depth, path){
    const isObj = value && typeof value==='object' && !Array.isArray(value);
    const isArr = Array.isArray(value);
    const indent='padding-left:'+(depth*14)+'px';
    if(isObj||isArr){
      const entries = isArr ? value.map((v,i)=>[i,v]) : Object.entries(value);
      const ob=isArr?'[':'{', cb=isArr?']':'}';
      const collapsed = S.jsonCollapsed[path]===true;
      let html='<div class="json-row" style="'+indent+'">' +
        '<span class="json-toggle" data-action="json-toggle" data-path="'+esc(path)+'">'+icon('chevron',10,'transform:rotate('+(collapsed?'0':'90')+'deg)')+'</span>' +
        (name!=null?'<span class="json-key">"'+esc(name)+'"</span><span class="json-bracket">: </span>':'') +
        '<span class="json-bracket">'+ob+'</span>';
      if(collapsed) html+='<span class="json-collapsed-summary">'+entries.length+' '+(isArr?'items':'keys')+'</span><span class="json-bracket">'+cb+'</span>';
      html+='</div>';
      if(!collapsed){
        entries.forEach((kv,i)=>{ html+=jsonNode(isArr?null:kv[0], kv[1], depth+1, path+'.'+kv[0]); });
        html+='<div class="json-row" style="padding-left:'+(depth*14+14)+'px"><span class="json-toggle placeholder"></span><span class="json-bracket">'+cb+'</span></div>';
      }
      return html;
    }
    let cls='json-null', disp='null';
    if(typeof value==='string'){ cls='json-string'; disp='"'+esc(value)+'"'; }
    else if(typeof value==='number'){ cls='json-number'; disp=esc(String(value)); }
    else if(typeof value==='boolean'){ cls='json-bool'; disp=esc(String(value)); }
    else if(value===null){ cls='json-null'; disp='null'; }
    return '<div class="json-row" style="'+indent+'"><span class="json-toggle placeholder"></span>' +
      (name!=null?'<span class="json-key">"'+esc(name)+'"</span><span class="json-bracket">: </span>':'') +
      '<span class="'+cls+'">'+disp+'</span></div>';
  }
  function jsonViewer(data, root){ return '<div class="json">'+jsonNode(null, data, 0, root||'$')+'</div>'; }

  function msgBlock(role, content, meta){
    return '<div class="message-block"><div class="message-head"><span class="message-role" data-role="'+esc(role)+'">'+esc(role)+'</span>' +
      (meta!=null?'<span style="font-family:var(--font-mono);color:var(--muted)">'+esc(meta)+'</span>':'') + '</div>' +
      '<div class="message-body">'+esc(typeof content==='string'?content:JSON.stringify(content,null,2))+'</div></div>';
  }
  // Input tab 必须把 event 里的 inputs 完整展示, 不丢字段:
  // system → system 卡片; messages → 逐条 role 卡片; 其余 (tools 等) → JSON。
  function inputView(span){
    const inp=span.input;
    if(!inp) return '<div class="detail-note">无输入记录</div>';
    const hasMsg = inp.messages && Array.isArray(inp.messages);
    const hasSys = typeof inp.system==='string' && inp.system.length>0;
    if(hasMsg || hasSys){
      let h='<div class="detail-section"><div class="detail-section-head"><span class="detail-section-title">Prompt'+(hasMsg?' · '+inp.messages.length+' msg':'')+'</span>'+copyBtn(inp)+'</div>';
      if(hasSys) h+=msgBlock('system', inp.system, 'system · '+inp.system.length+' chars');
      if(hasMsg) inp.messages.forEach((m,i)=>{ h+=msgBlock(m.role||'?', m.content, '#'+i); });
      const rest=Object.fromEntries(Object.entries(inp).filter(e=>e[0]!=='system'&&e[0]!=='messages'));
      if(Object.keys(rest).length){ h+='<div class="detail-section-head" style="margin-top:14px"><span class="detail-section-title">其他字段 · '+esc(Object.keys(rest).join(', '))+'</span>'+copyBtn(rest)+'</div>'+jsonViewer(rest,'$.input.rest'); }
      return h+'</div>';
    }
    return '<div class="detail-section"><div class="detail-section-head"><span class="detail-section-title">Input</span>'+copyBtn(inp)+'</div>'+jsonViewer(inp,'$.input')+'</div>';
  }
  function outputView(span){
    const out=span.output;
    if(!out) return '<div class="detail-note">无输出记录</div>';
    if(out.content && typeof out.content==='string'){
      let h='<div class="detail-section"><div class="detail-section-head"><span class="detail-section-title">Assistant Response</span>'+copyBtn(out.content)+'</div>';
      h+='<div class="message-block"><div class="message-head"><span class="message-role" data-role="assistant">assistant</span><span style="font-family:var(--font-mono);color:var(--muted)">'+(span.tokensOut?span.tokensOut+' tok':'')+'</span></div><div class="message-body">'+esc(out.content)+'</div></div>';
      const rest=Object.fromEntries(Object.entries(out).filter(e=>e[0]!=='content'));
      if(Object.keys(rest).length){ h+='<div class="detail-section-head" style="margin-top:14px"><span class="detail-section-title">Other fields</span></div>'+jsonViewer(rest,'$.output'); }
      return h+'</div>';
    }
    return '<div class="detail-section"><div class="detail-section-head"><span class="detail-section-title">Output</span>'+copyBtn(out)+'</div>'+jsonViewer(out,'$.output')+'</div>';
  }
  function attrsView(span){
    const a=Object.assign({
      'span.id':span.id, 'span.kind':span.kind, 'span.type':span.type, 'span.name':span.name,
      'span.parent_id':span.parentId||null, 'span.status':span.status, 'span.duration_ms':span.dur, 'span.start_ms':span.start,
    },
    span.component?{'component.id':span.component}:{},
    span.model?{'llm.model':span.model}:{},
    span.tokensIn!=null?{'llm.tokens.input':span.tokensIn}:{},
    span.tokensOut!=null?{'llm.tokens.output':span.tokensOut}:{},
    span.cost!=null?{'llm.cost.usd_est':span.cost}:{},
    span.attrs||{});
    let rows='';
    Object.entries(a).forEach(e=>{ const v=e[1]; rows+='<dt>'+esc(e[0])+'</dt><dd>'+(v==null?'<span style="color:var(--muted)">null</span>':(typeof v==='object'?esc(JSON.stringify(v)):esc(String(v))))+'</dd>'; });
    return '<div class="detail-section"><div class="detail-section-head"><span class="detail-section-title">Attributes</span>'+copyBtn(a)+'</div><dl class="kv">'+rows+'</dl></div>';
  }
  function rawView(span){ return '<div class="detail-section"><div class="detail-section-head"><span class="detail-section-title">Raw Span (JSON)</span>'+copyBtn(span)+'</div>'+jsonViewer(span,'$.raw')+'</div>'; }

  function renderDetail(){
    const el=document.getElementById('detail'); if(!el) return;
    const span=activeSpan(); const trace=activeTrace();
    if(!span){ el.innerHTML='<div class="detail-empty"><div class="detail-empty-mark">'+icon('layers',16)+'</div><div>选择左侧 Trace 中的一个 Span 查看详情</div><div style="font-size:11px;color:var(--muted-2)">Select a span to inspect input / output / metadata</div></div>'; return; }
    const startedAt = parseTs(span.startedAt);
    const tabs=[
      {id:'input', label:'Input', show: !!span.input},
      {id:'output', label:'Output', show: !!span.output},
      {id:'attrs', label:'Attributes', count:Object.keys(span.attrs||{}).length, show:true},
      {id:'raw', label:'Raw', show:true},
    ].filter(t=>t.show);
    if(!tabs.find(t=>t.id===S.detailTab)) S.detailTab=tabs[0].id;
    const tagBadge='<span class="badge" style="color:var(--hue-'+span.type+');background:var(--hue-'+span.type+'-bg);border-color:color-mix(in oklch, var(--hue-'+span.type+'), transparent 70%)">'+(SPAN_TYPE_LABEL[span.type]||span.type)+'</span>';
    const modelBadge=span.model?'<span class="badge badge-muted">'+esc(span.model)+'</span>':'';
    // 子 agent 关联: subagent.start span 一键跳到子 agent 的独立 session
    let linkHtml='';
    if(span.childSessionId){
      linkHtml = '<div class="detail-body" style="flex:0 0 auto;padding-bottom:0"><div class="jump-link" data-action="open-child" data-sid="'+esc(span.childSessionId)+'">'+icon('layers',13)+'打开子 agent session → <span class="link-kv">'+esc(span.subagentName||'')+(span.subagentType?' · '+esc(span.subagentType):'')+'</span></div></div>';
    } else if(span.subagentName){
      linkHtml = '<div class="detail-body" style="flex:0 0 auto;padding-bottom:0"><div class="jump-link" style="opacity:.6;cursor:default">'+icon('layers',13)+'派生子 agent <span class="link-kv">'+esc(span.subagentName)+(span.subagentType?' · '+esc(span.subagentType):'')+'</span> · 无独立 trace</div></div>';
    }
    let bodyHtml='';
    if(S.detailTab==='input') bodyHtml=inputView(span);
    else if(S.detailTab==='output') bodyHtml=outputView(span);
    else if(S.detailTab==='attrs') bodyHtml=attrsView(span);
    else bodyHtml=rawView(span);

    el.innerHTML =
      '<div class="detail-head"><div class="detail-tags">'+tagBadge+statusBadge(span.status)+modelBadge+'</div>' +
        '<h2 class="detail-title">'+esc(span.name)+'</h2>' +
        '<div class="detail-id"><span>'+esc(shortId(span.id))+'</span>'+copyBtn(span.id)+'<span style="color:var(--muted-2)">·</span><span>parent '+esc(span.parentId?shortId(span.parentId):'—')+'</span></div></div>' +
      '<div class="detail-grid">' +
        '<div class="detail-grid-cell"><div class="detail-grid-label">Duration</div><div class="detail-grid-value">'+fmtMs(span.dur)+'</div></div>' +
        '<div class="detail-grid-cell"><div class="detail-grid-label">Started</div><div class="detail-grid-value">'+clockTime(startedAt)+'</div></div>' +
        '<div class="detail-grid-cell"><div class="detail-grid-label">Tokens (in / out)</div><div class="detail-grid-value">'+((span.tokensIn!=null||span.tokensOut!=null)?(fmtTokens(span.tokensIn||0)+' / '+fmtTokens(span.tokensOut||0)):'<span style="color:var(--muted)">—</span>')+'</div></div>' +
        '<div class="detail-grid-cell"><div class="detail-grid-label">Cost (est.)</div><div class="detail-grid-value">'+(span.cost!=null?fmtCost(span.cost):'<span style="color:var(--muted)">—</span>')+'</div></div>' +
      '</div>' +
      linkHtml +
      '<div class="detail-tabs">' + tabs.map(t=>'<span class="detail-tab" data-active="'+(S.detailTab===t.id)+'" data-action="set-detail-tab" data-v="'+t.id+'">'+t.label+(t.count!=null?'<span class="detail-tab-count">'+t.count+'</span>':'')+'</span>').join('') + '</div>' +
      '<div class="detail-body">'+bodyHtml+'</div>';
  }

  // ============================ render: tweaks ============================
  function renderTweaks(){
    const el=document.getElementById('tweaks'); if(!el) return;
    if(!S.tweaksOpen){ el.className='tweaks collapsed'; el.innerHTML='<div class="tweaks-toggle" data-action="toggle-tweaks">'+icon('settings',13)+' Tweaks</div>'; return; }
    el.className='tweaks';
    const accents=['#3b66e8','#7a5af8','#0e9484','#d96b30','#1f1f24'];
    el.innerHTML =
      '<div class="tweaks-hd"><span>Tweaks</span><button class="tweaks-x" data-action="toggle-tweaks">✕</button></div>' +
      '<div class="tweak-sect">主题 · Theme</div>' +
      '<div class="seg">'+[['light','Light'],['dark','Dark']].map(o=>'<button data-on="'+(S.theme===o[0]?1:0)+'" data-action="set-theme" data-v="'+o[0]+'">'+o[1]+'</button>').join('')+'</div>' +
      '<div class="tweak-sect">Accent</div>' +
      '<div class="swatches">'+accents.map(c=>'<div class="swatch" style="background:'+c+'" data-on="'+(S.accent===c?1:0)+'" data-action="set-accent" data-v="'+c+'"></div>').join('')+'</div>' +
      '<div class="tweak-sect">密度 · Density</div>' +
      '<div class="seg">'+[['compact','紧凑'],['cozy','适中'],['comfortable','宽松']].map(o=>'<button data-on="'+(S.density===o[0]?1:0)+'" data-action="set-density" data-v="'+o[0]+'">'+o[1]+'</button>').join('')+'</div>';
  }

  // ============================ events ============================
  function onTabChange(){
    if(S.tab==='logs' && !S.logs) loadLogs();
    else if(S.tab==='metrics' && !S.metrics) loadMetrics();
    else if(S.tab==='context' && (!S.context || !S.visible || !S.contextItems || !S.contextChannels)) loadContext();
    else renderCenter();
  }

  document.addEventListener('click', async (e)=>{
    const el=e.target.closest('[data-action]'); if(!el) return;
    const act=el.getAttribute('data-action'); const v=el.getAttribute('data-v');
    if(act==='copy'){ const id=el.getAttribute('data-copy'); try{ await navigator.clipboard.writeText(COPY[id]||''); el.innerHTML=icon('check',11); setTimeout(()=>el.innerHTML=icon('copy',11),1100);}catch(_){} return; }
    if(act==='select-session' || act==='open-child'){ const sid=el.getAttribute('data-sid'); if(!sid || sid===S.activeSessionId) return; S.activeSessionId=sid; S.tab='traces'; renderSidebar(); renderCenter(); loadTraces(sid);
        const cur=S.sessions.find(x=>x.session_id===sid); const list=document.querySelector('.session-list'); if(list){ const row=list.querySelector('.session-row[data-active="true"]'); if(row) row.scrollIntoView({block:'nearest'}); } return; }
    if(act==='toggle-trace'){ const tid=el.getAttribute('data-tid');
        // 多开: 互不影响, 点开第二个不会收起第一个
        if(S.openTraces.has(tid)){ S.openTraces.delete(tid); }
        else { S.openTraces.add(tid); const t=S.traces.find(x=>x.id===tid); if(t){ const pick=t.spans.find(s=>s.type==='llm'&&!s.noise)||t.spans.find(s=>s.type==='root')||t.spans.find(s=>!s.noise)||t.spans[0]; S.activeTraceId=t.id; S.activeSpanId=pick?pick.id:null; renderDetail(); } }
        renderCenter(); return; }
    if(act==='select-span'){ const tid=el.getAttribute('data-tid'), sid=el.getAttribute('data-sid'); S.activeTraceId=tid; S.activeSpanId=sid; S.detailTab='input';
        // 原地切换高亮, 不重渲染中栏 → 保留滚动位置
        document.querySelectorAll('.span-row[data-active="true"]').forEach(r=>r.setAttribute('data-active','false'));
        el.setAttribute('data-active','true');
        renderDetail(); return; }
    if(act==='toggle-span'){ e.stopPropagation(); const tid=el.getAttribute('data-tid'), sid=el.getAttribute('data-sid'); const set=collapsedSet(tid); if(set.has(sid)) set.delete(sid); else set.add(sid); renderCenter(); return; }
    if(act==='open-visible-index'){
      const visibleIndexId=el.getAttribute('data-visible-index-id');
      if(!visibleIndexId) return;
      if(S.activeVisibleIndexId===visibleIndexId){ S.activeVisibleIndexId=null; S.activeContextItemId=null; renderCenter(); return; }
      S.activeVisibleIndexId=visibleIndexId; S.activeContextItemId=null;
      if(S.visibleIndexDetails[visibleIndexId]) renderCenter(); else await loadVisibleIndex(visibleIndexId);
      return;
    }
    if(act==='open-context-item'){
      const itemId=el.getAttribute('data-item-id');
      if(!itemId) return;
      if(S.activeContextItemId===itemId){ S.activeContextItemId=null; renderCenter(); return; }
      S.activeContextItemId=itemId;
      if(S.contextItemDetails[itemId]) renderCenter(); else await loadContextItem(itemId);
      return;
    }
    if(act==='set-context-mode'){
      S.contextMode=v==='channels' ? 'channels' : 'items';
      S.activeContextItemId=null;
      renderCenter();
      return;
    }
    if(act==='open-context-span'){
      const spanId=el.getAttribute('data-span-id');
      openTraceSpan(spanId); return;
    }
    if(act==='open-trace-span'){
      openTraceSpan(el.getAttribute('data-span-id')); return;
    }
    if(act==='set-filter'){ S.filter=v; renderCenter(); return; }
    if(act==='toggle-context'){ S.showContext=!S.showContext; renderCenter(); return; }
    if(act==='toggle-noise'){ S.showNoise=!S.showNoise; renderCenter(); return; }
    if(act==='set-loglevel'){ S.logLevel=v; loadLogs(); return; }
    if(act==='set-tab'){ S.tab=v; onTabChange(); return; }
    if(act==='set-detail-tab'){ S.detailTab=v; renderDetail(); return; }
    if(act==='json-toggle'){ const p=el.getAttribute('data-path'); S.jsonCollapsed[p]=!S.jsonCollapsed[p]; renderDetail(); return; }
    if(act==='toggle-theme'){ S.theme=S.theme==='dark'?'light':'dark'; localStorage.setItem('ts.theme',S.theme); applyChrome(); rerenderChromeButtons(); renderTweaks(); return; }
    if(act==='set-theme'){ S.theme=v; localStorage.setItem('ts.theme',v); applyChrome(); rerenderChromeButtons(); renderTweaks(); return; }
    if(act==='set-density'){ S.density=v; localStorage.setItem('ts.density',v); applyChrome(); renderTweaks(); return; }
    if(act==='set-accent'){ S.accent=v; localStorage.setItem('ts.accent',v); applyChrome(); renderTweaks(); return; }
    if(act==='toggle-tweaks'){ S.tweaksOpen=!S.tweaksOpen; renderTweaks(); return; }
    if(act==='refresh'){ refreshAll(); return; }
  });

  function rerenderChromeButtons(){
    const btn=document.querySelector('[data-action="toggle-theme"]'); if(btn) btn.innerHTML = S.theme==='dark'?icon('sun',14):icon('moon',14);
  }

  async function refreshAll(){
    if(S.refreshing) return; S.refreshing=true;
    const rb=document.getElementById('refreshBtn'); if(rb) rb.classList.add('spin');
    try {
      await loadOverview();
      await loadSessions();
      if(S.activeSessionId) await loadTraces(S.activeSessionId);
      S.logs=null; S.metrics=null; S.context=null; S.visible=null; S.contextItems=null; S.contextChannels=null;
      S.visibleIndexDetails={}; S.activeVisibleIndexId=null;
      S.contextItemDetails={}; S.activeContextItemId=null;
      if(S.tab==='logs') await loadLogs(); else if(S.tab==='metrics') await loadMetrics(); else if(S.tab==='context') await loadContext();
    } catch(_){} finally { S.refreshing=false; const r=document.getElementById('refreshBtn'); if(r) r.classList.remove('spin'); }
  }

  window.addEventListener('keydown', e=>{ if((e.metaKey||e.ctrlKey)&&e.key==='k'){ e.preventDefault(); const i=document.getElementById('search'); if(i) i.focus(); } });

  // ============================ boot ============================
  async function boot(){
    applyChrome();
    renderShell();
    renderStats(); renderSidebar(); renderCenter(); renderDetail(); renderTweaks();
    try {
      await loadOverview();
      await loadSessions();
      if(S.activeSessionId) await loadTraces(S.activeSessionId);
      if(S.tab==='logs') await loadLogs(); else if(S.tab==='metrics') await loadMetrics(); else if(S.tab==='context') await loadContext();
    } catch(e){
      document.getElementById('center').innerHTML = centerToolbar()+'<div class="empty-note">加载失败: '+esc(String(e))+'</div>';
    }
  }
  boot();
  </script>
</body>
</html>
"""
