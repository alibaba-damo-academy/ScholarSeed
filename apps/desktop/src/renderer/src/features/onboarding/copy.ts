/** All visible onboarding copy is resolved through this one key catalogue.
 * Wording lives in localization/locales/{zh,en}/onboarding.json.
 * 待定: pdf.figure,
 * pdf.selection and pdf.ai retain the supplied wording pending product review.
 */
export const OB_COPY = {
  center: 'center',
  view: 'view',
  seen: 'seen',
  unseen: 'unseen',
  reset: 'reset',
  done: 'done',
  skip: 'skip',
  next: 'next',
  start: 'start',
  step: 'step',
  noProject: 'noProject',
  sample: 'sample',
  sampleTitle: 'sampleTitle',
  sampleLimited: 'sampleLimited',
  unavailable: 'unavailable',
  noPdf: 'noPdf',
  openFailed: 'openFailed',
  home: {
    name: 'home.name',
    descriptionKey: 'home.description',
    titleKey: 'home.title',
  },
  project: {
    name: 'project.name',
    descriptionKey: 'project.description',
    switcher: { titleKey: 'project.switcher.title', body: 'project.switcher.body' },
    capabilities: { titleKey: 'project.capabilities.title', body: 'project.capabilities.body' },
    composer: { titleKey: 'project.composer.title', body: 'project.composer.body' },
    files: { titleKey: 'project.files.title', body: 'project.files.body' },
    workspace: { titleKey: 'project.workspace.title', body: 'project.workspace.body' },
  },
  globalLib: {
    name: 'globalLib.name',
    descriptionKey: 'globalLib.description',
    library: {
      titleKey: 'globalLib.library.title',
      body: 'globalLib.library.body',
    },
    import: {
      titleKey: 'globalLib.import.title',
      body: 'globalLib.import.body',
    },
    categories: {
      titleKey: 'globalLib.categories.title',
      body: 'globalLib.categories.body',
    },
    ai: {
      titleKey: 'globalLib.ai.title',
      body: 'globalLib.ai.body',
    },
  },
  pdf: {
    sampleSelection: {
      titleKey: 'pdf.sampleSelection.title',
      body: 'pdf.sampleSelection.body',
    },
    name: 'pdf.name',
    descriptionKey: 'pdf.description',
    figure: {
      titleKey: 'pdf.figure.title',
      body: 'pdf.figure.body',
    },
    tools: {
      titleKey: 'pdf.tools.title',
      body: 'pdf.tools.body',
    },
    selection: {
      titleKey: 'pdf.selection.title',
      body: 'pdf.selection.body',
    },
    ai: {
      titleKey: 'pdf.ai.title',
      body: 'pdf.ai.body',
    },
  },
} as const
