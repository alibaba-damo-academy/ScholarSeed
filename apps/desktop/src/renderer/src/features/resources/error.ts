const RESOURCE_ERROR_KEYS = {
  version_admission_unavailable: 'operationError.version_admission_unavailable',
  version_admission_failed: 'operationError.version_admission_failed',
  disk_revision_conflict: 'operationError.disk_revision_conflict',
  invalid_name: 'operationError.invalid_name',
  name_too_long: 'operationError.name_too_long',
  name_exists: 'operationError.name_exists',
  node_not_found: 'operationError.node_not_found',
  parent_not_found: 'operationError.parent_not_found',
  authorized_root_unavailable: 'operationError.authorized_root_unavailable',
  parent_not_writable: 'operationError.parent_not_writable',
  target_not_found: 'operationError.target_not_found',
  target_not_directory: 'operationError.target_not_directory',
  path_outside_project: 'operationError.path_outside_project',
  cannot_modify_root: 'operationError.cannot_modify_root',
  cannot_modify_mount: 'operationError.cannot_modify_mount',
  cannot_move_root: 'operationError.cannot_move_root',
  cannot_trash_linked: 'operationError.cannot_trash_linked',
  file_extension_change_forbidden: 'operationError.file_extension_change_forbidden',
  move_scope_mismatch: 'operationError.move_scope_mismatch',
  move_into_self: 'operationError.move_into_self',
  same_parent: 'operationError.same_parent',
  copy_into_self: 'operationError.copy_into_self',
  source_not_found: 'operationError.source_not_found',
  too_many_duplicates: 'operationError.too_many_duplicates',
  file_too_large: 'operationError.file_too_large',
  not_text_file: 'operationError.not_text_file',
  no_project_selected: 'operationError.no_project_selected',
  write_failed: 'operationError.write_failed',
  rename_failed: 'operationError.rename_failed',
  move_failed: 'operationError.move_failed',
  copy_failed: 'operationError.copy_failed',
  import_failed: 'operationError.import_failed',
  import_plan_stale: 'operationError.import_plan_stale',
  import_decisions_invalid: 'operationError.import_decisions_invalid',
  replace_not_supported: 'operationError.replace_not_supported',
  idempotency_conflict: 'operationError.idempotency_conflict',
  assistant_project_unavailable: 'operationError.assistant_project_unavailable',
  session_artifact_not_found: 'operationError.session_artifact_not_found',
  session_artifact_path_forbidden: 'operationError.session_artifact_path_forbidden',
  session_artifact_integrity_mismatch: 'operationError.session_artifact_integrity_mismatch',
  network_error: 'operationError.network_error',
  resource_import_interrupted: 'operationError.resource_import_interrupted',
  resource_import_failed: 'operationError.resource_import_failed',
} as const

export interface ResourceErrorMessage {
  key: typeof RESOURCE_ERROR_KEYS[keyof typeof RESOURCE_ERROR_KEYS] | 'operationError.unknown'
  detail?: string
}

export function resourceErrorMessage(code?: string): ResourceErrorMessage {
  const key = code && Object.prototype.hasOwnProperty.call(RESOURCE_ERROR_KEYS, code)
    ? RESOURCE_ERROR_KEYS[code as keyof typeof RESOURCE_ERROR_KEYS]
    : 'operationError.unknown'
  return { key, detail: key === 'operationError.unknown' ? code : undefined }
}

/** Preserve opaque upstream codes as diagnostics without translating their contents. */
export function resourceFailureDetail(code: string, detail?: string): string | undefined {
  if (!code) return detail || undefined
  if (!detail || detail === code) return code
  return `${code}: ${detail}`
}
