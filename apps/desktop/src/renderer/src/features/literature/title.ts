/**
 * 标题形态判别 (否决式) —— 与 `rndservice/z.py` 的 `paper_title_veto` 同一套口径。
 *
 * 判据是**不对称**的, 这是它的全部要点:
 *
 * - **判否必须有铁证**: 只有出现「不可能是论文标题」的结构性证据才判否 —— 空值、过短
 *   过长、一个字母都没有、占位符 (含 `Copy of X` / `X 的副本`)、URL/路径/文件名、标识符
 *   (DOI / arXiv / 带标签编号 / 版本号 / snake_case / camelCase / 日期)、小节标题
 *   (`3.1 Experimental Setup` / `第3章` / `Table 3`)、句子与段落 (含「This paper
 *   describes ...」自述式开头)、作者串与人名对、单个词。判否时给出原因, 便于排查
 *   「按钮为什么没了」。
 * - **判是一律宽松**: 没有反证就算标题。不要求学术词、词数区间或模板命中, 所以疑问式
 *   标题、副标题、连字符、中英混排、全大写、短中文标题都不会被误杀。
 *
 * 有意留的边界: 结构上没有反证的非论文文本 (`How to make a sandwich`) 会被放过。正则
 * 区分不了它和真实标题, 硬加体裁黑名单只会开始误杀 (`How Well Do Transformers Compress
 * Ourselves?`)。产品上这个方向的代价也小: 放过 = 多显示一次同步入口, 误杀 = 用户再也
 * 没有入口补元数据。
 *
 * **改这里就要改 z.py, 反之亦然** —— 两边是同一套判据的两种语言实现, 阈值与判据列表
 * 逐项对应。
 */

/** 判否原因; `null` 表示找不到反证, 判为论文标题。 */
export type PaperTitleVeto =
  | 'empty'
  | 'too-long'
  | 'no-letter'
  | 'placeholder'
  | 'locator'
  | 'identifier'
  | 'section-heading'
  | 'too-short'
  | 'single-token'
  | 'sentence-end'
  | 'multi-sentence'
  | 'statement'
  | 'name-list'

const MIN_CHARS = 4 // 可见字符下限: CJK 单字信息量高, 4 字已能构成一个短标题
const MAX_CHARS = 240 // 字符上限: 再长基本是摘要/正文被粘进了标题字段
const MIN_TOKENS = 2 // 词下限: 单个词更像关键词、文件名或刊名
const MAX_TOKENS = 40 // 词上限
const SENTENCE_COUNT_MIN = 2 // 几处句末标点算「段落」而不是标题
const SENTENCE_CASE_RATIO_MAX = 0.3 // 非首词大写占比低于此值 = 句子式大小写 (散文特征)
const NAME_LIST_MAX_TOKENS = 9 // 再长就不像作者串了
const SECTION_MAX_TOKENS = 6 // 栏目词那一支只在整条很短时才否决

/**
 * 分词: CJK 单字各算一个词, 其余按下划线以外的连续段整体算一个词。
 *
 * 第二个分支必须显式排掉 CJK —— `\p{L}` 本身就包含汉字, 否则「Attention机制在NLP中的应用」
 * 这种中英混排会被整串吞成 1 个词。交替顺序也有意义: CJK 分支在前, 混排才切得开。
 */
const CJK_CLASS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}'
const TOKEN = new RegExp(`[${CJK_CLASS}]|[^\\W_${CJK_CLASS}]+`, 'gu')

// 连续两个以上「1-2 个字母 + 点」才算缩写 (U.S. / e.g.), 单个尾点仍按句子处理。
const ABBREVIATION_DOTS = /(?:\b[A-Za-z]{1,2}\.){2,}/gu
const SENTENCE_END_CHARS = '.!。！'
// 句末标点要求后面是空白或串尾, 于是 Node.js / Express.js 里的小数点不算句子。
// 疑问号从不作为「句末」否决: 疑问式标题真实存在 (Is Attention All You Need?)。
const TERMINAL_MARK = /[.!。！？?](?=\s|$)/gu

