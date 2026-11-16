import { contentExamples } from './samples/content.mjs'
import { chartExamples } from './samples/charts.mjs'
import { artifactExamples } from './samples/artifacts.mjs'
import { sourceExamples } from './samples/sources.mjs'
import { researchExamples } from './samples/research.mjs'
import { markdownExamples } from './samples/markdown.mjs'
import { canvasExamples } from './samples/canvas.mjs'

export const examples = {
  ...contentExamples,
  ...chartExamples,
  ...artifactExamples,
  ...sourceExamples,
  ...researchExamples,
  ...markdownExamples,
  ...canvasExamples,
}
