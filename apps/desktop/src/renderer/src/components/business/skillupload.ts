import { zipSync } from 'fflate'

const DIRECTORY_UPLOAD_LIMIT = { files: 5000, bytes: 64 * 1024 * 1024 } as const

export async function packageSkillDirectory(files: readonly File[]): Promise<File> {
  if (!files.length || files.length > DIRECTORY_UPLOAD_LIMIT.files)
    throw new Error('invalid_directory')
  const root = files[0].webkitRelativePath.split('/')[0]
  const entries: Record<string, Uint8Array> = Object.create(null)
  let size = 0
  for (const file of files) {
    const parts = file.webkitRelativePath.split('/')
    if (
      parts.shift() !== root ||
      !parts.length ||
      parts.some((part) => !part || part === '.' || part === '..' || /[\\:\x00]/.test(part))
    )
      throw new Error('invalid_directory')
    const path = parts.join('/')
    if (path in entries) throw new Error('invalid_directory')
    size += file.size
    if (size > DIRECTORY_UPLOAD_LIMIT.bytes) throw new Error('invalid_directory')
    entries[path] = new Uint8Array(await file.arrayBuffer())
  }
  const archive = zipSync(entries)
  return new File([new Uint8Array(archive)], `${root}.zip`, { type: 'application/zip' })
}

export async function droppedSkillFiles(transfer: DataTransfer): Promise<File[]> {
  const items = Array.from(transfer.items)
  const entries = items.map((item) => item.webkitGetAsEntry())
  if (!entries.some((entry) => entry?.isDirectory)) return Array.from(transfer.files)
  if (entries.length !== 1 || !entries[0]?.isDirectory) throw new Error('invalid_directory')
  const files: File[] = []
  let size = 0
  async function walk(entry: FileSystemEntry, path: string): Promise<void> {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject)
      )
      size += file.size
      if (files.length >= DIRECTORY_UPLOAD_LIMIT.files || size > DIRECTORY_UPLOAD_LIMIT.bytes) {
        throw new Error('invalid_directory')
      }
      Object.defineProperty(file, 'webkitRelativePath', { value: path })
      files.push(file)
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject)
        )
        if (!batch.length) break
        for (const child of batch) await walk(child, `${path}/${child.name}`)
      }
    } else throw new Error('invalid_directory')
  }
  await walk(entries[0], entries[0].name)
  return files
}
