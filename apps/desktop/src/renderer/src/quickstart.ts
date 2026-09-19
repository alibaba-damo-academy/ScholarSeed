/**
 * quickstart.ts — the home page's 快捷开始 presets (PRD 2.1.2).
 *
 * A card seeds the composer and focuses it; it never sends on its own, so the
 * researcher always edits the task before the first real turn. Copy follows the
 * PRD prototype wording.
 */

export interface QuickStartPreset {
  id: string
  title: string
  hint: string
  icon: 'doc' | 'chart-line' | 'play'
  prompt: string
}

export const QUICK_START_PRESETS: QuickStartPreset[] = [
  {
    id: 'review',
    title: '做一次文献综述',
    hint: '自动检索文献、提炼主张、找出研究空白',
    icon: 'doc',
    prompt: '帮我做一次文献综述：先确认研究主题与时间范围，然后多库检索、去重、读全文，按机理聚类，最后撰写一份带出处的综述。'
  },
  {
    id: 'idea',
    title: '生成研究想法',
    hint: '顺着方向找空白、提出可验证的假设、给出切入点',
    icon: 'chart-line',
    prompt: '帮我生成研究想法：先确认我的研究方向与可用条件，检索定位现有工作的空白，最后收敛成一张可执行的想法卡。'
  },
  {
    id: 'reproduce',
    title: '复现一篇论文',
    hint: '调用论文复现技能：拆算法、落代码、跑 demo 验证',
    icon: 'play',
    prompt: '帮我复现一篇论文：先读论文拆解核心算法，然后落成可运行代码，并用一个最小 demo 验证核心机制是否成立。'
  }
]
