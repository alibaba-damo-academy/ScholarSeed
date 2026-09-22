import assert from 'node:assert/strict'
import test from 'node:test'

import { looksLikePaperTitle, paperTitleVeto, type PaperTitleVeto } from './title.ts'

/**
 * 判否用例: 每条都锁住「命中的是哪条判据」。产品用这个判断收起「同步元数据」入口,
 * 排查时要能一眼看出原因, 所以原因本身就是契约的一部分。
 *
 * 用例与 `rndservice/z.py` 的自测集逐条对应 (两边判定与否决原因已做过全量对拍);
 * 改任何一边的阈值或判据, 必须同步另一边。
 */
const VETO_CASES: readonly (readonly [string, PaperTitleVeto])[] = [
  ['', 'empty'],
  ['   ', 'empty'],
  ['17', 'no-letter'],
  ['17 32 45', 'no-letter'],
  ['17.32.45', 'no-letter'],
  ['1706.03762', 'no-letter'],
  ['A', 'too-short'],
  ['AI', 'too-short'],
  ['论文1', 'too-short'],
  ['Transformers', 'single-token'],
  ['Untitled', 'placeholder'],
  ['[Untitled]', 'placeholder'],
  ['Untitled Document 1', 'placeholder'],
  ['未命名', 'placeholder'],
  ['无标题文档', 'placeholder'],
  ['n/a', 'placeholder'],
  ['Copy of Notes', 'placeholder'],
  ['笔记 副本', 'placeholder'],
  ['摘要', 'placeholder'],
  ['参考文献', 'placeholder'],
  ['scan0001.pdf', 'locator'],
  ['paper_final_v2 (1).docx', 'locator'],
  ['https://arxiv.org/abs/1706.03762', 'locator'],
  ['/Users/w/papers/a.pdf', 'locator'],
  ['C:\\papers\\a.pdf', 'locator'],
  ['10.1234/abcd.2020', 'identifier'],
  ['arXiv:1706.03762', 'identifier'],
  ['ISBN 978-0-262-03384-8', 'identifier'],
  ['v2.1', 'identifier'],
  ['2020年12月3日', 'identifier'],
  ['attention_is_all_you_need', 'identifier'],
  ['attentionIsAllYouNeed', 'identifier'],
  ['3.1 Experimental Setup', 'section-heading'],
  ['第3章 实验结果', 'section-heading'],
  ['Table 3', 'section-heading'],
  ['Figure 12: The Result Curve', 'section-heading'],
  ['The weather is nice today.', 'sentence-end'],
  ['I love programming!', 'sentence-end'],
  ['We propose a new method. Experiments show large gains.', 'sentence-end'],
  ['This is a sentence that goes on and on', 'statement'],
  ['This paper describes our approach and results in detail', 'statement'],
  ['In this work we propose a new method for image segmentation', 'statement'],
  ['Thomas Fischer, Maik Veste', 'name-list'],
  ['Zhang, Wei', 'name-list'],
  ['a'.repeat(300), 'too-long']
]

/** 判是用例: 真实论文标题的各种形态, 一个都不能被误杀。 */
const TITLE_CASES: readonly string[] = [
  'Attention Is All You Need',
  'Attention is All You Need',
  'Deep Learning',
  'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
  'A Survey on Large Language Model Evaluation Benchmarks',
  'Graph Neural Networks for Drug Discovery: A Review',
  'LoRA: Low-Rank Adaptation of Large Language Models',
  'Is Attention All You Need?',
  'Do Transformers Really Perform Bad for Graph Representation?',
  'Attention, Is All You Need',
  'There Is No Free Lunch',
  'ResNet-50 Implementation Guide v2.1',
  'Node.js and Express.js in Production',
  'U.S. Healthcare Policy Reform',
  'AI/ML in Clinical Practice',
  'WWW 2024 Proceedings',
  'SARS-CoV-2 Spike Protein Dynamics',
  '70 Years of Artificial Intelligence',
  '3D Printing of Ceramic Scaffolds',
  '6G Networks: A Survey of Open Problems',
  'Section 8 Vouchers and Housing Mobility in American Cities',
  'The Study of Human Behavior in Online Communities',
  'The Paper Chase: Law School Admissions in 2024',
  'A Copy of the Genome Is Not Enough',
  'DOI Resolver Systems for Scholarly Metadata',
  'Key Findings from the 2024 Survey',
  'WHAT DOES BERT LOOK AT? AN ANALYSIS OF ATTENTION',
  'Dew formation on the surface of biological soil crusts',
  '基于深度学习的图像分类方法研究',
  '大语言模型综述',
  '深度学习',
  '机器学习导论',
  'GPT-4技术报告',
  'Attention机制在NLP中的应用',
  '中文标题：基于Transformer的文本分类研究'
]

/**
 * 有意放过的边界: 这些确实不是论文, 但结构上找不到反证。
 *
 * 正则区分不了它们和真实标题, 硬加体裁黑名单 (how to / news / recipe) 立刻会开始误杀
 * ("How Well Do Transformers Compress Ourselves?")。产品上这个方向的代价也更小:
 * 放过 = 多显示一次同步入口, 误杀 = 用户再也没有入口补元数据。
 */
const LENIENT_CASES: readonly string[] = [
  'How to make a sandwich',
  'Breaking News: AI Takes Over World',
  'my holiday photos'
]

test('结构性垃圾一律判否, 并给出命中的判据', () => {
  for (const [value, veto] of VETO_CASES) {
    assert.equal(paperTitleVeto(value), veto, value)
    assert.equal(looksLikePaperTitle(value), false, value)
  }
})

test('真实论文标题的各种形态都判是', () => {
  for (const value of TITLE_CASES) {
    assert.equal(paperTitleVeto(value), null, value)
    assert.equal(looksLikePaperTitle(value), true, value)
  }
})

test('结构上没有反证的非论文文本有意放过', () => {
  for (const value of LENIENT_CASES) {
    assert.equal(looksLikePaperTitle(value), true, value)
  }
})

test('中英混排按 CJK 单字切词, 不会被吞成一个词', () => {
  // 回归: 分词的第二个分支若不排除 CJK, `\p{L}` 会把 "Attention机制在NLP中的应用"
  // 整串吞成 1 个词, 于是撞上 single-token 判据、把真标题误杀。
  assert.equal(paperTitleVeto('Attention机制在NLP中的应用'), null)
  assert.equal(paperTitleVeto('基于Transformer的文本分类研究'), null)
  assert.equal(paperTitleVeto('BERT模型微调方法'), null)
  // 纯 ASCII 的连续段仍整体计数, 所以 snake_case 依旧由 identifier 判据接管。
  assert.equal(paperTitleVeto('attention_is_all_you_need'), 'identifier')
})

test('空值与缺省值不给同步入口', () => {
  assert.equal(looksLikePaperTitle(''), false)
  assert.equal(paperTitleVeto(null), 'empty')
  assert.equal(paperTitleVeto(undefined), 'empty')
})
