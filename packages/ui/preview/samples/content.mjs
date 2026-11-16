import { productivitySources } from './studies.mjs'

const preset = (id, label, data) => ({ id, label, data })
const percent = String.raw`\%\Delta = \left(e^{\hat{\beta}} - 1\right) \times 100\%`
const matrix = String.raw`\hat{\boldsymbol\beta} = \left(\mathbf{X}^{\top}\mathbf{X}\right)^{-1}\mathbf{X}^{\top}\mathbf{y}, \qquad \mathbf{X} = \begin{bmatrix} 1 & x_{11} & \cdots & x_{1p} \\ 1 & x_{21} & \cdots & x_{2p} \\ \vdots & \vdots & \ddots & \vdots \\ 1 & x_{n1} & \cdots & x_{np} \end{bmatrix}`
const formula = [
  preset('difference-in-differences', '双重差分模型与变量说明', {
    caption: '双重差分模型',
    source: String.raw`\ln y_{it} = \alpha_i + \lambda_t + \beta\,\mathrm{AI}_{it} + \varepsilon_{it}`,
    notes: String.raw`$y_{it}$：客服 $i$ 在第 $t$ 期每小时解决的问题数
$\mathrm{AI}_{it}$：是否已能使用 AI 助手（是 = 1）
$\alpha_i,\ \lambda_t$：个人固定效应、时间固定效应`,
  }),
  preset('percentage', '百分比换算', { caption: '百分比换算', source: percent }),
  preset('logit', '随机效应 Logit 的边际似然', {
    caption: '随机效应 Logit 的边际似然',
    source: String.raw`\hat{\boldsymbol\theta} = \arg\max_{\boldsymbol\theta}\; \sum_{i=1}^{N} \log \int_{-\infty}^{\infty} \prod_{t=1}^{T_i} \frac{\exp\!\left(\mathbf{x}_{it}^{\top}\boldsymbol\beta + u\right)^{y_{it}}}{1+\exp\!\left(\mathbf{x}_{it}^{\top}\boldsymbol\beta + u\right)}\,\phi\!\left(\frac{u}{\sigma_u}\right)\frac{\mathrm{d}u}{\sigma_u}`,
  }),
  preset('matrix', '最小二乘估计（矩阵形式）', {
    caption: '最小二乘估计（矩阵形式）',
    source: matrix,
  }),
  preset('matrix-long', '超长矩阵公式：横向滚动', {
    caption: '最小二乘估计（超长滚动示例）',
    source: Array(5)
      .fill(matrix)
      .join(String.raw`\qquad + \qquad `),
  }),
  preset('event-study', '事件研究模型', {
    caption: '事件研究模型',
    source: String.raw`\ln y_{it} = \alpha_i + \lambda_t + \sum_{k=-K,\;k\neq -1}^{L} \beta_k\,\mathbf{1}\!\left[t - E_i = k\right] + X_{it}'\gamma + \varepsilon_{it}`,
  }),
  preset('cohens-d', "标准化效应量（Cohen's d）", {
    caption: "标准化效应量（Cohen's d）",
    source: String.raw`\begin{aligned} d &= \frac{\bar{x}_{\mathrm{AI}} - \bar{x}_{\mathrm{control}}}{s_{\mathrm{pooled}}} \\[4pt] s_{\mathrm{pooled}} &= \sqrt{\frac{(n_1-1)\,s_1^2 + (n_2-1)\,s_2^2}{n_1 + n_2 - 2}} \end{aligned}`,
  }),
  preset('untitled', '无公式名称', { source: percent }),
  preset('parse-error', '公式解析失败：保留原文', {
    caption: '百分比换算',
    source: String.raw`\%\Delta = \left(e^{\hat{\beta}} - 1\right \times 100\%`,
  }),
  preset('units', '百分比换算与单位核对', {
    caption: '百分比换算',
    source: percent,
    notes: String.raw`$\hat{\beta}$：对数结果变量的估计系数，无量纲；示例值 0.14。
$\%\Delta$：相对变化，以百分比（%）表示，不是百分点。`,
  }),
]

