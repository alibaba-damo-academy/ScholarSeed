import { fetchPaperMeta, getLiterature, updateLiterature } from './api'
import { MetadataBatchStore, METADATA_BATCH_STATUS, synchronizeMetadata } from './batch'
import { catalogue } from './catalog'
import { literatureTasks } from './tasks'

export const metadataBatch = new MetadataBatchStore(async (entry, projectId) => {
  if (literatureTasks.isRunning(entry.id, 'metadata')) return METADATA_BATCH_STATUS.skipped
  return literatureTasks.run(entry.id, 'metadata-batch', async () => {
    const result = await synchronizeMetadata(entry.id, projectId, {
      get: getLiterature, fetch: fetchPaperMeta, save: updateLiterature
    })
    if (result === METADATA_BATCH_STATUS.success) catalogue.reload()
    return result
  })
})
