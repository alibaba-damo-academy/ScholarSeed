import { createLibrary, generateSystemPrompt } from '@openuidev/react-lang'
import { openuiLibrary } from '@openuidev/react-ui'
import { conversationLibrary, CONVERSATION_COMPONENT_GROUPS } from './library'
export { conversationLibrary } from './library'

const CANVAS_LAYOUTS = ['Stack', 'Tabs', 'TabItem', 'Accordion', 'AccordionItem', 'Separator']
const CANVAS_FIELDS = ['FormControl', 'Label', 'Input', 'TextArea', 'Select', 'SelectItem', 'Slider', 'CheckBoxGroup', 'CheckBoxItem', 'RadioGroup', 'RadioItem', 'SwitchGroup', 'SwitchItem']
const CANVAS_RESULTS = CONVERSATION_COMPONENT_GROUPS.flatMap(group => [...group.components])
const components = [...new Set([...CANVAS_LAYOUTS, ...CANVAS_FIELDS, ...CANVAS_RESULTS])]

export const canvasLibrary = createLibrary({
  id: 'canvas-v1',
  root: 'Stack',
  components: components.map(name => conversationLibrary.components[name] ?? openuiLibrary.components[name]),
  actions: [],
})

const promptLibrary = canvasLibrary.toSpec()
export const canvasPrompt = generateSystemPrompt({
  library: {
    ...promptLibrary,
    components: Object.fromEntries(Object.entries(promptLibrary.components).map(([name, component]) => [name, { signature: component.signature }])),
  },
  promptOptions: {
    preamble: 'Generate the OpenUI program for CanvasDocument.source only. Continue using the normal Agent tool workflow outside that string.',
    toolCalls: false,
    builtinFunctions: false,
    bindings: true,
    additionalRules: [
      'This is a task Canvas, not a conversation answer. Local fields and reactive variables never resume the Agent.',
      'The host owns optional rollback/cancel/submit controls. Do not generate submission buttons, Query, Mutation, @Run, @ToAssistant or @OpenUrl.',
      'Use named fields. Submitted values unwrap OpenUI field wrappers; field names and form nesting must match the declared output_schema.',
    ],
  },
})
