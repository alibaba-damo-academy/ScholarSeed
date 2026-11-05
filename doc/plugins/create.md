---
id: guide-plugin-create
title: Create a Plugin
doc_type: design
category: skills
status: active
keywords: [skill, sdk, hil]
summary: Generate a plugin with AI, or write and package the complete four-file example.
---

# Create a Plugin

**English** · [简体中文](create.zh.md) · [Read offline](../plugins.html#create)

[Plugin Overview](../plugins.md)

This tutorial builds **paper-reading-notes**. A user supplies a paper or excerpt, chooses **Understand the method** or **Check the evidence**, and receives focused notes with source locations.

## Ask the AI to Create It

Send this in a ScholarSeed conversation:

> Use plugin-create to create a paper-reading-notes plugin. After the user supplies a paper or excerpt, show a card asking for a reading focus: Understand the method or Check the evidence. For method notes, summarize the research question, method steps, and applicable conditions. For evidence notes, summarize conclusions, supporting evidence, and limitations. Include page or paragraph locations and mark missing information as not stated. Generate the source, validate and package the ZIP, then provide an installation card.

The AI generates the Skill, descriptor, component, and scenarios. Review the source and reports before confirming installation. To revise it, ask `plugin-create` for changes in the same conversation; do not create a second plugin with the same identity.

## Write It Yourself

In a Python environment with the target ScholarSeed backend installed, obtain the required `host` value:

```sh
python -c "from importlib.metadata import version; print('==' + version('scholarseed'))"
```

Create these files:

```text
paper-reading-notes/                 # Source and package input directory
├── SKILL.md                         # Reading workflow and note requirements
├── .scholarseed-plugin.json          # Identity, compatibility, cards, and actions
└── components/
    ├── focus.js                     # Reading-focus card
    └── focus.preview.json           # Example input and submissions
request.json                        # Validation request, outside the plugin directory
```

The packaging tool generates `.scholarseed-package.json`; do not write it by hand.

### 1 SKILL.md

Use the [standard Skill format](https://agentskills.io/specification) ([source](https://github.com/agentskills/agentskills)). This is an example inside the plugin, not a modification to ScholarSeed's bundled Skills.

```markdown
---
name: paper-reading-notes
description: Produce method notes or evidence notes for a paper or excerpt, according to the user's chosen reading focus.
version: "0.1.0"
---

# Paper Reading Notes

1. Confirm the supplied paper or excerpt; ask for materials if missing.
2. Query component/catalog and check that reading.focus is available.
3. Use component/request to publish a reading-focus card with a question and unique request_id.
4. Wait for the answer and parse JSON {action, values} from result.answers.
5. When action is confirm, use values.focus to generate:
   - method: research question, method steps, and applicable conditions.
   - evidence: conclusions, supporting evidence, and limitations.
6. Include page or paragraph locations for every note. Mark missing information as not stated.
7. Stop on cancellation or failure. If only an abstract or excerpt is available, state that coverage limit.
```

### 2 .scholarseed-plugin.json

The descriptor declares identity, card entry, and input/output contracts. Replace `__HOST__` with the complete output of the command above, including `==`.

```json
{
  "schema": 2,
  "id": "paper-reading-notes",
  "version": "0.1.0",
  "host": "__HOST__",
  "skill": "SKILL.md",
  "ui": {
    "compatibility": "1.0",
    "exports": ["React", "mount", "Button"]
  },
  "capabilities": ["interaction.answer"],
  "components": [
    {
      "id": "focus",
      "slot": "reading.focus",
      "entry": "components/focus.js",
      "preview": "components/focus.preview.json",
      "input_schema": {
        "type": "object",
        "required": ["question"],
        "properties": {"question": {"type": "string"}},
        "additionalProperties": false
      },
      "output_schema": {
        "type": "object",
        "required": ["focus"],
        "properties": {"focus": {"type": "string", "enum": ["method", "evidence"]}},
        "additionalProperties": false
      },
      "actions": [
        {
          "id": "confirm",
          "capability": "interaction.answer",
          "input_schema": {
            "type": "object",
            "required": ["focus"],
            "properties": {"focus": {"type": "string", "enum": ["method", "evidence"]}},
            "additionalProperties": false
          }
        }
      ]
    }
  ],
  "configuration": []
}
```

#### Top-Level Fields

| Field | Meaning | Value in this example |
| --- | --- | --- |
| `schema` | Descriptor format | The number `2`. |
| `host` | Supported backend distribution version | The exact queried version, prefixed by `==`. |
| `id` | Unique plugin name | `paper-reading-notes`, matching the Skill name; preserve it on updates. |
| `version` | Plugin release version | `0.1.0`, matching the Skill and packaging command; increment for updates. |
| `skill` | Skill entry path | `SKILL.md`. |
| `ui.compatibility` | ScholarSeed UI API version | `"1.0"`. |
| `ui.exports` | Official exports used by the component | `React`, `mount`, and `Button`; update when adding controls. |
| `capabilities` | Capabilities required by card actions | `["interaction.answer"]`. |
| `components` | Cards | One `focus` component, described below. |
| `configuration` | Optional configuration declarations | `[]` in this example. |

#### Card Fields

| Field | How to set it |
| --- | --- |
| `id` | Component name, unique within the plugin: `focus`. |
| `slot` | Name requested by the AI: `reading.focus`. Use two dot-separated segments; each starts with a lowercase letter and may contain digits or hyphens. |
| `public` | Defaults to `false`. Set `true` only to reference an existing [public card](cards.md#public-business-slots), using its slot and no `entry`. |
| `entry` | Relative JavaScript path: `components/focus.js`. |
| `preview` | Scenario JSON path: `components/focus.preview.json`. |
| `input_schema` | JSON Schema for card `data`; defaults to an object. Declare required fields and types. |
| `output_schema` | JSON Schema for answer `values`; defaults to an object. Do not wrap it in `{action, values}`. |
| `actions` | Defaults to `[]`. Each action has a unique `id` used by `submit` or `request`, a `capability` declared at top level, and an `input_schema` for its `values` (default object). |

For `submit("confirm", {focus: "method"})`, `confirm` is the action ID. Both the action schema and component output schema validate `{focus: "method"}`.

#### Configuration and Validation Rules

Each configuration declaration needs a unique `key`, a `type` (`string`, `integer`, or `boolean`), and a display `label`. It may include `required` and a `default` of the declared type. Declarations currently do not provide a settings page or value read/write API.

Unknown descriptor fields are rejected. Resource paths use `/` and are relative to the plugin root; no `..`, absolute paths, or Windows reserved names. Schemas cannot use `$ref` or `$dynamicRef`. Revalidate after edits.

### 3 components/focus.js

The buttons submit the chosen focus. Actions are enabled only while pending. For editable forms, also handle [drafts and state](runtime.md#drafts-and-answers).

```javascript
(() => {
  const { React, mount, Button } = window.scholarseedUI;
  const create = React.createElement;

  function FocusCard({ state }) {
    const disabled = state.status !== "pending";
    const chinese = state.language.startsWith("zh");
    return create("section", { "aria-label": chinese ? "阅读重点" : "Reading focus" },
      create("p", null, state.data.question),
      create(Button, {
        disabled,
        onClick: () => window.plugin.submit("confirm", { focus: "method" })
      }, chinese ? "理解方法" : "Understand the method"),
      create(Button, {
        disabled,
        onClick: () => window.plugin.submit("confirm", { focus: "evidence" })
      }, chinese ? "核对证据" : "Check the evidence")
    );
  }

  mount(state => create(FocusCard, { state }));
})();
```

The example intentionally includes both Chinese and English button labels, selected using the language supplied by ScholarSeed.

### 4 components/focus.preview.json

The descriptor's `preview` field connects this scenario to `focus.js`. `data` is sample input, `responses` simulates action responses, and `submissions` lists values to validate. A real conversation uses actual request data, not this file.

```json
{
  "data": {"question": "What would you like to focus on in this paper?"},
  "responses": {
    "confirm": {"state": "resolved", "data": {"focus": {"$input": "focus"}}}
  },
  "submissions": {
    "confirm": [{"focus": "method"}, {"focus": "evidence"}]
  }
}
```

## Request the Card

After installation and enabling, the AI requests the card with these `scholarseed_bridge` arguments:

```json
{
  "capability": "component",
  "operation": "request",
  "request": {
    "request_id": "reading-focus-1",
    "slot": "reading.focus",
    "data": {
      "question": "What would you like to focus on in this paper?"
    },
    "title": "Choose a reading focus",
    "prompt": "Choose a focus to generate the corresponding reading notes."
  }
}
```

When the backend returns the answer, parse `{action, values}` from `result.answers` and generate notes according to `values.focus`.

Before requesting the card, [preflight the slot](api.md#discover-components-and-slots) for conflicts with enabled plugins. Use a new `request_id` for each new question.

## Validate and Package

Save the **inner `request` object** above as `request.json`. From the plugin's parent directory, run:

```sh
python -m service.cli.plugins validate ./paper-reading-notes/.scholarseed-plugin.json ./request.json
python -m service.cli.plugins pack ./paper-reading-notes --name paper-reading-notes --version 0.1.0 --output ./paper-reading-notes-0.1.0.zip
```

After `valid=true`, retain the ZIP and SHA-256. Keep the ZIP outside the source directory. Increment the version and build a new package for updates.

`capabilities_unchecked` means runtime capabilities have not been verified. Offline validation is not installation or execution; continue with [a real end-to-end task](testing.md#install-and-complete-a-first-conversation).

## Install and Try It

- **AI-generated:** Review the report on the installation card and confirm installation. `published` means only that the card was published.
- **Hand-written:** In the Skills center, choose **Add skill**, select the ZIP, review the checks, and confirm installation.

After enabling the plugin, send:

> Please use paper-reading-notes to make reading notes for the paper I just uploaded. Let me choose the reading focus first.

**Understand the method** should produce the research question, method steps, and applicable conditions. **Check the evidence** should produce conclusions, evidence, and limitations. Both must include source locations. Follow [Test a Plugin](testing.md#install-and-complete-a-first-conversation) for the complete checks.

Next: [Public Conversation Cards](cards.md) · [How Plugins Run](runtime.md).
