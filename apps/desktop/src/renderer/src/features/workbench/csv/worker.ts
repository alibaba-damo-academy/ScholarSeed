import { CsvProcessor, type CsvRequest } from './protocol.ts'

const processor = new CsvProcessor()
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<CsvRequest>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}
scope.onmessage = (event) => {
  const response = processor.handle(event.data)
  const value = response.value as { bytes?: Uint8Array } | undefined
  scope.postMessage(response, value?.bytes ? [value.bytes.buffer as ArrayBuffer] : [])
}
