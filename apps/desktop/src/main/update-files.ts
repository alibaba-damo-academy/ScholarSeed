import { promises as physicalFs } from 'original-fs'

/** ASAR files in update artifacts must be removed as physical files, not virtual directories. */
export function removeUpdateArtifact(path: string): Promise<void> {
  return physicalFs.rm(path, { recursive: true, force: true })
}
