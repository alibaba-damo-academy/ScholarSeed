import type { ConvItem, Thread } from '../../model'
import { USER_INTERRUPT_REASON } from '../../model.ts'

export const TOOL_MATERIAL_STATES = [
  'running',
  'streaming',
  'completed',
  'failed',
  'paused',
  'search',
] as const
export type ToolMaterialState = (typeof TOOL_MATERIAL_STATES)[number]
type SampleText = (
  key: `conversation.toolSample.${'request' | 'intro' | 'next' | 'readResult' | 'searchResult' | 'failure' | 'answer' | 'partial' | 'queryOne' | 'queryTwo' | 'queryThree' | 'resultTitle'}`
) => string
const SAMPLE_TURN = 'material-tools-turn'
const SAMPLE_TIMING = { total: 23_000, first: 1_000, second: 10_000 } as const
const SAMPLE_RESULT_IDS = [
  'structure',
  'dynamics',
  'experiments',
  'benchmark',
  'review',
  'limitations',
] as const

export function toolMaterial(
  state: ToolMaterialState,
  text: SampleText,
  now: number
): Partial<Thread> {
  const running = state === 'running' || state === 'streaming'
  const startedAt = now - SAMPLE_TIMING.total
  const first: ConvItem = {
    kind: 'tool',
    toolId: 'material-tool-read',
    itemId: 'material-tool-read',
    turnId: SAMPLE_TURN,
    batchId: 'material-batch-read',
    name: 'read',
    status: 'done',
    input: { command: 'Read project research notes (sample)' },
    result: text('conversation.toolSample.readResult'),
    startedAt,
    completedAt: startedAt + SAMPLE_TIMING.first,
  }
  const second: ConvItem = {
    kind: 'tool',
    toolId: 'material-tool-search',
    itemId: 'material-tool-search',
    turnId: SAMPLE_TURN,
    batchId: 'material-batch-search',
    name: 'paper_search',
    status:
      state === 'running'
        ? 'running'
        : state === 'failed'
          ? 'error'
          : state === 'paused'
            ? 'cancelled'
            : 'done',
    input: { query: text('conversation.toolSample.queryOne') },
    result:
      state === 'running' || state === 'paused'
        ? undefined
        : text(
            state === 'failed'
              ? 'conversation.toolSample.failure'
              : 'conversation.toolSample.searchResult'
          ),
    startedAt: startedAt + SAMPLE_TIMING.first,
    ...(state === 'running' ? {} : { completedAt: startedAt + SAMPLE_TIMING.second }),
  }
  const search: ConvItem = {
    kind: 'web_search',
    searchId: 'material-web-search',
    itemId: 'material-web-search',
    turnId: SAMPLE_TURN,
    batchId: 'material-batch-search',
    status: 'done',
    action: {
      type: 'search',
      queries: [
        text('conversation.toolSample.queryOne'),
        text('conversation.toolSample.queryTwo'),
        text('conversation.toolSample.queryThree'),
      ],
    },
    query: text('conversation.toolSample.queryOne'),
    results: SAMPLE_RESULT_IDS.map((id, index) => ({
      ...(index === SAMPLE_RESULT_IDS.length - 1
        ? {}
        : { title: `${text('conversation.toolSample.resultTitle')} ${index + 1}` }),
      url: `https://example.org/research/${id}`,
    })),
    startedAt: startedAt + SAMPLE_TIMING.first,
    completedAt: startedAt + SAMPLE_TIMING.second,
  }
  const conversation: ConvItem[] = [
    {
      kind: 'user',
      turnId: SAMPLE_TURN,
      itemId: 'material-tools-user',
      text: text('conversation.toolSample.request'),
      startedAt,
    },
    {
      kind: 'thinking',
      turnId: SAMPLE_TURN,
      itemId: 'material-tools-intro',
      commentary: true,
      text: text('conversation.toolSample.intro'),
    },
    first,
    {
      kind: 'thinking',
      turnId: SAMPLE_TURN,
      itemId: 'material-tools-next',
      commentary: true,
      text: text('conversation.toolSample.next'),
    },
    state === 'search' ? search : second,
  ]
  if (state === 'paused')
    conversation.push({
      kind: 'status',
      turnId: SAMPLE_TURN,
      itemId: 'material-tools-stop',
      text: '',
      hideIcon: true,
      interruptionReason: USER_INTERRUPT_REASON,
    })
  else if (state !== 'running')
    conversation.push({
      kind: 'agent',
      turnId: SAMPLE_TURN,
      itemId: 'material-tools-answer',
      text: text(
        state === 'streaming'
          ? 'conversation.toolSample.partial'
          : state === 'failed'
            ? 'conversation.toolSample.failure'
            : 'conversation.toolSample.answer'
      ),
    })
  return {
    conversation,
    readOnly: true,
    running,
    status: running ? 'running' : 'done',
    activeTurnId: running ? SAMPLE_TURN : null,
    turnOutcomes: {
      [SAMPLE_TURN]: running ? 'running' : state === 'paused' ? 'interrupted' : 'completed',
    },
    turnTimings: { [SAMPLE_TURN]: { startedAt, ...(running ? {} : { completedAt: now }) } },
    todos: [],
    planSnapshots: [],
    backgroundTasks: {},
    artifacts: [],
  }
}
