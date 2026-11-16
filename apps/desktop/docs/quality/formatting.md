# 仓库格式规范

## Source of truth

- 根目录 `.editorconfig` 固定 UTF-8、LF、末尾换行和空格缩进；通用文件两空格，Python 四空格。
- Desktop 使用 `apps/desktop/.prettierrc`，不使用个人编辑器格式偏好覆盖仓库配置：无分号、单引号、ES5 尾逗号、100 列、两空格、箭头参数括号和 LF。Prettier 版本由 Desktop 的 `package-lock.json` 固定；使用仓库指定 Node/npm 和安装后的本地程序。
- Python 继续使用根目录 `pnpm ops ci format --write` / `pnpm ops ci format`，不由 Prettier 格式化。
- 知识文档和 AI 入口按根 `.prettierignore` 排除；不对全仓库执行 `prettier --write .`。

## Current / Required / Gap

- **current**：根 `.husky/pre-commit` 从 Desktop 运行 lint-staged；受触及的 `src` TypeScript/TSX 经 ESLint 与 Prettier，CSS/JSON 经 Prettier。
- **required**：编辑器使用最近的仓库 Prettier 配置，提交前先对本次触及路径运行格式化并审阅 diff。存量文件首次格式化可能产生大 diff；与业务变更一起提交前须明确获得该范围授权，不能自动扩大到未触及文件。
- **required**：`src/localization/types.d.ts` 与 `src/localization/resources.ts` 完全由 根目录 `pnpm ops ci check i18n --generate` 生成，根与 Desktop `.prettierignore` 均排除这两个精确路径。不得手工格式化或编辑它们；JSON 真源合并后重新生成，不逐行合并生成类型。
- **required**：源码文本契约只钉语义，不依赖可由格式化改变的缩进、尾逗号或换行。
- **gap**：此规则不代表全部存量源码已经完成统一格式迁移。

## Verification

在 `apps/desktop` 运行，显式替换为本次触及的源码路径：

```bash
npx --no-install prettier --write src/renderer/src/features/workbench/links.ts
npx --no-install prettier --check src/renderer/src/features/workbench/links.ts
npm run i18n:generate
node --test scripts/ci/localization/__tests__/prettier.test.mjs
```

格式契约测试验证 LF 输出的幂等性，以及生成物被排除但业务源码不被排除。提交钩子保留相同配置，不绕过规范或改写生成物。
