export interface ApplicationCandidate {
  name: string
  path: string
  isDefault: boolean
}

export function uniqueApplications<T extends ApplicationCandidate>(applications: T[]): T[] {
  const names = new Set<string>()
  return applications.filter((application) => {
    const name = application.name.trim().toLocaleLowerCase()
    if (names.has(name)) return false
    names.add(name)
    return true
  })
}
