import React from 'react'
import { useApp } from '../../store'
import { Joining } from './Joining'
import { createLiteratureCollection, getLiteratureProjects, listLiteratureCollections } from './api'
import { pushLibItem } from './join'
import { collectionNodes, paperJoinKey } from './hierarchy'
import { joinedCollectionCreated, recordJoined, useJoinedPapers } from './joinState'

export function JoinLibraryMenu(
  props: Omit<React.ComponentProps<typeof Joining>, 'ports'>
): React.JSX.Element {
  const { state } = useApp()
  const projectId = state.homeSelectedProjectId ?? undefined
  const receipts = useJoinedPapers()
  return (
    <Joining
      {...props}
      ports={{
        projectId,
        receipts,
        destinations: async () => {
          const [collections, projects] = await Promise.all([
            listLiteratureCollections(projectId),
            getLiteratureProjects(),
          ])
          return {
            collections: collectionNodes(collections, projectId),
            projects: projects.projects.map((project) => ({
              key: `project:${project.id}`,
              name: project.name,
              projectId: project.id,
              path: [project.name],
              children: collectionNodes(project.collections, project.id, [project.name]),
            })),
          }
        },
        admit: async (papers, destination) => {
          await pushLibItem(papers, destination, projectId)
          recordJoined(
            papers.flatMap((paper) => [
              paperJoinKey(paper),
              paperJoinKey(paper, destination.projectId),
            ]),
            destination
          )
        },
        createCollection: (name, destination) =>
          createLiteratureCollection(name, destination.projectId, destination.collectionId),
        created: joinedCollectionCreated,
      }}
    />
  )
}
