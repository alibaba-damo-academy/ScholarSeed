/** Kernel-observed pipe server and calling process identities. */
export interface NativeSessionObservation {
  readonly bytes: Buffer
  readonly ownerCreated: string
  readonly leaderCreated: string
}
/** Windows-only authenticated read; grants no install or mutation authority. */
export interface MaintenanceNative {
  maintenanceSession(pipe: string, workerPID: number): NativeSessionObservation
}
export type DirectoryRole = 'private' | 'project'
export type DirectoryPinRole = DirectoryRole | 'installation'
export interface DirectoryBinding {
  readonly role?: DirectoryRole
  readonly path: string
  readonly identity: string
  readonly ancestors: readonly string[]
}
export interface DomainNative {
  pin(path: string, create: boolean, role?: DirectoryPinRole): unknown
  pinChild?(pin: unknown, name: string): unknown
  lineage(pin: unknown): string[]
  /** Darwin cross-boot identity; absent on Windows. Does not replace runtime lineage. */
  persistentIdentity?(pin: unknown): string
  createAt(pin: unknown, name: string, bytes: Buffer): void
  createChild(pin: unknown, name: string): string
  acquireAt(pin: unknown, name: string, exclusive: boolean): unknown
  readAt(pin: unknown, name: string, maxBytes: number): Buffer | null
  listAt(pin: unknown, maxEntries: number, maxBytes: number): Record<string, Buffer>
  release(pin: unknown): void
}
export type FamilyAuthorization = (
  bindings: readonly DirectoryBinding[]
) => Promise<Readonly<Record<string, string>>>
export interface Domains {
  read(root: string, name: string, maxBytes: number): Buffer | null
  occupy(): void
  occupyFamily(authorize: FamilyAuthorization): Promise<void>
  reserveMutation(owner: string): { finish(): void }
  checkWritable(): void
  check(): void
  admit(): void
  close(): void
}
export function beginDomains(
  native: DomainNative,
  coordinator: string,
  roots: string[],
  maintenance?: boolean,
  roles?: Readonly<Record<string, DirectoryRole>>
): Domains
export function createDirectory(
  native: DomainNative,
  coordinator: string,
  parent: string,
  name: string,
  role?: DirectoryRole
): string
export function ensureDirectories(
  native: DomainNative,
  coordinator: string,
  roots: string[],
  roles?: Readonly<Record<string, DirectoryRole>>
): void
