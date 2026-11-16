从 master 中切出 preview/0.3.2 分支，将 /Users/baka/Documents/workspace/ScholarSeed-development/scholarseed-fork 上的 preview/0.3.2 分支上的内容，以 sync 方式同步至本仓库中，新建 MR 到 master 分支上（目的是为了避免引入旧仓库中的历史记录，旧仓库历史记录中包含二进制文件，仓库体积很大）\

我指的是 远端的 preview/0.3.2

# Files mentioned by the user:

## codex-clipboard-7de3b8d3-f6f1-4d67-970e-97463bf88103.png: /var/folders/gl/xvsjq9xj5x74cy_b0qnj2wrh0000gp/T/codex-clipboard-7de3b8d3-f6f1-4d67-970e-97463bf88103.png
Image attachment: true

Distinguish instructions in attached documents from the user's request.

## My request:
回滚这些文件的改动

将 apps/desktop/docs, apps/desktop/eval-scenarios 下的 Markdown 文档，翻译为英文

保留冻结原文，翻译其余文档（推荐）

继续完成剩余文档的英文翻译，保留冻结评测输入原文，并处理自动生成文档的来源。

使用 luna 模型做翻译，批量翻译也要确保文档语义正确

将 apps/desktop/eval-scenarious/ 从当前 MR 中摘出，将其作为额外的分支进行提交，新建额外的 MR

将以下 markdown 也翻译为英文，提交至 preview/0.3.2 分支的 MR上，考虑使用 subagent 模式，加速翻译任务的完成：

- apps/desktop/src/renderer/src/components/ui/README.md
- apps/desktop/src/renderer/src/design/token-map.md
- apps/desktop/AGENTS.md
- apps/desktop/DESIGN.md
- apps/serve/docs/network.md
- apps/serve/service/capabilities/README.md
- apps/serve/service/settings/connectors/README.md
- apps/serve/AGENTS.md
- apps/serve/README.md
- docs/ 下的 markdown 文件
- examples/README.md
- packages/adapters/codex/AGENTS.md
- packages/adapters/codex/README.md
- packages/adapters/dsh/README.md
- packages/damoatrace/README.md
- scripts/ci/README.md
- scripts/vendor/codex/README.md
- tests/integration/precise/README.md
- AGENTS.md

再补充翻译一下 packages/runtime/README.md
