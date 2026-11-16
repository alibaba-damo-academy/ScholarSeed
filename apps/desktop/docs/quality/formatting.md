<a id="仓库格式规范"></a>
# Repository Formatting Standards

## Source of truth

- The root `.editorconfig` specifies UTF-8, LF, a final newline, and space indentation: two spaces for general files and four for Python.
- Desktop uses `apps/desktop/.prettierrc`; personal editor preferences must not override repository settings: no semicolons, single quotes, ES5 trailing commas, 100 columns, two spaces, parentheses around arrow parameters, and LF. Desktop's `package-lock.json` pins the Prettier version; use the repository's Node/npm versions and installed local executable.
- Continue to format Python with the root `pnpm ops ci format --write` / `pnpm ops ci format`, not Prettier.
- The root `.prettierignore` excludes knowledge documents and AI entry points; do not run `prettier --write .` across the repository.

## Current / Required / Gap

- **current**: root `.husky/pre-commit` runs lint-staged from Desktop. Touched `src` TypeScript/TSX files run through ESLint and Prettier; CSS/JSON files run through Prettier.
- **required**: editors use the nearest repository Prettier configuration. Before committing, format the paths touched by the change and review the diff. Formatting an existing file for the first time can produce a large diff; obtain explicit authorization for that scope before including it with a product change, and do not automatically extend formatting to untouched files.
- **required**: `src/localization/types.d.ts` and `src/localization/resources.ts` are generated entirely by root `pnpm ops ci check i18n --generate`; both root and Desktop `.prettierignore` exclude these exact paths. Do not manually format or edit them. Regenerate after merging the JSON sources of truth instead of merging generated types line by line.
- **required**: source text contracts pin semantics only, not indentation, trailing commas, or line breaks that formatting can change.
- **gap**: this rule does not mean that all existing source has completed the formatting migration.

## Verification

Run from `apps/desktop`, explicitly substituting the source paths touched by the change:

```bash
npx --no-install prettier --write src/renderer/src/features/workbench/links.ts
npx --no-install prettier --check src/renderer/src/features/workbench/links.ts
npm run i18n:generate
node --test scripts/ci/localization/__tests__/prettier.test.mjs
```

The formatting contract test checks LF output idempotence and verifies that generated files are excluded while product source is not. Commit hooks retain the same configuration; do not bypass the standard or rewrite generated files.
