export interface ApplicationCandidate {
  name: string
  path: string
  isDefault: boolean
}

export function uniqueApplications<T extends ApplicationCandidate>(applications: T[]): T[] {
  const paths = new Set<string>()
  return applications
    .slice()
    .sort((left, right) => Number(right.isDefault) - Number(left.isDefault))
    .filter((application) => {
      if (!application.path) return true
      if (paths.has(application.path)) return false
      paths.add(application.path)
      return true
    })
}
