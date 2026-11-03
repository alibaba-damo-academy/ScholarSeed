export interface PreviewArtifactPolicy {
  readonly seed: 'empty' | 'sample'
  readonly catalogRead?: 'normal' | 'delayed' | 'failed'
  readonly historyRead?: 'normal' | 'delayed' | 'failed'
  readonly contentRead?: 'normal' | 'delayed' | 'failed'
  readonly publishOnCompletion?: boolean
}

export const PREVIEW_ARTIFACTS = {
  recoveryPath: '/__preview/artifacts/recover',
  delayMs: 2_000,
  textMaxBytes: 512 * 1024,
  binaryProbeBytes: 4096,
  editableHeader: 'x-scholarseed-artifact-editable',
  sample: [
    { path: 'readme.md', role: 'final' },
    { path: 'hello.py', role: 'intermediate' },
    { path: 'sample.pdf', role: 'supporting' },
  ],
  sampleSessions: 2,
  title: '模拟文件交付',
  seedMessage: '受审文件的模拟发布记录，不代表真实模型生成或磁盘交付。',
  notFound: 'session_artifact_not_found',
  invalid: 'preview_artifact_invalid',
  disposed: 'preview_artifact_disposed',
  readFailed: 'preview_artifact_read_failed',
  publishFailed: 'preview_artifact_publish_failed',
  recoveryUnavailable: 'preview_artifact_recovery_unavailable',
} as const
