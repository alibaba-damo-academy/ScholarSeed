import React, { createContext, useContext, useState } from 'react'
import { SearchSurface, type LiteratureSearchViewProps } from './Matches'
import { Joining, type JoinPorts } from './Joining'
import { collectionNodes, paperJoinKey, type JoinDestination } from './hierarchy'
import { ResultReport } from './Report'
import type { ConversationSearchResult } from '../../contracts/literature'
import type { LiteratureCardPorts } from './ports'
import type { LiteratureResultAuthorization } from './interaction'
import { saveBibtex, type SaveCopyBridge } from './export'

const DetailsContext = createContext<{
  ports: LiteratureCardPorts
  joining: JoinPorts
  saveCopy?: SaveCopyBridge
} | null>(null)

function DetailsJoin(
  props: Omit<React.ComponentProps<typeof Joining>, 'ports'>
): React.JSX.Element {
  const context = useContext(DetailsContext)!
  return <Joining {...props} ports={context.joining} />
}

function DetailsView(props: LiteratureSearchViewProps): React.JSX.Element {
  const context = useContext(DetailsContext)!
  const { saveCopy } = context
  return (
    <SearchSurface
      {...props}
      actions={{
        projectId: context.ports.projectId,
        saveBibtex: saveCopy ? (bibtex) => saveBibtex(bibtex, saveCopy) : undefined,
        receipts: context.joining.receipts,
        Join: DetailsJoin,
        openSource: (paper) => context.ports.openSource(paper.paper_id),
      }}
    />
  )
}

export function LiteratureDetails({
  content,
  ports,
  saveCopy,
}: {
  content: Record<string, unknown>
  ports: LiteratureCardPorts
  saveCopy?: SaveCopyBridge
}): React.JSX.Element {
  const result = content as unknown as ConversationSearchResult
  const context = content.context as { authorization?: LiteratureResultAuthorization } | undefined
  const [receipts, setReceipts] = useState<ReadonlyMap<string, JoinDestination>>(new Map())
  const joining: JoinPorts = {
    projectId: ports.projectId,
    receipts,
    destinations: async () => ({
      collections: collectionNodes(await ports.collections(), ports.projectId),
      projects: [],
    }),
    createCollection: (name, destination) => ports.createCollection(name, destination.collectionId),
    created: () => undefined,
    admit: async (papers, destination) => {
      for (const paper of papers)
        await ports.addReference(paper.paper_id, destination.collectionId ?? '')
      setReceipts(
        (current) =>
          new Map([
            ...current,
            ...papers.map((paper) => [paperJoinKey(paper, ports.projectId), destination] as const),
          ])
      )
    },
  }
  return (
    <DetailsContext.Provider value={{ ports, joining, saveCopy }}>
      <div className="h-[var(--vds-conversation-details-height)] min-w-0 overflow-hidden">
        <ResultReport View={DetailsView} result={result} authorization={context?.authorization} />
      </div>
    </DetailsContext.Provider>
  )
}