const columns = (labels) => labels.map((label, index) => ({ key: `column-${index}`, label }))
const rows = (values) => values.map((row, index) => ({ id: `row-${index + 1}`, values: row }))
const table = (caption, labels, values, extra = {}) => ({
  caption,
  dataset: { columns: columns(labels), rows: rows(values) },
  ...extra,
})
const tables = [
  preset(
    'comparison',
    '四项研究对照',
    table(
      '四项研究对照',
      ['研究', '对象', '任务', '效率变化', '质量变化'],
      [
        ['Noy & Zhang 2023', '453 名专业人士', '商务写作', '用时约 −40%', '评分约 +18%'],
        ['Brynjolfsson 等 2025', '5,172 名客服', '在线客服', '每小时解决数约 +15%', '资深员工略降'],
        [
          "Dell'Acqua 等 2026",
          '758 名咨询顾问',
          '咨询任务',
          '范围内速度 +25.1%',
          '范围外正确率 −19 个百分点',
        ],
        ['Peng 等 2023', '开发者', '编程任务', '速度 +55.8%', '未评估'],
      ],
      { notes: '各研究的效率指标不同，不宜直接比较大小。' }
    )
  ),
  preset(
    'wide-comparison',
    '四项研究完整对照：宽表滚动',
    table(
      '四项研究完整对照',
      [
        '研究',
        '对象与样本',
        '任务',
        '研究设计',
        '效率指标',
        '效率变化',
        '质量变化',
        '异质性',
        '出处',
      ],
      [
        [
          'Noy & Zhang 2023',
          '453 名专业人士',
          '商务写作',
          '线上随机实验',
          '完成用时',
          '约 −40%',
          '评分约 +18%',
          '原本写得较差的人提升更多',
          'Science',
        ],
        [
          'Brynjolfsson 等 2025',
          '5,172 名客服',
          '在线客服',
          '分批上线的自然实验',
          '每小时解决数',
          '平均约 +15%',
          '资深员工质量略降',
          '新手和低技能员工提升最大',
          'QJE',
        ],
        [
          "Dell'Acqua 等 2026",
          '758 名咨询顾问',
          '咨询任务',
          '预注册现场实验',
          '完成任务数、速度',
          '范围内速度 +25.1%',
          '范围内 +40% 以上；范围外正确率 −19 个百分点',
          '能力较弱者提升更多',
          'Organization Science',
        ],
        [
          'Peng 等 2023',
          '开发者',
          '编写 HTTP 服务器',
          '受控实验',
          '完成用时',
          '速度 +55.8%',
          '未评估',
          '—',
          'arXiv',
        ],
      ]
    )
  ),
  preset(
    'sources-missing',
    '研究结果、来源与缺失值',
    table(
      '研究结果与来源',
      ['研究', '指标与单位', '变化', '质量结果'],
      [
        ['Noy & Zhang 2023', '完成用时（%）', '约 −40%', '评分约 +18%'],
        ['Brynjolfsson 等 2025', '每小时解决数（%）', '约 +15%', null],
        ['Peng 等 2023', '完成用时（%）', '约 −55.8%', '未评估'],
      ],
      {
        notes: '— 表示本次材料未提供该项数据，不表示 0；各研究指标不同，不直接比较数值大小。',
        sources: productivitySources,
        citations: [
          { rowId: 'row-1', columnKey: 'column-2', sourceNumber: 1 },
          { rowId: 'row-1', columnKey: 'column-3', sourceNumber: 1 },
          { rowId: 'row-2', columnKey: 'column-2', sourceNumber: 2 },
          { rowId: 'row-3', columnKey: 'column-2', sourceNumber: 3 },
        ],
      }
    )
  ),
]

const shortCode = `import numpy as np

# 对数回归系数换算为百分比变化
beta = 0.14
pct = (np.exp(beta) - 1) * 100
print(f"提升约 {pct:.1f}%")

# 标准化效应量 Cohen's d
def cohens_d(x_ai, x_ctrl):
    s = np.sqrt((np.var(x_ai, ddof=1) + np.var(x_ctrl, ddof=1)) / 2)
    return (np.mean(x_ai) - np.mean(x_ctrl)) / s`
const longCode = `"""effect_size.py：把四项研究报告的效应统一换算成百分比，便于汇报"""
import numpy as np
import pandas as pd

STUDIES = [
    ("写作", "Noy & Zhang 2023", "用时", -40.0),
    ("客服", "Brynjolfsson et al. 2025", "每小时解决数", 15.0),
    ("编程", "Peng et al. 2023", "完成速度", 55.8),
    ("咨询", "Dell'Acqua et al. 2026", "完成速度", 25.1),
]

def log_to_pct(beta):
    """对数回归系数换算为百分比变化"""
    return (np.exp(beta) - 1) * 100

def cohens_d(x_ai, x_ctrl):
    s = np.sqrt((np.var(x_ai, ddof=1) + np.var(x_ctrl, ddof=1)) / 2)
    return (np.mean(x_ai) - np.mean(x_ctrl)) / s

df = pd.DataFrame(STUDIES, columns=["任务", "研究", "指标", "变化(%)"])
df["方向"] = np.where(df["变化(%)"] > 0, "提升", "缩短")
print(df.to_string(index=False))
print(f"系数 0.14 约等于 {log_to_pct(0.14):.1f}%")`

export const contentExamples = { Formula: formula, Tabulation: tables }

export const fencedExamples = {
  Code: [
    preset('short-python', 'Python：百分比换算与效应量', { language: 'python', code: shortCode }),
    preset('long-python', 'Python：23 行完整脚本', { language: 'python', code: longCode }),
  ],
  Diagram: [
    preset('search-flow', '检索流程：Mermaid', {
      title: '检索流程 · Mermaid',
      source:
        'flowchart LR\n  A["理解研究问题<br/>对象与关注点"] --> B["生成检索式<br/>中英文各一组"]\n  B --> C["跨来源检索<br/>论文、报告、博客"]\n  C --> D["去重排序<br/>31 → 6 条"]',
    }),
    preset('invalid-flow', '流程图解析失败：保留源码', {
      title: '检索流程 · Mermaid',
      source: 'flowchart LR\n  A[理解研究问题] --> B[生成检索式\n  B --> C[跨来源检索]',
    }),
  ],
}
