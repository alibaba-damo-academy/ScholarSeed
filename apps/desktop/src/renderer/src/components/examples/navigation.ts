/** Order and numbering follow AI 对话区.html, GROUPS and SCENES_RAW. Available means a preview, not product acceptance. */
export const conversationOverview = {
  id: 'prototype-overview',
  labelKey: 'prototype.overview',
  number: '◎',
  status: 'unbuilt',
} as const

export const conversationSections = [
  {
    id: 'input',
    labelKey: 'prototype.groups.input',
    items: [
      {
        id: 'conversation-messages',
        labelKey: 'conversation.messages',
        number: '01',
        status: 'available',
      },
      {
        id: 'conversation-context',
        labelKey: 'conversation.context',
        number: '02',
        status: 'available',
      },
    ],
  },
  {
    id: 'dialogue',
    labelKey: 'prototype.groups.dialogue',
    items: [
      {
        id: 'conversation-artifacts',
        labelKey: 'artifactPreview.title',
        number: '03',
        status: 'available',
      },
      {
        id: 'conversation-citations',
        labelKey: 'citationPreview.title',
        number: '04',
        status: 'available',
      },
      {
        id: 'conversation-body',
        labelKey: 'bodyPreview.title',
        number: '05',
        status: 'available',
      },
      {
        id: 'conversation-confirmation',
        labelKey: 'conversation.approval',
        number: '06',
        status: 'available',
      },
      {
        id: 'conversation-clarify',
        labelKey: 'prototype.clarify',
        number: '07',
        status: 'available',
      },
      {
        id: 'conversation-processing',
        labelKey: 'processingPreview.title',
        number: '08',
        status: 'available',
      },
    ],
  },
  {
    id: 'charts',
    labelKey: 'chartPreview.title',
    items: [
      {
        id: 'conversation-chart',
        labelKey: 'chartPreview.general',
        number: '09',
        status: 'available',
        preview: 'Plot',
      },
    ],
  },
  {
    id: 'workbench',
    labelKey: 'workbenchPreview.title',
    items: [
      {
        id: 'conversation-results',
        labelKey: 'workbenchPreview.results',
        number: '10',
        status: 'available',
        preview: 'Results',
      },
      {
        id: 'conversation-review',
        labelKey: 'workbenchPreview.review',
        number: '11',
        status: 'available',
        preview: 'Review',
      },
    ],
  },
  {
    id: 'a2ui',
    labelKey: 'a2uiPreview.title',
    items: [
      {
        id: 'conversation-canvas',
        labelKey: 'a2uiPreview.canvas',
        number: '12',
        status: 'available',
        preview: 'Canvas',
      },
      {
        id: 'conversation-openui',
        labelKey: 'a2uiPreview.components',
        number: '13',
        status: 'available',
        directory: 'openui',
      },
    ],
  },
] as const

export type ConversationDirectoryEntry =
  typeof conversationOverview | (typeof conversationSections)[number]['items'][number]
export const conversationEntries: readonly ConversationDirectoryEntry[] = [
  conversationOverview,
  ...conversationSections.flatMap(
    (section): readonly ConversationDirectoryEntry[] => section.items
  ),
]
