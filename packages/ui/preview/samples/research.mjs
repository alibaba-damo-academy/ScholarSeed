import { contracts } from '../catalog.mjs'
import { generate } from '../schema.mjs'
import { rules } from '../rules.mjs'
import { agentStudies } from './studies.mjs'

const base = generate(contracts.Results.schema, 'research-presets', rules, 'normal')
const paper = base.content.papers[0]
const preset = (id, label, status, count) => ({
  id,
  label,
  data: {
    content: {
      ...base.content,
      status,
      criteria: ['合成检索示例，不代表实际检索或研究结论。'],
      candidates: count,
      deduplicated: count,
      retained: count,
      sources: [],
      warnings: status === 'partial' ? ['agentic-search returned a partial result'] : [],
      papers: Array.from({ length: count }, (_, index) => ({
        ...paper,
        id: `sample-paper-${index + 1}`,
        title: `合成论文 ${index + 1}：用于检索卡片展示`,
        authors: ['示例作者'],
        year: 2025,
        venue: '合成来源',
        url: `https://example.org/papers/${index + 1}`,
        reasons: ['仅用于演示布局与交互。'],
      })),
    },
  },
})
const reviewBase = generate(contracts.Review.schema, 'review-presets', rules, 'normal').content
const sections = [
  [
    'abstract',
    '0 摘要',
    '界定 Agent、多智能体系统、评测与应用的讨论范围。',
    ['研究问题与材料边界'],
  ],
  [
    'introduction',
    '1 引言与概念框架',
    '区分基础模型、单智能体与多智能体工作流。',
    ['概念与组织框架'],
  ],
  [
    'capabilities',
    '2 智能体核心能力：规划、工具使用与记忆',
    '对照 ReAct 的推理/行动交替与 Reflexion 的语言反馈机制。',
    ['推理与规划', '工具调用', '反馈与记忆'],
  ],
  [
    'collaboration',
    '3 多智能体协作与通信机制',
    '对照 AutoGen 的会话框架与 MetaGPT 的角色、标准工作流程。',
    ['角色分工', '通信与中间产物核验'],
  ],
  [
    'evaluation',
    '4 评测基准与长期连贯性',
    '以 AgentBench 为线索，区分任务成功率、工具错误与长程决策。',
    ['任务环境', '错误与复现边界'],
  ],
  [
    'applications',
    '5 应用场景与工程挑战',
    '讨论软件工程、交互环境与可控执行，不合并不同基准的分数。',
    ['应用与可控执行'],
  ],
  [
    'questions',
    '6 总结与开放问题',
    '保留全文核验、版本差异与可复现性等未完成事项。',
    ['材料局限', '后续阅读计划'],
  ],
].map(([, title, description, children], index) => ({
  id: String(index),
  title: title.replace(/^\d+\s/, ''),
  description,
  children,
  papers: [0, 1, 2, 2, 1, 0, 0][index],
  comparison_tables: [],
}))
const bibliography = agentStudies.map(({ title, authors, year, venue, url }, index) => ({
  citation_key: `agent-study-${index + 1}`,
  paper_id: `agent-study-${index + 1}`,
  citation: { number: index + 1, title, authors, year, venue },
  evidence: { basis: 'abstract', reason: '仅核对公开书目与摘要，未逐篇核验全文。', extracted_chars: null },
  target: { kind: 'web', url },
}))
const references = (rows) => ({
  cited_count: rows.length,
  fulltext_cited_count: 0,
  abstract_cited_count: rows.length,
  rows,
})
const review = (id, label, changes = {}) => ({
  id,
  label,
  data: {
    content: {
      ...reviewBase,
      session_id: 'preview-agent-review',
      workspace: 'preview-agent-literature',
      title: '大语言模型智能体与多智能体系统：核心能力、协作机制与评测',
      intent: '使用六篇公开文献的真实书目信息，演示需求截图中的综述结构；非模型生成的完整综述。',
      scope: {
        topic: 'LLM Agent 与多智能体',
        time_range: '2022–2023 年首次提交的六篇公开文献',
        focus: ['规划、工具使用与记忆', '多智能体协作', '评测与开放问题'],
        requested_materials: [],
        project_materials: 0,
        external_materials: 6,
      },
      sections,
      section_count: sections.length,
      included: bibliography.length,
      fulltext: 0,
      abstract_only: bibliography.length,
      references: references(bibliography),
      verification: {
        issue_count: 1,
        rows: [{
          check: {
            id: 'fulltext',
            title: '全文与逐条论断',
            verdict: 'NOT_CHECKED',
            reason: '未在本任务阅读六篇全文；不伪造已读全文或核验通过。',
          },
          issue: {
            title: '待全文核验',
            detail: '逐篇确认方法、实验设置、版本和复现条件。',
            paper_ids: [],
            affected_content: '正文和比较表',
            priority: null,
          },
        }],
      },
      warnings: [
        '非真实任务执行结果；使用真实文献元数据的人工编排预览，不代表模型已生成或核验综述。',
      ],
      artifacts: [],
      status: 'partial',
      checkpoint: 'result',
      generation_status: 'PARTIAL_SUCCESS',
      source_hashes: {},
      ...changes,
    },
  },
})

export const researchExamples = {
  Review: [
    review('agents', 'Agent 综述：六篇公开文献'),
    review('outline', '七节大纲：待全文核验', { checkpoint: 'outline', status: 'outline' }),
    review('limited', '局部综述：仅三篇摘要', {
      title: '单智能体与多智能体：三篇摘要线索',
      included: 3,
      abstract_only: 3,
      references: references(bibliography.slice(0, 3)),
      scope: {
        topic: '单智能体反馈与会话协作',
        time_range: '2022–2023',
        focus: ['推理行动', '反思反馈', '会话协作'],
        requested_materials: [],
        project_materials: 0,
        external_materials: 3,
      },
      sections: sections.map((section, index) => ({
        ...section,
        papers: [0, 0, 2, 1, 0, 0, 0][index],
      })),
    }),
  ],
  Results: [
    preset('success', '检索结果：3 篇', 'success', 3),
    preset('many', '结果较多：40 篇', 'success', 40),
    preset('partial', '部分结果', 'partial', 2),
    preset('empty', '没有结果', 'no_confident_match', 0),
    preset('source-failed', '来源失败', 'source_failed', 0),
    preset('execution-blocked', '执行受阻', 'execution_blocked', 0),
    preset('invalid-result', '结果无效', 'invalid_result', 0),
  ],
}
