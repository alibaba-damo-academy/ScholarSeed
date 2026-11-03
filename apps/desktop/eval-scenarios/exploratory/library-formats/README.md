# 资料库四种格式打开与使用：探索性评测

方向：`RES-01`。状态：探索场景，暂无获批 PRD Requirement/Check，不计发布覆盖。本目录只提供可复现输入与候选判据，`baseline.json` 是待验证期望，不是运行结果；是否通过必须按真实构建的产品证据判定。

## 业务目标与边界

在同一个隔离项目中通过资料库导入并逐个打开 DOCX、XLSX、MD、PDF；各格式均应显示与原文件一致的关键内容。随后在一轮真实对话中分别使用四份资料回答问题。每种格式独立判定，任一格式的成功不能外推给另一格式。本轮只验证 `.xlsx`，不覆盖 `.xls`、编辑保存、导出或文件版本管理。

## 文件职责

- `scenario.json`、`cmd.jsonl`、`baseline.json` 沿用场景库三件套。`cmd.jsonl` 初始仅检查状态；Driver 按实际观察在忽略的运行副本中追加动作。
- `fixtures/` 仅包含合成无凭据资料及生成脚本。四份资料文件是实际导入对象，生成脚本不导入产品项目。
- `test_scene.py` 消费 `scenario.json` 物化文件，并经当前 Content 解码器核对四种格式；它只验证夹具和契约，不是产品验收。
- `driver.md` 只含用户可见任务与操作边界；独立 Driver 不读取 `judge.md` 或夹具原文。
- `judge.md` 保存候选参考事实和四项人读 Check，仅交独立 Judge。

## 环境准备与计时内业务导入

先冻结方向行修订、场景与判据的 Git commit、目标构建身份、模型、账号态、平台、预算和 30 分钟停止条件。复制场景到本次忽略的运行目录；按 `scenario.json` 把四份 fixture 暂存到运行目录的 `library/`，记录暂存文件 SHA-256。不要把脚本、`judge.md` 或场景说明放入待导入目录。

环境就绪后按 [执行入口](../../../../../.agents/skills/llm-evaluation/SKILL.md#batch-与-report)记录整批 T0；本节的项目创建及业务导入属于计时内动作，不能作为下载/安装准备排除。通过真实产品 UI 新建并读回本次独占项目及实际工作区；资料库选“导入本地资料 → 复制到项目”，用原生选择器选择暂存 `library/`。导入提示仅说明任务开始；等各导入任务与来源终态成功、刷新资料树，核对项目中的 `resources/library/` 四份文件与暂存字节摘要。目录或文件被重命名、归属不明或导入不完整时，记录业务执行缺口，不发送业务问题、不重新起表。Composer 附件不替代资料库导入。

Driver 按 [操作任务](driver.md)逐个在资料库打开四份文件、观察可见内容后发起一轮对话。Observer 冻结每个打开动作与真实窗口截图、项目和资料身份、原始用户消息和答复、session/turn/action 序号，以及**每种格式各自**的产品侧读取/来源或 Trace 指针与停止状态；缺独立读取证据就标缺口，不以答对内容代替。截图需实际打开检查；UI 内容、项目文件字节和模型答案分别取证。`ack.ok`、页签名、固定等待或 `running=false` 都不能独自证明打开正确或语义完成。

按 [候选判据](judge.md)逐格式给 `pass / fail / inconclusive / not_evaluated`。报告列出四项分母、执行状态、首轮失败与缺证、产品/Driver/Judge 用量和时间；无法取得的数据写未知。超过预算停止新增动作，未执行格式为 `not_evaluated`，不因停表删减方向。

## 夹具生成和核验

`fixtures/build.py docx|pdf` 以 Codex bundled Python 的 `python-docx`、`reportlab` 生成 DOCX/PDF；`fixtures/build.mjs` 以 bundled Node 和 `@oai/artifact-tool` 生成 XLSX，执行时需将 bundled `node_modules` 临时链接到 `fixtures/`，完成后移除链接。`interview-notes.md` 是纯 UTF-8 文本。生成脚本本身不由产品读取。下表摘要是本次入库文件的固定身份；重新生成导致摘要变化时，需要重新审查场景与判据，不能沿用旧运行证据。

| 文件 | SHA-256 |
| --- | --- |
| `pilot-brief.docx` | `780c28dbf334b0734c87edbd05246306462cb99c8b86c1bffe4bae3a4f816e3b` |
| `equipment-plan.xlsx` | `1fa7ab52c98c2ccd9338ecda138f3d1ce5036bfab5168607f3234e98d3d934e0` |
| `interview-notes.md` | `f03333a4eefcf3389f215637f29525a3cc081edcb60dcc3353343eb48ce32cba` |
| `rollout-note.pdf` | `b6ad9ab109efada67b0650aeaac7ca5724cbe23fa7879fc80d864e914f2ad240` |

这四个短文件均为评测编造的业务资料，不含真实用户或企业数据。其可解析性和视觉完整性在入库前检查；静态核验不能代替候选构建上的实际导入、打开与模型回答。
