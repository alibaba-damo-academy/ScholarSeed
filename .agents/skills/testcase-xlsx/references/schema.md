# JSON and Excel Schema

The root may be an array or an object with a `cases` array and optional `title`, `source_category`, `source_references`, and `case_count`.

Each case requires `id`, `name`, `folder`, `author`, `priority`, `precondition`, `steps`, `expected`, `tag`, and `description`. Priorities range from `P0` to `P3`. Steps and expected results accept multiline strings or string arrays. Existing workbook defaults are `手工` for `case_type` and `文本` for `content_type`.

The workbook sheet is named `测试用例` with headers in this order: `编号, 用例名称, 用例文件夹, 作者, 优先级, 用例类型, 前置条件, 内容类型, 步骤内容, 预期结果, 标签, 描述`.

Optional JSON-only automation metadata uses `automation.e2e` with fields such as `status`, `framework`, `references`, `cwd`, `command`, and `note`. Suggested statuses are `planned`, `automated`, and `not-applicable`. Workbook extraction cannot recover these fields.
