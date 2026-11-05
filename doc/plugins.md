---
id: guide-plugin-developers
title: Plugin Overview
doc_type: design
category: skills
status: active
keywords: [skill, sdk, hil]
summary: Learn what plugins can do and how to create, install, and use them in a conversation.
---

# Plugin Overview

**English** · [简体中文](plugins.zh.md) · [Read offline](plugins.html)

A plugin packages a Skill and conversation cards into an installable workflow. The Skill tells the AI how to perform a task; cards display results or collect user decisions.

> [!WARNING]
> Plugins are in **developer preview** and evolving rapidly. Future versions may introduce **breaking changes**.

## What Plugins Can Do

- **Organize workflows:** Read authorized materials, call backend operations, handle user decisions, and deliver results.
- **Show conversation cards:** Reuse public business cards or build your own interactions.
- **Reuse the official UI:** Use the React runtime, controls, and Conversation components provided by ScholarSeed.
- **Deliver inspectable packages:** Produce a ZIP and digest for the user to review and confirm installation.

Plugins do not provide global tool interception, automatic approval, or arbitrary hooks into ScholarSeed events. To perform business operations, the Skill must use the [available APIs](plugins/api.md); adding a button alone does not connect an operation.

## Create a Plugin

- **Through a conversation:** Ask ScholarSeed to use `plugin-create` and describe your workflow. The AI can generate and revise the plugin.
- **Write it yourself:** Follow the [creation tutorial](plugins/create.md#write-it-yourself) to connect a Skill, descriptor, and UI. Its example uses plain `.js` and ScholarSeed's React runtime: no separate Node.js installation, frontend bundler, or JSX/TypeScript compilation is required for that example. Validate and package the ZIP before delivery.

## Install and Use

In the Skills center, choose **Add skill**, review the ZIP identity, version, and risks, and confirm installation. AI-generated plugins can also be delivered through an installation card; publishing a card does not mean installation succeeded.

After installation and enabling the plugin, ask the AI to use it in a conversation. You do not need to bind it through the Skill picker first.

Install plugins only from trusted sources. An isolated component iframe does not mean Skill scripts run in a general-purpose sandbox. Never include credentials, login caches, or environment files in a package.

## Guides

- [Create a Plugin](plugins/create.md): Generate a plugin with AI or write your first one.
- [Public Conversation Cards](plugins/cards.md): Choose public slots, Conversation components, and UI controls.
- [How Plugins Run](plugins/runtime.md): Understand rendering, drafts, answers, updates, and historical cards.
- [Available APIs](plugins/api.md): Find frontend SDK methods, backend operations, and their actual contracts.
- [Test a Plugin](plugins/testing.md): Validate a package, run a real task, and troubleshoot failures.
