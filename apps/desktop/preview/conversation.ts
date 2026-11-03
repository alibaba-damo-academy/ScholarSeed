export interface PreviewConversationPolicy {
  mode: 'chat' | 'streaming' | 'tools' | 'approval' | 'failure'
  stream?: 'normal' | 'interruptible'
  tool?: 'normal' | 'delayed' | 'failed'
  submission?: 'normal' | 'delayed'
  approvalResume?: 'normal' | 'delayed'
  disconnectAfterDeltas?: number
  readonly reconnectDelayMs?: number
}

const TOOL_OUTPUT_CHUNKS = Object.freeze(['模拟', '文件内容'])
const TOOL_FAILED_OUTPUT_CHUNKS = Object.freeze(['模拟工具调用失败；', '没有执行真实文件或命令。'])

export const PREVIEW_CONVERSATION = Object.freeze({
  tickMs: 25,
  toolRunMs: 2000,
  submissionDelayMs: 2000,
  approvalResumeDelayMs: 2000,
  approvalAnswer: '模拟审批已批准；没有执行真实命令。',
  denialAnswer: '已拒绝模拟审批；没有执行任何操作。',
  submissionCancelled: 'preview_submission_cancelled',
  toolName: 'read_file',
  toolInput: Object.freeze({ path: 'readme.md' }),
  toolOutput: TOOL_OUTPUT_CHUNKS.join(''),
  toolFailedOutput: TOOL_FAILED_OUTPUT_CHUNKS.join(''),
  toolOutputChunks: TOOL_OUTPUT_CHUNKS,
  toolFailedOutputChunks: TOOL_FAILED_OUTPUT_CHUNKS,
  toolSuccessAnswer: '已完成模拟工具调用，可检查工具展开与结果布局。',
  toolFailureAnswer: '模拟工具调用失败，可展开工具卡检查错误；没有执行真实工具。',
  reconnectDelayMs: 2000,
  paragraphSeparator: '\n\n',
  reasoning: '正在准备模拟结果；不会调用真实模型。',
  answer: '## 模拟回答\n\n这里复用真实产品组件与事件投影。\n\n- 支持主题、语言和布局检查\n- 数据仅保存在当前预览实例\n\n**这不是模型或原生能力验收。**',
  normalChunks: Object.freeze(['这是', '模拟流式', '回答。']),
  normalIntervalMs: 25,
  interruptibleChunks: Object.freeze([
    '开始模拟长回答。',
    '\n第一段：正在整理预览内容。',
    '\n第二段：可以观察逐段追加的文本。',
    '\n第三段：此时可以使用停止按钮。',
    '\n第四段：也可以切换布局检查显示。',
    '\n第五段：当前内容仅来自模拟场景。',
    '\n第六段：不会请求真实模型服务。',
    '\n第七段：继续追加可见的预览片段。',
    '\n第八段：保留足够的交互检查时间。',
    '\n第九段：可以检查长回答的滚动效果。',
    '\n第十段：正在收尾这次模拟输出。',
    '模拟长回答已完成。',
  ]),
  interruptibleIntervalMs: 1000,
})

const RAW_POLICIES: Readonly<Record<string, Readonly<PreviewConversationPolicy>>> = Object.freeze({
  chat: Object.freeze({ mode: 'chat' }),
  tools: Object.freeze({ mode: 'tools' }),
  approval: Object.freeze({ mode: 'approval' }),
  failure: Object.freeze({ mode: 'failure' }),
  streaming: Object.freeze({ mode: 'streaming' }),
  empty: Object.freeze({ mode: 'chat' }),
})

export function previewConversationPolicy(explicit?: PreviewConversationPolicy, scene?: string): PreviewConversationPolicy {
  if (explicit) return { ...explicit }
  const key = scene && Object.prototype.hasOwnProperty.call(RAW_POLICIES, scene) ? scene : 'chat'
  return { ...RAW_POLICIES[key] }
}

export function previewConversationTool(policy: PreviewConversationPolicy): { name: string; runMs: number; success: boolean; input: { path: string }; output: string; answer: string; chunks: string[] } {
  const failed = policy.tool === 'failed'
  return {
    name: PREVIEW_CONVERSATION.toolName,
    runMs: policy.tool === 'delayed' || failed ? PREVIEW_CONVERSATION.toolRunMs : PREVIEW_CONVERSATION.tickMs,
    success: !failed,
    input: { ...PREVIEW_CONVERSATION.toolInput },
    output: failed ? PREVIEW_CONVERSATION.toolFailedOutput : PREVIEW_CONVERSATION.toolOutput,
    answer: failed ? PREVIEW_CONVERSATION.toolFailureAnswer : PREVIEW_CONVERSATION.toolSuccessAnswer,
    chunks: failed ? [...PREVIEW_CONVERSATION.toolFailedOutputChunks]
      : policy.tool === 'delayed' ? [...PREVIEW_CONVERSATION.toolOutputChunks]
        : [PREVIEW_CONVERSATION.toolOutput],
  }
}

export function previewConversationStream(policy: PreviewConversationPolicy): { chunks: string[]; intervalMs: number } {
  if (policy.mode === 'failure') {
    const separator = PREVIEW_CONVERSATION.paragraphSeparator
    return {
      chunks: PREVIEW_CONVERSATION.answer.split(separator).map((paragraph, index) => index === 0 ? paragraph : separator + paragraph),
      intervalMs: PREVIEW_CONVERSATION.normalIntervalMs,
    }
  }
  return policy.stream === 'interruptible'
    ? { chunks: [...PREVIEW_CONVERSATION.interruptibleChunks], intervalMs: PREVIEW_CONVERSATION.interruptibleIntervalMs }
    : { chunks: [...PREVIEW_CONVERSATION.normalChunks], intervalMs: PREVIEW_CONVERSATION.normalIntervalMs }
}
