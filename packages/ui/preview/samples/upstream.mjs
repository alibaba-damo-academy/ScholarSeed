const element = (typeName, props) => ({ type: 'element', typeName, props, partial: false })
const text = value => element('TextContent', { text: value })
const icon = name => element('Icon', { name })
const numberText = (value, subtext) => ({ variant: 'number', value, subtext, subtextVariant: 'text', size: 'md' })
const SCENARIOS = [
  {
    id: 'research', title: '文献调研', subject: '长上下文阅读',
    description: '比较检索增强、长上下文与结构化阅读方法，整理可追溯的证据。',
    labels: ['检索增强', '长上下文', '结构化阅读'], values: [42, 28, 18],
    count: '128', change: '+12%', date: '2026-11-06',
  },
  {
    id: 'experiment', title: '实验对比', subject: '多语言长上下文证据对齐与可追溯检索增强实验',
    description: '比较基线与候选方法；保留零值、负向变化和长名称，检查信息密度与换行。所有数值均为演示数据，不代表真实研究结论。',
    labels: ['基线方法', '多语言证据对齐的长上下文候选方法', '消融实验'], values: [0, -8, 12],
    count: '96', change: '-8%', date: '2026-11-13',
  },
]

function scenarioData(scene, image) {
  const experiment = scene.id === 'experiment'
  const { title, subject, description, labels, values, count, change, date } = scene
  const summary = `### ${subject}\n\n${description}\n\n- 纳入样本：**${count}**\n- 相对变化：**${change}**\n\n> 合成示例；请核验真实来源后再使用。`
  const series = [element('Series', { category: '候选方案', values }), element('Series', { category: '对照方案', values: [30, 24, 16] })]
  const point = { x: experiment ? 0 : 12, y: experiment ? -8 : 86, z: experiment ? 24 : 8 }
  const scatter = { name: title, points: [element('Point', point), element('Point', { x: 24, y: 92, z: 16 }), element('Point', { x: 36, y: 88, z: 6 })] }
  const columns = [element('Col', { label: '方法', data: labels, type: 'string' }), element('Col', { label: '变化（百分点）', data: values, type: 'number' })]
  const options = labels.map((label, index) => ({ value: `method-${index}`, label }))
  const input = { name: 'research-topic', type: 'text', placeholder: '填写研究主题', value: subject }
  const button = { label: experiment ? '检查实验设置' : '查看调研摘要', variant: experiment ? 'secondary' : 'primary', size: 'medium' }
  const formControl = { label: '研究主题', hint: '仅编辑本地预览，不提交任务', input: element('Input', input) }
  const formButtons = { buttons: [element('Button', button), element('Button', { label: '重置草稿', variant: 'tertiary' })] }
  const checkItem = { name: 'include-fulltext', label: '纳入全文证据', description, defaultChecked: !experiment }
  const radioItem = { value: 'fulltext', label: '全文阅读', description }
  const switchItem = { name: 'traceable', label: '展示证据来源', description: '仅切换本地状态', defaultChecked: !experiment }
  const chipItem = { value: 'method-0', label: labels[0], icon: icon('book-open'), disabled: experiment }
  const optionCard = { value: 'method-0', title: subject, subtitle: description, disabled: experiment }
  const tabItem = { value: 'summary', trigger: experiment ? '实验结果' : '调研摘要', content: [text(summary)] }
  const accordionItem = { value: 'evidence', trigger: experiment ? '查看误差分析与适用边界' : '查看检索与纳入标准', content: [text(summary)] }
  const step = { title: experiment ? '核对指标与样本' : '确定检索范围', details: description }
  const listItem = { title: subject, subtitle: description, actionLabel: '查看详情' }
  const metric = { value: count, subtext: experiment ? '实验样本' : '纳入文献' }
  const imageText = { src: image, alt: `${title}示意图`, title: subject, subtitle: description, bold: !experiment, layout: experiment ? 'vertical' : 'horizontal' }
  const boldText = numberText(count, experiment ? '实验样本' : '纳入文献')
  const iconText = { icon: icon(experiment ? 'triangle-alert' : 'book-open'), title: subject, subtitle: description, iconVariant: experiment ? 'warning' : 'info', iconSize: 'm', bold: !experiment, layout: experiment ? 'vertical' : 'horizontal' }
  const snippet = { id: 'summary', lhs: element('ImageText', imageText), rhs: element('BoldText', boldText) }
  const overview = { id: 'overview', top: element('IconText', iconText), bottom: element('MetricIndicatorInline', metric) }
  const context = { id: 'context', title: subject, body: description, bgColor: 'gray' }
  const composite = { id: 'composite', header: element('ImageText', imageText), body: [element('Text', { variant: 'text', value: description, subtextVariant: 'text', size: 'sm' }), element('TagBlock', { tags: [title, '演示数据'] })], footer: { button: element('Button', button) } }
  const visual = { id: 'visual', body: element('BoldText', boldText), bgImageSrc: image, bgImageAlt: `${title}示意图`, tag: element('Tag', { text: title, variant: experiment ? 'warning' : 'info' }) }
  const data = {
    Card: { children: [element('CardHeader', { title: subject, subtitle: title }), text(summary)], variant: experiment ? 'sunk' : 'card', direction: 'column', gap: 'm' },
    CardHeader: { title: subject, subtitle: description },
    TextContent: { text: summary, size: experiment ? 'small' : 'default' },
    MarkDownRenderer: { textMarkdown: summary, variant: experiment ? 'sunk' : 'clear' },
    Callout: { variant: experiment ? 'warning' : 'info', title: experiment ? '结果存在适用边界' : '证据整理完成', description },
    TextCallout: { variant: experiment ? 'danger' : 'success', title: experiment ? '请检查负向变化' : '可开始人工核验', description },
    Image: { src: image, alt: `${subject}：演示配图` },
    ImageBlock: { src: image, alt: `${title}：局部细节示意` },
    ImageGallery: { images: labels.slice(0, experiment ? 3 : 2).map(label => ({ src: image, alt: `${label}：演示配图` })) },
    CodeBlock: experiment ? { language: 'python', codeString: 'scores = [0, -8, 12]\nfor method, score in enumerate(scores):\n    print(f"method-{method}: {score:+d}")' } : { language: 'json', codeString: JSON.stringify({ topic: subject, included: 128, evidence: ['fulltext', 'abstract'] }, null, 2) },
    InlineHeader: { heading: subject, description },
    Table: { columns },
    Col: columns[experiment ? 1 : 0].props,
    EditableTable: { name: `editable-${scene.id}`, columns: [{ type: 'text', key: 'method', header: '方法' }, { type: 'number', key: 'change', header: '变化（百分点）' }], data: labels.map((label, index) => ({ id: `row-${index}`, values: [label, values[index]] })) },
    Series: { category: title, values },
    Slice: { category: experiment ? '待核验' : '已核验', value: experiment ? 30 : 70 },
    ScatterChart: { datasets: [element('ScatterSeries', scatter)], xLabel: '耗时（秒）', yLabel: '质量变化（百分点）' },
    ScatterSeries: scatter,
    Point: point,
    Form: { name: `form-${scene.id}`, fields: [element('FormControl', formControl), element('FormControl', { label: '研究说明', input: element('TextArea', { name: 'notes', value: description, rows: 3 }) })], buttons: element('Buttons', formButtons) },
    FormControl: formControl,
    Label: { text: `${title} · ${subject}` },
    Input: input,
    TextArea: { name: 'research-notes', placeholder: '填写纳入标准与备注', value: experiment ? summary : description, rows: experiment ? 6 : 3 },
    Select: { name: 'method', items: options.map(option => element('SelectItem', option)), placeholder: '选择方法', value: experiment ? 'method-1' : 'method-0', size: experiment ? 'large' : 'medium' },
    SelectItem: options[experiment ? 1 : 0],
    DatePicker: { name: 'review-date', mode: 'single', value: date },
    Slider: { name: 'sample-budget', label: '样本预算', variant: experiment ? 'discrete' : 'continuous', min: 0, max: 100, step: experiment ? 10 : 1, defaultValue: [experiment ? 0 : 60] },
    CheckBoxGroup: { name: 'evidence-types', items: [element('CheckBoxItem', checkItem), element('CheckBoxItem', { name: 'include-abstract', label: '纳入摘要证据', description: '摘要不等同于全文核验', defaultChecked: true })] },
    CheckBoxItem: checkItem,
    RadioGroup: { name: 'reading-depth', items: [element('RadioItem', radioItem), element('RadioItem', { value: 'abstract', label: '摘要筛选', description: '仅进行初步相关性判断' })], defaultValue: experiment ? 'abstract' : 'fulltext' },
    RadioItem: radioItem,
    SwitchGroup: { name: 'display-options', items: [element('SwitchItem', switchItem)], variant: experiment ? 'sunk' : 'clear' },
    SwitchItem: switchItem,
    ChipItem: chipItem,
    Chips: { name: 'methods', type: experiment ? 'multiple' : 'single', items: options.map(option => element('ChipItem', option)), defaultValue: experiment ? ['method-0', 'method-2'] : 'method-0' },
    OptionCard: optionCard,
    OptionCards: { name: 'review-mode', type: 'single', items: options.map(option => element('OptionCard', { value: option.value, title: option.label, subtitle: description })), defaultValue: experiment ? 'method-2' : 'method-0' },
    Button: button,
    Buttons: { ...formButtons, direction: experiment ? 'column' : 'row' },
    IconButton: { name: experiment ? '核验实验' : '查看文献', icon: icon(experiment ? 'circle-check' : 'book-open'), variant: experiment ? 'secondary' : 'tertiary', shape: experiment ? 'circle' : 'square' },
    Stack: { children: [text(subject), element('TagBlock', { tags: [title, '演示数据'] }), text(description)], direction: experiment ? 'row' : 'column', gap: 'm', wrap: true },
    Tabs: { items: [element('TabItem', tabItem), element('TabItem', { value: 'limits', trigger: '适用边界', content: [text('示例仅用于组件核验，不作为真实研究结论。')] })] },
    TabItem: tabItem,
    Accordion: { items: [element('AccordionItem', accordionItem), element('AccordionItem', { value: 'source', trigger: '数据来源', content: [text('当前所有数值均为手工准备的演示数据。')] })] },
    AccordionItem: accordionItem,
    Steps: { items: [element('StepsItem', step), element('StepsItem', { title: '人工核验', details: '复查来源、单位与适用条件。' }), element('StepsItem', { title: '整理交付', details: '保留限制与未解决问题。' })] },
    StepsItem: step,
    Carousel: { children: labels.map(label => [element('CardHeader', { title: label, subtitle: title }), text(description)]), variant: experiment ? 'sunk' : 'card' },
    Separator: { orientation: experiment ? 'vertical' : 'horizontal', decorative: !experiment },
    TagBlock: { tags: experiment ? [...labels, '待核验', '演示数据'] : ['调研中', '全文证据'], size: experiment ? 'sm' : 'md' },
    Tag: { text: experiment ? '需人工核验的长标签：多语言证据对齐' : '已纳入', variant: experiment ? 'warning' : 'success', size: experiment ? 'lg' : 'sm' },
    Icon: { name: experiment ? 'triangle-alert' : 'circle-check' },
    EntityList: { rows: labels.map((label, index) => ({ left: label, right: String(values[index]), rightVariant: 'number' })), size: experiment ? 'small' : 'default', header: { left: '方法', right: '变化（百分点）', rightVariant: 'text' } },
    ListBlock: { items: labels.map(label => element('ListItem', { title: label, subtitle: description })), variant: 'number', size: experiment ? 'small' : 'default' },
    ListItem: listItem,
    Text: { ...numberText(count, title), size: experiment ? 'lg' : 'sm' },
    BoldText: { ...boldText, subtext: change, subtextVariant: 'metric' },
    IconText: iconText,
    ImageText: imageText,
    ImageTextLarge: { src: image, alt: `${title}示意图`, title: subject, subtitle: description, bold: !experiment },
    MetricIndicatorInline: { ...metric, value: experiment ? '0' : count },
    MetricIndicatorWithStrikethrough: { ...metric, previousValue: experiment ? '104' : '116' },
    SnippetCardItem: snippet,
    OverviewCardItem: overview,
    ContextCardItem: context,
    CompositeCardItem: composite,
    VisualCardItem: visual,
    Modal: { title: `${title}详情`, open: false, size: experiment ? 'lg' : 'sm', children: [text(summary)] },
  }
  for (const name of ['BarChart', 'LineChart', 'AreaChart', 'RadarChart', 'HorizontalBarChart']) {
    data[name] = { labels, series }
    if (name !== 'RadarChart') Object.assign(data[name], { xLabel: '方法', yLabel: '变化（百分点）' })
    if (['BarChart', 'HorizontalBarChart'].includes(name)) data[name].variant = experiment ? 'stacked' : 'grouped'
    if (['LineChart', 'AreaChart'].includes(name)) data[name].variant = experiment ? 'step' : 'natural'
    if (name === 'HorizontalBarChart') Object.assign(data[name], { xLabel: '变化（百分点）', yLabel: '方法' })
  }
  for (const name of ['PieChart', 'RadialChart', 'SingleStackedBarChart']) data[name] = { labels: ['已核验', '待核验', '未纳入'], values: experiment ? [0, 30, 70] : [70, 20, 10] }
  data.PieChart.variant = experiment ? 'donut' : 'pie'
  const comparisons = {
    SnippetCard: { ...snippet, lhs: element('ImageText', { ...imageText, title: labels[1] }), rhs: element('BoldText', numberText('24', '对照方案')) },
    OverviewCard: { ...overview, top: element('IconText', { ...iconText, title: labels[1] }), bottom: element('MetricIndicatorInline', { value: '24', subtext: '对照方案' }) },
    ContextCard: { ...context, title: labels[1], body: '对照方案：采用相同样本与评价口径。' },
    CompositeCard: { ...composite, header: element('ImageText', { ...imageText, title: labels[1] }) },
    VisualCard: { ...visual, body: element('BoldText', numberText('24', '对照方案')), tag: element('Tag', { text: '对照方案' }) },
  }
  for (const [name, item] of Object.entries({ SnippetCard: snippet, OverviewCard: overview, ContextCard: context, CompositeCard: composite, VisualCard: visual })) {
    data[`${name}Block`] = { items: [item, { ...comparisons[name], id: 'comparison' }].map(props => element(`${name}Item`, props)), layout: 'grid', responsive: true }
    if (experiment && name !== 'SnippetCard') data[`${name}Block`].layout = 'carousel'
  }
  return data
}

export function createUpstreamExamples(image) {
  const examples = {}
  for (const scene of SCENARIOS) {
    for (const [name, data] of Object.entries(scenarioData(scene, image))) {
      examples[name] ??= []
      examples[name].push({ id: scene.id, labelKey: `upstream.scenarios.${scene.id}`, data })
    }
  }
  return examples
}