const PLACEHOLDER_EDGE_LEADING = /^[\s[\](){}【】《》「」『』"'“”‘’]+/u
const PLACEHOLDER_EDGE_TRAILING = /[\s[\](){}【】《》「」『』"'“”‘’]+$/u
const PLACEHOLDER_WORDS: ReadonlySet<string> = new Set([
  'untitled',
  'untitled document',
  'no title',
  'notitle',
  'new document',
  'unknown',
  'unknown title',
  'null',
  'none',
  'n/a',
  'na',
  'title',
  '未命名',
  '无标题',
  '未命名文档',
  '无标题文档',
  '新建文档',
  '标题',
  '未填写',
  '待补充',
  '未題',
  '参考文献',
  '摘要',
  '结论',
  '引言',
  '目录',
  '附录',
  '致谢',
  '正文',
])
const PLACEHOLDER_PATTERN = new RegExp(
  [
    // 占位符本体, 允许尾部编号 (Untitled Document 1)
    '^(?:untitled(?:\\s+document)?|no\\s*title|new\\s*document|unknown(?:\\s*title)?',
    '|未命名|无标题|新建文档|未填写|待补充)\\s*[-_#]?\\d*$',
    '^(?:document|文档)\\s*[-_#]?\\d+$',
    // 网盘/Office 的复制产物: "Copy of X"、"X 的副本"、"X 副本 (1)"
    '^copy\\s+of\\s+.+$',
    '^.+\\s*(?:的)?副本\\s*(?:\\(\\d+\\))?$',
  ].join('|'),
  'iu'
)

const URL_PATTERN = /(?:^[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b(?:doi|dx\.doi|arxiv)\.org\/|\bmailto:)/iu
const PATH_PATTERN = /(?:\\|^[~/]|\b[a-z]:[/\\]|\/(?:users|home|mnt|media|tmp|var|opt|data)\/)/iu
const FILE_SUFFIX_PATTERN =
  /\.(?:pdf|docx?|rtf|odt|tex|txt|md|markdown|pptx?|xlsx?|csv|tsv|zip|rar|7z|gz|tar|epub|mobi|caj|nh|bib|json|ya?ml|xml|html?|py|ipynb|sh|log|png|jpe?g|gif|tif?f|bmp|svg)$/i

const IDENTIFIER_PATTERNS: readonly RegExp[] = [
  /^10\.\d{4,9}\/\S+$/, // DOI
  /^(?:arxiv\s*[:：]\s*)?\d{4}\.\d{4,5}(?:v\d+)?$/, // arXiv 新式
  /^(?:arxiv\s*[:：]\s*)?[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?$/, // arXiv 旧式
  // 带标签的编号: 冒号可省 ("ISBN 978-..."), 但值里必须有数字, 否则 "DOI Resolver"
  // 这类真实词组会被误杀; id/key/ref 太像普通英文词, 只认冒号写法。
  /^(?:doi|arxiv|isbn|issn|pmid|orcid|handle|pii)\s*[:：]?\s*(?=.*\d).+$/iu,
  /^(?:id|key|ref)\s*[:：]\s*\S+$/iu,
  /^v\d+(?:[.-]\d+)*$/, // 版本号
  /^\d{4}\s*[-/年]\s*\d{1,2}(?:\s*[-/月]\s*\d{1,2}\s*日?)?$/, // 日期
  /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/, // snake_case
  /^[a-z]+(?:[A-Z][a-z0-9]*){2,}$/, // camelCase
]

// 「本文/本研究 + 动词」的自述式开头: "This paper describes ...", "In this work we propose ..."。
// 动词部分必须出现, 所以 "The Study of Human Behavior"、"The Paper Chase" 不会被误杀。
const META_DISCOURSE_PATTERN =
  /^(?:in\s+)?(?:this|the|our|these|my)\s+(?:paper|work|study|article|section|chapter|report|thesis|document|post|blog|page|note)\s+(?:we|it|is|are|was|were|describes?|presents?|proposes?|shows?|discusses?|analy[sz]es?|argues?|demonstrates?|introduces?|explores?|investigates?|reviews?|reports?|focuses?|aims?|provides?|gives?|contains?|covers?|examines?|summariz(?:es|e))\b/iu

// 陈述句开头; 只对「句子式大小写」生效, 所以 There Is No Free Lunch 这类标题不受影响。
const STATEMENT_PATTERNS: readonly RegExp[] = [
  /^(?:the|a|an|this|that|these|those|it|he|she|they|we|you|i)\s+\S+\s+(?:is|are|was|were|be|been|am|has|have|had)\b/iu,
  /^(?:there|here|it|this|that)\s+(?:is|are|was|were|has|have)\b/iu,
]

// 小节标题 (PDF/网页抽取的产物)。两处收紧都是为了不误杀真标题: 栏目词只认「+ 数字」,
// 且那一支还要求整条很短 —— 于是 "70 Years of AI"、"3D Printing"、"6G Networks"、
// "Section 8 Vouchers and Housing Mobility" 不受影响, 而 "3.1 Experimental Setup"、
// "Table 3"、"Figure 12: The Curve"、"第3章 实验结果" 会被拦掉。
const SECTION_PATTERNS: readonly RegExp[] = [
  /^\d+\.\d+(?:\.\d+)*\s+\S/,
  /^第\s*[\d一二三四五六七八九十百千零]+\s*[章节篇部条款讲]/u,
]
const SECTION_WORD_PATTERN =
  /^(?:chapter|section|appendix|figure|fig|table|equation|eq)\s+\d+[a-z]?(?:\s|$|[:：.])/i

const NAME_UNIT = "[A-Z][\\p{L}\\p{N}_.’'\\-]*(?:\\s+[A-Z][\\p{L}\\p{N}_.’'\\-]*){1,2}"
const NAME_LIST_PATTERN = new RegExp(`^${NAME_UNIT}(?:\\s*[,;、&]\\s*${NAME_UNIT})+$`, 'u')
// 人名对 ("Zhang, Wei"): 逗号两侧各一个首字母大写的单词, 整条到此为止 —— 作者字段串进
// 标题的典型形状; "Attention, Is All You Need" 逗号后不止一个词, 不受影响。
const NAME_PAIR_PATTERN = new RegExp(
  `^[A-Z][\\p{L}\\p{N}_.’'\\-]+\\s*,\\s*[A-Z][\\p{L}\\p{N}_.’'\\-]+$`,
  'u'
)
// 作者串判据只在没有任何学术词时生效, 避免把 "Deep Learning, Neural Networks" 误杀。
const ACADEMIC_HINTS: ReadonlySet<string> = new Set([
  'survey',
  'analysis',
  'approach',
  'framework',
  'model',
  'learning',
  'network',
  'algorithm',
  'evaluation',
  'method',
  'study',
  'review',
  'architecture',
  'optimization',
  'detection',
  'networks',
  'models',
  'methods',
  'reviews',
])

/** 合并所有空白 (含换行): 标题里的换行几乎都是粘贴产物, 不该单独成为否决理由。 */
function normalize(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim()
}

function tokens(text: string): string[] {
  return text.match(TOKEN) ?? []
}

function isPlaceholder(text: string): boolean {
  const bare = text.replace(PLACEHOLDER_EDGE_LEADING, '').replace(PLACEHOLDER_EDGE_TRAILING, '')
  if (!bare) return true
  return PLACEHOLDER_WORDS.has(bare.toLowerCase()) || PLACEHOLDER_PATTERN.test(bare)
}

function isLocator(text: string): boolean {
  return URL_PATTERN.test(text) || PATH_PATTERN.test(text) || FILE_SUFFIX_PATTERN.test(text)
}

function isIdentifier(text: string): boolean {
  return IDENTIFIER_PATTERNS.some((pattern) => pattern.test(text))
}

function isSectionHeading(text: string, words: readonly string[]): boolean {
  if (SECTION_PATTERNS.some((pattern) => pattern.test(text))) return true
  return words.length <= SECTION_MAX_TOKENS && SECTION_WORD_PATTERN.test(text)
}

/** 非首词的大写占比低 = 句子式大小写, 这是散文特征 (标题通常首字母大写或全大写)。 */
function isSentenceCase(words: readonly string[]): boolean {
  const tail = words.slice(1)
  if (!tail.length) return false
  const upper = tail.filter((word) => /^[\p{Lu}\p{Lt}]/u.test(word)).length
  return upper / tail.length <= SENTENCE_CASE_RATIO_MAX
}

function isStatement(text: string, words: readonly string[]): boolean {
  if (!isSentenceCase(words)) return false
  return (
    META_DISCOURSE_PATTERN.test(text) || STATEMENT_PATTERNS.some((pattern) => pattern.test(text))
  )
}

function isNameList(text: string, words: readonly string[]): boolean {
  if (words.length > NAME_LIST_MAX_TOKENS) return false
  if (words.some((word) => ACADEMIC_HINTS.has(word.toLowerCase()))) return false
  return NAME_LIST_PATTERN.test(text) || NAME_PAIR_PATTERN.test(text)
}

function proseVeto(text: string): PaperTitleVeto | null {
  const probe = text.replace(ABBREVIATION_DOTS, '').replace(/\s+$/u, '')
  if (probe && SENTENCE_END_CHARS.includes(probe[probe.length - 1])) return 'sentence-end'
  if ((probe.match(TERMINAL_MARK) ?? []).length >= SENTENCE_COUNT_MIN) return 'multi-sentence'
  return null
}

/**
 * 返回判否原因; `null` 表示「找不到反证, 判为论文标题」。
 *
 * 判据顺序 = 从最不可能出错到最需要语境: 先排掉空值/超长/无字母这类硬事实, 再排占位符
 * 与定位符 (URL/路径/文件名), 再排标识符与小节标题, 最后才是需要看句子形态的判据。
 */
export function paperTitleVeto(value: string | null | undefined): PaperTitleVeto | null {
  const text = normalize(value)
  if (!text) return 'empty'
  const words = tokens(text)
  if (text.length > MAX_CHARS || words.length > MAX_TOKENS) return 'too-long'
  if (!/\p{L}/u.test(text)) return 'no-letter'
  if (isPlaceholder(text)) return 'placeholder'
  if (isLocator(text)) return 'locator'
  if (isIdentifier(text)) return 'identifier'
  if (isSectionHeading(text, words)) return 'section-heading'
  if (text.length < MIN_CHARS) return 'too-short'
  if (words.length < MIN_TOKENS) return 'single-token'
  const prose = proseVeto(text)
  if (prose) return prose
  if (isStatement(text, words)) return 'statement'
  if (isNameList(text, words)) return 'name-list'
  return null
}

/**
 * 这串文本能不能当论文标题用。
 *
 * 调用方只关心布尔值; 要知道「为什么不行」用 `paperTitleVeto`, 它给的是可读原因。
 */
export function looksLikePaperTitle(value: string): boolean {
  return paperTitleVeto(value) === null
}
