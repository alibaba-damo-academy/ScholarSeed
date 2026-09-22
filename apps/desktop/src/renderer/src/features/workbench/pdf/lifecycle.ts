export const SCHOLARSEED_ANNOTATIONS_ATTACHMENT = 'scholarseed-annotations.json'

export interface PdfAttachmentLike {
  filename?: string
}

export type PdfAttachmentCollection =
  | ReadonlyMap<string, PdfAttachmentLike>
  | Record<string, PdfAttachmentLike>

export interface PdfDocumentLike<Page> {
  numPages: number
  getAttachments: () => Promise<PdfAttachmentCollection | null>
  getPage: (pageNumber: number) => Promise<Page>
}

export interface PdfLoadingTaskLike<Document> {
  promise: Promise<Document>
  destroy: () => Promise<void>
}

export interface PdfLifecycleDependencies<Bytes, Document, Page> {
  createTask: (bytes: Bytes) => PdfLoadingTaskLike<Document>
  restore: (bytes: Bytes) => Promise<Bytes>
}

export interface PdfOpenResult<Document, Page> {
  document: Document
  page: Page
  pageCount: number
}

export function hasScholarSeedAnnotations(
  attachments: PdfAttachmentCollection | null
): boolean {
  if (!attachments) return false
  const entries = attachments instanceof Map ? attachments.entries() : Object.entries(attachments)
  return Array.from(entries).some(([name, attachment]) => (
    name === SCHOLARSEED_ANNOTATIONS_ATTACHMENT
    || attachment.filename === SCHOLARSEED_ANNOTATIONS_ATTACHMENT
  ))
}

export class PdfLifecycle<
  Bytes,
  Document extends PdfDocumentLike<Page>,
  Page
> {
  private readonly destroyed = new WeakSet<object>()
  private readonly pages = new Map<number, Promise<Page | null>>()
  private document: Document | null = null
  private generation = 0
  private task: PdfLoadingTaskLike<Document> | null = null

  constructor(private readonly dependencies: PdfLifecycleDependencies<Bytes, Document, Page>) {}

  async open(bytes: Bytes, requestedPage: number): Promise<PdfOpenResult<Document, Page> | null> {
    const generation = ++this.generation
    const previous = this.task
    this.task = null
    this.document = null
    this.pages.clear()
    await this.destroy(previous)
    if (generation !== this.generation) return null

    let task = this.dependencies.createTask(bytes)
    this.task = task
    let document = await task.promise
    if (generation !== this.generation) {
      await this.destroy(task)
      return null
    }

    if (hasScholarSeedAnnotations(await document.getAttachments())) {
      await this.destroy(task)
      if (this.task === task) this.task = null
      const restored = await this.dependencies.restore(bytes)
      if (generation !== this.generation) return null
      task = this.dependencies.createTask(restored)
      this.task = task
      document = await task.promise
      if (generation !== this.generation) {
        await this.destroy(task)
        return null
      }
    }

    this.document = document
    const pageNumber = Math.max(1, Math.min(document.numPages, requestedPage))
    const page = await this.getPage(pageNumber)
    if (generation !== this.generation || !page) return null
    return { document, page, pageCount: document.numPages }
  }

  getPage(pageNumber: number): Promise<Page | null> {
    const document = this.document
    if (!document || pageNumber < 1 || pageNumber > document.numPages) return Promise.resolve(null)
    const generation = this.generation
    let page = this.pages.get(pageNumber)
    if (!page) {
      page = document.getPage(pageNumber).then(result => (
        generation === this.generation && document === this.document ? result : null
      ))
      this.pages.set(pageNumber, page)
    }
    return page
  }

  async suspend(): Promise<void> {
    this.generation += 1
    const task = this.task
    this.task = null
    this.document = null
    this.pages.clear()
    await this.destroy(task)
  }

  private async destroy(task: PdfLoadingTaskLike<Document> | null): Promise<void> {
    if (!task || this.destroyed.has(task)) return
    this.destroyed.add(task)
    await task.destroy()
  }
}
