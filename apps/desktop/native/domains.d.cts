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
  pruneLockOnlyAt?(pin: unknown, name: string): boolean
  createAt(pin: unknown, name: string, bytes: Buffer): void
  /** Atomically replace one leaf relative to the pinned directory; ERR_LEASE_SYNC means the result is uncertain. */
  replaceAt(pin: unknown, name: string, bytes: Buffer): void
  clearCacheAt?(pin: unknown): void
  publishCacheAt?(pin: unknown, staged: string, name: string): void
  discardCacheAliasAt?(pin: unknown, staged: string, name: string): void
  consumeAt?(
    pin: unknown,
    name: string,
    expected: Buffer,
    expectedDevice: string,
    expectedInode: string
  ): void
  createChild(pin: unknown, name: string): string
  acquireAt(pin: unknown, name: string, exclusive: boolean, offset?: number, identity?: string): unknown
  /** Exclusive flock on the pinned directory itself; Darwin only, ERR_LEASE_PLATFORM on Windows. */
  lockDirectoryAt?(pin: unknown): unknown
  readAt(pin: unknown, name: string, maxBytes: number): Buffer | null
  listAt(pin: unknown, maxEntries: number, maxBytes: number): Record<string, Buffer>
  release(pin: unknown): void
}
export type FamilyAuthorization = (
  bindings: readonly DirectoryBinding[]
) => Promise<Readonly<Record<string, string>>>
export interface Domains {
  clearCache(root: string, aliases?: readonly (readonly [string, string])[]): void
  publishCache(root: string, staged: string, name: string): void
  create(root: string, name: string, bytes: Buffer): void
  replace(root: string, name: string, bytes: Buffer): void
  read(root: string, name: string, maxBytes: number): Buffer | null
  occupy(): void
  occupyFamily(authorize: FamilyAuthorization): Promise<void>
  reserveMutation(owner: string): { finish(): void }
  checkWritable(): void
  /** Verify durable mutation barriers once for this occupancy; later reads may reuse the result. */
  verifyReadBarriers(): void
  policyBinding(root: string): { pin: unknown; lineage: string[]; acquire(name: string): unknown; release(handle: unknown): void }
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
